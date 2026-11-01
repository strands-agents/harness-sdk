import { describe, expect, it } from 'vitest'
import { InvocationContextImpl, reachedLimit } from '../invocation-context.js'

describe('InvocationContextImpl', () => {
  describe('recordStructuredOutputFailure', () => {
    it('counts toward limiting parents but not through an auxiliary call', () => {
      const request = new InvocationContextImpl({ structuredOutputAttempts: 2 })
      const nested = new InvocationContextImpl({ turns: 5 }, request)
      const auxiliary = new InvocationContextImpl(undefined, request, true)

      nested.recordStructuredOutputFailure()
      auxiliary.recordStructuredOutputFailure()

      expect(request.structuredOutputFailures).toBe(1)
      expect(reachedLimit(nested)).toBeUndefined()
      nested.recordStructuredOutputFailure()
      expect(reachedLimit(nested)).toBe('limitStructuredOutputAttempts')
    })
  })

  describe('hasLimit', () => {
    it('sees the limits of limiting parents only', () => {
      const request = new InvocationContextImpl({ structuredOutputAttempts: 2 })
      const auxiliary = new InvocationContextImpl(undefined, request, true)

      expect([
        new InvocationContextImpl({ turns: 5 }, request).hasLimit('structuredOutputAttempts'),
        auxiliary.hasLimit('structuredOutputAttempts'),
        new InvocationContextImpl({ turns: 5 }).hasLimit('structuredOutputAttempts'),
      ]).toStrictEqual([true, false, false])
    })
  })
})
