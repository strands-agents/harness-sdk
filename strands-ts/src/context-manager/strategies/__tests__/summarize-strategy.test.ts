import { describe, it, expect, vi } from 'vitest'
import { Offload } from '../offload/index.js'
import { BLOCK_SUMMARY_INSTRUCTIONS } from '../offload/summarize.js'
import { formatOffloaded, formatSummarized, offloadPlaceholder, REMOVED_MESSAGES } from '../../placeholder.js'
import { InvocationContextImpl } from '../../../agent/invocation-context.js'
import {
  Message,
  OffloadedBlock,
  ReasoningBlock,
  SummaryBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../../types/messages.js'
import { ImageBlock, VideoBlock } from '../../../types/media.js'
import { logger } from '../../../logging/logger.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { TestModelProvider } from '../../../__fixtures__/model-test-helpers.js'
import {
  heuristicCountTokens,
  makeContext as makeBaseContext,
  makeToolResultMessage,
  placeholdersIn,
} from '../../../__fixtures__/context-manager-helpers.js'
import { DEFAULT_SUMMARIZE_INSTRUCTIONS, SUMMARIZE_GUARD, type SummarizeResult } from '../../../models/summarize.js'
import type { ModelStreamEvent, Usage } from '../../../models/streaming.js'
import type { Agent } from '../../../agent/agent.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import type { ToolRegistry } from '../../../registry/tool-registry.js'
import type { Model } from '../../../models/model.js'

const summaryResult = (text: string, provider?: string): SummarizeResult => ({
  content: [new SummaryBlock({ text, ...(provider && { provider }) })],
})

/** A `summarize` mock for plain-object models, replying with a client-side summary. */
const mockSummarize = () =>
  vi.fn(async (_messages: Message[], _options?: unknown) => summaryResult('Summary of multimodal content'))

/** A context whose model is `model` over a {@link mockSummarize} default; no `model` leaves the agent without one. */
function makeContext(messages: Message[], utilization = 0.5, model?: unknown): ContextState {
  return makeBaseContext(messages, {
    utilization,
    model: model ? { modelInfo: {}, summarize: mockSummarize(), ...(model as object) } : null,
  })
}

describe('Offload.summarize', () => {
  it('creates a strategy with correct name', () => {
    const strategy = Offload.summarize('toolResults')
    expect(strategy.name).toBe('offload:summarize')
  })

  it('creates a strategy with .when() conditions', () => {
    const strategy = Offload.summarize('toolResults').when({ contextUtilization: '85%' })
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
      const strategy = Offload.summarize('toolResults').when({ blockThreshold: 2500 })
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
      const mainModel = {
        countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs),
        summarize: mockSummarize(),
      }
      const auxModel = {
        countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs),
        summarize: mockSummarize(),
      }
      const agent = createMockAgent({ messages, extra: { model: mainModel, auxModel } as unknown as Partial<Agent> })
      const strategy = Offload.summarize('toolResults')

      const result = await strategy.apply({ messages, agent, utilization: 0.9 })

      expect(result).toBe(true)
      expect(auxModel.summarize).toHaveBeenCalledTimes(1)
      expect(mainModel.summarize).not.toHaveBeenCalled()
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
      const strategy = Offload.summarize('toolResults').when({ contextUtilization: '85%' })
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
      const strategy = Offload.summarize('toolResults').when({ contextUtilization: '85%' })
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
          content: [
            offloadPlaceholder(
              'summarize',
              '[Summarized: tool result, ~2,525 tokens]\n\nSummary of tool output',
              undefined,
              2525
            ),
          ],
        }),
      ])
      expect(invocationContext.usage).toEqual({ turnsTaken: 5, inputTokens: 4, outputTokens: 5, totalTokens: 9 })
    })
  })
})

describe('summarizer errors', () => {
  // guards against summarizer failures being hidden by a lossy retry (#5291)
  it('keeps a block and continues the pass when its summarization fails', async () => {
    const summarize = mockSummarize().mockRejectedValueOnce(new Error('rejected'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const largeText = 'x'.repeat(2500 * 4 + 100)
    const messages = [makeToolResultMessage(largeText, 'call_1'), makeToolResultMessage(largeText, 'call_2')]
    const strategy = Offload.summarize('toolResults')

    const result = await strategy.apply(makeContext(messages, 0.9, { summarize }))

    expect(result).toBe(true)
    expect(((messages[0]!.content[0] as ToolResultBlock).content[0] as TextBlock).text).toBe(largeText)
    expect(((messages[1]!.content[0] as ToolResultBlock).content[0] as TextBlock).text).toContain('[Summarized:')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('error=<rejected>'))
    warnSpy.mockRestore()
  })

  it('offloads a video block without summarizing it', async () => {
    const model = new MockMessageModel()
    const summarize = vi.spyOn(model, 'summarize')
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({
        role: 'user',
        content: [new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array(4000) } })],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('latest')] }),
    ]
    const strategy = Offload.summarize('media', { model }).when({ contextUtilization: '50%', blockThreshold: 10 })
    const tokens = heuristicCountTokens([messages[1]!])

    const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

    expect(result).toBe(true)
    expect(messages[1]!.content).toEqual([
      offloadPlaceholder('summarize', formatOffloaded(tokens, 'video'), undefined, tokens),
    ])
    expect(summarize).not.toHaveBeenCalled()
  })

  it('offloads a media block when its summarization fails', async () => {
    const model = new MockMessageModel()
    vi.spyOn(model, 'summarize').mockRejectedValueOnce(new Error('images unsupported'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({
        role: 'user',
        content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array(4000) } })],
      }),
      new Message({ role: 'assistant', content: [new TextBlock('latest')] }),
    ]
    const strategy = Offload.summarize('media', { model }).when({ contextUtilization: '50%', blockThreshold: 10 })
    const tokens = heuristicCountTokens([messages[1]!])

    const result = await strategy.apply(makeContext(messages, 0.9, { stream: vi.fn() }))

    expect(result).toBe(true)
    expect(messages[1]!.content).toEqual([
      offloadPlaceholder('summarize', formatOffloaded(tokens, 'image'), undefined, tokens),
    ])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('error=<images unsupported>'))
    warnSpy.mockRestore()
  })
})

describe('repeated summarization', () => {
  // Regression test for https://github.com/strands-agents/harness-sdk/issues/4685
  it('keeps summaries out of a pinned message 0', async () => {
    const strategy = Offload.summarize('*').when({ contextUtilization: '70%', preserveRecent: 4 })
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
    expect(placeholdersIn(messages)).toEqual([expect.objectContaining({ method: 'summarize' })])
  })
})

const AGENT_PROMPT = 'You are a coding agent.'
const AGENT_TOOL = { name: 'shell', description: 'Run a command', inputSchema: { type: 'object' as const } }
const INSTRUCTIONS = new TextBlock(`${SUMMARIZE_GUARD}\n\n${DEFAULT_SUMMARIZE_INSTRUCTIONS}`)
const STREAM_USAGE: Usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

function streamEvents(text: string, onDelta?: () => void): () => AsyncGenerator<ModelStreamEvent> {
  return async function* () {
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
    onDelta?.()
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    yield { type: 'modelMetadataEvent', usage: STREAM_USAGE }
  }
}

/** A model whose `summarize` runs the base implementation, with `summarize`, `stream` and `countTokens` spied. */
function baseModel(serverSideSummary = false) {
  const model = new TestModelProvider(streamEvents('Summary of content.'))
  model.updateConfig({ modelInfo: { capabilities: { serverSideSummary } } })
  return {
    model,
    summarize: vi.spyOn(model, 'summarize'),
    stream: vi.spyOn(model, 'stream'),
    countTokens: vi.spyOn(model, 'countTokens').mockResolvedValue(5000),
  }
}

/** An agent on a {@link baseModel}, with a system prompt, a tool, a cancel signal and agent metadata. */
function mockAgent(
  messages: Message[],
  options: { serverSideSummary?: boolean; systemPrompt?: string | null; auxModel?: unknown } = {}
) {
  const spies = baseModel(options.serverSideSummary)
  const controller = new AbortController()
  const systemPrompt = options.systemPrompt === undefined ? AGENT_PROMPT : options.systemPrompt
  const agent = createMockAgent({
    messages,
    toolRegistry: { list: () => [{ toolSpec: AGENT_TOOL }] } as unknown as ToolRegistry,
    extra: {
      model: spies.model,
      cancelSignal: controller.signal,
      agentMetadata: { sessionId: 'session' },
      ...(systemPrompt !== null && { systemPrompt }),
      ...(options.auxModel !== undefined && { auxModel: options.auxModel }),
    } as unknown as Partial<Agent>,
  })
  return { agent, controller, ...spies }
}

function replayOptions(agent: LocalAgent, instructions?: string): Record<string, unknown> {
  return {
    ...(instructions !== undefined && { instructions }),
    cancelSignal: agent.cancelSignal,
    agentMetadata: agent.agentMetadata,
    toolSpecs: [AGENT_TOOL],
    systemPrompt: AGENT_PROMPT,
  }
}

/** Messages without tracking ids, so a request can be compared with the messages it should hold. */
const turns = (messages: Message[]): { role: string; content: unknown[]; pinned?: boolean }[] =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.metadata?.custom?.pinned === true && { pinned: true }),
  }))

/** The placeholder a summarized run leaves, over the 5,000 tokens the mocked count reports. */
const marker = (summary: string, tokens = 5000): OffloadedBlock =>
  offloadPlaceholder('summarize', formatSummarized(REMOVED_MESSAGES, tokens, summary), undefined, tokens)

const serverSideMessages = (): Message[] => [
  new Message({ role: 'user', content: [new TextBlock('task')] }),
  new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
  new Message({ role: 'user', content: [new TextBlock('old2')] }),
  new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
  new Message({ role: 'user', content: [new TextBlock('recent')] }),
]

const toolResultMessages = (): Message[] => [
  new Message({ role: 'user', content: [new TextBlock('task')] }),
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('x'.repeat(10000))] })],
  }),
]

const summarizedToolResult = (summary: string): { role: string; content: unknown[] } => ({
  role: 'user',
  content: [
    new ToolResultBlock({
      toolUseId: 't1',
      status: 'success',
      content: [offloadPlaceholder('summarize', formatSummarized('tool result', 5000, summary), undefined, 5000)],
    }),
  ],
})

const pinned = (text: string): Message =>
  new Message({ role: 'user', content: [new TextBlock(text)], metadata: { custom: { pinned: true } } })

const perMessage = () => Offload.summarize('*').when({ contextUtilization: '80%', preserveRecent: 1 })
const perBlock = (config?: { systemPrompt: string }) =>
  Offload.summarize('toolResults', config).when({ blockThreshold: 100 })

describe('summarizing message runs', () => {
  it('summarizes each contiguous run separately, around pinned messages', async () => {
    const summarize = mockSummarize()
      .mockResolvedValueOnce(summaryResult('late run'))
      .mockResolvedValueOnce(summaryResult('early run'))
    const pin = { metadata: { custom: { pinned: true } } }
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('a1')], ...pin }),
      ...['u2', 'a3', 'u4'].map(
        (value, index) => new Message({ role: index % 2 ? 'assistant' : 'user', content: [new TextBlock(value)] })
      ),
      new Message({ role: 'assistant', content: [new TextBlock('a5')], ...pin }),
      ...['u6', 'a7', 'u8', 'a9', 'u10'].map(
        (value, index) => new Message({ role: index % 2 ? 'assistant' : 'user', content: [new TextBlock(value)] })
      ),
    ]
    const strategy = Offload.summarize('*').when({ contextUtilization: '50%', preserveRecent: 3 })

    expect(await strategy.apply(makeContext(messages, 0.9, { summarize }))).toBe(true)

    expect(summarize).toHaveBeenCalledTimes(2)
    expect(messages.map((message) => message.content.map((block) => (block as TextBlock).text))).toEqual([
      ['task'],
      [
        'a1',
        '[Summarized: earlier messages, ~3 tokens]\n\nearly run',
        'a5',
        '[Summarized: earlier messages, ~2 tokens]\n\nlate run',
      ],
      ['u8'],
      ['a9'],
      ['u10'],
    ])
  })

  it('leaves a failed run intact and still summarizes the others', async () => {
    const summarize = mockSummarize()
      .mockResolvedValueOnce(summaryResult('late run'))
      .mockRejectedValueOnce(new Error('throttled'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      ...['a1', 'u2', 'a3'].map(
        (value, index) => new Message({ role: index % 2 ? 'user' : 'assistant', content: [new TextBlock(value)] })
      ),
      pinned('u4'),
      ...['a5', 'u6', 'a7'].map(
        (value, index) => new Message({ role: index % 2 ? 'user' : 'assistant', content: [new TextBlock(value)] })
      ),
    ]
    const strategy = Offload.summarize('*').when({ contextUtilization: '50%', preserveRecent: 1 })

    expect(await strategy.apply(makeContext(messages, 0.9, { summarize }))).toBe(true)

    const texts = messages.map((message) => message.content.map((block) => (block as TextBlock).text))
    expect(texts.slice(0, 5)).toEqual([['task'], ['a1'], ['u2'], ['a3'], ['u4']])
    expect(texts[5]).toContain(formatSummarized(REMOVED_MESSAGES, 2, 'late run'))
    warnSpy.mockRestore()
  })
})

describe('per-block cancellation and placement', () => {
  it('stops sending requests after a cancel', async () => {
    const toolResult = (id: string) =>
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({ toolUseId: id, status: 'success', content: [new TextBlock('x'.repeat(10000))] }),
        ],
      })
    const messages = [0, 1, 2, 3, 4].map((index) => toolResult(`call_${index}`))
    const { agent, model, controller, stream } = mockAgent(messages)
    model.setEventGenerator(streamEvents('partial', () => controller.abort()))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(false)

    expect(stream).toHaveBeenCalledTimes(1)
    expect(turns(messages)).toEqual(turns([0, 1, 2, 3, 4].map((index) => toolResult(`call_${index}`))))
    warnSpy.mockRestore()
  })

  it('skips a run summary once cancelled', async () => {
    const messages = serverSideMessages()
    const { agent, controller, stream } = mockAgent(messages)
    controller.abort()

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(false)

    expect(stream).not.toHaveBeenCalled()
    expect(turns(messages)).toEqual(turns(serverSideMessages()))
  })

  it('places only the first summary block', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue({
      content: [new SummaryBlock({ text: 'first' }), new SummaryBlock({ text: 'second' })],
    })

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(turns(messages)[1]).toEqual(summarizedToolResult('first'))
  })
})

describe('a summarized run replays the agent request', () => {
  const reasoning = () => new ReasoningBlock({ text: 'think', signature: 'sig' })
  const replayMessages = (): Message[] => [
    new Message({ role: 'user', content: [new TextBlock('task')] }),
    new Message({ role: 'assistant', content: [reasoning(), new TextBlock('old1')] }),
    new Message({ role: 'user', content: [new TextBlock('old2')] }),
    new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
    new Message({ role: 'user', content: [new TextBlock('recent')] }),
  ]

  // guards against a rejected first request and a text-only retry that drops tool calls (#5291)
  it('replays tool calls in a single model call', async () => {
    const toolUse = new ToolUseBlock({ toolUseId: 'call_1', name: 'shell', input: { command: 'ls' } })
    const toolResult = new ToolResultBlock({
      toolUseId: 'call_1',
      status: 'success',
      content: [new TextBlock('a.ts b.ts')],
    })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('fix the build')] }),
      new Message({ role: 'assistant', content: [toolUse] }),
      new Message({ role: 'user', content: [toolResult] }),
      new Message({ role: 'assistant', content: [new TextBlock('done')] }),
      new Message({ role: 'user', content: [new TextBlock('next')] }),
    ]
    const { agent, stream } = mockAgent(messages)
    const strategy = Offload.summarize('*').when({ contextUtilization: '70%', preserveRecent: 2 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(stream).toHaveBeenCalledTimes(1)
    const [sent, options] = stream.mock.calls[0]!
    expect(turns(sent)).toEqual([
      { role: 'user', content: [new TextBlock('fix the build')] },
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [toolResult, INSTRUCTIONS] },
    ])
    expect(options).toEqual({
      toolSpecs: [AGENT_TOOL],
      systemPrompt: AGENT_PROMPT,
      cancelSignal: agent.cancelSignal,
      agentMetadata: agent.agentMetadata,
    })
  })

  it('sends the history prefix with the agent prompt and tools', async () => {
    const messages = replayMessages()
    const { agent, summarize } = mockAgent(messages)

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    const [sent, options] = summarize.mock.calls[0]!
    expect(turns(sent)).toEqual(turns(replayMessages().slice(0, 4)))
    expect(options).toEqual(replayOptions(agent))
  })

  it('summarizes each side of a kept pin on its own', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
      pinned('pin'),
      new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize } = mockAgent(messages)

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    // The later run goes first, so removing it leaves the earlier run's position unchanged.
    expect(summarize.mock.calls.map(([sent]) => turns(sent))).toEqual([
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [new TextBlock('old3')] },
      ],
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [new TextBlock('old1')] },
      ],
    ])
    expect(summarize.mock.calls[0]![1]).toEqual(replayOptions(agent))
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('Summary of content.')] },
      { role: 'user', content: [new TextBlock('pin')], pinned: true },
      { role: 'assistant', content: [marker('Summary of content.')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })

  it('sends only the messages a blockThreshold selected', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('big1')] }),
      new Message({ role: 'user', content: [new TextBlock('question')] }),
      new Message({ role: 'assistant', content: [new TextBlock('big2')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize, countTokens } = mockAgent(messages)
    countTokens.mockImplementation(async (counted: Message[]) =>
      counted.some((message) =>
        message.content.some((block) => block instanceof TextBlock && block.text.includes('big'))
      )
        ? 5000
        : 10
    )
    const strategy = Offload.summarize('*').when({ contextUtilization: '80%', blockThreshold: 100 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize.mock.calls.map(([sent]) => turns(sent))).toEqual([
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [new TextBlock('big2')] },
      ],
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [new TextBlock('big1')] },
      ],
    ])
    expect(summarize.mock.calls[0]![1]).toEqual(replayOptions(agent))
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('Summary of content.')] },
      { role: 'user', content: [new TextBlock('question')] },
      { role: 'assistant', content: [marker('Summary of content.')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })

  it('replays the prefix as sent when it holds adjacent same-role messages', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'user', content: [new TextBlock('more task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize } = mockAgent(messages)

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    const [sent, options] = summarize.mock.calls[0]!
    expect(turns(sent)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'user', content: [new TextBlock('more task')] },
      { role: 'assistant', content: [new TextBlock('old1')] },
    ])
    expect(options).toEqual(replayOptions(agent))
  })

  it('leaves reasoning out of a run that is not the history prefix', async () => {
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [reasoning(), new TextBlock('old1')] }),
      pinned('pin'),
      new Message({ role: 'assistant', content: [reasoning(), new TextBlock('old3')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize } = mockAgent(messages)

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize.mock.calls.map(([sent]) => turns(sent))).toEqual([
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [new TextBlock('old3')] },
      ],
      [
        { role: 'user', content: [new TextBlock('task')] },
        { role: 'assistant', content: [reasoning(), new TextBlock('old1')] },
      ],
    ])
  })

  it('sends no system prompt for an agent without one', async () => {
    const messages = replayMessages()
    const { agent, stream } = mockAgent(messages, { systemPrompt: null })

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(stream.mock.calls[0]![1]?.systemPrompt).toBeUndefined()
  })

  it('leaves the history unchanged when cancelled mid-summary', async () => {
    const messages = replayMessages()
    const { agent, model, controller } = mockAgent(messages)
    model.setEventGenerator(streamEvents('partial', () => controller.abort()))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(false)

    expect(turns(messages)).toEqual(turns(replayMessages()))
    warnSpy.mockRestore()
  })

  it('leaves reasoning out for a model other than the agent model', async () => {
    const messages = replayMessages()
    const auxModel = {
      countTokens: vi.fn(async () => 5000),
      modelInfo: {},
      summarize: vi.fn(async (_messages: Message[]) => summaryResult('aux summary')),
    }
    const { agent } = mockAgent(messages, { auxModel })

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    const expected = replayMessages().slice(0, 4)
    expected[1] = new Message({ role: 'assistant', content: [new TextBlock('old1')] })
    expect(turns(auxModel.summarize.mock.calls[0]![0])).toEqual(turns(expected))
  })

  it('leaves the history unchanged when the reply holds no text', async () => {
    const messages = replayMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue({ content: [] })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(false)

    expect(turns(messages)).toEqual(turns(replayMessages()))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('summary held no text'))
    warnSpy.mockRestore()
  })

  it('sends an earlier server-side summary with the run that replaces it', async () => {
    const earlier = new SummaryBlock({ provider: 'anthropic', text: 'fact' })
    const history = (): Message[] => [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [earlier] }),
      new Message({ role: 'user', content: [new TextBlock('old1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old2')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const messages = history()
    const { agent, summarize } = mockAgent(messages)

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(turns(summarize.mock.calls[0]![0])).toEqual(turns(history().slice(0, 4)))
  })
})

describe('server-side summary', () => {
  /** A history where only message 3 is over a 100-token `blockThreshold`. */
  const sizeFilteredMessages = (): Message[] => [
    new Message({ role: 'user', content: [new TextBlock('task')] }),
    new Message({ role: 'assistant', content: [new TextBlock('small a1')] }),
    new Message({ role: 'user', content: [new TextBlock('small u2')] }),
    new Message({ role: 'assistant', content: [new TextBlock('BIG '.repeat(200))] }),
    new Message({ role: 'user', content: [new TextBlock('small u4')] }),
    new Message({ role: 'assistant', content: [new TextBlock('small a5')] }),
    new Message({ role: 'user', content: [new TextBlock('last')] }),
  ]

  const sizeFiltered = () =>
    Offload.summarize('*').when({ contextUtilization: '50%', blockThreshold: 100, preserveRecent: 1 })

  it('replaces the opening run with the server-side summary', async () => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    const summary = new SummaryBlock({ provider: 'anthropic', text: 'compacted' })
    summarize.mockResolvedValue({ content: [summary] })

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    const sent = summarize.mock.calls[0]![0]
    expect(sent.flatMap((message) => message.content.map((block) => (block as TextBlock).text))).toEqual([
      'task',
      'old1',
      'old2',
      'old3',
    ])
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [summary] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })

  it('places a summary without a provider as a client-side marker', async () => {
    const messages = serverSideMessages()
    const { agent, summarize, countTokens } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('written client-side'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(countTokens).toHaveBeenCalledTimes(1)
    expect(turns(countTokens.mock.calls[0]![0])).toEqual(turns(serverSideMessages().slice(1, 4)))
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('written client-side')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
    warnSpy.mockRestore()
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
    const { model } = baseModel(true)
    const summarize = vi.spyOn(model, 'summarize').mockResolvedValue(summaryResult('compacted', 'anthropic'))
    const messages = serverSideMessages()
    const agent = createMockAgent({
      messages,
      toolRegistry: { list: () => [{ toolSpec }] } as unknown as ToolRegistry,
      extra: { model, systemPrompt: 'be terse' } as unknown as Partial<Agent>,
    })
    const strategy = Offload.summarize('*', config).when({ contextUtilization: '80%', preserveRecent: 1 })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize).toHaveBeenCalledWith(expect.any(Array), {
      systemPrompt: 'be terse',
      toolSpecs: [toolSpec],
      cancelSignal: agent.cancelSignal,
      ...instructions,
    })
  })

  it.each<{ name: string; other: Record<string, unknown> }>([
    { name: 'a different model id', other: { modelId: 'claude-opus-5-5' } },
    { name: 'a different provider', other: { constructor: class OtherModel {} } },
  ])('summarizes client-side when the agent model is $name', async ({ other }) => {
    // The agent's model is the one that replays the summary block, so only its own provider may write it.
    const serverSideModel = (overrides: Record<string, unknown> = {}) =>
      ({
        modelId: 'claude-haiku-5-5',
        modelInfo: { capabilities: { serverSideSummary: true } },
        countTokens: vi.fn(async () => 5000),
        summarize: mockSummarize(),
        ...overrides,
      }) as unknown as Model
    const auxModel = serverSideModel()
    const agentModel = serverSideModel(other)
    const messages = serverSideMessages()
    const agent = createMockAgent({
      messages,
      extra: { model: agentModel, auxModel } as unknown as Partial<Agent>,
    })

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('Summary of multimodal content')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })

  it('summarizes client-side when message 0 holds a tool use', async () => {
    const messages = [
      new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId: 't0', name: 'read', input: {} })] }),
      makeToolResultMessage('done', 't0'),
      ...serverSideMessages().slice(1),
    ]
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    await perMessage().apply({ messages, agent, utilization: 0.9 })

    expect(messages[0]!.content[0]).toBeInstanceOf(ToolUseBlock)
    expect(messages.some((message) => message.content.some((block) => block instanceof SummaryBlock))).toBe(false)
  })

  it('summarizes client-side when a blockThreshold selects messages by size', async () => {
    const messages = sizeFilteredMessages()
    const { agent, summarize, countTokens } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))
    countTokens.mockImplementation(async (counted: Message[]) => heuristicCountTokens(counted))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const bigTokens = heuristicCountTokens([messages[3]!])

    expect(await sizeFiltered().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    // A server-side summary covers the conversation's start, so it can't honour a per-message size filter.
    expect(messages.flatMap((message) => message.content.map((block) => (block as TextBlock).text))).toEqual([
      'task',
      'small a1',
      'small u2',
      formatSummarized(REMOVED_MESSAGES, bigTokens, 'compacted'),
      'small u4',
      'small a5',
      'last',
    ])
    warnSpy.mockRestore()
  })

  it('warns once that a blockThreshold rules out the server-side summary', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const strategy = sizeFiltered()
    const first = sizeFilteredMessages()
    const second = sizeFilteredMessages()
    const { agent, summarize } = mockAgent(first, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    expect(await strategy.apply({ messages: first, agent, utilization: 0.9 })).toBe(true)
    expect(await strategy.apply({ messages: second, agent, utilization: 0.9 })).toBe(true)

    const skips = warnSpy.mock.calls.filter(([message]) => String(message).includes('cannot honour a blockThreshold'))
    expect(skips).toHaveLength(1)
    expect(skips[0]![0]).toContain('blockThreshold=<100> | a server-side summary covers the conversation')
    warnSpy.mockRestore()
  })

  it('falls back to client-side when message 0 is pinned', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = serverSideMessages()
    messages[0] = pinned('task')
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')], pinned: true },
      { role: 'assistant', content: [marker('compacted')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pinned=<1> | server-side summary does not support pinned messages')
    )
    warnSpy.mockRestore()
  })

  it('falls back to client-side when a pin is summarized', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old1')] }),
      pinned('pin'),
      new Message({ role: 'assistant', content: [new TextBlock('old3')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pinned=<1> | server-side summary does not support pinned messages')
    )
    // The pin splits the removable messages into two runs, and each run gets its own summary.
    expect(summarize).toHaveBeenCalledTimes(2)
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('compacted')] },
      { role: 'user', content: [new TextBlock('pin')], pinned: true },
      { role: 'assistant', content: [marker('compacted')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
    warnSpy.mockRestore()
  })

  it.each([
    { name: 'agent model unsupported', agentSupports: false, auxSupports: true },
    { name: 'aux model unsupported', agentSupports: true, auxSupports: false },
  ])('requires both models to support server-side summary: $name', async ({ agentSupports, auxSupports }) => {
    const messages = serverSideMessages()
    const aux = baseModel(auxSupports)
    const { agent } = mockAgent(messages, { serverSideSummary: agentSupports, auxModel: aux.model })

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [marker('Summary of content.')] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })

  it.each([
    {
      name: 'error',
      result: () => Promise.reject(new Error('overloaded')),
      log: 'error=<overloaded> | summarization failed',
    },
    { name: 'empty', result: () => Promise.resolve({ content: [] }), log: 'summary held no text' },
  ])('a failed server-side summary leaves the history unchanged: $name', async ({ result, log }) => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockImplementation(result)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(false)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(turns(messages)).toEqual(turns(serverSideMessages()))
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(log),
      ...(log.includes('error') ? [expect.any(Error)] : [])
    )
    warnSpy.mockRestore()
  })

  it('warns that a client-side summary drops kept thinking', async () => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('written client-side'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('thinking blocks kept after it will be dropped'))
    warnSpy.mockRestore()
  })

  it('sends an earlier server-side summary with the opening messages', async () => {
    const earlier = new SummaryBlock({ provider: 'anthropic', text: 'fact' })
    const messages = [
      new Message({ role: 'user', content: [new TextBlock('task')] }),
      new Message({ role: 'assistant', content: [earlier] }),
      new Message({ role: 'user', content: [new TextBlock('old1')] }),
      new Message({ role: 'assistant', content: [new TextBlock('old2')] }),
      new Message({ role: 'user', content: [new TextBlock('recent')] }),
    ]
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize).toHaveBeenCalledTimes(1)
    const [sent, options] = summarize.mock.calls[0]!
    expect(turns(sent)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [earlier] },
      { role: 'user', content: [new TextBlock('old1')] },
      { role: 'assistant', content: [new TextBlock('old2')] },
    ])
    expect(options).toEqual(replayOptions(agent))
    expect(turns(messages)).toEqual([
      { role: 'user', content: [new TextBlock('task')] },
      { role: 'assistant', content: [new SummaryBlock({ provider: 'anthropic', text: 'compacted' })] },
      { role: 'user', content: [new TextBlock('recent')] },
    ])
  })
})

describe('client-side summaries use Model.summarize', () => {
  it('a provider override writes client-side summaries', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue(summaryResult('provider summary'))

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(turns(messages)[1]).toEqual(summarizedToolResult('provider summary'))
    const [sent, options] = summarize.mock.calls[0]!
    expect(turns(sent)).toEqual([
      {
        role: 'user',
        content: [
          new TextBlock('<content>'),
          new TextBlock('[tool result]'),
          new TextBlock('x'.repeat(10000)),
          new TextBlock('</content>'),
        ],
      },
    ])
    expect(options).not.toHaveProperty('toolSpecs')
    expect(options).not.toHaveProperty('systemPrompt')
  })

  it('a server-side model writes block summaries as text', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    summarize.mockResolvedValue(summaryResult('compacted', 'anthropic'))

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(summarize).toHaveBeenCalledTimes(1)
    expect(turns(messages)[1]).toEqual(summarizedToolResult('compacted'))
  })

  it('a failed per-message summary leaves the history unchanged', async () => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockRejectedValue(new Error('throttled'))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9 })).toBe(false)

    expect(turns(messages)).toEqual(turns(serverSideMessages()))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('error=<throttled> | summarization failed'))
    warnSpy.mockRestore()
  })

  it('a block summary sends a tool result after its tool name', async () => {
    const messages = toolResultMessages()
    messages.splice(
      1,
      0,
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ toolUseId: 't1', name: 'read_file', input: { path: 'a.py' } })],
      })
    )
    const { agent, summarize } = mockAgent(messages)

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(turns(summarize.mock.calls[0]![0])).toEqual([
      {
        role: 'user',
        content: [
          new TextBlock('<content>'),
          new TextBlock('[tool result: read_file]'),
          new TextBlock('x'.repeat(10000)),
          new TextBlock('</content>'),
        ],
      },
    ])
  })

  it('a block summary labels a failed tool result with its status', async () => {
    const failure = 'x'.repeat(10000)
    const messages = [
      new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'bash', toolUseId: 't1', input: {} })] }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 't1', status: 'error', content: [new TextBlock(failure)] })],
      }),
    ]
    const { agent, summarize } = mockAgent(messages)
    const strategy = Offload.summarize('toolResultErrors').when({ blockThreshold: 100 })

    expect(await strategy.apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(turns(summarize.mock.calls[0]![0])).toEqual([
      {
        role: 'user',
        content: [
          new TextBlock('<content>'),
          new TextBlock('[tool result: bash (error)]'),
          new TextBlock(failure),
          new TextBlock('</content>'),
        ],
      },
    ])
  })

  it('a custom system prompt reaches client-side summaries', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue(summaryResult('provider summary'))

    expect(await perBlock({ systemPrompt: 'Be very brief.' }).apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(summarize.mock.calls[0]![1]?.instructions).toBe('Be very brief.')
  })

  it('a custom system prompt reaches run summaries', async () => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue(summaryResult('provider summary'))
    const strategy = Offload.summarize('*', { systemPrompt: 'Be very brief.' }).when({
      contextUtilization: '80%',
      preserveRecent: 1,
    })

    expect(await strategy.apply({ messages, agent, utilization: 0.9 })).toBe(true)

    expect(summarize).toHaveBeenCalledTimes(1)
    const [sent, options] = summarize.mock.calls[0]!
    expect(turns(sent)).toEqual(turns(serverSideMessages().slice(0, 4)))
    expect(options).toEqual(replayOptions(agent, 'Be very brief.'))
  })

  it('a block summary sends the block instructions without a system prompt', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages)

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(true)

    expect(summarize.mock.calls[0]![1]).toEqual({
      instructions: BLOCK_SUMMARY_INSTRUCTIONS,
      cancelSignal: agent.cancelSignal,
      agentMetadata: agent.agentMetadata,
    })
  })

  it.each([false, true])(
    'a block summary adds its usage to the request: serverSideSummary=%s',
    async (serverSideSummary) => {
      const messages = toolResultMessages()
      const { agent } = mockAgent(messages, { serverSideSummary })
      const invocationContext = new InvocationContextImpl()

      expect(await perBlock().apply({ messages, agent, utilization: 0.5, invocationContext })).toBe(true)

      expect(invocationContext.usage).toEqual({ turnsTaken: 0, ...STREAM_USAGE })
    }
  )

  it('a per-message summary adds its usage to the request', async () => {
    const messages = serverSideMessages()
    const { agent } = mockAgent(messages)
    const invocationContext = new InvocationContextImpl()

    expect(await perMessage().apply({ messages, agent, utilization: 0.9, invocationContext })).toBe(true)

    expect(invocationContext.usage).toEqual({ turnsTaken: 0, ...STREAM_USAGE })
  })

  it.each([
    { name: 'with a summary', content: [new SummaryBlock({ provider: 'anthropic', text: 'compacted' })] },
    { name: 'without a summary', content: [] },
  ])('a server-side summary adds its usage to the request: $name', async ({ content }) => {
    const messages = serverSideMessages()
    const { agent, summarize } = mockAgent(messages, { serverSideSummary: true })
    const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
    summarize.mockResolvedValue({ content, usage })
    const invocationContext = new InvocationContextImpl()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perMessage().apply({ messages, agent, utilization: 0.9, invocationContext })).toBe(content.length > 0)

    expect(invocationContext.usage).toEqual({ turnsTaken: 0, ...usage })
    warnSpy.mockRestore()
  })

  it('warns when summarize returns no text', async () => {
    const messages = toolResultMessages()
    const { agent, summarize } = mockAgent(messages)
    summarize.mockResolvedValue({ content: [] })
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    expect(await perBlock().apply({ messages, agent, utilization: 0.5 })).toBe(false)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('summary held no text'))
    expect(turns(messages)).toEqual(turns(toolResultMessages()))
    warnSpy.mockRestore()
  })
})
