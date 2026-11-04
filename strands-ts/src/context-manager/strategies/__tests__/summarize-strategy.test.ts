import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { warnOnServerSideSummaryLimits } from '../offload/summarize.js'
import { flattenMessagesToContent } from '../../../models/summarize.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import { ImageBlock, VideoBlock } from '../../../types/media.js'
import { logger } from '../../../logging/logger.js'
import { mergedMessages } from '../../stash.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { Agent } from '../../../agent/agent.js'
import type { ContextState } from '../../types.js'

/** Stands in for the model's summary call: receives what the summarizer reads and the model, returns the text. */
const summarizeContent = vi.fn(
  async (_content: ContentBlock[], _model: unknown): Promise<string | null> => 'Summary of multimodal content'
)

/** Adds a `summarize()` to a mock model that answers through {@link summarizeContent}. */
function withSummarize<T extends object>(model: T): T {
  const summarizing = {
    ...model,
    summarize: async (messages: Message[]) => {
      const content = messages.length === 1 ? messages[0]!.content : flattenMessagesToContent(messages)
      const text = await summarizeContent(content, summarizing)
      return { content: text ? [new TextBlock(text)] : [] }
    },
  }
  return summarizing
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
    ? withSummarize({ countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs), ...(model as object) })
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
      summarizeContent.mockClear()
      const largeText = 'x'.repeat(2500 * 4 + 100)
      const messages = [makeToolResultMessage(largeText)]
      const mainModel = { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) }
      const auxModel = withSummarize({ countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) })
      const agent = createMockAgent({ messages, extra: { model: mainModel, auxModel } as unknown as Partial<Agent> })
      const strategy = Offload.summarize('toolResults')

      const result = await strategy.apply({ messages, agent, utilization: 0.9 })

      expect(result).toBe(true)
      expect(summarizeContent).toHaveBeenCalledTimes(1)
      expect(summarizeContent.mock.calls[0]![1]).toBe(auxModel)
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
    summarizeContent.mockRejectedValueOnce(new Error('rejected'))
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
    summarizeContent.mockClear()
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
    const summarizer = new MockMessageModel()
    vi.spyOn(summarizer, 'summarize').mockRejectedValueOnce(new Error('images unsupported'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = [
      new Message({
        role: 'user',
        content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array(4000) } })],
      }),
    ]
    const strategy = Offload.summarize('*', { model: summarizer }).when({ threshold: 10 })

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

describe('summarizing whole messages', () => {
  const turns = (...values: string[]): Message[] =>
    values.map(
      (value, index) => new Message({ role: index % 2 ? 'assistant' : 'user', content: [new TextBlock(value)] })
    )

  const pinnedTurn = (role: 'user' | 'assistant', text: string): Message =>
    new Message({ role, content: [new TextBlock(text)], metadata: { custom: { pinned: true } } })

  const textsOf = (messages: Message[]): string[][] =>
    messages.map((message) => message.content.map((block) => (block as TextBlock).text))

  it('leaves a pinned message out of the summary and in place', async () => {
    summarizeContent.mockClear().mockResolvedValueOnce('run')
    const messages = turns('task', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8')
    messages[4] = pinnedTurn('user', 'm4')
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    expect(summarizeContent).toHaveBeenCalledOnce()
    const request = JSON.stringify(summarizeContent.mock.calls[0]![0])
    expect(request).toContain('m1')
    expect(request).toContain('m6')
    expect(request).not.toContain('m4')
    const texts = textsOf(messages)
    expect(texts[1]).toEqual([expect.stringMatching(/^\[Summarized: 5 messages, ~\d+ tokens\]\n\nrun$/)])
    expect(texts.slice(2)).toEqual([['m4'], ['m7'], ['m8']])
    expect(messages[2]!.metadata?.custom?.pinned).toBe(true)
  })

  it('summarizes the messages after a pinned message 1', async () => {
    summarizeContent.mockClear().mockResolvedValueOnce('run')
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    messages[1] = pinnedTurn('assistant', 'a1')
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    const texts = textsOf(messages)
    expect(texts[1]).toEqual(['a1', expect.stringMatching(/^\[Summarized: 3 messages, ~\d+ tokens\]\n\nrun$/), 'a5'])
    expect(texts.slice(2)).toEqual([['u6']])
    expect(messages[1]!.metadata?.custom?.pinned).toBe(true)
  })

  it('keeps a pinned message after the summary of its run', async () => {
    summarizeContent.mockClear().mockResolvedValueOnce('run')
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6', 'a7', 'u8')
    messages[3] = new Message({
      role: 'assistant',
      content: [new TextBlock('a3')],
      metadata: { custom: { pinned: true } },
    })
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    expect(summarizeContent).toHaveBeenCalledOnce()
    const texts = messages.map((message) => message.content.map((block) => (block as TextBlock).text))
    expect(texts[0]).toEqual(['task'])
    expect(texts[1]).toEqual([expect.stringMatching(/^\[Summarized: 4 messages, ~\d+ tokens\]\n\nrun$/), 'a3'])
    expect(texts.slice(2)).toEqual([['u6'], ['a7'], ['u8']])
    expect(messages[1]!.metadata?.custom?.pinned).toBe(true)
  })

  it('places the summary ahead of the assistant message after a run ending on a user turn', async () => {
    summarizeContent.mockClear().mockResolvedValueOnce('run')
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const a3 = new Message({
      role: 'assistant',
      content: [new TextBlock('a3')],
      metadata: { custom: { source: 'planner' } },
    })
    messages[3] = a3
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 4 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    const texts = messages.map((message) => message.content.map((block) => (block as TextBlock).text))
    expect(texts).toEqual([
      ['task'],
      [expect.stringMatching(/^\[Summarized: 2 messages, ~\d+ tokens\]\n\nrun$/), 'a3'],
      ['u4'],
      ['a5'],
      ['u6'],
    ])
    expect(mergedMessages(messages[1]!).find((part) => part.trackingId === a3.trackingId)?.offset).toBe(1)
    expect(messages[1]!.trackingId).toBe(a3.trackingId)
    expect(messages[1]!.metadata?.custom?.source).toBe('planner')
  })

  it('keeps the tool result of a pinned tool use', async () => {
    summarizeContent.mockClear().mockResolvedValueOnce('run')
    const toolUse = new ToolUseBlock({ name: 'lookup', toolUseId: 't1', input: {} })
    const toolResult = makeToolResultMessage('r1', 't1')
    const messages = [
      ...turns('task', 'a1', 'u2'),
      new Message({ role: 'assistant', content: [toolUse], metadata: { custom: { pinned: true } } }),
      toolResult,
      new Message({ role: 'assistant', content: [new TextBlock('a5')] }),
      new Message({ role: 'user', content: [new TextBlock('u6')] }),
    ]
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(messages[1]!.content[1]).toBe(toolUse)
    expect(messages[2]!.content).toEqual(toolResult.content)
  })

  it('does not summarize a run holding only an earlier summary', async () => {
    summarizeContent.mockClear()
    const messages = turns('task', '[Summarized: 3 messages, ~10 tokens]\n\nold', 'u2', 'a3', 'u4')
    const strategy = Offload.summarize('*').when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(false)

    expect(summarizeContent).not.toHaveBeenCalled()
  })
})

describe('server-side summary', () => {
  const COMPACTION = { provider: 'test', signature: 'opaque' }

  /** A model with server-side summaries whose override returns a server-side summary. */
  function summarizingModel(): MockMessageModel {
    const model = new MockMessageModel()
    model.updateConfig({ modelInfo: { capabilities: { serverSideSummary: true } } })
    vi.spyOn(model, 'summarize').mockResolvedValue({
      content: [new TextBlock('compacted', { metadata: { serverSideSummary: COMPACTION } })],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    })
    return model
  }

  /** A context whose agent model also declares server-side summaries, so it sends the stored block natively. */
  const nativeContext = (messages: Message[]): ContextState =>
    makeContext(messages, 0.9, { stream: vi.fn(), modelInfo: { capabilities: { serverSideSummary: true } } })

  const turns = (...values: string[]): Message[] =>
    values.map(
      (value, index) => new Message({ role: index % 2 ? 'assistant' : 'user', content: [new TextBlock(value)] })
    )

  it('compacts the opening run from message 0, keeping message 0 and placing the summary as its own message', async () => {
    const model = summarizingModel()
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const [task, a1, u2, a3] = messages
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })
    const invocationContext = new InvocationContextImpl({})

    expect(await strategy.apply({ ...nativeContext(messages), invocationContext })).toBe(true)

    expect(model.summarize).toHaveBeenCalledOnce()
    expect(vi.mocked(model.summarize).mock.calls[0]![0]).toEqual([task, a1, u2, a3])
    expect(vi.mocked(model.summarize).mock.calls[0]![1]).toEqual(
      expect.objectContaining({ toolSpecs: expect.any(Array), cancelSignal: expect.any(AbortSignal) })
    )
    expect(messages[0]).toBe(task)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    const tokens = heuristicCountTokens([a1!, u2!, a3!])
    expect(messages[1]!.content).toEqual([
      new TextBlock(`[Summarized: 3 messages, ~${tokens} tokens]\n\ncompacted`, {
        metadata: { serverSideSummary: COMPACTION },
      }),
    ])
    expect(invocationContext.usage).toEqual(expect.objectContaining({ inputTokens: 3, outputTokens: 4 }))
  })

  it('keeps the first server-side summary verbatim', async () => {
    const model = summarizingModel()
    vi.mocked(model.summarize).mockResolvedValueOnce({
      content: [
        new TextBlock('plain'),
        new TextBlock('  compacted\n', { metadata: { serverSideSummary: COMPACTION } }),
        new TextBlock('more', { metadata: { serverSideSummary: { provider: 'other' } } }),
      ],
    })
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const [, a1, u2, a3] = messages
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    const tokens = heuristicCountTokens([a1!, u2!, a3!])
    expect(messages[1]!.content).toStrictEqual([
      new TextBlock(`[Summarized: 3 messages, ~${tokens} tokens]\n\n  compacted\n`, {
        metadata: { serverSideSummary: COMPACTION },
      }),
    ])
  })

  it('compacts a run that ends on a tool result, placing the summary ahead of the next assistant message', async () => {
    const model = summarizingModel()
    const messages = [
      ...turns('task'),
      new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'read', toolUseId: 't1', input: {} })] }),
      makeToolResultMessage('one', 't1'),
      new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'read', toolUseId: 't2', input: {} })] }),
      makeToolResultMessage('two', 't2'),
    ]
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(model.summarize).toHaveBeenCalledOnce()
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user'])
    const [summary, toolUse] = messages[1]!.content
    expect((summary as TextBlock).metadata?.serverSideSummary).toEqual(COMPACTION)
    expect(toolUse).toBeInstanceOf(ToolUseBlock)
  })

  const pinned = (role: 'user' | 'assistant', text: string): Message =>
    new Message({ role, content: [new TextBlock(text)], metadata: { custom: { pinned: true } } })

  const textsOf = (messages: Message[]): string[][] =>
    messages.map((message) => message.content.map((block) => (block as TextBlock).text))

  it('keeps pinned messages after the server-side summary', async () => {
    const model = summarizingModel()
    const messages = turns('task', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8')
    const m4 = pinned('user', 'm4')
    messages[4] = m4
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    const sent = vi.mocked(model.summarize).mock.calls[0]![0]
    expect(textsOf(sent)).toEqual([['task'], ['m1'], ['m2'], ['m3'], ['m4'], ['m5'], ['m6']])
    expect(textsOf(messages.slice(1, 2))).toEqual([
      [expect.stringMatching(/^\[Summarized: 5 messages, ~\d+ tokens\]\n\ncompacted$/)],
    ])
    expect((messages[1]!.content[0] as TextBlock).metadata?.serverSideSummary).toEqual(COMPACTION)
    expect(messages[2]).toBe(m4)
    expect(textsOf(messages.slice(3))).toEqual([['m7'], ['m8']])
  })

  it('summarizes server-side when message 1 is pinned', async () => {
    const model = summarizingModel()
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    messages[1] = pinned('assistant', 'a1')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    const texts = textsOf(messages)
    expect(texts[1]).toEqual([expect.stringMatching(/^\[Summarized: 2 messages, ~\d+ tokens\]\n\ncompacted$/), 'a1'])
    expect(texts.slice(2)).toEqual([['u4'], ['a5'], ['u6']])
    expect((messages[1]!.content[0] as TextBlock).metadata?.serverSideSummary).toEqual(COMPACTION)
    expect(messages[1]!.metadata?.custom?.pinned).toBe(true)
  })

  it('keeps a pinned message without the earlier summary merged into it', async () => {
    const model = summarizingModel()
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    messages[1] = pinned('assistant', 'a1')
    await Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 }).apply(nativeContext(messages))
    messages.push(
      new Message({ role: 'assistant', content: [new TextBlock('a7')] }),
      new Message({ role: 'user', content: [new TextBlock('u8')] })
    )
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 2 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(model.summarize).toHaveBeenCalledTimes(2)
    const texts = textsOf(messages)
    expect(texts[1]).toEqual([
      expect.stringMatching(/^\[Summarized: 3 messages, ~\d+ tokens\]\n\ncompacted$/),
      'a1',
      'a7',
    ])
    expect(texts.slice(2)).toEqual([['u8']])
  })

  it('keeps pinned messages after the base summary when compaction writes none', async () => {
    const model = summarizingModel()
    vi.mocked(model.summarize).mockResolvedValueOnce({ content: [] })
    model.addTurn({ type: 'textBlock', text: 'base summary' })
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    messages[3] = pinned('assistant', 'a3')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(messages[1]!.content.at(-1)).toStrictEqual(new TextBlock('a3'))
    expect(messages[1]!.metadata?.custom?.pinned).toBe(true)
  })

  it('uses the base summary when the run does not start right after message 0', async () => {
    const model = summarizingModel()
    model.addTurn({ type: 'textBlock', text: 'base summary' })
    const messages = [
      ...turns('task', 'a1', 'u2'),
      new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'read', toolUseId: 't1', input: {} })] }),
      makeToolResultMessage('one', 't1'),
      new Message({ role: 'assistant', content: [new TextBlock('a5')] }),
      new Message({ role: 'user', content: [new TextBlock('u6')] }),
    ]
    const strategy = Offload.summarize(['tool::read'], { model }).when({ utilization: 0.5 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(model.summarize).not.toHaveBeenCalled()
    expect(JSON.stringify(messages)).toContain('base summary')
    expect(JSON.stringify(messages)).not.toContain('serverSideSummary')
  })

  it('gives the opening run the base summary when compaction writes none', async () => {
    const model = summarizingModel()
    vi.mocked(model.summarize).mockResolvedValueOnce({ content: [] })
    model.addTurn({ type: 'textBlock', text: 'base summary' })
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(model.summarize).toHaveBeenCalledOnce()
    expect(messages[0]!.content).toEqual([new TextBlock('task')])
    expect(JSON.stringify(messages)).toContain('base summary')
    expect(JSON.stringify(messages)).not.toContain('serverSideSummary')
  })

  it('does not compact a run holding only the earlier summary again', async () => {
    const model = summarizingModel()
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })
    await strategy.apply(nativeContext(messages))
    vi.mocked(model.summarize).mockClear()

    expect(await strategy.apply(nativeContext(messages))).toBe(false)

    expect(model.summarize).not.toHaveBeenCalled()
  })

  it('uses the base summary when only the summarizer declares server-side summaries', async () => {
    const model = summarizingModel()
    model.addTurn({ type: 'textBlock', text: 'base summary' })
    const messages = turns('task', 'a1', 'u2', 'a3', 'u4', 'a5', 'u6')
    const strategy = Offload.summarize('*', { model }).when({ utilization: 0.5, preserveRecent: 3 })

    expect(await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))).toBe(true)

    expect(model.summarize).not.toHaveBeenCalled()
    expect(messages[0]!.content).toEqual([new TextBlock('task')])
    expect(JSON.stringify(messages)).toContain('base summary')
    expect(JSON.stringify(messages)).not.toContain('serverSideSummary')
  })

  it('summarizes blocks with the base summary, not the override', async () => {
    const model = summarizingModel()
    model.addTurn({ type: 'textBlock', text: 'block summary' })
    const messages = [makeToolResultMessage('x'.repeat(2500 * 4 + 100))]
    const strategy = Offload.summarize('toolResults', { model })

    expect(await strategy.apply(nativeContext(messages))).toBe(true)

    expect(model.summarize).not.toHaveBeenCalled()
    expect(((messages[0]!.content[0] as ToolResultBlock).content[0] as TextBlock).text).toContain('block summary')
  })
})

describe('warnOnServerSideSummaryLimits', () => {
  const PINNED =
    'pinned messages are kept after a server-side summary' +
    ' | thinking in the messages kept after the summary will be dropped'
  const PER_BLOCK = 'per-block summarization with preserveRecent rewrites blocks the model has already seen'
  const THINKING = 'thinking from earlier turns will be dropped on the next turns'

  function summarizingAgent(pinned: boolean, modelInfo: object = { capabilities: { serverSideSummary: true } }) {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({
        role: 'assistant',
        content: [new TextBlock('a1')],
        ...(pinned && { metadata: { custom: { pinned: true } } }),
      }),
    ]
    return createMockAgent({ messages, extra: { model: { modelId: 'claude-test', modelInfo } } as Partial<Agent> })
  }

  function warnings(run: () => void): string[] {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      run()
      return warnSpy.mock.calls.map((call) => String(call[0]))
    } finally {
      warnSpy.mockRestore()
    }
  }

  it.each([
    {
      pinned: true,
      strategies: () => [Offload.summarize('*').when({ utilization: 0.5 })],
      statements: PINNED,
    },
    {
      pinned: false,
      strategies: () => [Offload.summarize('toolResults').when({ threshold: 100, preserveRecent: 2 })],
      statements: `${PER_BLOCK} | ${THINKING}`,
    },
    {
      pinned: true,
      strategies: () => [
        Offload.summarize('*').when({ utilization: 0.5 }),
        Offload.summarize('*').when({ threshold: 100, preserveRecent: 2 }),
      ],
      statements: `${PINNED} | ${PER_BLOCK} | ${THINKING}`,
    },
  ])('describes the features in use: $statements', ({ pinned, strategies, statements }) => {
    const agent = summarizingAgent(pinned)

    expect(warnings(() => warnOnServerSideSummaryLimits(agent, strategies()))).toEqual([
      `model_id=<claude-test> | ${statements}`,
    ])
  })

  it.each([
    { name: 'a run summary without pins', strategies: () => [Offload.summarize('*').when({ utilization: 0.5 })] },
    {
      name: 'per-block summarization without preserveRecent',
      strategies: () => [Offload.summarize('toolResults').when({ threshold: 100 })],
    },
    {
      name: 'per-block truncation',
      strategies: () => [Offload.truncate('toolResults').when({ threshold: 2500, preserveRecent: 2 })],
    },
  ])('stays silent with $name', ({ strategies }) => {
    const agent = summarizingAgent(false)

    expect(warnings(() => warnOnServerSideSummaryLimits(agent, strategies()))).toEqual([])
  })

  it('ignores pins when no summary compacts server-side', () => {
    const agent = summarizingAgent(true)
    const summarizer = new MockMessageModel()
    const strategies = [Offload.summarize('*', { model: summarizer }).when({ utilization: 0.5 })]

    expect(warnings(() => warnOnServerSideSummaryLimits(agent, strategies))).toEqual([])
  })

  it("stays silent when the agent's model does not compact server-side", () => {
    const agent = summarizingAgent(true, {})
    const strategies = [Offload.summarize('*').when({ threshold: 100, preserveRecent: 2 })]

    expect(warnings(() => warnOnServerSideSummaryLimits(agent, strategies))).toEqual([])
  })
})
