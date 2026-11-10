import { describe, expect, it, vi } from 'vitest'

import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { CancelledError } from '../../../errors.js'
import { AfterModelCallEvent, BeforeInvocationEvent } from '../../../hooks/events.js'
import { ToolRegistry } from '../../../registry/tool-registry.js'
import { Message, TextBlock } from '../../../types/messages.js'
import { ModelRouter, RoutingCandidate } from '../router.js'
import type { InvocationState, LocalAgent } from '../../../types/agent.js'
import type { HookCallbackOptions, HookableEventConstructor } from '../../../hooks/types.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { RoutingContext, RoutingStrategy } from '../strategy.js'

interface RegisteredHook {
  callback: (event: never) => void | Promise<void>
  options?: HookCallbackOptions
}

function model(text = 'ok'): MockMessageModel {
  return new MockMessageModel().addTurn({ type: 'textBlock', text })
}

function candidate(modelValue = model(), name?: string): RoutingCandidate {
  return new RoutingCandidate({ model: modelValue, ...(name !== undefined && { name }) })
}

function mockAgent(
  modelValue: MockMessageModel,
  systemPrompt?: string
): {
  agent: LocalAgent
  hooks: Map<HookableEventConstructor, RegisteredHook[]>
  middleware: ((context: InvokeModelContext) => Promise<InvokeModelContext>)[]
} {
  const hooks = new Map<HookableEventConstructor, RegisteredHook[]>()
  const middleware: ((context: InvokeModelContext) => Promise<InvokeModelContext>)[] = []
  const agent = {
    id: 'duplicate-caller-id',
    model: modelValue,
    messages: [new Message({ role: 'user', content: [new TextBlock('hello')] })],
    systemPrompt,
    toolRegistry: new ToolRegistry(),
    addHook: vi.fn((eventType, callback, options) => {
      const entries = hooks.get(eventType) ?? []
      entries.push({ callback, ...(options !== undefined && { options }) })
      hooks.set(eventType, entries)
      return (): void => {}
    }),
    addMiddleware: vi.fn((_phase, handler) => {
      middleware.push(handler)
      return (): void => {}
    }),
  } as unknown as LocalAgent
  return { agent, hooks, middleware }
}

function invokeContext(agent: LocalAgent, invocationState: InvocationState): InvokeModelContext {
  return {
    agent,
    model: agent.model,
    messages: agent.messages,
    ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
    toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
    invocationState,
  }
}

async function selectViaMiddleware(
  router: ModelRouter,
  mocked: ReturnType<typeof mockAgent>,
  invocationState: InvocationState
): Promise<unknown> {
  router.attachToAgent(mocked.agent)
  return (await mocked.middleware.at(-1)!(invokeContext(mocked.agent, invocationState))).model
}

function afterModelHook(hooks: Map<HookableEventConstructor, RegisteredHook[]>): RegisteredHook {
  return hooks.get(AfterModelCallEvent)![0]!
}

function failureEvent(
  agent: LocalAgent,
  selectedModel: MockMessageModel,
  invocationState: InvocationState,
  error = new Error('down')
): AfterModelCallEvent {
  return new AfterModelCallEvent({
    agent,
    model: selectedModel,
    attemptCount: 1,
    invocationState,
    error,
  })
}

class RecordingStrategy implements RoutingStrategy {
  readonly contexts: RoutingContext[] = []
  private readonly _indexes: number[]

  constructor(...indexes: number[]) {
    this._indexes = indexes
  }

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    this.contexts.push(context)
    const index = this._indexes.shift()
    return index === undefined ? undefined : context.candidates[index]
  }
}

describe('RoutingCandidate', () => {
  describe('constructor', () => {
    it('freezes candidate topology while preserving model and candidate identity', () => {
      const selectedModel = model()
      const selected = new RoutingCandidate({
        model: selectedModel,
        name: 'vision',
        description: 'Handles images',
      })
      const router = new ModelRouter([selected])

      expect(router.candidates).toEqual([selected])
      expect(router.candidates[0]).toBe(selected)
      expect(selected.model).toBe(selectedModel)
      expect(Object.isFrozen(selected)).toBe(true)
      expect(Object.isFrozen(router.candidates)).toBe(true)
    })

    it('preserves caller metadata and validates that it is a JSON-serializable object', () => {
      const metadata = { modelId: 'fast-v1', supportsToolUse: true }
      const withMetadata = new RoutingCandidate({ model: model(), metadata })

      expect(withMetadata.metadata).toBe(metadata)
      expect(() => new RoutingCandidate({ model: model(), metadata: [] as never })).toThrow(
        'metadata must be an object'
      )
      expect(() => new RoutingCandidate({ model: model(), metadata: { run: (() => {}) as never } })).toThrow(
        'cannot be serialized'
      )
      expect(() => new RoutingCandidate({ model: model(), metadata: { score: Number.NaN } })).toThrow(
        'non-finite number'
      )
    })

    it('allows subclasses to initialize strategy-specific metadata', () => {
      class PricedCandidate extends RoutingCandidate {
        readonly cost: number

        constructor(modelValue: MockMessageModel, cost: number) {
          super({ model: modelValue })
          this.cost = cost
          Object.freeze(this)
        }
      }

      const selected = new PricedCandidate(model(), 2)

      expect(selected.cost).toBe(2)
      expect(Object.isFrozen(selected)).toBe(true)
    })
  })
})

describe('ModelRouter', () => {
  describe('constructor', () => {
    it('normalizes models and exposes stable plugin configuration', () => {
      const first = model('first')
      const nestedDefault = model('nested')
      const nested = new ModelRouter([nestedDefault])
      const router = new ModelRouter([first, nested])

      expect({ name: router.name, candidates: router.candidates, defaultModel: router.defaultModel }).toEqual({
        name: 'strands:model-router',
        candidates: [expect.objectContaining({ model: first }), expect.objectContaining({ model: nested })],
        defaultModel: first,
      })
      expect(new ModelRouter([nested]).defaultModel).toBe(nestedDefault)
    })
    it.each([
      { name: 'non-array models', build: () => new ModelRouter('model' as never), message: 'sequence' },
      { name: 'empty models', build: () => new ModelRouter([]), message: 'at least one' },
      { name: 'invalid candidate', build: () => new ModelRouter([{} as never]), message: 'Model or ModelRouter' },
      {
        name: 'strategy without select',
        build: () => new ModelRouter([model()], { strategy: {} as RoutingStrategy }),
        message: 'select(context)',
      },
      {
        name: 'negative switch cap',
        build: () => new ModelRouter([model()], { maxSwitches: -1 }),
        message: 'non-negative integer',
      },
      {
        name: 'non-integer switch cap',
        build: () => new ModelRouter([model()], { maxSwitches: Number.NaN }),
        message: 'non-negative integer',
      },
    ])('rejects $name', ({ build, message }) => {
      expect(build).toThrow(message)
    })

    it('accepts a non-async select method that returns a Promise', async () => {
      const first = model('first')
      const strategy: RoutingStrategy = {
        select: vi.fn((context: RoutingContext) => Promise.resolve(context.candidates[0])),
      }
      const router = new ModelRouter([first], { strategy })
      const mocked = mockAgent(first)
      router.attachToAgent(mocked.agent)

      const transformed = await mocked.middleware[0]!(invokeContext(mocked.agent, {}))

      expect(transformed.model).toBe(first)
      expect(strategy.select).toHaveBeenCalledOnce()
    })

    it('rejects stateful models and duplicate topology', () => {
      class StatefulModel extends MockMessageModel {
        override get stateful(): boolean {
          return true
        }
      }
      const shared = model()
      const duplicateCandidate = candidate(model(), 'same')

      expect(() => new ModelRouter([new StatefulModel()])).toThrow('stateful')
      expect(() => new ModelRouter([shared, shared])).toThrow('repeats a model')
      expect(() => new ModelRouter([duplicateCandidate, duplicateCandidate])).toThrow('duplicate RoutingCandidate')
      expect(() => new ModelRouter([candidate(model(), 'same'), candidate(model(), 'same')])).toThrow(
        'duplicate candidate name'
      )
      expect(() => new ModelRouter([shared, new ModelRouter([shared])])).toThrow('repeats a model')
    })
  })

  describe('selection middleware', () => {
    it('selects once per agent and invocation while supplying fresh isolated request copies', async () => {
      const first = model('first')
      const second = model('second')
      const strategy = new RecordingStrategy(1, 0)
      const router = new ModelRouter([first, second], { strategy })
      const mocked = mockAgent(first, 'Be precise')
      const state: InvocationState = { callerValue: 1 }

      const selected = await selectViaMiddleware(router, mocked, state)
      strategy.contexts[0]!.messages[0]!.content.push(new TextBlock('mutated copy'))
      const cached = await selectViaMiddleware(router, mocked, state)

      expect({ selected, cached, calls: strategy.contexts.length, messages: mocked.agent.messages }).toEqual({
        selected: second,
        cached: second,
        calls: 1,
        messages: [expect.objectContaining({ content: [expect.objectContaining({ text: 'hello' })] })],
      })
      expect(strategy.contexts[0]!.invocationState).toBe(state)
      expect(strategy.contexts[0]!.systemPrompt).toBe('Be precise')
      expect(strategy.contexts[0]!.candidates[1]).toBe(router.candidates[1])
    })

    it('keys cached state by router and agent object identity rather than caller id', async () => {
      const first = model('first')
      const strategy = new RecordingStrategy(0, 0, 0)
      const routerOne = new ModelRouter([first], { strategy })
      const routerTwo = new ModelRouter([model('other')], { strategy })
      const one = mockAgent(first)
      const two = mockAgent(first)
      const state: InvocationState = {}

      await selectViaMiddleware(routerOne, one, state)
      await selectViaMiddleware(routerOne, two, state)
      await selectViaMiddleware(routerTwo, one, state)

      expect(Object.keys(state).filter((key) => key.startsWith('strands:modelRouting'))).toHaveLength(3)
      expect(strategy.contexts).toHaveLength(3)
    })
  })
  describe('initAgent', () => {
    it('registers idempotent middleware, routing hook, and scoped boundary cleanup', async () => {
      const first = model('first')
      const second = model('second')
      const strategy = new RecordingStrategy(1, 0)
      const router = new ModelRouter([first, second], { strategy })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = { keep: true }

      router.attachToAgent(agent)
      router.attachToAgent(agent)
      const transformed = await middleware[0]!(invokeContext(agent, state))

      expect((transformed as InvokeModelContext & { model: MockMessageModel }).model).toBe(second)
      expect(middleware).toHaveLength(1)
      expect(strategy.contexts).toHaveLength(1)
      expect(afterModelHook(hooks).options).toEqual({ order: 50 })

      const before = hooks.get(BeforeInvocationEvent)![0]!
      await before.callback(new BeforeInvocationEvent({ agent, invocationState: state }) as never)
      expect(state).toEqual({ keep: true })
      expect(router.getRoutedModel(agent, state)).toBeUndefined()
    })

    it('rejects plugin initialization even when another router shares the default model', () => {
      const shared = model('shared')
      const configured = new ModelRouter([shared])
      const foreign = new ModelRouter([shared])
      const { agent } = mockAgent(shared)
      configured.attachToAgent(agent)

      expect(() => foreign.initAgent(agent)).toThrow('Agent({ model })')
    })
  })

  describe('failure routing', () => {
    it('ignores cancellation without recording a failure or selecting another candidate', async () => {
      const first = model('first')
      const second = model('second')
      const strategy = new RecordingStrategy(0, 1)
      const router = new ModelRouter([first, second], { strategy })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const cancelled = failureEvent(agent, first, state, new CancelledError())
      await afterModelHook(hooks).callback(cancelled as never)

      expect({
        retry: cancelled.retry,
        model: router.getRoutedModel(agent, state),
        strategyCalls: strategy.contexts.length,
      }).toEqual({ retry: undefined, model: first, strategyCalls: 1 })

      const failed = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(failed as never)

      expect(strategy.contexts[1]!.attempts).toEqual([
        expect.objectContaining({ candidate: router.candidates[0], exception: failed.error }),
      ])
      expect({ retry: failed.retry, model: router.getRoutedModel(agent, state) }).toEqual({
        retry: true,
        model: second,
      })
    })

    it('records complete outcomes, switches once, and opens a new round after success', async () => {
      const first = model('first')
      const second = model('second')
      const strategy = new RecordingStrategy(0, 1, 0)
      const router = new ModelRouter([first, second], { strategy })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const failed = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(failed as never)
      expect({ retry: failed.retry, model: router.getRoutedModel(agent, state) }).toEqual({
        retry: true,
        model: second,
      })

      const succeeded = new AfterModelCallEvent({
        agent,
        model: second,
        attemptCount: 1,
        invocationState: state,
        stopData: {
          message: new Message({ role: 'assistant', content: [new TextBlock('ok')] }),
          stopReason: 'endTurn',
        },
      })
      await afterModelHook(hooks).callback(succeeded as never)
      const failedAgain = failureEvent(agent, second, state)
      await afterModelHook(hooks).callback(failedAgain as never)

      expect({ retry: failedAgain.retry, model: router.getRoutedModel(agent, state) }).toEqual({
        retry: true,
        model: first,
      })
      expect(strategy.contexts.map((context) => context.attempts.length)).toEqual([0, 1, 3])
      expect(strategy.contexts[1]!.attempts[0]!.candidate).toBe(router.candidates[0])
    })
    it('consumes an unresolvable nested candidate and continues to a healthy candidate', async () => {
      const first = model('first')
      const backup = model('backup')
      const nestedContexts: RoutingContext[] = []
      const nested = new ModelRouter([model('nested')], {
        strategy: {
          async select(context): Promise<RoutingCandidate | undefined> {
            nestedContexts.push(context)
            throw new Error('nested resolution failed')
          },
        },
      })
      const strategy = new RecordingStrategy(0, 1, 2)
      const router = new ModelRouter([first, new RoutingCandidate({ model: nested, name: 'broken' }), backup], {
        strategy,
      })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const failed = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(failed as never)

      expect({ retry: failed.retry, model: router.getRoutedModel(agent, state) }).toEqual({
        retry: true,
        model: backup,
      })
      expect(strategy.contexts[2]!.attempts).toEqual([
        expect.objectContaining({ candidate: router.candidates[0], exception: failed.error }),
        expect.objectContaining({ candidate: router.candidates[1], exception: expect.any(Error) }),
      ])
      expect(nestedContexts[0]!.attempts).toEqual([])
    })

    it('stops when a strategy repeats an unresolvable candidate in the same round', async () => {
      const first = model('first')
      const backup = model('backup')
      const nested = new ModelRouter([model('nested')], {
        strategy: {
          async select(): Promise<RoutingCandidate | undefined> {
            throw new Error('nested resolution failed')
          },
        },
      })
      const strategy = new RecordingStrategy(0, 1, 1, 2)
      const router = new ModelRouter([first, new RoutingCandidate({ model: nested, name: 'broken' }), backup], {
        strategy,
      })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const failed = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(failed as never)

      expect({
        retry: failed.retry,
        model: router.getRoutedModel(agent, state),
        strategyCalls: strategy.contexts.length,
      }).toEqual({
        retry: undefined,
        model: first,
        strategyCalls: 3,
      })
    })

    it('does not replace a pending model error when strategy selection fails or repeats a used candidate', async () => {
      const first = model('first')
      let calls = 0
      const router = new ModelRouter([first, model('backup')], {
        strategy: {
          async select(context): Promise<RoutingCandidate | undefined> {
            calls += 1
            if (calls === 1) return context.candidates[0]
            if (calls === 2) throw new Error('routing failure')
            return context.candidates[0]
          },
        },
      })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const selectionFailure = failureEvent(agent, first, state, new Error('original model error'))
      await afterModelHook(hooks).callback(selectionFailure as never)
      expect(selectionFailure.retry).toBeUndefined()

      const repeatState: InvocationState = {}
      await middleware[0]!(invokeContext(agent, repeatState))
      const repeated = failureEvent(agent, first, repeatState)
      await afterModelHook(hooks).callback(repeated as never)
      expect(repeated.retry).toBeUndefined()
    })

    it('honors maxSwitches as a cap on successful switches', async () => {
      const first = model('first')
      const strategy = new RecordingStrategy(0, 1)
      const router = new ModelRouter([first, model('second')], { strategy, maxSwitches: 0 })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const failed = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(failed as never)

      expect({
        retry: failed.retry,
        model: router.getRoutedModel(agent, state),
        calls: strategy.contexts.length,
      }).toEqual({
        retry: undefined,
        model: first,
        calls: 1,
      })
    })

    it('allows exactly maxSwitches successful candidate changes', async () => {
      const first = model('first')
      const second = model('second')
      const third = model('third')
      const strategy = new RecordingStrategy(0, 1, 2)
      const router = new ModelRouter([first, second, third], { strategy, maxSwitches: 1 })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const firstFailure = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(firstFailure as never)
      const secondFailure = failureEvent(agent, second, state)
      await afterModelHook(hooks).callback(secondFailure as never)

      expect(firstFailure.retry).toBe(true)
      expect(secondFailure.retry).toBeUndefined()
      expect(router.getRoutedModel(agent, state)).toBe(second)
      expect(strategy.contexts).toHaveLength(2)
    })

    it('bounds a failure round when a strategy cycles to an already-used candidate', async () => {
      const first = model('first')
      const second = model('second')
      const router = new ModelRouter([first, second], { strategy: new RecordingStrategy(0, 1, 0) })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const firstFailure = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(firstFailure as never)
      const secondFailure = failureEvent(agent, second, state)
      await afterModelHook(hooks).callback(secondFailure as never)

      expect(firstFailure.retry).toBe(true)
      expect(secondFailure.retry).toBeUndefined()
      expect(router.getRoutedModel(agent, state)).toBe(second)
    })

    it('keeps the successful candidate used when opening the next failure round', async () => {
      const first = model('first')
      const second = model('second')
      const router = new ModelRouter([first, second], { strategy: new RecordingStrategy(0, 1, 1) })
      const { agent, hooks, middleware } = mockAgent(first)
      const state: InvocationState = {}
      router.attachToAgent(agent)
      await middleware[0]!(invokeContext(agent, state))

      const firstFailure = failureEvent(agent, first, state)
      await afterModelHook(hooks).callback(firstFailure as never)
      await afterModelHook(hooks).callback(
        new AfterModelCallEvent({
          agent,
          model: second,
          attemptCount: 1,
          invocationState: state,
          stopData: {
            message: new Message({ role: 'assistant', content: [new TextBlock('ok')] }),
            stopReason: 'endTurn',
          },
        }) as never
      )
      const nextFailure = failureEvent(agent, second, state)
      await afterModelHook(hooks).callback(nextFailure as never)

      expect(nextFailure.retry).toBeUndefined()
      expect(router.getRoutedModel(agent, state)).toBe(second)
    })
  })

  describe('opening selection', () => {
    it('uses the default on decline and propagates invalid opening results', async () => {
      const first = model('first')
      const declining = new ModelRouter([first], { strategy: new RecordingStrategy() })
      const decliningAgent = mockAgent(first)
      expect(await selectViaMiddleware(declining, decliningAgent, {})).toBe(first)

      const invalid = new ModelRouter([first], {
        strategy: {
          async select(): Promise<RoutingCandidate> {
            return candidate(model('foreign'))
          },
        },
      })
      await expect(selectViaMiddleware(invalid, mockAgent(first), {})).rejects.toThrow('context.candidates')
    })

    it('rejects null because only undefined declines selection', async () => {
      const first = model('first')
      const router = new ModelRouter([first], {
        strategy: {
          async select() {
            return null
          },
        } as unknown as RoutingStrategy,
      })

      await expect(selectViaMiddleware(router, mockAgent(first), {})).rejects.toThrow(
        'strategy.select must return a RoutingCandidate or undefined; got null'
      )
    })
  })
})
