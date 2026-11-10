import { describe, expect, it } from 'vitest'
import { createStage, MiddlewareRegistry } from '../index.js'
import type { MiddlewareHandler, MiddlewareNext } from '../types.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'

async function collect<TEvent, TResult>(gen: AsyncGenerator<TEvent, TResult, undefined>) {
  const { items, result } = await collectGenerator(gen as AsyncGenerator<TEvent, TResult, never>)
  return { events: items, result }
}

// Custom stage types for testing third-party extensibility
interface CustomContext {
  readonly label: string
  readonly count: number
}

interface CustomEvent {
  readonly kind: string
}

interface CustomResult {
  readonly summary: string
}

describe('Third-party custom stages', () => {
  describe('createStage', () => {
    it('returns a frozen object', () => {
      const stage = createStage<CustomContext, CustomResult, CustomEvent>('myCustomStage')
      expect(Object.isFrozen(stage)).toBe(true)
    })

    it('returns object with correct name property', () => {
      const stage = createStage<CustomContext, CustomResult, CustomEvent>('myCustomStage')
      expect(stage.name).toBe('myCustomStage')
    })
  })

  describe('custom stage with registry', () => {
    it('works with registry.add and compose (handlers execute correctly)', async () => {
      const CustomStage = createStage<CustomContext, CustomResult, CustomEvent>('custom')
      const registry = new MiddlewareRegistry()
      const callOrder: string[] = []

      const handler: MiddlewareHandler<CustomContext, CustomResult, CustomEvent> = async function* (context, next) {
        callOrder.push('middleware')
        yield { kind: `pre-${context.label}` }
        const result = yield* next(context)
        callOrder.push('middleware-after')
        return result
      }

      registry.add(CustomStage, handler)

      const terminal: MiddlewareNext<CustomContext, CustomResult, CustomEvent> = async function* (ctx) {
        callOrder.push('terminal')
        yield { kind: `terminal-${ctx.label}` }
        return { summary: `done-${ctx.count}` }
      }

      const chain = registry.compose(CustomStage, terminal)
      const { events, result } = await collect(chain({ label: 'test', count: 42 }))

      expect(callOrder).toStrictEqual(['middleware', 'terminal', 'middleware-after'])
      expect(events).toStrictEqual([{ kind: 'pre-test' }, { kind: 'terminal-test' }])
      expect(result).toStrictEqual({ summary: 'done-42' })
    })

    it('two stages with the same name are distinct (reference identity)', async () => {
      const StageA = createStage<CustomContext, CustomResult, CustomEvent>('shared-name')
      const StageB = createStage<CustomContext, CustomResult, CustomEvent>('shared-name')

      const registry = new MiddlewareRegistry()

      const handlerA: MiddlewareHandler<CustomContext, CustomResult, CustomEvent> = async function* (context, next) {
        yield { kind: 'from-A' }
        return yield* next(context)
      }

      const handlerB: MiddlewareHandler<CustomContext, CustomResult, CustomEvent> = async function* (context, next) {
        yield { kind: 'from-B' }
        return yield* next(context)
      }

      registry.add(StageA, handlerA)
      registry.add(StageB, handlerB)

      // eslint-disable-next-line require-yield
      const terminal: MiddlewareNext<CustomContext, CustomResult, CustomEvent> = async function* () {
        return { summary: 'terminal' }
      }

      // Composing for StageA should only include handlerA
      const chainA = registry.compose(StageA, terminal)
      const resultA = await collect(chainA({ label: 'a', count: 1 }))
      expect(resultA.events).toStrictEqual([{ kind: 'from-A' }])

      // Composing for StageB should only include handlerB
      const chainB = registry.compose(StageB, terminal)
      const resultB = await collect(chainB({ label: 'b', count: 2 }))
      expect(resultB.events).toStrictEqual([{ kind: 'from-B' }])
    })

    it('custom stage middleware can be composed with a terminal and executes correctly', async () => {
      const CustomStage = createStage<CustomContext, CustomResult, CustomEvent>('pipeline')
      const registry = new MiddlewareRegistry()

      // Register multiple middleware for the custom stage
      const logger: MiddlewareHandler<CustomContext, CustomResult, CustomEvent> = async function* (context, next) {
        yield { kind: 'log-start' }
        const result = yield* next(context)
        yield { kind: 'log-end' }
        return result
      }

      const transformer: MiddlewareHandler<CustomContext, CustomResult, CustomEvent> = async function* (context, next) {
        const modified = { ...context, count: context.count * 2 }
        return yield* next(modified)
      }

      registry.add(CustomStage, logger)
      registry.add(CustomStage, transformer)

      const terminal: MiddlewareNext<CustomContext, CustomResult, CustomEvent> = async function* (ctx) {
        yield { kind: `processed-${ctx.count}` }
        return { summary: `result-${ctx.label}-${ctx.count}` }
      }

      const chain = registry.compose(CustomStage, terminal)
      const { events, result } = await collect(chain({ label: 'item', count: 5 }))

      expect(events).toStrictEqual([{ kind: 'log-start' }, { kind: 'processed-10' }, { kind: 'log-end' }])
      expect(result).toStrictEqual({ summary: 'result-item-10' })
    })
  })
})
