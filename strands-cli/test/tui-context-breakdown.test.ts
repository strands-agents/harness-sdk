import {
  AfterModelCallEvent,
  Agent,
  FunctionTool,
  ImageBlock,
  InvokeModelStage,
  Message,
  Model,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type ModelStreamEvent,
  type StreamOptions,
  type Usage,
} from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { ChatContextBreakdown, ChatRunResult } from '../src/tui/chat/types.js'
import { AgentModelRuntime } from '../src/tui/model/runtime.js'
import { storeContext } from '../src/tui/session/context.js'
import { StrandsChatBackend } from '../src/tui/strands-backend.js'

class ContextModel extends Model {
  calls = 0
  countCalls = 0
  fail = false
  usage: Usage | undefined = { inputTokens: 1_000, outputTokens: 5, totalTokens: 1_005 }
  received: { messages: Message[]; options: StreamOptions | undefined } | undefined

  getConfig() {
    return { modelId: 'context-test', contextWindowLimit: 10_000 }
  }

  updateConfig() {}

  async countTokens() {
    this.countCalls++
    return 1
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls++
    this.received = { messages, options }
    if (this.fail) throw new Error('model unavailable')
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    if (this.usage) yield { type: 'modelMetadataEvent', usage: this.usage }
  }
}

async function run(backend: StrandsChatBackend, prompt = 'go'): Promise<ChatRunResult> {
  const stream = backend.stream(prompt)
  let next = await stream.next()
  while (!next.done) next = await stream.next()
  return next.value
}

function categories(result: ChatRunResult): Record<string, number> {
  expect(result.context?.breakdown).toBeDefined()
  const entries = result.context!.breakdown!.categories
  expect(entries.reduce((sum, entry) => sum + entry.tokens, 0)).toBe(
    result.context!.projectedTokens ?? result.context!.currentTokens
  )
  return Object.fromEntries(entries.map(({ kind, tokens }) => [kind, tokens]))
}

describe('context breakdown', () => {
  it('captures effective prompts, tools, conversation, and ephemeral memory without extra token-count requests', async () => {
    const model = new ContextModel()
    const memorySearch = vi.fn(async () => [{ content: 'saved memory' }])
    const agent = new Agent({
      model,
      printer: false,
      contextManager: false,
      systemPrompt: 'base',
      tools: [new FunctionTool({ name: 'probe', description: 'Check things', callback: () => 'ok' })],
      memoryManager: {
        stores: [{ name: 'memory', writable: false, search: memorySearch }],
        searchToolConfig: false,
        injection: { format: () => 'abcdefgh' },
      },
      messages: [
        new Message({ role: 'user', content: [new TextBlock('old')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'probe', toolUseId: 'probe-1', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({ toolUseId: 'probe-1', status: 'success', content: [new TextBlock('abcdefgh')] }),
          ],
        }),
        new Message({ role: 'assistant', content: [new TextBlock('past')] }),
      ],
    })
    await agent.initialize()
    agent.addMiddleware(InvokeModelStage.Wrap, async function* (context, next) {
      return yield* next({ ...context, systemPrompt: 'abcdefgh' })
    })
    const result = await run(new StrandsChatBackend(new AgentModelRuntime(agent)))

    expect(categories(result)).toMatchObject({
      systemPrompt: 2,
      userMessages: 2,
      assistantMessages: 9,
      toolResults: 2,
      injectedContext: 3,
    })
    expect(categories(result).tools).toBeGreaterThan(0)
    expect(categories(result).other).toBeGreaterThan(0)
    expect(model.received?.options?.systemPrompt).toBe('abcdefgh')
    expect(model.received?.messages.at(-1)?.content).toHaveLength(2)
    expect(agent.messages.at(-2)?.content).toEqual([new TextBlock('go')])
    expect(memorySearch).toHaveBeenCalledOnce()
    expect(model.countCalls).toBe(1)
  })

  it('scales overestimates down and keeps media and uncounted overhead in Other', async () => {
    const model = new ContextModel()
    const agent = new Agent({
      model,
      printer: false,
      contextManager: false,
      messages: [
        new Message({
          role: 'user',
          content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })],
        }),
      ],
    })
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const withMedia = categories(await run(backend, '1234'))
    expect(withMedia.userMessages).toBe(1)
    expect(withMedia.assistantMessages).toBe(5)
    expect(withMedia.other).toBe(999)

    agent.messages.splice(0)
    agent.systemPrompt = 's'.repeat(400)
    model.usage = { inputTokens: 8, outputTokens: 5, totalTokens: 13 }
    const small = categories(await run(backend, 'u'.repeat(400)))
    expect(small).toEqual({ systemPrompt: 4, userMessages: 4, assistantMessages: 5 })
  })

  it('counts cached prompt tokens once and uses the final call instead of accumulated turn usage', async () => {
    class BedrockModel extends ContextModel {}
    const model = new BedrockModel()
    model.usage = { inputTokens: 2, outputTokens: 5, totalTokens: 107, cacheWriteInputTokens: 100 }
    const agent = new Agent({ model, printer: false, contextManager: false })
    let retry = true
    agent.addHook(AfterModelCallEvent, (event) => {
      if (!retry) return
      retry = false
      event.retry = true
    })
    const result = await run(new StrandsChatBackend(new AgentModelRuntime(agent)))
    expect(result.context).toMatchObject({ currentTokens: 102, projectedTokens: 107 })
    expect(categories(result)).toEqual({ userMessages: 1, assistantMessages: 5, other: 101 })
    expect(result.usage?.totalTokens).toBe(214)
  })

  it('uses only the final successful retry and removes observers between turns', async () => {
    const model = new ContextModel()
    const agent = new Agent({ model, printer: false, contextManager: false, systemPrompt: 's'.repeat(400) })
    let retry = true
    agent.addHook(AfterModelCallEvent, (event) => {
      if (!retry) return
      retry = false
      event.retry = true
      agent.systemPrompt = 'tiny'
    })
    const register = vi.spyOn(agent, 'addMiddleware')
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))

    expect(categories(await run(backend)).systemPrompt).toBe(1)
    expect(model.calls).toBe(2)
    expect(register.mock.calls.filter(([stage]) => Object.is(stage, InvokeModelStage.Wrap))).toHaveLength(1)
    register.mockClear()
    expect(categories(await run(backend)).systemPrompt).toBe(1)
    expect(register.mock.calls.filter(([stage]) => Object.is(stage, InvokeModelStage.Wrap))).toHaveLength(1)
  })

  it('does not replace saved context after failure or reuse capture when the next response has no usage', async () => {
    const model = new ContextModel()
    const agent = new Agent({ model, printer: false, contextManager: false, systemPrompt: 'system' })
    const backend = new StrandsChatBackend(new AgentModelRuntime(agent))
    const saved = (await run(backend)).context
    expect(saved?.breakdown).toBeDefined()
    model.fail = true
    await expect(run(backend)).rejects.toThrow('model unavailable')
    expect(backend.contextUsage()).toEqual(saved)
    model.fail = false
    model.usage = undefined
    expect((await run(backend)).context?.breakdown).toBeUndefined()
  })

  it('discards earlier capture when middleware repeats the model call without usage', async () => {
    const model = new ContextModel()
    const agent = new Agent({ model, printer: false, contextManager: false })
    agent.addMiddleware(InvokeModelStage.Wrap, async function* (context, next) {
      yield* next(context)
      model.usage = undefined
      return yield* next(context)
    })
    const result = await run(new StrandsChatBackend(new AgentModelRuntime(agent)))
    expect(model.calls).toBe(2)
    expect(result.context?.breakdown).toBeUndefined()
  })

  it('observes the replacement root agent and excludes child model calls', async () => {
    const childModel = new ContextModel()
    const child = new Agent({ model: childModel, printer: false, contextManager: false, systemPrompt: 'c'.repeat(400) })
    const replacement = new Agent({
      model: new ContextModel(),
      printer: false,
      contextManager: false,
      systemPrompt: 'new root',
    })
    replacement.addMiddleware(InvokeModelStage.Wrap, async function* (context, next) {
      for await (const event of child.stream('child')) yield event
      return yield* next(context)
    })
    const original = new Agent({
      model: new ContextModel(),
      printer: false,
      contextManager: false,
      systemPrompt: 'old'.repeat(400),
    })
    const runtime = new AgentModelRuntime(original)
    runtime.stream = async function* (...args) {
      Object.assign(runtime, { _agent: replacement })
      return yield* replacement.stream(...args)
    }

    const result = await run(new StrandsChatBackend(runtime))
    expect(childModel.calls).toBe(1)
    expect(categories(result).systemPrompt).toBe(2)
    expect(categories(result).assistantMessages).toBe(5)
  })

  it('restores valid category counts and rejects malformed breakdowns independently of aggregate usage', async () => {
    const model = new ContextModel()
    const agent = new Agent({ model, printer: false, contextManager: false })
    const runtime = new AgentModelRuntime(agent)
    const backend = new StrandsChatBackend(runtime)
    const result = await run(backend)
    expect(backend.contextUsage()).toEqual(result.context)
    const restored = new Agent({
      model: new ContextModel(),
      printer: false,
      contextManager: false,
      messages: agent.messages.map((message) => message.clone()),
    })
    expect(new StrandsChatBackend(new AgentModelRuntime(restored)).contextUsage()).toEqual(result.context)

    const { breakdown: valid, ...aggregate } = result.context!
    expect(valid).toBeDefined()
    const invalidCategories = [
      [{ kind: 'unknown', tokens: 1_005 }],
      [{ kind: 'other', tokens: -1 }],
      [
        { kind: 'other', tokens: 1_000 },
        { kind: 'other', tokens: 5 },
      ],
      [{ kind: 'other', tokens: 1_004 }],
    ]
    for (const invalid of invalidCategories) {
      storeContext(runtime, undefined, {
        ...aggregate,
        breakdown: { categories: invalid } as ChatContextBreakdown,
      })
      expect(backend.contextUsage()).toEqual(aggregate)
    }
  })
})
