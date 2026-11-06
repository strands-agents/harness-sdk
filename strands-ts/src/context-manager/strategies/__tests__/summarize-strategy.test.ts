import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { summarizeContent } from '../../methods/summarize.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { Message, SummaryBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { NotImplementedError } from '../../../errors.js'
import { ImageBlock, VideoBlock } from '../../../types/media.js'
import { logger } from '../../../logging/logger.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'
import type { ToolRegistry } from '../../../registry/tool-registry.js'

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
    ? { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs), modelInfo: {}, ...(model as object) }
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

  describe('tool call history', () => {
    // guards against a rejected first request and a text-only retry that drops tool calls (#5291)
    it('summarizes tool calls as text in a single model call', async () => {
      const actualSummarize =
        await vi.importActual<typeof import('../../methods/summarize.js')>('../../methods/summarize.js')
      vi.mocked(summarizeContent).mockImplementationOnce(actualSummarize.summarizeContent)
      const summarizer = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Listed the files' })
      const streamSpy = vi.spyOn(summarizer, 'stream')
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('fix the build')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'shell', toolUseId: 'call_1', input: { command: 'ls' } })],
        }),
        makeToolResultMessage('a.ts b.ts', 'call_1'),
        new Message({ role: 'assistant', content: [new TextBlock('done')] }),
        new Message({ role: 'user', content: [new TextBlock('next')] }),
      ]
      const strategy = Offload.summarize('*', { model: summarizer }).when({ utilization: 0.7, preserveRecent: 2 })

      const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

      expect(result).toBe(true)
      expect(streamSpy).toHaveBeenCalledTimes(1)
      expect(streamSpy.mock.calls[0]![0]).toEqual([
        expect.objectContaining({
          role: 'user',
          content: [
            new TextBlock('<content>'),
            new TextBlock('\n---\n[assistant]'),
            new TextBlock('[tool call: shell] {"command":"ls"}'),
            new TextBlock('\n---\n[user]'),
            new TextBlock('[tool result: shell]'),
            new TextBlock('a.ts b.ts'),
            new TextBlock('</content>'),
          ],
        }),
      ])
    })
  })
})

describe('summarizer errors', () => {
  // guards against summarizer failures being hidden by a lossy retry (#5291)
  it('keeps a block and continues the pass when its summarization fails', async () => {
    vi.mocked(summarizeContent).mockRejectedValueOnce(new Error('rejected'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const messages = [makeToolResultMessage(largeText, 'call_1'), makeToolResultMessage(largeText, 'call_2')]
    const strategy = Offload.summarize('toolResults')

    const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

    expect(result).toBe(true)
    expect(((messages[0]!.content[0] as ToolResultBlock).content[0] as TextBlock).text).toBe(largeText)
    expect(((messages[1]!.content[0] as ToolResultBlock).content[0] as TextBlock).text).toContain('[Summarized:')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('error=<rejected>'))
    warnSpy.mockRestore()
  })

  it('offloads a video block without summarizing it', async () => {
    vi.mocked(summarizeContent).mockClear()
    const messages = [
      new Message({
        role: 'user',
        content: [new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array(4000) } })],
      }),
    ]
    const strategy = Offload.summarize('*', { model: new MockMessageModel() }).when({ threshold: 10 })

    const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

    expect(result).toBe(true)
    expect(messages[0]!.content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^\[Offloaded: ~\d+ tokens\]/) }),
    ])
    expect(summarizeContent).not.toHaveBeenCalled()
  })

  it('offloads a media block when its summarization fails', async () => {
    vi.mocked(summarizeContent).mockRejectedValueOnce(new Error('images unsupported'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = [
      new Message({
        role: 'user',
        content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array(4000) } })],
      }),
    ]
    const strategy = Offload.summarize('*', { model: new MockMessageModel() }).when({ threshold: 10 })

    const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

    expect(result).toBe(true)
    expect(messages[0]!.content).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/^\[Offloaded: ~\d+ tokens\]/) }),
    ])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('error=<images unsupported>'))
    warnSpy.mockRestore()
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
describe('server-side summary', () => {
  const openingMessages = (): Message[] => [
    new Message({ role: 'user', content: [new TextBlock('task')] }),
    new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
    new Message({ role: 'user', content: [new TextBlock('old2')] }),
    new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
    new Message({ role: 'user', content: [new TextBlock('recent')] }),
  ]

  const serverSideModel = (summarize: ReturnType<typeof vi.fn>, serverSideSummary: boolean | undefined = true) => ({
    stream: vi.fn(),
    countTokens: vi.fn(async () => 5000),
    modelInfo: { capabilities: { serverSideSummary } },
    summarize,
  })

  const texts = (messages: Message[]): string[] =>
    messages.flatMap((message) => message.content.map((block) => (block as TextBlock).text))

  const hasClientSideSummary = (messages: Message[]): boolean =>
    messages.some((message) =>
      message.content.some((block) => block instanceof TextBlock && block.text.includes('[Summarized:'))
    )

  it('replaces the opening run with the server-side summary', async () => {
    const summary = new SummaryBlock({ provider: 'anthropic', text: 'compacted' })
    const summarize = vi.fn(async (_messages: Message[]) => summary)
    const messages = openingMessages()
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, serverSideModel(summarize)))).toBe(true)

    const sent = summarize.mock.calls[0]![0]
    expect(texts(sent)).toEqual(['task', 'old1', 'old2', 'old3'])
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', content: [new TextBlock('task')] }),
      expect.objectContaining({ role: 'assistant', content: [summary] }),
      expect.objectContaining({ role: 'user', content: [new TextBlock('recent')] }),
    ])
  })

  it.each([
    {
      name: 'with summarizer instructions',
      config: { systemPrompt: 'keep ids' },
      instructions: { instructions: 'keep ids' },
    },
    { name: 'without summarizer instructions', config: {}, instructions: {} },
  ])('passes the live system prompt and tools to the server-side summary $name', async ({ config, instructions }) => {
    const toolSpec = { name: 'read', description: 'Read a file', inputSchema: { type: 'object' as const } }
    const summarize = vi.fn(async () => new SummaryBlock({ provider: 'anthropic', text: 'compacted' }))
    const model = serverSideModel(summarize)
    const messages = openingMessages()
    const agent = createMockAgent({
      messages,
      toolRegistry: { list: () => [{ toolSpec }] } as unknown as ToolRegistry,
      extra: { model, systemPrompt: 'be terse' } as unknown as Partial<Agent>,
    })
    const strategy = Offload.summarize('*', config).when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize).toHaveBeenCalledWith(expect.any(Array), {
      systemPrompt: 'be terse',
      toolSpecs: [toolSpec],
      ...instructions,
    })
  })

  it.each<{ name: string; other: Record<string, unknown> }>([
    { name: 'a different model id', other: { modelId: 'claude-opus-5-5' } },
    { name: 'a different provider', other: { constructor: class OtherModel {} } },
  ])('summarizes client-side when the agent model is $name', async ({ other }) => {
    const auxModel = { ...serverSideModel(vi.fn()), modelId: 'claude-haiku-5-5' }
    const agentModel = { ...serverSideModel(vi.fn()), modelId: 'claude-haiku-5-5', ...other }
    const messages = openingMessages()
    const agent = createMockAgent({
      messages,
      extra: { model: agentModel, auxModel } as unknown as Partial<Agent>,
    })
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(auxModel.summarize).not.toHaveBeenCalled()
    expect(hasClientSideSummary(messages)).toBe(true)
  })

  it('falls back to client-side when message 0 is pinned', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const summarize = vi.fn()
    const messages = openingMessages()
    messages[0] = new Message({
      role: 'user',
      content: [new TextBlock('task')],
      metadata: { custom: { pinned: true } },
    })
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, serverSideModel(summarize)))).toBe(true)

    expect(summarize).not.toHaveBeenCalled()
    expect(hasClientSideSummary(messages)).toBe(true)
    expect(texts(messages)[0]).toBe('task')
    warnSpy.mockRestore()
  })

  it('falls back to client-side when a pin is summarized', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const summarize = vi.fn()
    const messages = openingMessages()
    messages[2] = new Message({ role: 'user', content: [new TextBlock('pin')], metadata: { custom: { pinned: true } } })
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, serverSideModel(summarize)))).toBe(true)

    expect(summarize).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pinned=<1> | server-side summary does not support pinned messages')
    )
    expect(texts(messages)).toEqual([
      'task',
      '[Summarized: 2 messages, ~5,000 tokens]\n\nSummary of multimodal content',
      'pin',
      'recent',
    ])
    warnSpy.mockRestore()
  })

  it.each([
    { name: 'agent model unsupported', agentSupports: false, auxSupports: true },
    { name: 'aux model unsupported', agentSupports: true, auxSupports: false },
  ])('requires both models to support server-side summary: $name', async ({ agentSupports, auxSupports }) => {
    const auxModel = serverSideModel(vi.fn(), auxSupports)
    const messages = openingMessages()
    const agent = createMockAgent({
      messages,
      extra: { model: serverSideModel(vi.fn(), agentSupports), auxModel } as unknown as Partial<Agent>,
    })
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(auxModel.summarize).not.toHaveBeenCalled()
    expect(hasClientSideSummary(messages)).toBe(true)
  })

  it.each([
    { name: 'not implemented', error: new NotImplementedError('no server-side summary'), traceback: false },
    { name: 'error', error: new Error('compaction rejected'), traceback: true },
  ])('falls back to client-side: $name', async ({ error, traceback }) => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const summarize = vi.fn(async () => {
      throw error
    })
    const messages = openingMessages()
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, serverSideModel(summarize)))).toBe(true)

    expect(summarize).toHaveBeenCalledOnce()
    expect(hasClientSideSummary(messages)).toBe(true)
    const fallback = warnSpy.mock.calls.find(([message]) =>
      String(message).includes('falling back to client-side summary')
    )!
    expect(fallback[0]).toContain(`reason=<${error.name}(${error.message})>`)
    expect(fallback[0]).toContain('thinking blocks kept after it will be dropped')
    expect(fallback.length > 1).toBe(traceback)
    warnSpy.mockRestore()
  })

  it('keeps an earlier server-side summary in the client-side fallback', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(summarizeContent).mockClear()
    const summarize = vi.fn(async () => {
      throw new Error('overloaded')
    })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new SummaryBlock({ provider: 'anthropic', text: 'fact' })] }),
      new Message({ role: 'user', content: [new TextBlock('old1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old2')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const strategy = Offload.summarize('*').when({ utilization: 0.8, preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, serverSideModel(summarize)))).toBe(true)

    const sent = vi.mocked(summarizeContent).mock.calls.flatMap(([content]) => content)
    expect(sent).toContainEqual(new TextBlock('fact'))
    warnSpy.mockRestore()
  })
})
