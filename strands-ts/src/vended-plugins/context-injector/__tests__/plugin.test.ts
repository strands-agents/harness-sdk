import { describe, it, expect, vi } from 'vitest'
import { ContextInjector } from '../plugin.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import { Message, TextBlock } from '../../../types/messages.js'
import type { InvokeModelContext } from '../../../middleware/index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import type { StreamOptions } from '../../../models/model.js'
import { anyTrackingId } from '../../../__fixtures__/message-helpers.js'

const user = (text: string) => new Message({ role: 'user', content: [new TextBlock(text)] })
const assistant = (text: string) => new Message({ role: 'assistant', content: [new TextBlock(text)] })

// Builds a mock agent that captures addMiddleware registrations, with a real appState/cancelSignal.
function makeAgent() {
  const addMiddleware = vi.fn()
  const agent = createMockAgent({ extra: { addMiddleware } as never })
  return { agent, addMiddleware }
}

describe('ContextInjector', () => {
  describe('plugin interface', () => {
    it('defaults to the strands:context-injector name', () => {
      expect(new ContextInjector({ renderContent: async () => 'x' }).name).toBe('strands:context-injector')
    })

    it('honors a custom name (so multiple injectors can be told apart)', () => {
      expect(new ContextInjector({ name: 'now', renderContent: async () => 'x' }).name).toBe('now')
    })

    it('registers an InvokeModelStage input middleware on initAgent', () => {
      const { agent, addMiddleware } = makeAgent()
      new ContextInjector({ renderContent: async () => 'x' }).initAgent(agent)

      expect(addMiddleware).toHaveBeenCalledTimes(1)
      expect(addMiddleware.mock.calls[0]![0]).toBe(InvokeModelStage.Input)
      expect(typeof addMiddleware.mock.calls[0]![1]).toBe('function')
    })
  })

  describe('registered handler', () => {
    // Runs the handler the plugin registered, with a context backed by the mock agent.
    async function run(plugin: ContextInjector, messages: Message[]) {
      const { agent, addMiddleware } = makeAgent()
      plugin.initAgent(agent)
      const handler = addMiddleware.mock.calls[0]![1] as (ctx: InvokeModelContext) => Promise<InvokeModelContext>
      return handler({ messages, agent } as unknown as InvokeModelContext)
    }

    it('folds renderContent() text into the latest user message', async () => {
      const result = await run(new ContextInjector({ renderContent: async () => 'INJECTED' }), [
        assistant('prior'),
        user('ask'),
      ])
      expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
        { role: 'assistant', content: [{ text: 'prior' }], trackingId: anyTrackingId },
        {
          role: 'user',
          content: [{ text: 'ask' }, { text: '\n\nINJECTED' }],
          trackingId: anyTrackingId,
        },
      ])
    })

    it('skips on a non-user turn by default (userTurn trigger)', async () => {
      const renderContent = vi.fn(async () => 'x')
      const input = [user('ask'), assistant('reply')]
      const result = await run(new ContextInjector({ renderContent }), input)
      expect(renderContent).not.toHaveBeenCalled()
      expect(result.messages).toBe(input)
    })

    it("'everyTurn' injects regardless of the latest role", async () => {
      const result = await run(new ContextInjector({ trigger: 'everyTurn', renderContent: async () => 'INJECTED' }), [
        user('ask'),
        assistant('reply'),
      ])
      // No later user message than index 0, so the fold targets it.
      expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
        {
          role: 'user',
          content: [{ text: 'ask' }, { text: '\n\nINJECTED' }],
          trackingId: anyTrackingId,
        },
        { role: 'assistant', content: [{ text: 'reply' }], trackingId: anyTrackingId },
      ])
    })

    it('exposes appState and the agent to renderContent', async () => {
      const { agent, addMiddleware } = makeAgent()
      let sawAgent = false
      let sawAppState = false
      new ContextInjector({
        renderContent: async (ctx) => {
          sawAgent = ctx.agent === agent
          sawAppState = ctx.appState === agent.appState
          return undefined
        },
      }).initAgent(agent)
      const handler = addMiddleware.mock.calls[0]![1] as (ctx: InvokeModelContext) => Promise<InvokeModelContext>
      await handler({ messages: [user('ask')], agent } as unknown as InvokeModelContext)

      expect(sawAgent).toBe(true)
      expect(sawAppState).toBe(true)
    })

    it('fails open (passes context through) when renderContent throws', async () => {
      const result = await run(
        new ContextInjector({
          renderContent: async () => {
            throw new Error('boom')
          },
        }),
        [assistant('prior'), user('ask')]
      )
      // Unchanged: the original messages, no injected block.
      expect(result.messages.map((m) => m.toJSON())).toStrictEqual([
        { role: 'assistant', content: [{ text: 'prior' }], trackingId: anyTrackingId },
        { role: 'user', content: [{ text: 'ask' }], trackingId: anyTrackingId },
      ])
    })
  })

  describe('per-call trailing blocks handoff to the provider', () => {
    // The boundary must survive the whole chain, so these go through a real Agent.
    const trailingBlocksSeen = (model: MockMessageModel): number[] => {
      const seen: number[] = []
      const original = model.stream.bind(model)
      model.stream = async function* mockStream(messages, options?: StreamOptions) {
        seen.push(options?.dynamicTrailingBlocks ?? 0)
        yield* original(messages, options)
      } as typeof model.stream
      return seen
    }

    it('reaches the model when an injector is active', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const seen = trailingBlocksSeen(model)
      const agent = new Agent({
        model,
        plugins: [new ContextInjector({ renderContent: async () => '<ctx>EPHEMERAL</ctx>' })],
      })

      await agent.invoke('what is the weather?')

      expect(seen).toStrictEqual([1])
    })

    it('is absent without an injector, so an ordinary call is unchanged', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const seen = trailingBlocksSeen(model)
      const agent = new Agent({ model })

      await agent.invoke('what is the weather?')

      expect(seen).toStrictEqual([0])
    })
  })
})
