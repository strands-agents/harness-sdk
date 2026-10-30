import { afterEach, describe, expect, it, vi } from 'vitest'

import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { ContextWindowOverflowError } from '../../../errors.js'
import { FallbackStrategy } from '../fallback-strategy.js'
import { ModelRouter } from '../router.js'
import type { RoutingAttempt, RoutingContext } from '../strategy.js'

function context(count: number, attempts: readonly RoutingAttempt[] = []): RoutingContext {
  const router = new ModelRouter(
    Array.from({ length: count }, () => new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' }))
  )
  return {
    messages: [],
    toolSpecs: [],
    candidates: router.candidates,
    invocationState: {},
    attempts,
  }
}

describe('FallbackStrategy', () => {
  afterEach(() => vi.restoreAllMocks())

  describe('select', () => {
    it('uses declaration order before any attempt', async () => {
      const routingContext = context(2)

      const selected = await new FallbackStrategy().select(routingContext)

      expect(selected).toBe(routingContext.candidates[0])
    })

    it('advances through each candidate once in a failure round', async () => {
      const routingContext = context(2)
      const error = new Error('down')
      const firstFailure = { candidate: routingContext.candidates[0]!, exception: error }
      const secondFailure = { candidate: routingContext.candidates[1]!, exception: error }

      expect(await new FallbackStrategy().select({ ...routingContext, attempts: [firstFailure] })).toBe(
        routingContext.candidates[1]
      )
      expect(
        await new FallbackStrategy().select({ ...routingContext, attempts: [firstFailure, secondFailure] })
      ).toBeUndefined()
    })

    it('rearms after success while retaining other candidates failure history', async () => {
      const routingContext = context(3)
      const error = new Error('down')
      const attempts: RoutingAttempt[] = [
        { candidate: routingContext.candidates[0]!, exception: error },
        { candidate: routingContext.candidates[1]! },
        { candidate: routingContext.candidates[1]!, exception: error },
      ]

      const selected = await new FallbackStrategy().select({ ...routingContext, attempts })

      expect(selected).toBe(routingContext.candidates[2])
    })

    it("clears a successful candidate's own accumulated failure count", async () => {
      const routingContext = context(3)
      const error = new Error('down')
      const attempts: RoutingAttempt[] = [
        { candidate: routingContext.candidates[0]!, exception: error },
        { candidate: routingContext.candidates[0]!, exception: error },
        { candidate: routingContext.candidates[1]!, exception: error },
        { candidate: routingContext.candidates[0]! },
        { candidate: routingContext.candidates[2]!, exception: error },
      ]

      const selected = await new FallbackStrategy().select({ ...routingContext, attempts })

      expect(selected).toBe(routingContext.candidates[0])
    })

    it('rearms the other candidate after a fallback succeeds and later fails', async () => {
      const routingContext = context(2)
      const error = new Error('down')
      const attempts: RoutingAttempt[] = [
        { candidate: routingContext.candidates[0]!, exception: error },
        { candidate: routingContext.candidates[1]! },
        { candidate: routingContext.candidates[1]!, exception: error },
      ]

      const selected = await new FallbackStrategy().select({ ...routingContext, attempts })

      expect(selected).toBe(routingContext.candidates[0])
    })

    it('declines errors excluded by failOverOn', async () => {
      const routingContext = context(2)
      const attempts = [{ candidate: routingContext.candidates[0]!, exception: new TypeError('bad request') }]

      const selected = await new FallbackStrategy({ failOverOn: [RangeError] }).select({
        ...routingContext,
        attempts,
      })

      expect(selected).toBeUndefined()
    })

    it('skips a cooling candidate across invocations and retries it after expiry', async () => {
      const now = vi.spyOn(globalThis.performance, 'now').mockReturnValue(0)
      const routingContext = context(2)
      const strategy = new FallbackStrategy({ cooldown: 60 })
      const attempts = [{ candidate: routingContext.candidates[0]!, exception: new Error('down') }]

      expect(await strategy.select({ ...routingContext, attempts })).toBe(routingContext.candidates[1])

      now.mockReturnValue(10_000)
      expect(await strategy.select({ ...routingContext, attempts: [] })).toBe(routingContext.candidates[1])

      now.mockReturnValue(61_000)
      expect(await strategy.select({ ...routingContext, attempts: [] })).toBe(routingContext.candidates[0])
    })

    it('uses the earliest-expiring candidate when all candidates are cooling', async () => {
      const now = vi.spyOn(globalThis.performance, 'now').mockReturnValue(0)
      const routingContext = context(2)
      const strategy = new FallbackStrategy({ cooldown: 60 })
      const firstFailure = [{ candidate: routingContext.candidates[0]!, exception: new Error('first down') }]
      expect(await strategy.select({ ...routingContext, attempts: firstFailure })).toBe(routingContext.candidates[1])

      now.mockReturnValue(10_000)
      const secondFailure = [
        ...firstFailure,
        { candidate: routingContext.candidates[1]!, exception: new Error('second down') },
      ]
      expect(await strategy.select({ ...routingContext, attempts: secondFailure })).toBeUndefined()

      now.mockReturnValue(20_000)
      expect(await strategy.select({ ...routingContext, attempts: [] })).toBe(routingContext.candidates[0])
    })

    it('uses only a larger context candidate for overflow without cooling the source', async () => {
      vi.spyOn(globalThis.performance, 'now').mockReturnValue(0)
      const models = [8_000, 4_000, 16_000].map((contextWindowLimit) => {
        const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
        model.updateConfig({ contextWindowLimit })
        return model
      })
      const router = new ModelRouter(models)
      const routingContext: RoutingContext = {
        messages: [],
        toolSpecs: [],
        candidates: router.candidates,
        invocationState: {},
        attempts: [],
      }
      const strategy = new FallbackStrategy({ cooldown: 60 })
      const attempts = [{ candidate: router.candidates[0]!, exception: new ContextWindowOverflowError('too large') }]

      expect(await strategy.select({ ...routingContext, attempts })).toBe(router.candidates[2])
      expect(await strategy.select(routingContext)).toBe(router.candidates[0])
    })
  })
})
