import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { compactionSplitIndex } from '../offload/summarize.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { Message, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock, VideoBlock } from '../../../types/media.js'
import { logger } from '../../../logging/logger.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { anyTrackingId } from '../../../__fixtures__/message-helpers.js'
import type { Agent } from '../../../agent/agent.js'
import type { ToolRegistry } from '../../../registry/tool-registry.js'
import type { ContextState } from '../../types.js'
import { Model } from '../../../models/model.js'
import type { SummarizeResult } from '../../../models/summarize.js'

const baseSummarize = Model.prototype.summarize

/** Stubs the base `Model.summarize()` that block-level summaries call. */
function mockBlockSummary(): void {
  vi.spyOn(Model.prototype, 'summarize').mockResolvedValue({
    summary: new Message({ role: 'user', content: [new TextBlock('Summary of multimodal content')] }),
  })
}

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

  beforeEach(mockBlockSummary)
  afterEach(() => {
    vi.restoreAllMocks()
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
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const mainModel = { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) }
      const auxModel = { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) }
      const agent = createMockAgent({ messages, extra: { model: mainModel, auxModel } as unknown as Partial<Agent> })
      const strategy = Offload.summarize('toolResults')

      const result = await strategy.apply({ messages, agent, utilization: 0.9 })

      expect(result).toBe(true)
      expect(vi.mocked(Model.prototype.summarize).mock.contexts).toEqual([auxModel])
    })

    it('sends a block to the base summarize in its source role with the custom system prompt', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const message = new Message({ role: 'assistant', content: [new TextBlock(largeText)] })
      const strategy = Offload.summarize('assistantText', { systemPrompt: 'Keep ids' })
      const context = makeContext([message], 0.9, { stream: vi.fn() })

      expect(await strategy.apply(context)).toBe(true)
      expect(Model.prototype.summarize).toHaveBeenCalledWith(
        [new Message({ role: 'assistant', content: [new TextBlock(largeText)], trackingId: anyTrackingId })],
        { instructions: 'Keep ids', cancelSignal: context.agent.cancelSignal }
      )
    })

    it('sends a tool result after its tool call with the agent cancel signal', async () => {
      const toolUse = new ToolUseBlock({ name: 'shell', toolUseId: 'call_1', input: { command: 'ls' } })
      const result = makeToolResultMessage('x'.repeat(2500 * 4 + 100), 'call_1')
      const resultBlock = result.content[0]!
      const messages = [new Message({ role: 'assistant', content: [toolUse] }), result]
      const strategy = Offload.summarize('toolResults')
      const context = makeContext(messages, 0.9, { stream: vi.fn() })

      expect(await strategy.apply(context)).toBe(true)
      expect(Model.prototype.summarize).toHaveBeenCalledWith(
        [
          new Message({ role: 'assistant', content: [toolUse], trackingId: anyTrackingId }),
          new Message({ role: 'user', content: [resultBlock], trackingId: anyTrackingId }),
        ],
        { cancelSignal: context.agent.cancelSignal }
      )
    })

    it('sends a block to the base summarize without instructions by default', async () => {
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const message = new Message({ role: 'assistant', content: [new TextBlock(largeText)] })
      const strategy = Offload.summarize('assistantText')

      const context = makeContext([message], 0.9, { stream: vi.fn() })

      expect(await strategy.apply(context)).toBe(true)
      expect(Model.prototype.summarize).toHaveBeenCalledWith(
        [new Message({ role: 'assistant', content: [new TextBlock(largeText)], trackingId: anyTrackingId })],
        { cancelSignal: context.agent.cancelSignal }
      )
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
      const summarizer = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Summary of tool output' })
      const strategy = Offload.summarize('toolResults', { model: summarizer }).when({ utilization: 0.85 })
      const context = makeContext(messages, 0.9)

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
      vi.mocked(Model.prototype.summarize).mockImplementationOnce(baseSummarize)
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

describe('summarizer errors', () => {
  beforeEach(mockBlockSummary)
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // guards against summarizer failures being hidden by a lossy retry (#5291)
  it('keeps a block and continues the pass when its summarization fails', async () => {
    vi.mocked(Model.prototype.summarize).mockRejectedValueOnce(new Error('rejected'))
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
    expect(Model.prototype.summarize).not.toHaveBeenCalled()
  })

  it('offloads a media block when its summarization fails', async () => {
    vi.mocked(Model.prototype.summarize).mockRejectedValueOnce(new Error('images unsupported'))
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
    const summarizer = new MockMessageModel()
    for (let index = 0; index < 30; index++) summarizer.addTurn({ type: 'textBlock', text: 'Summary' })
    const strategy = Offload.summarize('*', { model: summarizer }).when({
      utilization: 0.7,
      preserveRecent: 4,
    })
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
      await strategy.apply(makeContext(messages, 0.9))
    }
    expect(messages[0]!.content).toEqual(task().content)
    expect(messages[0]!.metadata).toEqual(task().metadata)
    const summaries = messages
      .flatMap((message) => message.content)
      .filter((block) => block instanceof TextBlock && block.text.startsWith('[Summarized:'))
    expect(summaries).toHaveLength(1)
  })
})

describe('base summarize', () => {
  it('summarizes the messages after message 0, keeping it verbatim', async () => {
    const summarizer = new MockMessageModel().addTurn({ type: 'textBlock', text: 'summary' })
    const strategy = Offload.summarize('*', { model: summarizer }).when({ utilization: 0.5, preserveRecent: 2 })
    const text = (role: 'user' | 'assistant', value: string): Message =>
      new Message({ role, content: [new TextBlock(value)] })
    const messages = [text('user', 'task'), text('assistant', 'a1'), text('user', 'u2')]
    messages.push(text('assistant', 'a3'), text('user', 'u4'))

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)
    expect(messages).toHaveLength(3)
    expect(messages[0]!.content).toEqual([new TextBlock('task')])
    expect(messages[1]!.content[0]).toEqual(new TextBlock('a3'))
    expect((messages[1]!.content[1] as TextBlock).text).toMatch(/^\[Summarized: 2 messages,/)
    expect(messages[2]!.content).toEqual([new TextBlock('u4')])
  })

  it('skips the pass when the one message left after message 0 holds a summary', async () => {
    // The message left after message 0 opens with an earlier pass's summary, so re-summarizing it frees nothing.
    const summarizer = new MockMessageModel().addTurn({ type: 'textBlock', text: 'summary' })
    const strategy = Offload.summarize('*', { model: summarizer }).when({ utilization: 0.5, preserveRecent: 2 })
    const text = (role: 'user' | 'assistant', value: string): Message =>
      new Message({ role, content: [new TextBlock(value)] })
    const pinned = new Message({
      role: 'assistant',
      content: [new TextBlock('a1')],
      metadata: { custom: { pinned: true } },
    })
    const carrier = new Message({
      role: 'user',
      content: [new TextBlock('[Summarized: 3 messages, ~5,000 tokens]\n\nsummary'), new TextBlock('u2')],
    })
    const messages = [text('user', 'task'), pinned, carrier, text('assistant', 'a3'), text('user', 'u4')]
    const original = [...messages]

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(false)
    expect(messages).toEqual(original)
  })

  it('summarizes the one message left after message 0', async () => {
    // A large message right after the task is summarized alone; only an earlier summary is not.
    const summarizer = new MockMessageModel().addTurn({ type: 'textBlock', text: 'summary' })
    const strategy = Offload.summarize('*', { model: summarizer }).when({ utilization: 0.5, preserveRecent: 3 })
    const text = (role: 'user' | 'assistant', value: string): Message =>
      new Message({ role, content: [new TextBlock(value)] })
    const messages = [text('user', 'task'), text('assistant', 'x'.repeat(20000)), text('user', 'u2')]
    messages.push(text('assistant', 'a3'), text('user', 'u4'))
    const original = [...messages]

    expect(await strategy.apply(makeContext(messages, 0.9))).toBe(true)
    expect(messages[0]).toBe(original[0])
    expect(messages[1]!.role).toBe('assistant')
    expect((messages[1]!.content[0] as TextBlock).text).toMatch(/^\[Summarized: 1 messages,/)
    expect(messages.slice(2)).toEqual(original.slice(2))
  })
})

describe('routing through Model.summarize', () => {
  const text = (role: 'user' | 'assistant', value: string): Message =>
    new Message({ role, content: [new TextBlock(value)] })
  const largeResult = (toolUseId: string): Message => makeToolResultMessage('x'.repeat(2500 * 4 + 100), toolUseId)
  const toolSpec = { name: 'read', description: 'Read a file', inputSchema: { type: 'object' as const } }

  function makeRoutingContext(messages: Message[], utilization: number, model: MockMessageModel): ContextState {
    const agent = createMockAgent({
      messages,
      toolRegistry: { list: () => [{ toolSpec }] } as unknown as ToolRegistry,
      extra: { model, systemPrompt: 'live system prompt' } as Partial<Agent>,
    })
    return { messages, agent, utilization, invocationContext: new InvocationContextImpl({}) }
  }

  function makeHistory(): Message[] {
    return [
      text('user', 'task'),
      text('assistant', 'a'),
      largeResult('tool-1'),
      text('assistant', 'b'),
      largeResult('tool-2'),
      text('assistant', 'c'),
      text('user', 'latest'),
    ]
  }

  const toolUse = (id: string): Message =>
    new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId: id, name: 'read', input: {} })] })
  const summary = text('user', 'summary')
  /** The summary block placed for `count` messages, which `mockSummarize` counts as 5,000 tokens. */
  const marked = (count: number): TextBlock =>
    new TextBlock(`[Summarized: ${count} messages, ~5,000 tokens]\n\nsummary`)
  const markedSummary = (count: number): Message =>
    new Message({ role: 'user', content: [marked(count)], trackingId: anyTrackingId })
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Mocks both the model's own `summarize()` and the base implementation, recording what either receives. */
  function mockSummarize(model: MockMessageModel, result: SummarizeResult = { summary, usage }): Message[][] {
    const received: Message[][] = []
    const record = async (messages: Message[]): Promise<SummarizeResult> => {
      received.push([...messages])
      return result
    }
    vi.spyOn(model, 'summarize').mockImplementation(record)
    vi.spyOn(Model.prototype, 'summarize').mockImplementation(record)
    vi.spyOn(model, 'countTokens').mockResolvedValue(5000)
    return received
  }

  it('sends a whole-history message-level summary through summarize with the live prompt, tools, and instructions', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model, systemPrompt: 'Keep ids' }).when({
      utilization: 0.7,
      preserveRecent: 2,
    })
    const messages = makeHistory()
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.5, model))).toBe(false)
    expect(received).toEqual([])

    const context = makeRoutingContext(messages, 0.5, model)
    context.overflow = true
    expect(await strategy.apply(context)).toBe(true)
    expect(received).toEqual([original.slice(0, 5)])
    expect(Model.prototype.summarize).not.toHaveBeenCalled()
    expect(model.summarize).toHaveBeenCalledWith(original.slice(0, 5), {
      systemPrompt: 'live system prompt',
      toolSpecs: [toolSpec],
      instructions: 'Keep ids',
      cancelSignal: context.agent.cancelSignal,
    })
    expect(messages).toEqual([markedSummary(5), ...original.slice(5)])
  })

  it('records the compaction usage on the invocation context', async () => {
    const model = new MockMessageModel()
    mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const context = makeRoutingContext(makeHistory(), 0.9, model)

    expect(await strategy.apply(context)).toBe(true)
    expect((context.invocationContext as InvocationContextImpl).usage).toEqual({ turnsTaken: 0, ...usage })
  })

  it('records no usage when the provider reports none', async () => {
    const model = new MockMessageModel()
    mockSummarize(model, { summary })
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const context = makeRoutingContext(makeHistory(), 0.9, model)

    expect(await strategy.apply(context)).toBe(true)
    expect((context.invocationContext as InvocationContextImpl).usage).toEqual({
      turnsTaken: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    })
  })

  it('marks a text summary with the summarized messages and their token count', async () => {
    const model = new MockMessageModel()
    const content = [new TextBlock('first'), new TextBlock('second')]
    mockSummarize(model, { summary: new Message({ role: 'user', content }) })
    vi.mocked(model.countTokens).mockResolvedValue(1234)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const messages = makeHistory()
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(model.countTokens).toHaveBeenCalledWith(original.slice(0, 5))
    expect(messages).toEqual([
      new Message({
        role: 'user',
        content: [new TextBlock('[Summarized: 5 messages, ~1,234 tokens]\n\nfirst\nsecond')],
        trackingId: anyTrackingId,
      }),
      ...original.slice(5),
    ])
  })

  it('places a summary with non-text content unchanged', async () => {
    const model = new MockMessageModel()
    const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })
    const placed = new Message({ role: 'user', content: [new TextBlock('summary'), image] })
    mockSummarize(model, { summary: placed })
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const messages = makeHistory()
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(model.countTokens).not.toHaveBeenCalled()
    expect(messages).toEqual([placed, ...original.slice(5)])
  })

  it('moves a cut on a tool pair forward', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const toolUse = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: 'tool-1', name: 'read', input: {} })],
    })
    const messages = [
      text('user', 'task'),
      text('assistant', 'a'),
      text('user', 'b'),
      toolUse,
      largeResult('tool-1'),
      text('assistant', 'c'),
      text('user', 'latest'),
    ]
    const original = [...messages]
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 3 })

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(0, 5)])
    expect(messages).toEqual([markedSummary(5), ...original.slice(5)])
  })

  it('merges same-role messages at the join', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const messages = makeHistory()
    const original = [...messages]
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 1 })

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(0, 5)])
    expect(messages).toEqual([
      new Message({ role: 'user', content: [marked(5)], trackingId: anyTrackingId }),
      ...original.slice(5),
    ])
  })

  it('leaves the history unchanged and warns when summarize writes no summary', async () => {
    const model = new MockMessageModel()
    mockSummarize(model, { summary: new Message({ role: 'user', content: [] }), usage })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7 })
    const messages = makeHistory()
    const original = [...messages]
    const context = makeRoutingContext(messages, 0.9, model)

    expect(await strategy.apply(context)).toBe(false)
    expect(messages).toEqual(original)
    expect((context.invocationContext as InvocationContextImpl).usage).toEqual({ turnsTaken: 0, ...usage })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('model summarize returned no summary'))
    warnSpy.mockRestore()
  })

  it('sends a prefix opening with an assistant turn through the base summarize', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const messages = makeHistory().slice(1)
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(1, 4)])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(vi.mocked(Model.prototype.summarize).mock.contexts).toEqual([model])
    expect(messages).toEqual([original[0], markedSummary(3), ...original.slice(4)])
  })

  it('skips a pass whose only summary would join the last message', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const messages = [text('user', 'task'), text('assistant', 'a1'), text('user', 'latest')]
    const original = [...messages]
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7 })

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(false)
    expect(received).toEqual([])
    expect(messages).toEqual(original)
  })

  it('keeps the summary out of a pinned assistant message so the next pass summarizes it', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5 })
    const pinned = { custom: { pinned: true } }
    const task = new Message({ role: 'user', content: [new TextBlock('task')], metadata: pinned })
    const ack = new Message({ role: 'assistant', content: [new TextBlock('ack')], metadata: pinned })
    const messages = [task, ack, text('user', 'u2'), text('assistant', 'a3'), text('user', 'u4')]
    messages.push(text('assistant', 'a5'), text('user', 'u6'))

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    messages.push(text('assistant', 'a7'), text('user', 'u8'))
    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)

    expect(received[1]!.map((message) => message.content)).toEqual([
      [marked(3)],
      [new TextBlock('a5')],
      [new TextBlock('u6')],
    ])
    expect(messages.map((message) => message.content)).toEqual([
      [new TextBlock('task')],
      [new TextBlock('ack')],
      [marked(3)],
      [new TextBlock('a7')],
      [new TextBlock('u8')],
    ])
  })

  it('places the summary at a later gap when the first lies between pinned messages', async () => {
    const model = new MockMessageModel()
    mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 1 })
    const pinned = { custom: { pinned: true } }
    const task = new Message({ role: 'user', content: [new TextBlock('task')], metadata: pinned })
    const ack = new Message({ role: 'assistant', content: [new TextBlock('ack')], metadata: pinned })
    const note = new Message({ role: 'user', content: [new TextBlock('note')], metadata: pinned })
    const latest = text('user', 'u8')
    const messages = [
      task,
      ack,
      text('user', 'u2'),
      text('assistant', 'a3'),
      note,
      text('assistant', 'a5'),
      text('user', 'u6'),
      text('assistant', 'a7'),
      latest,
    ]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(messages).toEqual([
      task,
      ack,
      note,
      new Message({ role: 'assistant', content: [new TextBlock('a7'), marked(4)], trackingId: anyTrackingId }),
      latest,
    ])
  })

  it('skips the pass when every gap lies between pinned messages of both roles', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })
    const pinned = { custom: { pinned: true } }
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')], metadata: pinned }),
      text('assistant', 'a1'),
      text('user', 'u2'),
      new Message({ role: 'assistant', content: [new TextBlock('answer')], metadata: pinned }),
      text('user', 'u4'),
    ]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(false)
    expect(received).toEqual([])
    expect(messages).toEqual(original)
  })

  it('keeps a run whose removal would join pinned messages', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5 })
    const pinned = { custom: { pinned: true } }
    const first = new Message({ role: 'assistant', content: [new TextBlock('a1')], metadata: pinned })
    const second = new Message({ role: 'assistant', content: [new TextBlock('a3')], metadata: pinned })
    const messages = [text('user', 'u0'), first, text('user', 'u2'), second, text('user', 'u4')]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([[original[0]]])
    expect(messages).toEqual([markedSummary(1), ...original.slice(1)])
  })

  it('keeps a targeted run whose removal would join a pinned message', async () => {
    const model = new MockMessageModel()
    mockSummarize(model)
    const strategy = Offload.summarize('userText', { model }).when({ utilization: 0.5 })
    const pinned = new Message({
      role: 'assistant',
      content: [new TextBlock('a5')],
      metadata: { custom: { pinned: true } },
    })
    const messages = [
      text('user', 'u0'),
      text('assistant', 'a1'),
      text('user', 'u2'),
      text('assistant', 'a3'),
      text('user', 'u4'),
      pinned,
      text('user', 'u6'),
    ]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(messages.slice(-3)).toEqual(original.slice(4))
  })

  it('leaves a lone pinned tool result unsummarized', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5 })
    const result = makeToolResultMessage('ok')
    const messages = [new Message({ role: 'user', content: result.content, metadata: { custom: { pinned: true } } })]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(false)
    expect(received).toEqual([])
    expect(messages).toEqual(original)
  })

  it('keeps message 0 when the only slot before it lies before a pinned user message', async () => {
    // Summarized with the rest, the task would leave a user-role summary that joins the pinned prompt.
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })
    const prompt = new Message({
      role: 'user',
      content: [new TextBlock('now add tests')],
      metadata: { custom: { pinned: true } },
    })
    const messages = [text('user', 'task'), toolUse('t1'), makeToolResultMessage('x', 't1'), toolUse('t2')]
    messages.push(makeToolResultMessage('x', 't2'), text('assistant', 'done'), prompt, text('assistant', 'ok'))
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(1, 6)])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(messages).toEqual([
      original[0],
      new Message({ role: 'assistant', content: [marked(5)], trackingId: anyTrackingId }),
      prompt,
      original[7],
    ])
  })

  it('skips the pass when the only message after message 0 is an earlier summary', async () => {
    // The second pass has only the first pass's summary left to summarize, which frees nothing.
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })
    const prompt = new Message({
      role: 'user',
      content: [new TextBlock('now add tests')],
      metadata: { custom: { pinned: true } },
    })
    const messages = [text('user', 'task'), toolUse('t1'), makeToolResultMessage('x', 't1'), toolUse('t2')]
    messages.push(makeToolResultMessage('x', 't2'), text('assistant', 'done'), prompt, text('assistant', 'ok'))
    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    const compacted = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(false)
    expect(received).toHaveLength(1)
    expect(messages).toEqual(compacted)
  })

  it('skips the pass when only an earlier summary can be removed', async () => {
    // Removing u2 would join the pinned a1 and a3, so only the summary at message 0 is left to summarize.
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })
    const pinned = new Message({
      role: 'assistant',
      content: [new TextBlock('a1')],
      metadata: { custom: { pinned: true } },
    })
    const messages = [new Message({ role: 'user', content: [marked(3)] }), pinned, text('user', 'u2')]
    messages.push(text('assistant', 'a3'), text('user', 'recent'))
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(false)
    expect(received).toHaveLength(0)
    expect(messages).toEqual(original)
  })

  it('summarizes the messages after a pinned task into assistant content behind it', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.8 })
    const task = new Message({ role: 'user', content: [new TextBlock('task')], metadata: { custom: { pinned: true } } })
    const messages = [
      task,
      text('assistant', 'old1'),
      text('user', 'old2'),
      text('assistant', 'old3'),
      text('user', 'recent'),
    ]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(1, 3)])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(vi.mocked(Model.prototype.summarize).mock.contexts).toEqual([model])
    expect(messages).toEqual([
      task,
      new Message({ role: 'assistant', content: [new TextBlock('old3'), marked(2)], trackingId: anyTrackingId }),
      original[4],
    ])
  })

  it('leaves a pinned message before the cut out of the summary', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const messages = makeHistory()
    const pinned = makeToolResultMessage('x'.repeat(2500 * 4 + 100), 'tool-1')
    pinned.metadata = { custom: { pinned: true } }
    messages[2] = pinned
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([[original[1], original[3], original[4]]])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(messages).toEqual([
      original[0],
      new Message({ role: 'assistant', content: [marked(3)], trackingId: anyTrackingId }),
      pinned,
      ...original.slice(5),
    ])
  })

  it('passes no instruction without a custom system prompt', async () => {
    const model = new MockMessageModel()
    mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })

    const context = makeRoutingContext(makeHistory(), 0.9, model)

    expect(await strategy.apply(context)).toBe(true)
    expect(model.summarize).toHaveBeenCalledWith(expect.anything(), {
      systemPrompt: 'live system prompt',
      toolSpecs: [toolSpec],
      cancelSignal: context.agent.cancelSignal,
    })
  })

  it('makes a second pass over the compacted history a no-op', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const messages = Array.from({ length: 9 }, (_, index) => text(index % 2 === 0 ? 'user' : 'assistant', `m${index}`))
    const original = [...messages]
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 4 })

    const acted = []
    for (let pass = 0; pass < 3; pass++) acted.push(await strategy.apply(makeRoutingContext(messages, 0.9, model)))

    expect(acted).toEqual([true, false, false])
    expect(received).toHaveLength(1)
    expect(messages).toEqual([markedSummary(5), ...original.slice(5)])
  })

  it('keeps the message before a pinned last message so the summary does not end the history', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 1 })
    const messages = makeHistory()
    messages[6] = new Message({
      role: 'user',
      content: [new TextBlock('latest')],
      metadata: { custom: { pinned: true } },
    })
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([original.slice(0, 5)])
    expect(messages).toEqual([markedSummary(5), ...original.slice(5)])
  })

  it('sends a target-filtered summary through the base summarize with the selected tool pairs', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('toolResults', { model }).when({ utilization: 0.7 })
    const messages = [
      text('user', 'task'),
      toolUse('t1'),
      largeResult('t1'),
      text('assistant', 'a'),
      text('user', 'u'),
      toolUse('t2'),
      largeResult('t2'),
      text('assistant', 'b'),
      text('user', 'latest'),
    ]
    const original = [...messages]

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    expect(received).toEqual([[...original.slice(1, 3), ...original.slice(5, 7)]])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(messages).toEqual([
      original[0],
      new Message({ role: 'assistant', content: [new TextBlock('a'), marked(4)], trackingId: original[3]!.trackingId }),
      original[4],
      original[7],
      original[8],
    ])
  })

  it('sends a threshold summary of the oversized messages through the base summarize', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    // The threshold selects by real per-message counts.
    vi.mocked(model.countTokens).mockRestore()
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, threshold: 10 })
    const messages = makeHistory()
    const original = [...messages]
    const tokens = await model.countTokens([original[2]!])

    expect(await strategy.apply(makeRoutingContext(messages, 0.9, model))).toBe(true)
    // Removing the second result would merge the kept messages around it, so it waits for a later pass.
    expect(received).toEqual([[original[2]]])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(messages).toEqual([
      original[0],
      original[1],
      new Message({
        role: 'user',
        content: [new TextBlock(`[Summarized: 1 messages, ~${tokens.toLocaleString('en-US')} tokens]\n\nsummary`)],
        trackingId: anyTrackingId,
      }),
      ...original.slice(3),
    ])
  })

  // guards against tool calls being dropped from or split from their results in the summary request (#5291)
  it('sends tool calls with their results and the live tools to summarize', async () => {
    const model = new MockMessageModel()
    const received = mockSummarize(model)
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.7, preserveRecent: 2 })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('fix the build')], metadata: { custom: { pinned: true } } }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'shell', toolUseId: 'call_1', input: { command: 'ls' } })],
      }),
      makeToolResultMessage('a.ts b.ts', 'call_1'),
      text('assistant', 'done'),
      text('user', 'next'),
    ]
    const original = [...messages]

    const context = makeRoutingContext(messages, 0.9, model)

    expect(await strategy.apply(context)).toBe(true)
    expect(received).toEqual([[original[1], original[2]]])
    expect(model.summarize).not.toHaveBeenCalled()
    expect(Model.prototype.summarize).toHaveBeenCalledWith(expect.anything(), {
      systemPrompt: 'live system prompt',
      toolSpecs: [toolSpec],
      cancelSignal: context.agent.cancelSignal,
    })
  })
})

describe('summary placement', () => {
  const text = (role: 'user' | 'assistant', value: string, trackingId?: string): Message =>
    new Message({ role, content: [new TextBlock(value)], ...(trackingId && { trackingId }) })
  const pinned = { custom: { pinned: true } }
  const redacted = new ReasoningBlock({ redactedContent: new Uint8Array([120]) })
  const marked = (count: number): TextBlock =>
    new TextBlock(`[Summarized: ${count} messages, ~5,000 tokens]\n\nsummary`)

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeContext(messages: Message[], model: MockMessageModel, result: SummarizeResult): ContextState {
    vi.spyOn(model, 'summarize').mockResolvedValue(result)
    vi.spyOn(Model.prototype, 'summarize').mockResolvedValue(result)
    vi.spyOn(model, 'countTokens').mockResolvedValue(5000)
    const agent = createMockAgent({ messages, extra: { model } as Partial<Agent> })
    return { messages, agent, utilization: 0.9 }
  }

  const history = (): Message[] => [
    text('user', 'u0'),
    text('assistant', 'a1'),
    text('user', 'u2'),
    text('assistant', 'a3'),
    text('user', 'u4'),
  ]

  it('places an override compaction block verbatim as its own message with its own role', async () => {
    const model = new MockMessageModel()
    const summary = new Message({ role: 'assistant', content: [redacted] })
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })
    const messages = history()
    const original = [...messages]

    expect(await strategy.apply(makeContext(messages, model, { summary }))).toBe(true)
    expect(messages).toEqual([summary, ...original.slice(2)])
  })

  it('warns and keeps the history when an override compaction block does not alternate', async () => {
    const model = new MockMessageModel()
    const summary = new Message({ role: 'assistant', content: [redacted] })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })
    const messages = history()
    const original = [...messages]

    expect(await strategy.apply(makeContext(messages, model, { summary }))).toBe(false)
    expect(messages).toEqual(original)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('summary does not alternate with the kept messages'))
  })

  it('keeps the summary out of a tool result whose tool use is pinned', async () => {
    const model = new MockMessageModel()
    const summary = text('user', 'summary')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5 })
    const task = new Message({ role: 'user', content: [new TextBlock('task')], metadata: pinned })
    const toolUse = new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId: 't1', name: 'read', input: {} })],
      metadata: pinned,
    })
    const toolResult = makeToolResultMessage('ok', 't1')
    const messages = [task, toolUse, toolResult, text('assistant', 'a3'), text('user', 'u4')]
    messages.push(text('assistant', 'a5'), text('user', 'u6'))
    const context = makeContext(messages, model, { summary })

    expect(await strategy.apply(context)).toBe(true)
    messages.push(text('assistant', 'a7'), text('user', 'u8'))
    expect(await strategy.apply(context)).toBe(true)

    expect(messages).toEqual([
      task,
      toolUse,
      toolResult,
      new Message({ role: 'assistant', content: [new TextBlock('a7'), marked(2)], trackingId: anyTrackingId }),
      new Message({ role: 'user', content: [new TextBlock('u8')], trackingId: anyTrackingId }),
    ])
    expect(messages[2]!.content).toEqual(makeToolResultMessage('ok', 't1').content)
  })

  it('opens the kept message with a leading summary so its stash refs still resolve', async () => {
    const model = new MockMessageModel()
    const summary = text('user', 'summary')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })
    const metadata = { custom: { source: 'upload' } }
    const big = new Message({ role: 'user', content: [new TextBlock('x'.repeat(10000))], trackingId: 'id2', metadata })
    const messages = [text('user', 'u0', 'id0'), text('assistant', 'a1', 'id1'), big]
    messages.push(text('assistant', 'a3', 'id3'), text('user', 'u4', 'id4'))
    const kept = messages.slice(2)

    expect(await strategy.apply(makeContext(messages, model, { summary }))).toBe(true)
    const carrier = messages[0]!
    expect(carrier.content).toEqual([marked(2), ...big.content])
    expect(carrier.trackingId).toBe('id2')
    expect(carrier.metadata?.custom).toMatchObject({
      source: 'upload',
      mergedMessages: [{ offset: 0 }, { trackingId: 'id2', offset: 1, metadata }],
    })
    expect(messages.slice(1)).toEqual(kept.slice(1))
  })

  it('places a summary between two same-role messages on its own', async () => {
    const model = new MockMessageModel()
    const summary = text('user', 'summary')
    const strategy = Offload.summarize('assistantText', { model }).when({ utilization: 0.5, threshold: 50 })
    const question = new Message({
      role: 'user',
      content: [new TextBlock('q2')],
      trackingId: 'id2',
      metadata: { custom: { tag: 'x' } },
    })
    const latest = text('user', 'latest', 'id4')
    const messages = [
      text('user', 'task'),
      text('assistant', 'ok'),
      question,
      text('assistant', 'a'.repeat(400)),
      latest,
    ]
    const original = [...messages]
    const context = makeContext(messages, model, { summary })
    vi.mocked(model.countTokens).mockImplementation(async (counted: Message[]) =>
      counted.reduce(
        (total, message) =>
          total +
          message.content.reduce((sum, block) => sum + (block instanceof TextBlock ? block.text.length / 4 : 0), 0),
        0
      )
    )

    expect(await strategy.apply(context)).toBe(true)
    expect(messages.slice(0, 3)).toEqual(original.slice(0, 3))
    expect(messages[3]!.role).toBe('assistant')
    expect(messages[4]).toBe(latest)
    expect(messages).toHaveLength(5)
  })

  it('sends a prefix that does not alternate through the base summarize', async () => {
    const model = new MockMessageModel()
    const summary = text('user', 'summary')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })
    const messages = [
      text('user', 'u0'),
      text('user', 'u1'),
      text('assistant', 'a2'),
      text('user', 'u3'),
      text('assistant', 'a4'),
      text('user', 'u5'),
      text('assistant', 'a6'),
      text('user', 'u7'),
    ]

    expect(await strategy.apply(makeContext(messages, model, { summary }))).toBe(true)
    expect(model.summarize).not.toHaveBeenCalled()
    expect(Model.prototype.summarize).toHaveBeenCalledTimes(1)
  })

  it('does not re-summarize a lone earlier summary', async () => {
    const model = new MockMessageModel()
    const summary = text('user', 'summary')
    const strategy = Offload.summarize('assistantText', { model }).when({ utilization: 0.5 })
    const messages = [text('user', 'u0'), new Message({ role: 'assistant', content: [marked(3)] }), text('user', 'u2')]
    const original = [...messages]

    expect(await strategy.apply(makeContext(messages, model, { summary }))).toBe(false)
    expect(messages).toEqual(original)
    expect(Model.prototype.summarize).not.toHaveBeenCalled()
  })
})

describe('compactionSplitIndex', () => {
  const text = (role: 'user' | 'assistant', value: string): Message =>
    new Message({ role, content: [new TextBlock(value)] })
  const toolUse = (id: string): Message =>
    new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId: id, name: 'read', input: {} })] })
  const toolResult = (id: string): Message =>
    new Message({
      role: 'user',
      content: [new ToolResultBlock({ toolUseId: id, status: 'success', content: [new TextBlock('ok')] })],
    })

  it('keeps a count or ratio of trailing messages and never cuts past the last message', () => {
    const messages = [
      text('user', 'a'),
      text('assistant', 'b'),
      text('user', 'c'),
      text('assistant', 'd'),
      text('user', 'e'),
    ]

    expect(compactionSplitIndex(messages, 2)).toBe(3)
    expect(compactionSplitIndex(messages, 0.5)).toBe(2)
    expect(compactionSplitIndex(messages, 0)).toBe(4)
    expect(compactionSplitIndex(messages, 5)).toBe(0)
    expect(compactionSplitIndex(messages, 9)).toBe(0)
    expect(compactionSplitIndex(messages, 4)).toBe(0)
    expect(compactionSplitIndex([], 0)).toBe(0)
    expect(compactionSplitIndex(messages.slice(0, 1), 0)).toBe(0)
    expect(compactionSplitIndex(messages.slice(0, 2), 0)).toBe(0)
    expect(compactionSplitIndex(messages.slice(0, 3), 0)).toBe(2)
  })

  it('moves the cut forward so a toolUse stays with its toolResult, or back when the toolResult is last', () => {
    const messages = [text('user', 'task'), toolUse('a'), toolResult('a'), toolUse('b'), toolResult('b')]

    expect(compactionSplitIndex(messages, 2)).toBe(3)
    expect(compactionSplitIndex(messages, 3)).toBe(3)
    expect(compactionSplitIndex(messages, 0)).toBe(3)
  })

  it('does not cut when moving the cut back off a tool pair leaves one message', () => {
    expect(compactionSplitIndex([text('user', 'task'), toolUse('a'), toolResult('a')], 0)).toBe(0)
  })
})
