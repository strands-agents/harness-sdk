import { describe, it, expect, vi } from 'vitest'
import { InjectedBlock, Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { MessageData } from '../../types/messages.js'
import {
  addInjection,
  createInjectionMiddleware,
  foldIntoLastUserMessage,
  isUserTurn,
  resolveTrigger,
} from '../message-injection.js'
import type { InvokeModelContext } from '../../middleware/index.js'
import type { InjectionContext, InjectionOptions } from '../types.js'
import { Agent } from '../../agent/agent.js'
import type { AgentConfig } from '../../agent/agent.js'
import { Offload } from '../../context-manager/strategies/offload/index.js'
import { AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent } from '../../hooks/events.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { logger } from '../../logging/logger.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'
import type { Tool } from '../../tools/tool.js'

const user = (text: string) => new Message({ role: 'user', content: [new TextBlock(text)] })
const assistant = (text: string) => new Message({ role: 'assistant', content: [new TextBlock(text)] })
const toolResult = () =>
  new Message({
    role: 'user',
    content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('done')] })],
  })
const injected = (text: string, source = 'test') => new InjectedBlock({ text, source })

// resolveTrigger predicates take an InjectionContext; tests only exercise `messages`, so a minimal bag suffices.
const injectionCtx = (messages: MessageData[]) => ({ messages }) as unknown as InjectionContext

describe('foldIntoLastUserMessage', () => {
  it('appends the text as a trailing TextBlock on the last user message, behind its content', () => {
    const messages = [user('original task'), assistant('prior step'), user('next ask')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    // A trailing run is the only placement a provider can keep out of its cached prefix.
    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'original task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'prior step' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'next ask' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
    expect(result.appended).toBe(1)
  })

  it('preserves the folded-into message tracking id (same logical message)', () => {
    const target = new Message({ role: 'user', content: [new TextBlock('ask')], trackingId: 'durable-1' })
    const result = foldIntoLastUserMessage([assistant('prior'), target], 'INJECTED')

    // Folding rewrites content but it is the same message, so its tracking id must survive.
    expect(result.messages[1]!.trackingId).toBe('durable-1')
  })

  it('returns a new array and does not mutate the input or its messages', () => {
    const original = user('ask')
    const messages = [assistant('prior'), original]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    expect(result.messages).not.toBe(messages)
    expect(messages[1]).toBe(original)
    expect(original.content).toHaveLength(1) // untouched
    expect(result.messages[1]).not.toBe(original)
  })

  it('appends after the tool result block when the target is a tool-result turn', () => {
    const tr = toolResult()
    const result = foldIntoLastUserMessage([user('task'), assistant('thinking'), tr], 'INJECTED')

    // A tool result must stay first in the turn answering a tool use; appending satisfies that.
    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'thinking' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [tr.toJSON().content[0], { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('targets the most recent user message when several exist', () => {
    const messages = [user('first'), assistant('a'), user('second')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')

    expect(result.messages.map((message) => message.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'first' }], trackingId: anyTrackingId }, // earlier user untouched
      { role: 'assistant', content: [{ text: 'a' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'second' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('preserves message metadata on the folded message', () => {
    const tagged = new Message({
      role: 'user',
      content: [new TextBlock('ask')],
      metadata: { custom: { keep: 'me' } },
    })
    const result = foldIntoLastUserMessage([tagged], 'INJECTED')
    expect(result.messages[0]!.metadata?.custom).toStrictEqual({ keep: 'me' })
  })

  it('returns the input unchanged when there is no user message', () => {
    const messages = [assistant('only assistant')]
    const result = foldIntoLastUserMessage(messages, 'INJECTED')
    expect(result.messages).toBe(messages)
    expect(result.appended).toBe(0)
  })

  it('reports no per-call trailing blocks when the fold target is not the last message', () => {
    // Counting an earlier message's blocks would make the provider count back through the wrong one.
    const result = foldIntoLastUserMessage([user('ask'), assistant('reply')], 'INJECTED')

    expect(result.messages[0]!.toJSON().content).toStrictEqual([{ text: 'ask' }, { text: '\n\nINJECTED' }])
    expect(result.appended).toBe(0)
  })

  it('omits the blank-line separator when the target message has no content', () => {
    const result = foldIntoLastUserMessage([new Message({ role: 'user', content: [] })], 'INJECTED')
    expect(result.messages[0]!.toJSON().content).toStrictEqual([{ text: 'INJECTED' }])
  })
})

describe('isUserTurn', () => {
  it('is true when the last message is a plain user ask', () => {
    expect(isUserTurn([assistant('prior').toJSON(), user('ask').toJSON()])).toBe(true)
  })

  it('is false when the last message is a user tool-result turn', () => {
    expect(isUserTurn([user('task').toJSON(), assistant('a').toJSON(), toolResult().toJSON()])).toBe(false)
  })

  it('is false when the last message is an assistant message', () => {
    expect(isUserTurn([user('ask').toJSON(), assistant('reply').toJSON()])).toBe(false)
  })

  it('is false for an empty conversation', () => {
    expect(isUserTurn([])).toBe(false)
  })
})

describe('resolveTrigger', () => {
  it('defaults (undefined) to the userTurn policy', () => {
    const trigger = resolveTrigger(undefined)
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(false)
  })

  it("'userTurn' uses isUserTurn", () => {
    const trigger = resolveTrigger('userTurn')
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(false)
  })

  it("'everyTurn' always fires", () => {
    const trigger = resolveTrigger('everyTurn')
    expect(trigger(injectionCtx([]))).toBe(true)
    expect(trigger(injectionCtx([toolResult().toJSON()]))).toBe(true)
  })

  it('uses a custom predicate over the context', () => {
    const trigger = resolveTrigger((context) => context.messages.length >= 2)
    expect(trigger(injectionCtx([user('a').toJSON()]))).toBe(false)
    expect(trigger(injectionCtx([user('a').toJSON(), assistant('b').toJSON()]))).toBe(true)
  })

  it('fails open (returns false, logs) when a custom predicate throws', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const trigger = resolveTrigger(() => {
      throw new Error('boom')
    })
    expect(trigger(injectionCtx([user('ask').toJSON()]))).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('createInjectionMiddleware', () => {
  // The handler is an InvokeModelStage.Input transformer. It reads `context.messages` and derives the
  // InjectionContext (appState/agent) from `context.agent`, then spreads the rest through, so a context
  // carrying `messages` plus a mock agent exercises it faithfully.
  const ctx = (messages: Message[]) => ({ messages, agent: createMockAgent() }) as unknown as InvokeModelContext

  it('folds renderContent() text into the latest user message, leaving other context fields intact', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
    const result = await handler(ctx([assistant('prior'), user('ask')]))

    expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
      { role: 'assistant', content: [{ text: 'prior' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [{ text: 'ask' }, { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('passes an InjectionContext carrying the conversation (as data) to renderContent', async () => {
    const seen: string[] = []
    const handler = createInjectionMiddleware({
      renderContent: async (context) => {
        seen.push(...context.messages.map((m) => m.role))
        return 'x'
      },
    })
    await handler(ctx([assistant('prior'), user('ask')]))

    expect(seen).toStrictEqual(['assistant', 'user'])
  })

  it('exposes appState and the agent on the InjectionContext', async () => {
    const appState = { get: () => 'stashed' }
    const agent = { appState } as unknown as InvokeModelContext['agent']
    const input = { messages: [user('ask')], agent } as unknown as InvokeModelContext
    let received: { appState: unknown; agent: unknown } | undefined
    const handler = createInjectionMiddleware({
      renderContent: async (context) => {
        received = { appState: context.appState, agent: context.agent }
        return undefined
      },
    })
    await handler(input)

    expect(received).toStrictEqual({ appState, agent })
  })

  it('returns the context unchanged when the trigger does not fire', async () => {
    const renderContent = vi.fn(async () => 'x')
    const handler = createInjectionMiddleware({ renderContent }) // default 'userTurn'
    const input = ctx([user('task'), assistant('a'), toolResult()])
    const result = await handler(input)

    expect(result).toBe(input)
    expect(renderContent).not.toHaveBeenCalled()
  })

  it("'everyTurn' injects on an autonomous tool-result turn, keeping the tool result first", async () => {
    const handler = createInjectionMiddleware({ trigger: 'everyTurn', renderContent: async () => 'INJECTED' })
    const tr = toolResult()
    const result = await handler(ctx([user('task'), assistant('a'), tr]))

    // The most recent user message on a tool-result turn carries the tool result, which must stay the
    // first block, so the injected text is appended after it.
    expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
      { role: 'user', content: [{ text: 'task' }], trackingId: anyTrackingId },
      { role: 'assistant', content: [{ text: 'a' }], trackingId: anyTrackingId },
      {
        role: 'user',
        content: [tr.toJSON().content[0], { text: '\n\nINJECTED' }],
        trackingId: anyTrackingId,
      },
    ])
  })

  it('returns the context unchanged when renderContent yields empty text', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => '   ' })
    const input = ctx([assistant('prior'), user('ask')])
    const result = await handler(input)

    expect(result).toBe(input)
  })

  it('fails open (returns the context unchanged, logs) when renderContent throws', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const handler = createInjectionMiddleware({
      renderContent: async () => {
        throw new Error('boom')
      },
    })
    const input = ctx([assistant('prior'), user('ask')])
    const result = await handler(input)

    expect(result).toBe(input)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not mutate the original context messages', async () => {
    const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
    const input = ctx([assistant('prior'), user('ask')])
    const before = input.messages[1]!
    await handler(input)

    expect(before.content).toHaveLength(1) // the original user message is untouched
  })

  describe('per-call trailing blocks reporting', () => {
    // The boundary a provider needs is reported on the context, not written into the messages.
    it('reports one trailing block as per-call', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
      const result = await handler(ctx([user('ask')]))

      expect(result.dynamicTrailingBlocks).toBe(1)
    })

    it('accumulates across producers on one call', async () => {
      const first = createInjectionMiddleware({ renderContent: async () => 'ONE' })
      const second = createInjectionMiddleware({ renderContent: async () => 'TWO' })

      const result = await second(await first(ctx([user('ask')])))

      expect(result.dynamicTrailingBlocks).toBe(2)
    })

    it('reports nothing when injection is skipped', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => '' })
      const result = await handler(ctx([user('ask')]))

      expect(result.dynamicTrailingBlocks ?? 0).toBe(0)
    })

    it('reports nothing when the fold target is not the last message', async () => {
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED', trigger: 'everyTurn' })
      const result = await handler(ctx([user('ask'), assistant('reply')]))

      expect(result.dynamicTrailingBlocks).toBe(0)
    })

    it('emits no cache point into the messages', async () => {
      // Most providers reject a cachePoint inside a message, so the framework never writes one.
      const handler = createInjectionMiddleware({ renderContent: async () => 'INJECTED' })
      const result = await handler(ctx([user('ask')]))

      const blocks = result.messages.flatMap((message) => (message as Message).content)
      expect(blocks.some((block) => block.type === 'cachePointBlock')).toBe(false)
    })
  })
})

describe('addInjection', () => {
  /** An agent with one injection and a record of the messages each model call received. */
  function setup(
    model: MockMessageModel,
    options: Omit<InjectionOptions, 'source'>,
    tools: Tool[] = [],
    config: Pick<AgentConfig, 'contextManager'> = {}
  ) {
    const agent = new Agent({ model, printer: false, tools, ...config })
    addInjection(agent, { source: 'test', ...options })
    const requests: MessageData[][] = []
    const originalStream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation(async function* (messages, streamOptions) {
      requests.push(messages.map((message) => message.toJSON()))
      yield* originalStream(messages, streamOptions)
    })
    return { agent, requests }
  }

  /** Every request starts with the previous request, byte for byte. */
  function expectEachRequestExtendsThePrevious(requests: MessageData[][]): void {
    for (let index = 1; index < requests.length; index++) {
      const previous = requests[index - 1]!
      expect(requests[index]!.slice(0, previous.length)).toStrictEqual(previous)
    }
  }

  it('writes the text into the latest user message as an injected block, sent to the model as text', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const { agent, requests } = setup(model, { renderContent: async () => '<memory>dark mode</memory>' })

    await agent.invoke('what theme?')

    expect(agent.messages[0]!.content).toStrictEqual([
      new TextBlock('what theme?'),
      injected('<memory>dark mode</memory>'),
    ])
    expect(requests[0]![0]!.content).toStrictEqual([
      { text: 'what theme?' },
      { text: '\n\n<memory>dark mode</memory>' },
    ])
  })

  it('fires no event for the write, so listeners keep the message as it was added', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const { agent } = setup(model, { renderContent: async () => 'reminder' })
    const added: Message[] = []
    agent.addHook(MessageAddedEvent, (event) => {
      added.push(event.message)
    })

    await agent.invoke('ask')

    expect(added.map((message) => message.content)).toStrictEqual([[new TextBlock('ask')], [new TextBlock('ok')]])
    expect(agent.messages[0]!.trackingId).toBe(added[0]!.trackingId)
  })

  it('keeps each injector apart when two write into the same message', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const agent = new Agent({ model, printer: false })
    addInjection(agent, { source: 'memory', renderContent: async () => 'likes tea' })
    addInjection(agent, { source: 'env', renderContent: async () => 'cwd: /repo' })

    await agent.invoke('ask')

    expect(agent.messages[0]!.content).toStrictEqual([
      new TextBlock('ask'),
      injected('likes tea', 'memory'),
      injected('cwd: /repo', 'env'),
    ])
  })

  it("writes on every tool-result turn with 'everyTurn', and sends only the latest text", async () => {
    let todo = 'v1'
    const tool = createMockTool('todo_write', () => {
      todo = 'v2'
      return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('saved')] })
    })
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'todo_write', toolUseId: 'tool-1', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })
    const { agent, requests } = setup(
      model,
      { trigger: 'everyTurn', renderContent: async () => `<todos>${todo}</todos>` },
      [tool]
    )

    await agent.invoke('plan the work')

    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('plan the work'), injected('<todos>v1</todos>')])
    // The tool result stays first in its message; the new list follows it.
    expect(agent.messages[2]!.content).toStrictEqual([
      expect.objectContaining({ type: 'toolResultBlock' }),
      injected('<todos>v2</todos>'),
    ])
    expect(requests).toHaveLength(2)
    expect(requests[1]![0]!.content).toStrictEqual([{ text: 'plan the work' }])
    expect(requests[1]![2]!.content).toStrictEqual([
      expect.objectContaining({ toolResult: expect.anything() }),
      { text: '\n\n<todos>v2</todos>' },
    ])
  })

  it('keeps every request a prefix of the next for a model with temporary messages', async () => {
    let todo = 'v1'
    const tool = createMockTool('todo_write', () => {
      todo = 'v2'
      return new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('saved')] })
    })
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'todo_write', toolUseId: 'tool-1', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })
      .addTurn({ type: 'textBlock', text: 'again' })
    model.updateConfig({ modelInfo: { capabilities: { temporaryMessages: true } } })
    const { agent, requests } = setup(
      model,
      { trigger: 'everyTurn', renderContent: async () => `<todos>${todo}</todos>` },
      [tool]
    )

    await agent.invoke('plan the work')
    await agent.invoke('next')

    expect(requests).toHaveLength(3)
    expectEachRequestExtendsThePrevious(requests)
    expect(requests[2]!.at(-1)!.content).toStrictEqual([
      { text: 'next' },
      { injected: { text: '<todos>v2</todos>', source: 'test' } },
    ])
  })

  it('writes on every user turn, and sends only the latest text', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'one' })
      .addTurn({ type: 'textBlock', text: 'two' })
    const { agent, requests } = setup(model, { renderContent: async () => 'cwd: /repo' })

    await agent.invoke('first')
    await agent.invoke('second')

    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('first'), injected('cwd: /repo')])
    expect(agent.messages[2]!.content).toStrictEqual([new TextBlock('second'), injected('cwd: /repo')])
    expect(requests[1]!.map((message) => message.content)).toStrictEqual([
      [{ text: 'first' }],
      [{ text: 'one' }],
      [{ text: 'second' }, { text: '\n\ncwd: /repo' }],
    ])
  })

  it('keeps injected blocks out of context offloading', async () => {
    const text = `<agents_md>${'Keep functions small. '.repeat(40)}</agents_md>`
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'one' })
      .addTurn({ type: 'textBlock', text: 'two' })
      .addTurn({ type: 'textBlock', text: 'three' })
    const { agent, requests } = setup(model, { renderContent: async () => text }, [], {
      contextManager: { strategies: [Offload.summarize('*').when({ threshold: 20 })] },
    })

    await agent.invoke('first')
    await agent.invoke('second')
    await agent.invoke('third')

    // Three requests means the summarizer never ran on the injected block.
    expect(requests).toHaveLength(3)
    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('first'), injected(text)])
  })

  it('writes into a message once, so a retry resends the same request even when the text changes', async () => {
    let renders = 0
    const model = new MockMessageModel().addTurn(new Error('throttled')).addTurn({ type: 'textBlock', text: 'ok' })
    const { agent, requests } = setup(model, { renderContent: async () => `<now>${++renders}</now>` })
    agent.addHook(AfterModelCallEvent, (event) => {
      if (event.error) event.retry = true
    })

    await agent.invoke('ask')

    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('ask'), injected('<now>1</now>')])
    expect(requests[1]).toStrictEqual(requests[0])
    expect(renders).toBe(1)
  })

  it('writes nothing when another hook cancels the model call', async () => {
    const renderContent = vi.fn(async () => 'reminder')
    const { agent } = setup(new MockMessageModel(), { renderContent })
    agent.addHook(BeforeModelCallEvent, (event) => {
      event.cancel = 'denied'
    })

    await agent.invoke('ask')

    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('ask')])
    expect(renderContent).not.toHaveBeenCalled()
  })

  it('writes into a user message another BeforeModelCallEvent hook adds', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const { agent } = setup(model, { renderContent: async () => 'reminder' })
    agent.addHook(BeforeModelCallEvent, (event) => {
      event.agent.messages.push(new Message({ role: 'user', content: [new TextBlock('[guide] be brief')] }))
    })

    await agent.invoke('ask')

    expect(agent.messages.slice(0, 2).map((message) => message.content)).toStrictEqual([
      [new TextBlock('ask')],
      [new TextBlock('[guide] be brief'), injected('reminder')],
    ])
  })

  it("does not render on a tool-result turn with the default 'userTurn' trigger", async () => {
    const tool = createMockTool(
      'lookup',
      () => new ToolResultBlock({ toolUseId: 'tool-1', status: 'success', content: [new TextBlock('found')] })
    )
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'lookup', toolUseId: 'tool-1', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })
    const renderContent = vi.fn(async () => 'reminder')
    const { agent, requests } = setup(model, { renderContent }, [tool])

    await agent.invoke('ask')

    expect(renderContent).toHaveBeenCalledTimes(1)
    expect(requests[0]![0]!.content).toStrictEqual([{ text: 'ask' }, { text: '\n\nreminder' }])
    expect(requests[1]![0]!.content).toStrictEqual([{ text: 'ask' }])
  })

  it('passes the conversation as data, appState and the agent to renderContent', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    let received: InjectionContext | undefined
    const { agent } = setup(model, {
      renderContent: async (context) => {
        received = context
        return undefined
      },
    })

    await agent.invoke('ask')

    expect(received!.messages.map((message) => message.role)).toStrictEqual(['user'])
    expect(received!.appState).toBe(agent.appState)
    expect(received!.agent).toBe(agent)
  })

  it.each([
    ['returns empty text', async () => '   '],
    [
      'throws',
      async () => {
        throw new Error('boom')
      },
    ],
  ])('leaves the conversation unchanged when renderContent %s', async (_name, renderContent) => {
    using _warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    const { agent } = setup(model, { renderContent })

    await agent.invoke('ask')

    expect(agent.messages[0]!.content).toStrictEqual([new TextBlock('ask')])
  })
})
