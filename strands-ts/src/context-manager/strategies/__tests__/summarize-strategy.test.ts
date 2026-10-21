import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { summarizeContent } from '../../methods/summarize.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'

vi.mock('../../methods/summarize.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    summarizeContent: vi.fn(async () => 'Summary of multimodal content'),
  }
})

function makeToolResultMessage(text: string, toolUseId = 'tool-123'): Message {
  return new Message({
    role: 'user',
    content: [
      new ToolResultBlock({
        toolUseId,
        status: 'success',
        content: [new TextBlock(text)],
      }),
    ],
  })
}

function heuristicCountTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) {
        total += Math.ceil(block.text.length / 4)
      } else if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / 4)
          else total += Math.ceil(JSON.stringify(content).length / 2)
        }
      } else {
        total += Math.ceil(JSON.stringify(block).length / 2)
      }
    }
  }
  return total
}

function makeContext(messages: Message[], utilization = 0.5, model?: unknown): ContextState {
  const resolvedModel = model
    ? { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs), ...(model as object) }
    : undefined
  const mockData = resolvedModel ? { messages, extra: { model: resolvedModel } as Partial<Agent> } : { messages }
  const agent = createMockAgent(mockData)
  return {
    messages,
    agent,
    utilization,
  }
}

describe('Offload.summarize', () => {
  it('creates a strategy with correct name', () => {
    const strategy = Offload.summarize('toolResults')
    expect(strategy.name).toBe('offload:summarize')
  })

  it('creates a strategy with .when() conditions', () => {
    const strategy = Offload.summarize('toolResults').when({ utilization: 0.85 })
    expect(strategy.name).toBe('offload:summarize')
  })

  describe('apply', () => {
    it('returns false when no model is available', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const strategy = Offload.summarize('toolResults')
      const context = makeContext(messages)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
    })

    it('returns false when blocks are below threshold', async () => {
      const smallText = 'short result'
      const messages = [makeToolResultMessage(smallText)]
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('toolResults').when({ threshold: 2500 })
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
    })

    it('summarizes large tool results', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('toolResults')
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      const block = messages[0]!.content[0] as ToolResultBlock
      expect((block.content[0] as TextBlock).text).toContain('[Summarized:')
    })

    it('summarizes with agent.auxModel when the strategy has no model', async () => {
      const { summarizeContent } = await import('../../methods/summarize.js')
      vi.mocked(summarizeContent).mockClear()
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const mainModel = { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) }
      const auxModel = { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) }
      const agent = createMockAgent({ messages, extra: { model: mainModel, auxModel } as unknown as Partial<Agent> })
      const strategy = Offload.summarize('toolResults')

      const result = await strategy.apply({ messages, agent, utilization: 0.9 })

      expect(result).toBe(true)
      expect(summarizeContent).toHaveBeenCalledTimes(1)
      expect(vi.mocked(summarizeContent).mock.calls[0]![1]).toBe(auxModel)
    })

    it('summarizes assistant text blocks', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const message = new Message({
        role: 'assistant',
        content: [new TextBlock(largeText)],
      })
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('assistantText')
      const context = makeContext([message], 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      const block = message.content[0] as TextBlock
      expect(block.text).toContain('[Summarized:')
    })

    it('summarizes user text blocks', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const message = new Message({
        role: 'user',
        content: [new TextBlock(largeText)],
      })
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('userText')
      const context = makeContext([message], 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      const block = message.content[0] as TextBlock
      expect(block.text).toContain('[Summarized:')
    })

    it('skips when utilization is below threshold', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('toolResults').when({ utilization: 0.85 })
      const context = makeContext(messages, 0.5, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
    })

    it('fires when utilization exceeds threshold', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const firstMessage = new Message({ role: 'user', content: [new TextBlock('initial question')] })
      const toolResultMessage = makeToolResultMessage(largeText)
      const latest = new Message({ role: 'assistant', content: [new TextBlock('latest')] })
      const messages = [firstMessage, toolResultMessage, latest]
      const mockModel = { stream: vi.fn(), countTokens: vi.fn(async () => 5000) }
      const strategy = Offload.summarize('toolResults').when({ utilization: 0.85 })
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
    })

    it('returns false on empty messages', async () => {
      const mockModel = { stream: vi.fn() }
      const strategy = Offload.summarize('toolResults')
      const context = makeContext([], 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
    })
  })

  describe('server-side compaction routing', () => {
    function makeMessages(): Message[] {
      return [
        new Message({ role: 'user', content: [new TextBlock('old1')] }),
        new Message({ role: 'assistant', content: [new TextBlock('old2')] }),
        new Message({ role: 'user', content: [new TextBlock('recent')] }),
      ]
    }

    it('routes to model.compact when retroactive and required', async () => {
      const preserved = new Message({ role: 'user', content: [new TextBlock('recent')] })
      const compactionMessage = new Message({ role: 'assistant', content: [] })
      const compact = vi.fn(async () => [compactionMessage, preserved])
      const mockModel = { stream: vi.fn(), requiresServerSideCompaction: true, compact }
      const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })
      const messages = makeMessages()
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      expect(compact).toHaveBeenCalledOnce()
      expect(compact).toHaveBeenCalledWith(messages, {
        utilization: 0.9,
        preservedMessages: 1,
        toolSpecs: [],
      })
      expect(messages).toEqual([compactionMessage, preserved])
    })

    it('falls back to false when compact returns undefined', async () => {
      const compact = vi.fn(async () => undefined)
      const mockModel = { stream: vi.fn(), requiresServerSideCompaction: true, compact }
      const strategy = Offload.summarize('*').when({ utilization: 0.8 })
      const messages = makeMessages()
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
    })

    it('does not route to compact when requiresServerSideCompaction is false', async () => {
      const compact = vi.fn()
      const mockModel = { stream: vi.fn(), countTokens: vi.fn(async () => 5000), compact }
      const strategy = Offload.summarize('*').when({ utilization: 0.8 })
      const messages = makeMessages()
      const context = makeContext(messages, 0.9, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      expect(compact).not.toHaveBeenCalled()
    })

    it('does not route to compact when the strategy is not retroactive', () => {
      const strategy = Offload.summarize('toolResults').when({ threshold: 10 })
      expect((strategy as unknown as { _isRetroactive: boolean })._isRetroactive).toBe(false)
    })

    it('does not route to compact when utilization is below threshold', async () => {
      // Regression: the message-level utilization/overflow gate must still apply to the
      // server-side branch -- it must not fire on every apply() call just because the model
      // requires server-side compaction.
      const compact = vi.fn()
      const mockModel = { stream: vi.fn(), requiresServerSideCompaction: true, compact }
      const strategy = Offload.summarize('*').when({ utilization: 0.8 })
      const messages = makeMessages()
      const context = makeContext(messages, 0.2, mockModel)

      const result = await strategy.apply(context)

      expect(result).toBe(false)
      expect(compact).not.toHaveBeenCalled()
    })

    it('routes to compact on overflow even below the utilization threshold', async () => {
      const preserved = new Message({ role: 'user', content: [new TextBlock('recent')] })
      const compactionMessage = new Message({ role: 'assistant', content: [] })
      const compact = vi.fn(async () => [compactionMessage, preserved])
      const mockModel = { stream: vi.fn(), requiresServerSideCompaction: true, compact }
      const strategy = Offload.summarize('*').when({ utilization: 0.8 })
      const messages = [new Message({ role: 'user', content: [new TextBlock('old1')] }), preserved]
      const context: ContextState = { ...makeContext(messages, 0.2, mockModel), overflow: true }

      const result = await strategy.apply(context)

      expect(result).toBe(true)
      expect(compact).toHaveBeenCalledOnce()
    })
  })

  describe('request limits', () => {
    it('adds the summarizer usage to the request total even when the request limit is used up', async () => {
      const actualSummarize =
        await vi.importActual<typeof import('../../methods/summarize.js')>('../../methods/summarize.js')
      vi.mocked(summarizeContent).mockImplementationOnce(actualSummarize.summarizeContent)
      const summarizer = new MockMessageModel().addTurn(
        { type: 'textBlock', text: 'Summary of tool output' },
        { usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } }
      )
      const messages = [makeToolResultMessage('x'.repeat(2500 * 4 + 100))]
      const strategy = Offload.summarize('toolResults', { model: summarizer })
      const invocationContext = new InvocationContextImpl({ turns: 1 })
      invocationContext.usage.turnsTaken = 5

      const result = await strategy.apply({ ...makeContext(messages, 0.9, { stream: vi.fn() }), invocationContext })

      expect(result).toBe(true)
      expect(messages[0]!.content).toEqual([
        new ToolResultBlock({
          toolUseId: 'tool-123',
          status: 'success',
          content: [new TextBlock('[Summarized: tool result, ~2,525 tokens]\n\nSummary of tool output')],
        }),
      ])
      expect(invocationContext.usage).toEqual({ turnsTaken: 5, inputTokens: 4, outputTokens: 5, totalTokens: 9 })
    })
  })
})

describe('repeated summarization', () => {
  // Regression test for https://github.com/strands-agents/harness-sdk/issues/4685
  it('keeps summaries out of a pinned message 0', async () => {
    const strategy = Offload.summarize('*').when({ utilization: 0.7, preserveRecent: 4 })
    const mockModel = { stream: vi.fn() }
    const task = () =>
      new Message({ role: 'user', content: [new TextBlock('task')], metadata: { custom: { pinned: true } } })
    const messages = [task()]
    for (let index = 0; index < 30; index++) {
      messages.push(
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ toolUseId: `t${index}`, name: 'read', input: {} })],
        }),
        makeToolResultMessage('x', `t${index}`)
      )
      await strategy.apply(makeContext(messages, 0.9, mockModel))
    }
    expect(messages[0]!.content).toEqual(task().content)
    expect(messages[0]!.metadata).toEqual(task().metadata)
    const summaries = messages
      .flatMap((message) => message.content)
      .filter((block) => block instanceof TextBlock && block.text.startsWith('[Summarized:'))
    expect(summaries).toHaveLength(1)
  })
})
