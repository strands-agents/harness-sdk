import { describe, expect, it } from 'vitest'
import { MiddlewareRegistry, createStage } from '../index.js'
import type { MiddlewareHandler, MiddlewareNext } from '../types.js'
import { CancelledError } from '../../errors.js'
import { InterruptError, Interrupt } from '../../interrupt.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'

async function collect<TEvent, TResult>(gen: AsyncGenerator<TEvent, TResult, undefined>) {
  const { items, result } = await collectGenerator(gen as AsyncGenerator<TEvent, TResult, never>)
  return { events: items, result }
}

// Simple test types
interface TestContext {
  readonly value: string
}

interface TestEvent {
  readonly data: string
}

interface TestResult {
  readonly output: string
}

const TestStage = createStage<TestContext, TestResult, TestEvent>('test')

describe('MiddlewareRegistry', () => {
  describe('add', () => {
    it('stores handlers in registration order', () => {
      const registry = new MiddlewareRegistry()
      const callOrder: number[] = []

      const handler1: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callOrder.push(1)
        return yield* next(context)
      }

      const handler2: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callOrder.push(2)
        return yield* next(context)
      }

      registry.add(TestStage, handler1)
      registry.add(TestStage, handler2)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        callOrder.push(3)
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)
      // Execute the chain to verify order
      const gen = chain({ value: 'test' })
      return collect(gen).then(() => {
        expect(callOrder).toStrictEqual([1, 2, 3])
      })
    })
  })

  describe('compose', () => {
    it('with no handlers returns terminal-equivalent function', async () => {
      const registry = new MiddlewareRegistry()

      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* (ctx) {
        yield { data: `event-${ctx.value}` }
        return { output: `result-${ctx.value}` }
      }

      const chain = registry.compose(TestStage, terminal)
      const { events, result } = await collect(chain({ value: 'hello' }))

      expect(events).toStrictEqual([{ data: 'event-hello' }])
      expect(result).toStrictEqual({ output: 'result-hello' })
    })

    it('executes handlers in registration order (outermost first)', async () => {
      const registry = new MiddlewareRegistry()
      const callOrder: string[] = []

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callOrder.push('outer-before')
        const result = yield* next(context)
        callOrder.push('outer-after')
        return result
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callOrder.push('inner-before')
        const result = yield* next(context)
        callOrder.push('inner-after')
        return result
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        callOrder.push('terminal')
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)
      await collect(chain({ value: 'test' }))

      expect(callOrder).toStrictEqual(['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after'])
    })
  })

  describe('short-circuit behavior', () => {
    it('does not call next handlers or terminal when middleware does not call next', async () => {
      const registry = new MiddlewareRegistry()
      let terminalCalled = false
      let innerCalled = false

      const shortCircuit: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* () {
        yield { data: 'synthetic' }
        return { output: 'short-circuited' }
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        innerCalled = true
        return yield* next(context)
      }

      registry.add(TestStage, shortCircuit)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        terminalCalled = true
        return { output: 'terminal' }
      }

      const chain = registry.compose(TestStage, terminal)
      const { events, result } = await collect(chain({ value: 'test' }))

      expect(terminalCalled).toBe(false)
      expect(innerCalled).toBe(false)
      expect(events).toStrictEqual([{ data: 'synthetic' }])
      expect(result).toStrictEqual({ output: 'short-circuited' })
    })
  })

  describe('event pass-through via yield* next(context)', () => {
    it('forwards all events from terminal and returns terminal result', async () => {
      const registry = new MiddlewareRegistry()

      const passThrough: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      registry.add(TestStage, passThrough)

      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        yield { data: 'event-1' }
        yield { data: 'event-2' }
        yield { data: 'event-3' }
        return { output: 'terminal-result' }
      }

      const chain = registry.compose(TestStage, terminal)
      const { events, result } = await collect(chain({ value: 'test' }))

      expect(events).toStrictEqual([{ data: 'event-1' }, { data: 'event-2' }, { data: 'event-3' }])
      expect(result).toStrictEqual({ output: 'terminal-result' })
    })
  })

  describe('event filtering via manual iteration', () => {
    it('only yields events matching a predicate', async () => {
      const registry = new MiddlewareRegistry()

      const filter: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        const gen = next(context)
        let iterResult = await gen.next()
        while (!iterResult.done) {
          const event = iterResult.value
          // Only forward events containing 'keep'
          if (event.data.includes('keep')) {
            yield event
          }
          iterResult = await gen.next()
        }
        return iterResult.value
      }

      registry.add(TestStage, filter)

      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        yield { data: 'keep-1' }
        yield { data: 'drop-1' }
        yield { data: 'keep-2' }
        yield { data: 'drop-2' }
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)
      const { events, result } = await collect(chain({ value: 'test' }))

      expect(events).toStrictEqual([{ data: 'keep-1' }, { data: 'keep-2' }])
      expect(result).toStrictEqual({ output: 'done' })
    })
  })

  describe('context modification flows to terminal', () => {
    it('terminal receives modified context', async () => {
      const registry = new MiddlewareRegistry()
      let receivedContext: TestContext | undefined

      const modifier: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        const modified = { ...context, value: 'modified' }
        return yield* next(modified)
      }

      registry.add(TestStage, modifier)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* (ctx) {
        receivedContext = ctx
        return { output: ctx.value }
      }

      const chain = registry.compose(TestStage, terminal)
      const { result } = await collect(chain({ value: 'original' }))

      expect(receivedContext).toStrictEqual({ value: 'modified' })
      expect(result).toStrictEqual({ output: 'modified' })
    })

    it('each middleware can further modify context', async () => {
      const registry = new MiddlewareRegistry()
      let receivedContext: TestContext | undefined

      const first: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next({ ...context, value: context.value + '-first' })
      }

      const second: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next({ ...context, value: context.value + '-second' })
      }

      registry.add(TestStage, first)
      registry.add(TestStage, second)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* (ctx) {
        receivedContext = ctx
        return { output: ctx.value }
      }

      const chain = registry.compose(TestStage, terminal)
      const { result } = await collect(chain({ value: 'start' }))

      expect(receivedContext).toStrictEqual({ value: 'start-first-second' })
      expect(result).toStrictEqual({ output: 'start-first-second' })
    })
  })

  describe('error propagation through chain', () => {
    it('errors from terminal reach middleware', async () => {
      const registry = new MiddlewareRegistry()
      let caughtError: Error | undefined

      const catcher: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } catch (error) {
          caughtError = error as Error
          return { output: 'recovered' }
        }
      }

      registry.add(TestStage, catcher)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new Error('terminal error')
      }

      const chain = registry.compose(TestStage, terminal)
      const { result } = await collect(chain({ value: 'test' }))

      expect(caughtError).toBeInstanceOf(Error)
      expect(caughtError!.message).toBe('terminal error')
      expect(result).toStrictEqual({ output: 'recovered' })
    })

    it('errors from middleware reach caller', async () => {
      const registry = new MiddlewareRegistry()

      // eslint-disable-next-line require-yield
      const thrower: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* () {
        throw new Error('middleware error')
      }

      registry.add(TestStage, thrower)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow('middleware error')
    })

    it('middleware can transform errors from next', async () => {
      const registry = new MiddlewareRegistry()

      const transformer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } catch {
          throw new Error('transformed error')
        }
      }

      registry.add(TestStage, transformer)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new Error('original error')
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow('transformed error')
    })
  })

  describe('CancelledError and InterruptError propagation', () => {
    it('CancelledError propagates without being swallowed', async () => {
      const registry = new MiddlewareRegistry()

      const passThrough: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      registry.add(TestStage, passThrough)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new CancelledError()
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow(CancelledError)
    })

    it('InterruptError propagates without being swallowed', async () => {
      const registry = new MiddlewareRegistry()

      const passThrough: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      registry.add(TestStage, passThrough)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new InterruptError(new Interrupt({ id: 'int-1', name: 'test_interrupt' }))
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow(InterruptError)
    })

    it('CancelledError propagates through multiple middleware layers', async () => {
      const registry = new MiddlewareRegistry()

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new CancelledError()
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow(CancelledError)
    })

    it('InterruptError propagates through multiple middleware layers', async () => {
      const registry = new MiddlewareRegistry()

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new InterruptError(new Interrupt({ id: 'int-1', name: 'test_interrupt' }))
      }

      const chain = registry.compose(TestStage, terminal)

      await expect(collect(chain({ value: 'test' }))).rejects.toThrow(InterruptError)
    })
  })

  describe('try-finally guarantees', () => {
    it('outer finally runs when inner middleware throws', async () => {
      const registry = new MiddlewareRegistry()
      const order: string[] = []

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('outer-finally')
        }
      }

      // eslint-disable-next-line require-yield
      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* () {
        order.push('inner-throw')
        throw new Error('inner exploded')
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        return { output: 'unreachable' }
      }

      const chain = registry.compose(TestStage, terminal)
      await expect(collect(chain({ value: 'test' }))).rejects.toThrow('inner exploded')

      expect(order).toStrictEqual(['inner-throw', 'outer-finally'])
    })

    it('inner finally runs when terminal throws', async () => {
      const registry = new MiddlewareRegistry()
      const order: string[] = []

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('outer-finally')
        }
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('inner-finally')
        }
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        order.push('terminal-throw')
        throw new Error('terminal exploded')
      }

      const chain = registry.compose(TestStage, terminal)
      await expect(collect(chain({ value: 'test' }))).rejects.toThrow('terminal exploded')

      expect(order).toStrictEqual(['terminal-throw', 'inner-finally', 'outer-finally'])
    })

    it('all finally blocks run in reverse order when terminal throws', async () => {
      const registry = new MiddlewareRegistry()
      const order: string[] = []

      const a: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          order.push('a-enter')
          return yield* next(context)
        } finally {
          order.push('a-finally')
        }
      }

      const b: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          order.push('b-enter')
          return yield* next(context)
        } finally {
          order.push('b-finally')
        }
      }

      const c: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          order.push('c-enter')
          return yield* next(context)
        } finally {
          order.push('c-finally')
        }
      }

      registry.add(TestStage, a)
      registry.add(TestStage, b)
      registry.add(TestStage, c)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        throw new Error('boom')
      }

      const chain = registry.compose(TestStage, terminal)
      await expect(collect(chain({ value: 'test' }))).rejects.toThrow('boom')

      expect(order).toStrictEqual(['a-enter', 'b-enter', 'c-enter', 'c-finally', 'b-finally', 'a-finally'])
    })

    it('finally runs even when caller abandons the generator mid-stream', async () => {
      const registry = new MiddlewareRegistry()
      const order: string[] = []

      const middleware: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('middleware-finally')
        }
      }

      registry.add(TestStage, middleware)

      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        yield { data: 'event-1' }
        yield { data: 'event-2' }
        yield { data: 'event-3' }
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)
      const gen = chain({ value: 'test' })

      // Only consume one event then abandon (call return to close the generator)
      await gen.next()
      await gen.return({ output: 'abandoned' })

      expect(order).toStrictEqual(['middleware-finally'])
    })

    it('finally runs in both middleware when caller abandons mid-stream', async () => {
      const registry = new MiddlewareRegistry()
      const order: string[] = []

      const outer: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('outer-finally')
        }
      }

      const inner: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        try {
          return yield* next(context)
        } finally {
          order.push('inner-finally')
        }
      }

      registry.add(TestStage, outer)
      registry.add(TestStage, inner)

      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        yield { data: 'event-1' }
        yield { data: 'event-2' }
        return { output: 'done' }
      }

      const chain = registry.compose(TestStage, terminal)
      const gen = chain({ value: 'test' })

      await gen.next()
      await gen.return({ output: 'abandoned' })

      expect(order).toStrictEqual(['inner-finally', 'outer-finally'])
    })
  })

  describe('remove', () => {
    it('removes a handler so it no longer runs', async () => {
      const registry = new MiddlewareRegistry()
      const callOrder: number[] = []

      const handler: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callOrder.push(1)
        return yield* next(context)
      }

      registry.add(TestStage, handler)
      registry.remove(TestStage, handler)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        callOrder.push(2)
        return { output: 'done' }
      }

      await collect(registry.invoke(TestStage, { value: 'test' }, terminal))
      expect(callOrder).toStrictEqual([2])
    })

    it('only removes the first occurrence of a duplicate handler', async () => {
      const registry = new MiddlewareRegistry()
      let callCount = 0

      const handler: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        callCount++
        return yield* next(context)
      }

      registry.add(TestStage, handler)
      registry.add(TestStage, handler)
      registry.remove(TestStage, handler)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<TestContext, TestResult, TestEvent> = async function* () {
        return { output: 'done' }
      }

      await collect(registry.invoke(TestStage, { value: 'test' }, terminal))
      expect(callCount).toBe(1)
    })

    it('is a no-op when handler was never registered', async () => {
      const registry = new MiddlewareRegistry()

      const handler: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      // Should not throw
      registry.remove(TestStage, handler)
    })

    it('is a no-op when stage has no handlers', () => {
      const registry = new MiddlewareRegistry()
      const OtherStage = createStage<TestContext, TestResult, TestEvent>('other')

      const handler: MiddlewareHandler<TestContext, TestResult, TestEvent> = async function* (context, next) {
        return yield* next(context)
      }

      // Should not throw
      registry.remove(OtherStage, handler)
    })
  })
})
