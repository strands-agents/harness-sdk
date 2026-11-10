import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { AgentStreamStage, ExecuteToolStage, InvokeModelStage } from '../stages.js'
import type {
  AgentStreamContext,
  ExecuteToolContext,
  InvokeModelContext,
  ExecuteToolResult,
  AgentStreamResult,
} from '../stages.js'
import type { MiddlewareHandler, MiddlewareHandlerOf } from '../types.js'
import type { AgentStreamEvent, AgentResult, LocalAgent } from '../../types/agent.js'
import type { Plugin } from '../../plugins/plugin.js'
import { TextBlock, ToolResultBlock, Message } from '../../types/messages.js'
import {
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
  BeforeToolCallEvent,
  BeforeInvocationEvent,
  AfterInvocationEvent,
  AgentResultEvent,
  ContentBlockEvent,
} from '../../hooks/events.js'
import type { ToolContext } from '../../tools/tool.js'

type ExecuteToolMiddleware = MiddlewareHandler<ExecuteToolContext, ExecuteToolResult, AgentStreamEvent>
type AgentStreamMiddleware = MiddlewareHandler<AgentStreamContext, AgentStreamResult, AgentStreamEvent>

describe('Agent middleware integration — InvokeModelStage', () => {
  describe('addMiddleware registers handler and it executes on model call', () => {
    it('middleware handler is invoked during model call', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const middlewareCalled = vi.fn()

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        middlewareCalled()
        return yield* next(context)
      })

      await agent.invoke('Test prompt')

      expect(middlewareCalled).toHaveBeenCalledOnce()
    })

    it('middleware receives InvokeModelContext with correct fields', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success' as const,
            content: [new TextBlock('ok')],
          })
      )
      const agent = new Agent({ model, tools: [tool], printer: false, systemPrompt: 'Be helpful' })

      let receivedContext: InvokeModelContext | undefined

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedContext = context
        return yield* next(context)
      })

      await agent.invoke('Test prompt')

      expect(receivedContext?.agent).toBe(agent)
      expect(receivedContext?.model).toBe(model)
      expect(receivedContext).toMatchObject({
        systemPrompt: 'Be helpful',
        messages: expect.arrayContaining([expect.any(Message)]),
        toolSpecs: expect.arrayContaining([expect.objectContaining({ name: 'testTool' })]),
        invocationState: expect.anything(),
      })
    })

    it('middleware can select the model for one call', async () => {
      const defaultModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Default response' })
      const selectedModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Selected response' })
      const defaultStreamSpy = vi.spyOn(defaultModel, 'stream')
      const agent = new Agent({ model: defaultModel, printer: false })

      agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
        ...context,
        model: selectedModel,
      }))

      const result = await agent.invoke('Test prompt')

      expect(result.lastMessage.content).toEqual([new TextBlock('Selected response')])
      expect(defaultStreamSpy).not.toHaveBeenCalled()
    })

    it('middleware result is used as the model call result', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const result = yield* next(context)
        return result
      })

      const result = await agent.invoke('Test prompt')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Hello')])
    })
  })

  describe('middleware can short-circuit model call with synthetic result', () => {
    it('returns synthetic result without calling the model', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Real response' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(
        InvokeModelStage,
        // eslint-disable-next-line require-yield
        async function* () {
          return {
            result: {
              message: new Message({ role: 'assistant', content: [new TextBlock('Cached response')] }),
              stopReason: 'endTurn' as const,
            },
          }
        }
      )

      const result = await agent.invoke('Test prompt')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Cached response')])
    })

    it('model is not called when middleware short-circuits', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Real response' })
      const agent = new Agent({ model, printer: false })

      const streamSpy = vi.spyOn(model, 'stream')

      agent.addMiddleware(
        InvokeModelStage,
        // eslint-disable-next-line require-yield
        async function* () {
          return {
            result: {
              message: new Message({ role: 'assistant', content: [new TextBlock('Cached')] }),
              stopReason: 'endTurn' as const,
            },
          }
        }
      )

      await agent.invoke('Test prompt')

      expect(streamSpy).not.toHaveBeenCalled()
    })
  })

  describe('middleware can transform context (messages, toolSpecs) before model call', () => {
    it('modified messages are passed to the model', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const modifiedContext: InvokeModelContext = {
          ...context,
          messages: [...context.messages, new Message({ role: 'user', content: [new TextBlock('Injected message')] })],
        }
        return yield* next(modifiedContext)
      })

      const streamSpy = vi.spyOn(model, 'stream')

      await agent.invoke('Test prompt')

      expect(streamSpy).toHaveBeenCalled()
      const calledMessages = streamSpy.mock.calls[0]![0]
      expect(calledMessages.length).toBeGreaterThan(1)
    })

    it('modified toolSpecs are passed to the model', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        const modifiedContext: InvokeModelContext = {
          ...context,
          toolSpecs: [],
        }
        return yield* next(modifiedContext)
      })

      const streamSpy = vi.spyOn(model, 'stream')

      await agent.invoke('Test prompt')

      expect(streamSpy).toHaveBeenCalled()
      const calledOptions = streamSpy.mock.calls[0]![1]
      expect(calledOptions?.toolSpecs).toStrictEqual([])
    })
  })

  describe('hooks fire around middleware', () => {
    it('BeforeModelCallEvent fires before middleware executes', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addHook(BeforeModelCallEvent, () => {
        order.push('beforeModelCall')
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('middleware')
        return yield* next(context)
      })

      await agent.invoke('Test prompt')

      expect(order.indexOf('beforeModelCall')).toBeLessThan(order.indexOf('middleware'))
    })

    it('AfterModelCallEvent fires after middleware completes', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addHook(AfterModelCallEvent, () => {
        order.push('afterModelCall')
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('middleware-start')
        const result = yield* next(context)
        order.push('middleware-end')
        return result
      })

      await agent.invoke('Test prompt')

      expect(order.indexOf('middleware-end')).toBeLessThan(order.indexOf('afterModelCall'))
    })

    it('Before/After hooks fire even when middleware short-circuits', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const beforeCalled = vi.fn()
      const afterCalled = vi.fn()

      agent.addHook(BeforeModelCallEvent, beforeCalled)
      agent.addHook(AfterModelCallEvent, afterCalled)

      agent.addMiddleware(
        InvokeModelStage,
        // eslint-disable-next-line require-yield
        async function* () {
          return {
            result: {
              message: new Message({ role: 'assistant', content: [new TextBlock('Cached')] }),
              stopReason: 'endTurn' as const,
            },
          }
        }
      )

      await agent.invoke('Test prompt')

      expect(beforeCalled).toHaveBeenCalled()
      expect(afterCalled).toHaveBeenCalled()
    })
  })

  describe('addMiddleware returns cleanup function', () => {
    it('returns a function that removes the middleware', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })

      const agent = new Agent({ model, printer: false })

      let middlewareCalled = false
      const cleanup = agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        middlewareCalled = true
        return yield* next(context)
      })

      await agent.invoke('First call')
      expect(middlewareCalled).toBe(true)

      middlewareCalled = false
      cleanup()

      await agent.invoke('Second call')
      expect(middlewareCalled).toBe(false)
    })

    it('only removes the specific handler, not others on the same stage', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Result' })

      const agent = new Agent({ model, printer: false })

      const calls: string[] = []
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        calls.push('keeper')
        return yield* next(context)
      })
      const cleanup = agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        calls.push('removed')
        return yield* next(context)
      })

      cleanup()
      await agent.invoke('Test')
      expect(calls).toStrictEqual(['keeper'])
    })
  })

  describe('no middleware registered', () => {
    it('agent works correctly without any middleware', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const result = await agent.invoke('Test prompt')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Hello')])
    })

    it('agent with tools works correctly without middleware', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success' as const,
            content: [new TextBlock('Tool executed')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      const result = await agent.invoke('Use the tool')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Done')])
    })

    it('stream works correctly without middleware', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const { result } = await collectGenerator(agent.stream('Test prompt'))

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Hello')])
    })
  })
})

describe('AgentStreamStage integration', () => {
  describe('middleware wraps the entire agent stream', () => {
    it('middleware executes around the full agent stream', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const callOrder: string[] = []

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        callOrder.push('middleware-before')
        const result = yield* next(context)
        callOrder.push('middleware-after')
        return result
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { result } = await collectGenerator(agent.stream('Test prompt'))

      expect(callOrder).toStrictEqual(['middleware-before', 'middleware-after'])
      expect(result.stopReason).toBe('endTurn')
    })

    it('middleware receives AgentStreamContext with agent, args, and options', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      let receivedContext: AgentStreamContext | undefined

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        receivedContext = context
        return yield* next(context)
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      await collectGenerator(agent.stream('Test prompt'))

      expect(receivedContext).toBeDefined()
      expect(receivedContext!.agent).toBe(agent)
      expect(receivedContext!.args).toBe('Test prompt')
    })

    it('middleware receives options when provided', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      let receivedContext: AgentStreamContext | undefined
      const options = { invocationState: { key: 'value' } }

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        receivedContext = context
        return yield* next(context)
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      await collectGenerator(agent.stream('Test prompt', options))

      expect(receivedContext!.options).toBe(options)
    })

    it('middleware can short-circuit the entire agent stream', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Should not reach' })
      const agent = new Agent({ model, printer: false })

      // eslint-disable-next-line require-yield
      const middleware: AgentStreamMiddleware = async function* () {
        return {
          result: {
            stopReason: 'endTurn',
            lastMessage: { type: 'message', role: 'assistant', content: [] },
            metrics: { cycleCount: 0, accumulatedUsage: {}, accumulatedMetrics: {}, toolMetrics: {} },
            invocationState: {},
          } as unknown as AgentResult,
        }
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items, result } = await collectGenerator(agent.stream('Test prompt'))

      // BeforeInvocationEvent fires outside middleware (always fires per design decision)
      const nonHookItems = items.filter(
        (e) =>
          !(e instanceof BeforeInvocationEvent) &&
          !(e instanceof AfterInvocationEvent) &&
          !(e instanceof AgentResultEvent)
      )
      expect(nonHookItems).toStrictEqual([])
      expect(result.stopReason).toBe('endTurn')
    })

    it('multiple middleware execute in registration order', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const callOrder: string[] = []

      const outer: AgentStreamMiddleware = async function* (context, next) {
        callOrder.push('outer-before')
        const result = yield* next(context)
        callOrder.push('outer-after')
        return result
      }

      const inner: AgentStreamMiddleware = async function* (context, next) {
        callOrder.push('inner-before')
        const result = yield* next(context)
        callOrder.push('inner-after')
        return result
      }

      agent.addMiddleware(AgentStreamStage, outer)
      agent.addMiddleware(AgentStreamStage, inner)

      await collectGenerator(agent.stream('Test prompt'))

      expect(callOrder).toStrictEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after'])
    })
  })

  describe('middleware can filter events from the stream', () => {
    it('filters out specific event types', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        const gen = next(context)
        let iterResult = await gen.next()
        while (!iterResult.done) {
          const event = iterResult.value
          // Filter out modelStreamUpdate events
          if (event.type !== 'modelStreamUpdateEvent') {
            yield event
          }
          iterResult = await gen.next()
        }
        return iterResult.value
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items } = await collectGenerator(agent.stream('Test prompt'))

      const modelStreamEvents = items.filter((e: AgentStreamEvent) => e.type === 'modelStreamUpdateEvent')
      expect(modelStreamEvents).toStrictEqual([])
      // Other events should still be present
      expect(items.length).toBeGreaterThan(0)
    })

    it('preserves the result when filtering events', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        const gen = next(context)
        let iterResult = await gen.next()
        while (!iterResult.done) {
          const event = iterResult.value
          if (event.type !== 'contentBlockEvent') {
            yield event
          }
          iterResult = await gen.next()
        }
        return iterResult.value
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { result } = await collectGenerator(agent.stream('Test prompt'))

      expect(result.stopReason).toBe('endTurn')
    })

    it('can suppress all events while still returning the result', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      // eslint-disable-next-line require-yield
      const middleware: AgentStreamMiddleware = async function* (context, next) {
        const gen = next(context)
        let iterResult = await gen.next()
        while (!iterResult.done) {
          // Suppress all events — do not yield
          iterResult = await gen.next()
        }
        return iterResult.value
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items, result } = await collectGenerator(agent.stream('Test prompt'))

      // Middleware suppresses stream events but BeforeInvocationEvent fires outside middleware
      const nonHookItems = items.filter(
        (e) =>
          !(e instanceof BeforeInvocationEvent) &&
          !(e instanceof AfterInvocationEvent) &&
          !(e instanceof AgentResultEvent)
      )
      expect(nonHookItems).toStrictEqual([])
      expect(result.stopReason).toBe('endTurn')
    })
  })

  describe('middleware can inject synthetic events', () => {
    it('injects events before the stream', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const syntheticEvent = { type: 'contentBlockEvent' } as unknown as AgentStreamEvent

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        yield syntheticEvent
        return yield* next(context)
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items } = await collectGenerator(agent.stream('Test prompt'))

      // items[0] is BeforeInvocationEvent (fires outside middleware); synthetic is first middleware event
      expect(items[1]).toBe(syntheticEvent)
      expect(items.length).toBeGreaterThan(2)
    })

    it('injects events after the stream', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const syntheticEvent = { type: 'contentBlockEvent' } as unknown as AgentStreamEvent

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        const result = yield* next(context)
        yield syntheticEvent
        return result
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items } = await collectGenerator(agent.stream('Test prompt'))

      // Lifecycle events fire outside middleware; synthetic event is last middleware-yielded event
      const middlewareItems = items.filter(
        (e) =>
          !(e instanceof BeforeInvocationEvent) &&
          !(e instanceof AfterInvocationEvent) &&
          !(e instanceof AgentResultEvent)
      )
      expect(middlewareItems[middlewareItems.length - 1]).toBe(syntheticEvent)
    })

    it('injects events alongside real events via manual iteration', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const syntheticEvent = { type: 'contentBlockEvent', synthetic: true } as unknown as AgentStreamEvent

      const middleware: AgentStreamMiddleware = async function* (context, next) {
        const gen = next(context)
        let iterResult = await gen.next()
        let injected = false
        while (!iterResult.done) {
          yield iterResult.value
          if (!injected) {
            yield syntheticEvent
            injected = true
          }
          iterResult = await gen.next()
        }
        return iterResult.value
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items } = await collectGenerator(agent.stream('Test prompt'))

      // items[0] is BeforeInvocationEvent; items[1] is first real event from stream; items[2] is synthetic
      expect(items[2]).toBe(syntheticEvent)
      // Total events should include exactly one synthetic event
      expect(items.filter((e: AgentStreamEvent) => e === syntheticEvent)).toHaveLength(1)
    })

    it('can yield events without calling next (pure synthetic stream)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Should not reach' })
      const agent = new Agent({ model, printer: false })

      const syntheticEvent1 = { type: 'contentBlockEvent', id: 1 } as unknown as AgentStreamEvent
      const syntheticEvent2 = { type: 'contentBlockEvent', id: 2 } as unknown as AgentStreamEvent

      const middleware: AgentStreamMiddleware = async function* () {
        yield syntheticEvent1
        yield syntheticEvent2
        return {
          result: {
            stopReason: 'endTurn',
            lastMessage: { type: 'message', role: 'assistant', content: [] },
            metrics: { cycleCount: 0, accumulatedUsage: {}, accumulatedMetrics: {}, toolMetrics: {} },
            invocationState: {},
          } as unknown as AgentResult,
        }
      }

      agent.addMiddleware(AgentStreamStage, middleware)

      const { items } = await collectGenerator(agent.stream('Test prompt'))

      // BeforeInvocationEvent fires outside middleware, then the two synthetic events
      const nonHookItems = items.filter(
        (e) =>
          !(e instanceof BeforeInvocationEvent) &&
          !(e instanceof AfterInvocationEvent) &&
          !(e instanceof AgentResultEvent)
      )
      expect(nonHookItems).toStrictEqual([syntheticEvent1, syntheticEvent2])
    })
  })

  describe('no AgentStreamStage middleware registered', () => {
    it('agent streams directly without middleware overhead', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const { items, result } = await collectGenerator(agent.stream('Test prompt'))

      expect(result.stopReason).toBe('endTurn')
      expect(items.length).toBeGreaterThan(0)
    })

    it('existing behavior is unchanged when no middleware is registered', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello world' })
      const agent = new Agent({ model, printer: false })

      const { items, result } = await collectGenerator(agent.stream('Test prompt'))

      const beforeInvocation = items.find((e: AgentStreamEvent) => e.type === 'beforeInvocationEvent')
      const afterInvocation = items.find((e: AgentStreamEvent) => e.type === 'afterInvocationEvent')
      expect(beforeInvocation).toBeDefined()
      expect(afterInvocation).toBeDefined()
      expect(result.stopReason).toBe('endTurn')
    })

    it('middleware on other stages does not affect AgentStreamStage', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      // Register middleware on InvokeModelStage only
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        return yield* next(context)
      })

      const { result } = await collectGenerator(agent.stream('Test prompt'))

      expect(result.stopReason).toBe('endTurn')
    })
  })

  describe('hooks fire outside middleware (per design decision)', () => {
    it('BeforeInvocationEvent fires even when middleware short-circuits', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const beforeCalled = vi.fn()
      agent.addHook(BeforeInvocationEvent, beforeCalled)

      agent.addMiddleware(
        AgentStreamStage,
        // eslint-disable-next-line require-yield
        async function* () {
          return { result: { stopReason: 'endTurn' } } as never
        }
      )

      await agent.invoke('Test')

      expect(beforeCalled).toHaveBeenCalled()
    })

    it('AfterInvocationEvent fires even when middleware short-circuits', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const afterCalled = vi.fn()
      agent.addHook(AfterInvocationEvent, afterCalled)

      agent.addMiddleware(
        AgentStreamStage,
        // eslint-disable-next-line require-yield
        async function* () {
          return { result: { stopReason: 'endTurn' } } as never
        }
      )

      await agent.invoke('Test')

      expect(afterCalled).toHaveBeenCalled()
    })

    it('BeforeInvocationEvent fires before middleware executes', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addHook(BeforeInvocationEvent, () => {
        order.push('before-hook')
      })

      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        order.push('middleware')
        return yield* next(context)
      })

      await agent.invoke('Test')

      expect(order.indexOf('before-hook')).toBeLessThan(order.indexOf('middleware'))
    })

    it('AfterInvocationEvent fires after middleware completes', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addHook(AfterInvocationEvent, () => {
        order.push('after-hook')
      })

      agent.addMiddleware(AgentStreamStage, async function* (context, next) {
        order.push('middleware-start')
        const result = yield* next(context)
        order.push('middleware-end')
        return result
      })

      await agent.invoke('Test')

      expect(order.indexOf('middleware-end')).toBeLessThan(order.indexOf('after-hook'))
    })
  })
})

describe('ExecuteToolStage integration', () => {
  describe('middleware executes around tool calls', () => {
    it('middleware handler is invoked during tool execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: { x: 1 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('executed')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      const executionOrder: string[] = []

      const middleware: ExecuteToolMiddleware = async function* (context, next) {
        executionOrder.push('middleware:before')
        const result = yield* next(context)
        executionOrder.push('middleware:after')
        return result
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      expect(executionOrder).toStrictEqual(['middleware:before', 'middleware:after'])
    })

    it('middleware receives ExecuteToolContext with correct fields', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: { key: 'val' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      let receivedContext: ExecuteToolContext | undefined

      const middleware: ExecuteToolMiddleware = async function* (context, next) {
        receivedContext = context
        return yield* next(context)
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      expect(receivedContext).toBeDefined()
      expect(receivedContext!.agent).toBe(agent)
      expect(receivedContext!.tool).toBeDefined()
      expect(receivedContext!.tool!.name).toBe('testTool')
      expect(receivedContext!.toolUse).toStrictEqual({
        name: 'testTool',
        toolUseId: 'tool-1',
        input: { key: 'val' },
      })
      expect(receivedContext!.invocationState).toBeDefined()
    })

    it('multiple middleware execute in registration order', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      const callOrder: string[] = []

      const outer: ExecuteToolMiddleware = async function* (context, next) {
        callOrder.push('outer-before')
        const result = yield* next(context)
        callOrder.push('outer-after')
        return result
      }

      const inner: ExecuteToolMiddleware = async function* (context, next) {
        callOrder.push('inner-before')
        const result = yield* next(context)
        callOrder.push('inner-after')
        return result
      }

      agent.addMiddleware(ExecuteToolStage, outer)
      agent.addMiddleware(ExecuteToolStage, inner)

      await agent.invoke('Use the tool')

      expect(callOrder).toStrictEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after'])
    })
  })

  describe('middleware can mock tool responses (short-circuit)', () => {
    it('returns mock result without executing the real tool', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const toolFn = vi.fn(
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('real result')],
          })
      )

      const tool = createMockTool('testTool', toolFn)

      const agent = new Agent({ model, tools: [tool], printer: false })

      // eslint-disable-next-line require-yield
      const middleware: ExecuteToolMiddleware = async function* (context) {
        return {
          result: new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('mocked result')],
          }),
        }
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      const result = await agent.invoke('Use the tool')

      // The real tool function should NOT have been called
      expect(toolFn).not.toHaveBeenCalled()
      // The agent should still complete successfully
      expect(result.stopReason).toBe('endTurn')
    })

    it('short-circuit result is used in the conversation', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Got the mocked data' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('real')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      // eslint-disable-next-line require-yield
      const middleware: ExecuteToolMiddleware = async function* (context) {
        return {
          result: new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('mocked data')],
          }),
        }
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      // The tool result message in conversation should contain the mocked result
      const toolResultMessage = agent.messages.find(
        (m: Message) => m.role === 'user' && m.content.some((c) => c.type === 'toolResultBlock')
      )
      expect(toolResultMessage).toBeDefined()
      const toolResultBlock = toolResultMessage!.content.find((c: { type: string }) => c.type === 'toolResultBlock')
      expect(toolResultBlock).toStrictEqual(
        new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success',
          content: [new TextBlock('mocked data')],
        })
      )
    })
  })

  describe('middleware can transform tool input via context modification', () => {
    it('modified input reaches the tool', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: { value: 'original' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let receivedInput: unknown

      const tool = createMockTool('testTool', (context: ToolContext) => {
        receivedInput = context.toolUse.input
        return new ToolResultBlock({
          toolUseId: context.toolUse.toolUseId,
          status: 'success',
          content: [new TextBlock('ok')],
        })
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      const middleware: ExecuteToolMiddleware = async function* (context, next) {
        const modifiedContext: ExecuteToolContext = {
          ...context,
          toolUse: {
            ...context.toolUse,
            input: { value: 'transformed' },
          },
        }
        return yield* next(modifiedContext)
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      expect(receivedInput).toStrictEqual({ value: 'transformed' })
    })

    it('original context is not mutated', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: { value: 'original' } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('ok')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      let originalInput: unknown

      const middleware: ExecuteToolMiddleware = async function* (context, next) {
        originalInput = context.toolUse.input
        const modifiedContext: ExecuteToolContext = {
          ...context,
          toolUse: {
            ...context.toolUse,
            input: { value: 'modified' },
          },
        }
        return yield* next(modifiedContext)
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      // The original context input should remain unchanged
      expect(originalInput).toStrictEqual({ value: 'original' })
    })
  })

  describe('hooks fire around middleware for tool execution', () => {
    it('BeforeToolCallEvent fires before middleware, AfterToolCallEvent fires after', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('executed')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      const executionOrder: string[] = []

      agent.addHook(BeforeToolCallEvent, () => {
        executionOrder.push('hook:beforeToolCall')
      })

      agent.addHook(AfterToolCallEvent, () => {
        executionOrder.push('hook:afterToolCall')
      })

      const middleware: ExecuteToolMiddleware = async function* (context, next) {
        executionOrder.push('middleware:before')
        const result = yield* next(context)
        executionOrder.push('middleware:after')
        return result
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      // Hooks fire OUTSIDE middleware: Before hook → middleware → After hook
      expect(executionOrder).toStrictEqual([
        'hook:beforeToolCall',
        'middleware:before',
        'middleware:after',
        'hook:afterToolCall',
      ])
    })

    it('hooks fire even when middleware short-circuits', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('real')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      const beforeCalled = vi.fn()
      const afterCalled = vi.fn()

      agent.addHook(BeforeToolCallEvent, beforeCalled)
      agent.addHook(AfterToolCallEvent, afterCalled)

      // eslint-disable-next-line require-yield
      const middleware: ExecuteToolMiddleware = async function* (context) {
        return {
          result: new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('mocked')],
          }),
        }
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      expect(beforeCalled).toHaveBeenCalled()
      expect(afterCalled).toHaveBeenCalled()
    })

    it('AfterToolCallEvent receives the middleware result when short-circuited', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'testTool', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool(
        'testTool',
        () =>
          new ToolResultBlock({
            toolUseId: 'tool-1',
            status: 'success',
            content: [new TextBlock('real')],
          })
      )

      const agent = new Agent({ model, tools: [tool], printer: false })

      let afterToolResult: ToolResultBlock | undefined

      agent.addHook(AfterToolCallEvent, (event: AfterToolCallEvent) => {
        afterToolResult = event.result
      })

      // eslint-disable-next-line require-yield
      const middleware: ExecuteToolMiddleware = async function* (context) {
        return {
          result: new ToolResultBlock({
            toolUseId: context.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('from middleware')],
          }),
        }
      }

      agent.addMiddleware(ExecuteToolStage, middleware)

      await agent.invoke('Use the tool')

      expect(afterToolResult).toBeDefined()
      expect(afterToolResult!.content).toStrictEqual([new TextBlock('from middleware')])
    })
  })
})

describe('Middleware use cases', () => {
  describe('caching tool results', () => {
    class ToolResultCache implements Plugin {
      name = 'tool-result-cache'

      private readonly _cache = new Map<string, ToolResultBlock>()

      initAgent(agent: LocalAgent): void {
        const cache = this._cache

        agent.addMiddleware(ExecuteToolStage, async function* (context, next) {
          const key = `${context.toolUse.name}:${JSON.stringify(context.toolUse.input)}`
          const cached = cache.get(key)
          if (cached) {
            return {
              result: new ToolResultBlock({
                toolUseId: context.toolUse.toolUseId,
                status: cached.status,
                content: cached.content,
              }),
            }
          }
          const result = yield* next(context)
          cache.set(key, result.result)
          return result
        })
      }
    }

    it('returns cached result on second call, skipping real execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'expensiveApi', toolUseId: 'call-1', input: { query: 'weather' } })
        .addTurn({ type: 'textBlock', text: 'First done' })
        .addTurn({ type: 'toolUseBlock', name: 'expensiveApi', toolUseId: 'call-2', input: { query: 'weather' } })
        .addTurn({ type: 'textBlock', text: 'Second done' })

      const realCallCount = vi.fn()
      const tool = createMockTool('expensiveApi', (ctx: ToolContext) => {
        realCallCount()
        return new ToolResultBlock({
          toolUseId: ctx.toolUse.toolUseId,
          status: 'success',
          content: [new TextBlock('sunny, 72°F')],
        })
      })

      const agent = new Agent({ model, tools: [tool], plugins: [new ToolResultCache()], printer: false })

      await agent.invoke('What is the weather?')
      expect(realCallCount).toHaveBeenCalledTimes(1)

      await agent.invoke('What is the weather?')
      expect(realCallCount).toHaveBeenCalledTimes(1) // cache hit
    })
  })

  describe('auto-retrying model invocations', () => {
    class RetryOnThrottle implements Plugin {
      name = 'retry-on-throttle'

      private readonly _maxRetries: number

      constructor(maxRetries = 3) {
        this._maxRetries = maxRetries
      }

      initAgent(agent: LocalAgent): void {
        const maxRetries = this._maxRetries
        agent.addMiddleware(InvokeModelStage, async function* (context, next) {
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              return yield* next(context)
            } catch (e) {
              const isRetryable = (e as Error).message.includes('ThrottlingException')
              if (!isRetryable || attempt === maxRetries - 1) throw e
              // In production: await sleep(backoff(attempt))
            }
          }
          throw new Error('exhausted retries')
        })
      }
    }

    it('retries on transient error and succeeds on second attempt', async () => {
      let callCount = 0
      const model = new MockMessageModel()
      model.addTurn({ type: 'textBlock', text: 'Success after retry' })

      const agent = new Agent({ model, plugins: [new RetryOnThrottle(3)], printer: false })

      const originalStream = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation((...args) => {
        callCount++
        if (callCount === 1) throw new Error('ThrottlingException: rate limit exceeded')
        return originalStream(...args)
      })

      const result = await agent.invoke('Hello')

      expect(callCount).toBe(2)
      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('Success after retry')])
    })
  })

  describe('stream final turn only (buffer intermediate turns)', () => {
    class StreamFinalTurnOnly implements Plugin {
      name = 'stream-final-turn-only'

      initAgent(agent: LocalAgent): void {
        agent.addMiddleware(AgentStreamStage, (...args) => this._handler(...args))
      }

      private async *_handler(
        ...[context, next]: Parameters<MiddlewareHandlerOf<typeof AgentStreamStage>>
      ): ReturnType<MiddlewareHandlerOf<typeof AgentStreamStage>> {
        let buffer: AgentStreamEvent[] = []
        const gen = next(context)
        let iterResult = await gen.next()

        while (!iterResult.done) {
          const event = iterResult.value

          if (event.type === 'contentBlockEvent' || event.type === 'modelStreamUpdateEvent') {
            buffer.push(event)
          } else if (event.type === 'afterModelCallEvent') {
            const stopReason = (event as AfterModelCallEvent).stopData?.stopReason
            if (stopReason === 'endTurn') {
              for (const buffered of buffer) yield buffered
            }
            buffer = []
            yield event
          } else {
            yield event
          }

          iterResult = await gen.next()
        }

        for (const buffered of buffer) yield buffered
        return iterResult.value
      }
    }

    it('suppresses content events from intermediate tool-use turns, emits only final turn', async () => {
      const model = new MockMessageModel()
        .addTurn([
          { type: 'textBlock', text: 'Let me check that for you' },
          { type: 'toolUseBlock', name: 'lookup', toolUseId: 'tool-1', input: {} },
        ])
        .addTurn({ type: 'textBlock', text: 'The answer is 42' })

      const tool = createMockTool(
        'lookup',
        (ctx: ToolContext) =>
          new ToolResultBlock({
            toolUseId: ctx.toolUse.toolUseId,
            status: 'success',
            content: [new TextBlock('42')],
          })
      )

      const agent = new Agent({ model, tools: [tool], plugins: [new StreamFinalTurnOnly()], printer: false })

      const { items, result } = await collectGenerator(agent.stream('What is the meaning of life?'))

      const contentEvents = items.filter((e: AgentStreamEvent) => e.type === 'contentBlockEvent')
      expect(contentEvents).toHaveLength(1)
      expect((contentEvents[0] as ContentBlockEvent).contentBlock).toStrictEqual(new TextBlock('The answer is 42'))
      expect(result.stopReason).toBe('endTurn')
    })

    it('passes through all events when there is only one turn (no tool use)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Simple answer' })
      const agent = new Agent({ model, plugins: [new StreamFinalTurnOnly()], printer: false })

      const { items, result } = await collectGenerator(agent.stream('Hello'))

      const contentEvents = items.filter((e: AgentStreamEvent) => e.type === 'contentBlockEvent')
      expect(contentEvents).toHaveLength(1)
      expect((contentEvents[0] as ContentBlockEvent).contentBlock).toStrictEqual(new TextBlock('Simple answer'))
      expect(result.stopReason).toBe('endTurn')
    })
  })
})

describe('Middleware phases (Input / Wrap / Output)', () => {
  describe('InvokeModelStage.Input', () => {
    it('transforms context before the model call', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      let receivedMessages: unknown

      agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
        ...context,
        messages: [...context.messages, new Message({ role: 'user', content: [new TextBlock('injected')] })],
      }))

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        receivedMessages = context.messages
        return yield* next(context)
      })

      await agent.invoke('Original')

      expect((receivedMessages as Message[]).length).toBe(2)
      expect((receivedMessages as Message[])[1]!.content[0]).toEqual(new TextBlock('injected'))
    })

    it('runs before Wrap handlers regardless of registration order', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      // Register Wrap first, then Input
      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('wrap')
        return yield* next(context)
      })

      agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        order.push('input')
        return context
      })

      await agent.invoke('Test')

      expect(order).toStrictEqual(['input', 'wrap'])
    })

    it('multiple Input handlers compose in registration order', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        order.push('input-1')
        return context
      })

      agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        order.push('input-2')
        return context
      })

      await agent.invoke('Test')

      expect(order).toStrictEqual(['input-1', 'input-2'])
    })
  })

  describe('InvokeModelStage.Output', () => {
    it('transforms result after the model call', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      let outputSeen = false

      agent.addMiddleware(InvokeModelStage.Output, async (result) => {
        outputSeen = true
        expect(result.result.stopReason).toBe('endTurn')
        return result
      })

      await agent.invoke('Test')

      expect(outputSeen).toBe(true)
    })

    it('transformed result message is appended to agent.messages', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Original' })
      const agent = new Agent({ model, printer: false })

      agent.addMiddleware(InvokeModelStage.Output, async (result) => ({
        result: {
          ...result.result,
          message: new Message({ role: 'assistant', content: [new TextBlock('Rewritten by middleware')] }),
        },
      }))

      await agent.invoke('Test')

      const assistantMessages = agent.messages.filter((m) => m.role === 'assistant')
      expect(assistantMessages.at(-1)?.content).toEqual([new TextBlock('Rewritten by middleware')])
    })

    it('runs after Wrap handlers (wraps them)', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addMiddleware(InvokeModelStage.Output, async (result) => {
        order.push('output')
        return result
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('wrap-before')
        const result = yield* next(context)
        order.push('wrap-after')
        return result
      })

      await agent.invoke('Test')

      // Output wraps Wrap: output sees the result after wrap-after
      expect(order).toStrictEqual(['wrap-before', 'wrap-after', 'output'])
    })

    it('changing stopReason from tool_use to endTurn prevents tool dispatch', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'shouldNotRun', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Should not reach here' })

      let toolCalled = false
      const tool = createMockTool('shouldNotRun', () => {
        toolCalled = true
        return new ToolResultBlock({
          toolUseId: 'tool-1',
          status: 'success' as const,
          content: [new TextBlock('ran')],
        })
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      // Output rewrites the tool_use result into an endTurn result, short-circuiting the loop
      agent.addMiddleware(InvokeModelStage.Output, async (result) => ({
        result: { ...result.result, stopReason: 'endTurn' as const },
      }))

      const result = await agent.invoke('Use the tool')

      expect(result.stopReason).toBe('endTurn')
      expect(toolCalled).toBe(false)
    })
  })

  describe('InvokeModelStage (Wrap phase)', () => {
    it('bare InvokeModelStage registers as Wrap phase and executes between Input and Output', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        order.push('input')
        return context
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('wrap')
        return yield* next(context)
      })

      agent.addMiddleware(InvokeModelStage.Output, async (result) => {
        order.push('output')
        return result
      })

      await agent.invoke('Test prompt')

      expect(order).toStrictEqual(['input', 'wrap', 'output'])
    })
  })

  describe('phase ordering', () => {
    it('Input → Wrap → Output execution order', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })

      const order: string[] = []

      // Register in reverse order to prove phase ordering overrides registration order
      agent.addMiddleware(InvokeModelStage.Output, async (result) => {
        order.push('output')
        return result
      })

      agent.addMiddleware(InvokeModelStage, async function* (context, next) {
        order.push('wrap')
        return yield* next(context)
      })

      agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        order.push('input')
        return context
      })

      await agent.invoke('Test')

      expect(order).toStrictEqual(['input', 'wrap', 'output'])
    })
  })

  describe('ExecuteToolStage phases', () => {
    it('Input transforms tool context before execution', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'myTool', toolUseId: 'tool-1', input: { x: 1 } })
        .addTurn({ type: 'textBlock', text: 'Done' })

      let receivedInput: unknown
      const tool = createMockTool('myTool', (ctx: ToolContext) => {
        receivedInput = ctx.toolUse.input
        return 'ok'
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      agent.addMiddleware(ExecuteToolStage.Input, async (context) => ({
        ...context,
        toolUse: { ...context.toolUse, input: { x: 2 } },
      }))

      await agent.invoke('Test')

      expect(receivedInput).toEqual({ x: 2 })
    })
  })

  describe('cleanup', () => {
    it('cleanup removes Input handler', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })

      const agent = new Agent({ model, printer: false })

      let inputCalled = false
      const cleanup = agent.addMiddleware(InvokeModelStage.Input, async (context) => {
        inputCalled = true
        return context
      })

      await agent.invoke('First')
      expect(inputCalled).toBe(true)

      inputCalled = false
      cleanup()

      await agent.invoke('Second')
      expect(inputCalled).toBe(false)
    })

    it('cleanup removes Output handler', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'First' })
        .addTurn({ type: 'textBlock', text: 'Second' })

      const agent = new Agent({ model, printer: false })

      let outputCalled = false
      const cleanup = agent.addMiddleware(InvokeModelStage.Output, async (result) => {
        outputCalled = true
        return result
      })

      await agent.invoke('First')
      expect(outputCalled).toBe(true)

      outputCalled = false
      cleanup()

      await agent.invoke('Second')
      expect(outputCalled).toBe(false)
    })
  })

  describe('error handling', () => {
    it('throws on unknown phase', () => {
      const agent = new Agent({ model: 'test', printer: false })
      const fakePhase = { _phase: 'unknown', _stage: InvokeModelStage } as never

      expect(() => agent.addMiddleware(fakePhase, (() => {}) as never)).toThrow('Unknown middleware phase: unknown')
    })
  })
})
