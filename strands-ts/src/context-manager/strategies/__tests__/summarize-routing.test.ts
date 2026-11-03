import { describe, expect, it, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { SummarizeStrategy } from '../offload/summarize.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { Role } from '../../../types/messages.js'
import { Model } from '../../../models/model.js'
import type { BaseModelConfig, StreamOptions } from '../../../models/model.js'
import type { ModelInfo } from '../../../models/model-info.js'
import type { ModelStreamEvent } from '../../../models/streaming.js'
import type { SummaryRequest, SummaryResult } from '../../../models/summary.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { ToolRegistry } from '../../../registry/tool-registry.js'
import { tool } from '../../../tools/tool-factory.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'
import type { LocalAgent } from '../../../types/agent.js'
import { z } from 'zod'
import { logger } from '../../../logging/logger.js'

const usage = { inputTokens: 30, outputTokens: 7, totalTokens: 37 }
const nativeUsage = { inputTokens: 144, outputTokens: 276, totalTokens: 420 }

const text = (role: Role, value: string): Message => new Message({ role, content: [new TextBlock(value)] })

/** [task] then alternating turns; the last message is a user turn. */
function history(): Message[] {
  return [
    text('user', 'TASK'),
    text('assistant', 'a1'),
    text('user', 'u2'),
    text('assistant', 'a3'),
    text('user', 'u4'),
    text('assistant', 'a5'),
    text('user', 'u6'),
  ]
}

function summarizerModel(serverSideCompaction?: boolean): MockMessageModel {
  const model = new MockMessageModel()
    .addTurn({ type: 'textBlock', text: 'BASE SUMMARY' }, { usage })
    .addTurn({ type: 'textBlock', text: 'BASE SUMMARY 2' }, { usage })
  if (serverSideCompaction !== undefined) model.updateConfig({ modelInfo: { capabilities: { serverSideCompaction } } })
  return model
}

function nativeResult(text = 'NATIVE SUMMARY'): SummaryResult {
  return {
    block: new TextBlock(text, {
      providerData: { provider: 'anthropic', data: { type: 'compaction', signature: 's' } },
    }),
    usage: nativeUsage,
  }
}

const lookup = tool({ name: 'lookup', description: 'Look up.', inputSchema: z.object({}), callback: () => 'x' })

function context(
  messages: Message[],
  models: { model?: Model | undefined; auxModel?: Model | undefined }
): ContextState & { invocationContext: InvocationContextImpl } {
  const agent = createMockAgent({
    messages,
    toolRegistry: new ToolRegistry([lookup]),
    extra: { model: models.model, auxModel: models.auxModel, systemPrompt: 'LIVE SYSTEM' } as Partial<Agent>,
  })
  return { messages, agent, utilization: 0.9, invocationContext: new InvocationContextImpl() }
}

function strategy(
  config: ConstructorParameters<typeof SummarizeStrategy>[1] = {},
  preserveRecent = 2
): SummarizeStrategy {
  return new SummarizeStrategy('*', config, { utilization: 0.5, preserveRecent })
}

describe('SummarizeStrategy routing', () => {
  describe('resolve', () => {
    it.each([
      [true, 'NativeSummarizer'],
      [false, 'BaseSummarizer'],
      [undefined, 'BaseSummarizer'],
    ])('serverSideCompaction=%s resolves %s', (serverSideCompaction, name) => {
      const agent = context(history(), { auxModel: summarizerModel(serverSideCompaction) }).agent
      expect(strategy().resolve(agent)?.constructor.name).toBe(name)
    })

    it('reads the configured model before agent.auxModel', () => {
      const configured = summarizerModel(true)
      const agent = context(history(), { auxModel: summarizerModel(false) }).agent
      expect(strategy({ model: configured }).resolve(agent)?.model).toBe(configured)
      expect(strategy().resolve(agent)?.constructor.name).toBe('BaseSummarizer')
    })

    it('resolves nothing without a summarizer model, and the pass is skipped', async () => {
      const state = context(history(), {})
      expect(strategy().resolve(state.agent)).toBeUndefined()
      const messages = [...state.messages]
      expect(await strategy().apply(state)).toBe(false)
      expect(state.messages).toStrictEqual(messages)
    })

    it('follows the capability a wrapper reports, not whether it overrides compact', () => {
      class Wrapper extends Model<BaseModelConfig> {
        constructor(private readonly _inner: Model) {
          super()
        }
        updateConfig(): void {}
        getConfig(): BaseModelConfig {
          return this._inner.getConfig()
        }
        override get modelInfo(): ModelInfo {
          return this._inner.modelInfo
        }
        override compact(request: SummaryRequest): Promise<SummaryResult | undefined> {
          return this._inner.compact(request)
        }
        stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
          return this._inner.stream(messages, options)
        }
      }
      const agentFor = (inner: Model): LocalAgent => context(history(), { auxModel: new Wrapper(inner) }).agent
      expect(strategy().resolve(agentFor(summarizerModel(true)))?.constructor.name).toBe('NativeSummarizer')
      expect(strategy().resolve(agentFor(summarizerModel()))?.constructor.name).toBe('BaseSummarizer')
    })
  })

  describe('native path', () => {
    it('compacts from message 0 with the live system prompt and tools, and places the block first', async () => {
      const model = summarizerModel(true)
      const compact = vi.spyOn(model, 'compact').mockResolvedValue(nativeResult())
      const stream = vi.spyOn(model, 'stream')
      const messages = history()
      const original = [...messages]
      const state = context(messages, { auxModel: model })

      expect(await strategy({ systemPrompt: 'Keep the task.' }).apply(state)).toBe(true)

      const request = compact.mock.calls[0]![0]
      expect(request.messages).toStrictEqual(original.slice(0, 5))
      expect(request.messages[0]).toBe(original[0])
      expect(request.systemPrompt).toBe('LIVE SYSTEM')
      expect(request.toolSpecs).toStrictEqual([lookup.toolSpec])
      expect(request.instructions).toBe('Keep the task.')
      expect(request.cancelSignal).toBe(state.agent.cancelSignal)
      expect(stream).not.toHaveBeenCalled()

      expect(messages).toHaveLength(3)
      expect(messages[0]!.role).toBe('assistant')
      expect(messages[0]!.content).toStrictEqual([
        new TextBlock('NATIVE SUMMARY', {
          metadata: { offloaded: { method: 'summarize', removedMessages: 5 } },
          providerData: { provider: 'anthropic', data: { type: 'compaction', signature: 's' } },
        }),
      ])
      expect(messages.slice(1)).toStrictEqual(original.slice(5))
      expect(messages[1]).toBe(original[5])
      expect(state.invocationContext.usage).toMatchObject(nativeUsage)
    })

    it('sends the body as the model saw it, with an earlier client-side summary rendered', async () => {
      const model = summarizerModel(true)
      const compact = vi.spyOn(model, 'compact').mockResolvedValue(nativeResult())
      const messages = history()
      messages[1] = new Message({
        role: 'assistant',
        content: [
          new TextBlock('EARLIER', {
            metadata: { offloaded: { method: 'summarize', removedMessages: 3, removedTokens: 40 } },
          }),
        ],
      })
      await strategy().apply(context(messages, { auxModel: model }))
      const sent = compact.mock.calls[0]![0].messages.flatMap((message) => message.content)
      expect(sent).toContainEqual(new TextBlock('[Summarized: 3 messages, ~40 tokens]\n\nEARLIER'))
      expect(compact.mock.calls[0]![0].messages.at(-1)!.role).toBe('user')
    })

    it('compacts again over the earlier native block', async () => {
      const model = summarizerModel(true)
      const compact = vi
        .spyOn(model, 'compact')
        .mockResolvedValueOnce(nativeResult('FIRST'))
        .mockResolvedValueOnce(nativeResult('SECOND'))
      const messages = history()
      const state = context(messages, { auxModel: model })
      await strategy({}, 2).apply(state)
      messages.push(text('assistant', 'a7'), text('user', 'u8'), text('assistant', 'a9'), text('user', 'u10'))
      const first = messages[0]!

      expect(await strategy({}, 2).apply(state)).toBe(true)
      expect(compact.mock.calls[1]![0].messages[0]).toBe(first)
      expect((messages[0]!.content[0] as TextBlock).text).toBe('SECOND')
      expect(
        messages.filter((message) => message.content.some((block) => block.type === 'textBlock' && block.providerData))
      ).toHaveLength(1)
      expect(state.invocationContext.usage).toMatchObject({ inputTokens: 288, outputTokens: 552, totalTokens: 840 })
    })

    describe('when compact returns undefined', () => {
      it('re-cuts the original history keeping message 0 and summarizes client-side in the same pass', async () => {
        const model = summarizerModel(true)
        const compact = vi.spyOn(model, 'compact').mockResolvedValue(undefined)
        const stream = vi.spyOn(model, 'stream')
        const messages = history()
        const original = [...messages]
        const state = context(messages, { auxModel: model })

        expect(await strategy().apply(state)).toBe(true)

        expect(compact.mock.calls[0]![0].messages).toStrictEqual(original.slice(0, 5))
        expect(stream).toHaveBeenCalledTimes(1)
        expect(stream.mock.calls[0]![1]).toStrictEqual({
          systemPrompt: expect.stringContaining('summarization assistant'),
          cancelSignal: state.agent.cancelSignal,
        })
        expect(JSON.stringify(stream.mock.calls[0]![0])).not.toContain('TASK')
        expect(messages[0]).toBe(original[0])
        expect(messages[1]!.content[0]).toMatchObject({
          text: 'BASE SUMMARY',
          metadata: { offloaded: { method: 'summarize', removedMessages: 4 } },
        })
        expect(messages.slice(2)).toStrictEqual(original.slice(5))
        expect(state.invocationContext.usage).toMatchObject(usage)
      })

      it('leaves the history unchanged when no base cut is legal', async () => {
        const model = summarizerModel(true)
        vi.spyOn(model, 'compact').mockResolvedValue(undefined)
        const stream = vi.spyOn(model, 'stream')
        const messages = history()
        messages[1] = new Message({
          role: 'assistant',
          content: [new TextBlock('a1')],
          metadata: { custom: { pinned: true } },
        })
        const original = [...messages]
        const state = context(messages, { auxModel: model })

        expect(await strategy().apply(state)).toBe(false)
        expect(stream).not.toHaveBeenCalled()
        expect(messages).toStrictEqual(original)
      })
    })

    it('propagates a compaction error and leaves the history unchanged', async () => {
      const model = summarizerModel(true)
      vi.spyOn(model, 'compact').mockRejectedValue(new Error('compaction_block_misplaced'))
      const stream = vi.spyOn(model, 'stream')
      const messages = history()
      const original = [...messages]
      const state = context(messages, { auxModel: model })

      await expect(strategy().apply(state)).rejects.toThrow('compaction_block_misplaced')
      expect(stream).not.toHaveBeenCalled()
      expect(messages).toStrictEqual(original)
      expect(state.invocationContext.usage.totalTokens).toBe(0)
    })

    it('skips the pass with a warning when message 0 is pinned', async () => {
      const model = summarizerModel(true)
      const compact = vi.spyOn(model, 'compact')
      const stream = vi.spyOn(model, 'stream')
      const warn = vi.spyOn(logger, 'warn')
      const messages = history()
      messages[0] = new Message({
        role: 'user',
        content: [new TextBlock('TASK')],
        metadata: { custom: { pinned: true } },
      })
      const original = [...messages]
      expect(await strategy().apply(context(messages, { auxModel: model }))).toBe(false)
      expect(compact).not.toHaveBeenCalled()
      expect(stream).not.toHaveBeenCalled()
      expect(messages).toStrictEqual(original)
      expect(warn).toHaveBeenCalledWith('model_id=<test-model> | message 0 is pinned, skipping native compaction')
    })
  })

  describe('base path', () => {
    it.each([false, undefined])(
      'serverSideCompaction=%s keeps message 0 and stores the summary as its own message',
      async (capability) => {
        const model = summarizerModel(capability)
        const compact = vi.spyOn(model, 'compact')
        vi.spyOn(model, 'countTokens').mockResolvedValue(55)
        const messages = history()
        const original = [...messages]
        const state = context(messages, { auxModel: model })

        expect(await strategy().apply(state)).toBe(true)

        expect(compact).not.toHaveBeenCalled()
        expect(messages[0]).toBe(original[0])
        expect(messages[1]).toStrictEqual(
          new Message({
            role: 'assistant',
            trackingId: messages[1]!.trackingId,
            content: [
              new TextBlock('BASE SUMMARY', {
                metadata: { offloaded: { method: 'summarize', removedMessages: 4, removedTokens: 55 } },
              }),
            ],
          })
        )
        expect(messages.slice(2)).toStrictEqual(original.slice(5))
        expect(state.invocationContext.usage).toMatchObject(usage)
      }
    )

    it('rolls an earlier summary into the next one', async () => {
      const model = summarizerModel()
      const stream = vi.spyOn(model, 'stream')
      const messages = history()
      const state = context(messages, { auxModel: model })
      await strategy().apply(state)
      messages.push(text('assistant', 'a7'), text('user', 'u8'))

      expect(await strategy().apply(state)).toBe(true)
      expect(JSON.stringify(stream.mock.calls[1]![0])).toContain('BASE SUMMARY')
      const summaries = messages
        .flatMap((message) => message.content)
        .filter((block) => block.type === 'textBlock' && block.metadata)
      expect(summaries).toHaveLength(1)
      expect((summaries[0] as TextBlock).text).toBe('BASE SUMMARY 2')
      expect(state.invocationContext.usage).toMatchObject({ inputTokens: 60, outputTokens: 14, totalTokens: 74 })
    })

    it('leaves the history unchanged when the summarizer writes no text', async () => {
      const model = new MockMessageModel().addTurn({ type: 'toolUseBlock', name: 'x', toolUseId: 'y', input: {} })
      const messages = history()
      const original = [...messages]
      expect(await strategy().apply(context(messages, { auxModel: model }))).toBe(false)
      expect(messages).toStrictEqual(original)
    })

    it('propagates a summarizer error and leaves the history unchanged', async () => {
      const model = new MockMessageModel().addTurn(new Error('throttled'))
      const messages = history()
      const original = [...messages]
      await expect(strategy().apply(context(messages, { auxModel: model }))).rejects.toThrow('throttled')
      expect(messages).toStrictEqual(original)
    })

    it('keeps tool pairs whole', async () => {
      const model = summarizerModel()
      const messages = [
        text('user', 'TASK'),
        new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'lookup', toolUseId: 't', input: {} })] }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 't', status: 'success', content: [new TextBlock('r')] })],
        }),
        text('assistant', 'a3'),
        text('user', 'u4'),
      ]
      const kept = messages.slice(3)
      expect(await strategy({}, 3).apply(context(messages, { auxModel: model }))).toBe(true)
      expect(messages.slice(2)).toStrictEqual(kept)
    })
  })

  describe('selection paths stay on the client-side summary', () => {
    it.each([
      ['a target other than *', Offload.summarize('toolResults').when({ utilization: 0.5 })],
      ['a threshold with utilization', Offload.summarize('*').when({ utilization: 0.5, threshold: 1 })],
    ])('%s never calls compact', async (_, selection) => {
      const model = summarizerModel(true)
      const compact = vi.spyOn(model, 'compact')
      const messages = [
        text('user', 'TASK'),
        new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'lookup', toolUseId: 't', input: {} })] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({ toolUseId: 't', status: 'success', content: [new TextBlock('r'.repeat(400))] }),
          ],
        }),
        text('assistant', 'a3'),
        text('user', 'u4'),
      ]
      await selection.apply(context(messages, { model, auxModel: model }))
      expect(compact).not.toHaveBeenCalled()
      expect(JSON.stringify(messages)).toContain('[Summarized:')
    })
  })
})
