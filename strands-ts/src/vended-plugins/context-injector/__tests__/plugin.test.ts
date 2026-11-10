import { describe, it, expect, vi } from 'vitest'
import { ContextInjector } from '../plugin.js'
import type { ContextInjectorConfig } from '../plugin.js'
import { InjectedBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ContentBlock, MessageData } from '../../../types/messages.js'
import { AfterModelCallEvent, BeforeModelCallEvent, MessageAddedEvent } from '../../../hooks/events.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import { continuations } from '../../../agent/continuation.js'
import { Agent } from '../../../agent/agent.js'
import type { AgentConfig } from '../../../agent/agent.js'
import { Offload } from '../../../context-manager/strategies/offload/index.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { logger } from '../../../logging/logger.js'
import type { StreamOptions } from '../../../models/model.js'
import type { InjectionContext } from '../../../injection/types.js'
import type { Tool } from '../../../tools/tool.js'
import type { Plugin } from '../../../plugins/plugin.js'

const injected = (text: string, source = 'test') => new InjectedBlock({ text, source })

describe('ContextInjector', () => {
  describe('plugin interface', () => {
    it('defaults to the strands:context-injector name', () => {
      expect(new ContextInjector({ renderContent: async () => 'x' }).name).toBe('strands:context-injector')
    })

    it('honors a custom name (so multiple injectors can be told apart)', () => {
      expect(new ContextInjector({ name: 'now', renderContent: async () => 'x' }).name).toBe('now')
    })

    it('registers an InvokeModelStage input middleware on initAgent', () => {
      const addMiddleware = vi.fn()
      const agent = createMockAgent({ extra: { addMiddleware } as never })
      new ContextInjector({ renderContent: async () => 'x' }).initAgent(agent)

      expect(addMiddleware.mock.calls.map(([stage]) => stage)).toStrictEqual([InvokeModelStage.Input])
    })
  })

  describe('with an agent', () => {
    it('sends the injected text last and keeps the cache point ahead of it', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const seen: { lastBlock: ContentBlock | undefined; dynamicTrailingBlocks: number }[] = []
      const original = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation(async function* (messages, options?: StreamOptions) {
        seen.push({
          lastBlock: messages.at(-1)?.content.at(-1),
          dynamicTrailingBlocks: options?.dynamicTrailingBlocks ?? 0,
        })
        yield* original(messages, options)
      })
      const agent = new Agent({
        model,
        printer: false,
        plugins: [new ContextInjector({ renderContent: async () => '<ctx>INJECTED</ctx>' })],
      })

      await agent.invoke('what is the weather?')

      expect(seen).toStrictEqual([
        {
          lastBlock: new TextBlock('\n\n<ctx>INJECTED</ctx>'),
          dynamicTrailingBlocks: 1,
        },
      ])
    })
  })

  describe('writing into the conversation', () => {
    /** An agent with one injection and a record of the messages each model call received. */
    function setup(
      model: MockMessageModel,
      options: Omit<ContextInjectorConfig, 'name'>,
      tools: Tool[] = [],
      config: Pick<AgentConfig, 'contextManager'> = {}
    ) {
      const agent = new Agent({
        model,
        printer: false,
        tools,
        ...config,
        plugins: [new ContextInjector({ name: 'test', ...options })],
      })
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

    it('writes the text into the latest user message as an injected block under its name, sent as text', async () => {
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
      const agent = new Agent({
        model,
        printer: false,
        plugins: [
          new ContextInjector({ name: 'memory', renderContent: async () => 'likes tea' }),
          new ContextInjector({ name: 'env', renderContent: async () => 'cwd: /repo' }),
        ],
      })

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

    it('keeps every request a prefix of the next for a model that takes temporary messages', async () => {
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

    it('writes into the result a background task delivers before the model call', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'one' })
        .addTurn({ type: 'textBlock', text: 'two' })
      const { agent, requests } = setup(model, { trigger: 'everyTurn', renderContent: async () => 'reminder' })
      await agent.invoke('Run work.')
      agent.addHook(BeforeModelCallEvent, (event) => {
        continuations.addInput(event, {
          args: [
            new Message({
              role: 'assistant',
              content: [new ToolUseBlock({ name: 'task', toolUseId: 'task-1', input: {} })],
            }),
            new Message({
              role: 'user',
              content: [
                new ToolResultBlock({ toolUseId: 'task-1', status: 'success', content: [new TextBlock('done')] }),
              ],
            }),
          ],
        })
      })

      await agent.invoke('Continue.')

      expect(requests[1]!.at(-1)!.content).toStrictEqual([
        expect.objectContaining({ toolResult: expect.anything() }),
        { text: '\n\nreminder' },
      ])
    })

    it('keeps text other middleware adds for one call after the injected block', async () => {
      const model = new MockMessageModel().addTurn(new Error('throttled')).addTurn({ type: 'textBlock', text: 'ok' })
      const perCall: Plugin = {
        name: 'per-call',
        initAgent: (agent) => {
          agent.addMiddleware(InvokeModelStage.Input, async (context) => {
            const messages = [...context.messages]
            const latest = messages.at(-1)!
            messages[messages.length - 1] = new Message({
              role: 'user',
              content: [...latest.content, new TextBlock('\n\nper-call')],
              trackingId: latest.trackingId,
            })
            return { ...context, messages }
          })
        },
      }
      const agent = new Agent({
        model,
        printer: false,
        plugins: [perCall, new ContextInjector({ name: 'test', renderContent: async () => 'reminder' })],
      })
      const requests: MessageData[][] = []
      const originalStream = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation(async function* (messages, streamOptions) {
        requests.push(messages.map((message) => message.toJSON()))
        yield* originalStream(messages, streamOptions)
      })
      agent.addHook(AfterModelCallEvent, (event) => {
        if (event.error) event.retry = true
      })

      await agent.invoke('ask')

      expect(requests[0]![0]!.content).toStrictEqual([
        { text: 'ask' },
        { text: '\n\nreminder' },
        { text: '\n\nper-call' },
      ])
      expect(requests[1]).toStrictEqual(requests[0])
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
})
