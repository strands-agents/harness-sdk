import { describe, expect, it } from 'vitest'

import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
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
  })
})
