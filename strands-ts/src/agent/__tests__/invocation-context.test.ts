import { describe, expect, it } from 'vitest'
import { InvocationContextImpl, reachedLimit } from '../invocation-context.js'
import { accumulateUsage, createEmptyUsage, type Usage } from '../../models/streaming.js'

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

  describe('usageByModel', () => {
    const call = { inputTokens: 3, outputTokens: 1, totalTokens: 4 }

    function summed(usages: Usage[]): Usage {
      const total = createEmptyUsage()
      for (const usage of usages) accumulateUsage(total, usage)
      return total
    }

    it('keeps one record per provider name and model id', () => {
      const request = new InvocationContextImpl()

      request.recordUsage(call, { providerName: 'bedrock', modelId: 'model-a' })
      request.recordUsage({ ...call, cacheReadInputTokens: 2 }, { providerName: 'bedrock', modelId: 'model-a' })
      request.recordUsage(call, { providerName: 'openai', modelId: 'model-a' })
      request.recordUsage(call, { providerName: 'bedrock', modelId: 'model-b' })

      expect(request.usageByModel).toStrictEqual([
        {
          providerName: 'bedrock',
          modelId: 'model-a',
          usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8, cacheReadInputTokens: 2 },
        },
        { providerName: 'openai', modelId: 'model-a', usage: call },
        { providerName: 'bedrock', modelId: 'model-b', usage: call },
      ])
    })

    it('keeps usage of an unknown model apart', () => {
      const request = new InvocationContextImpl()

      request.recordUsage(call)
      request.recordUsage(call, { providerName: 'bedrock', modelId: null })
      request.recordUsage(call, { providerName: 'bedrock', modelId: 'model-a' })

      expect(request.usageByModel).toStrictEqual([
        { providerName: null, modelId: null, usage: call },
        { providerName: 'bedrock', modelId: null, usage: call },
        { providerName: 'bedrock', modelId: 'model-a', usage: call },
      ])
    })

    it('adds up to usage in the context and every parent', () => {
      const request = new InvocationContextImpl()
      const nested = new InvocationContextImpl({ turns: 5 }, request)
      const auxiliary = new InvocationContextImpl(undefined, nested, true)
      const modelA = { providerName: 'bedrock', modelId: 'model-a' }

      request.recordUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }, modelA)
      nested.recordUsage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 }, modelA)
      nested.recordUsage({ inputTokens: 5, outputTokens: 5, totalTokens: 20, cacheWriteInputTokens: 10 })
      auxiliary.recordUsage(
        { inputTokens: 100, outputTokens: 1, totalTokens: 101 },
        { providerName: 'openai', modelId: 'model-b' }
      )

      const contexts = [request, nested, auxiliary]
      expect(contexts.map((context) => context.usageByModel.length)).toStrictEqual([3, 3, 1])
      for (const context of contexts) {
        const { turnsTaken: _turnsTaken, ...usage } = context.usage
        expect(summed(context.usageByModel.map((record) => record.usage))).toStrictEqual(usage)
      }
    })

    it('returns a snapshot', () => {
      const request = new InvocationContextImpl()
      const modelA = { providerName: 'bedrock', modelId: 'model-a' }
      request.recordUsage(call, modelA)

      const snapshot = request.usageByModel
      snapshot[0]!.usage.inputTokens = 99
      snapshot.length = 0
      request.recordUsage(call, modelA)

      expect(request.usageByModel).toStrictEqual([
        { ...modelA, usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 } },
      ])
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
