import { describe, expect, it } from 'vitest'

import { DecisionsAPIDecisionModel, TypeSafeDecisionModel } from '@strands-agents/sdk'
import type { DecisionModel } from '@strands-agents/sdk'

interface SystemOneProvider {
  readonly name: string
  readonly skip: boolean
  readonly providerName: string
  create(): DecisionModel
}

const providers: readonly SystemOneProvider[] = [
  {
    name: 'TypeSafeDecisionModel',
    skip: !process.env['TYPESAFE_API_KEY'],
    providerName: 'typesafe',
    create: () => new TypeSafeDecisionModel(),
  },
  {
    name: 'DecisionsAPIDecisionModel',
    skip: !process.env['JEV_API_KEY'],
    providerName: 'decisionsApi',
    create: () => new DecisionsAPIDecisionModel(),
  },
]

describe.each(providers)('System One DecisionModel Integration Tests ($name)', (provider) => {
  const describeOrSkip = provider.skip ? describe.skip : describe

  describeOrSkip('ask', () => {
    it('answers Noul and Choice questions and reports provider metadata', { timeout: 120_000, retry: 1 }, async () => {
      const result = await provider.create().ask('The fruit is a ripe yellow banana.', {
        color: {
          question: 'What color is the fruit?',
          choices: ['red', 'yellow', 'blue'],
          uncertainty: false,
        },
        isFruit: {
          question: 'Is the thing described a fruit?',
          choices: 'boolean',
          uncertainty: false,
        },
      })

      expect(result.answers).toEqual({ color: 'yellow', isFruit: true })
      expect(result.metadata.providerName).toBe(provider.providerName)
      expect(result.metadata.modelId).toBeTruthy()
      expect(result.metadata.probabilities?.color).toBeDefined()
      expect(result.metadata.probabilities?.isFruit).toBeDefined()
      expect(result.metadata.confidence?.color).toBeGreaterThanOrEqual(0)
      expect(result.metadata.confidence?.isFruit).toBeGreaterThanOrEqual(0)
      expect(result.metadata.latencyMs).toBeGreaterThan(0)
    })
  })
})
