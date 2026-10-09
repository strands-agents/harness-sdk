import { describe, expect, it } from 'vitest'
import { LLMDecisionModel, Uncertain } from '@strands-agents/sdk'
import type { DecisionModel } from '@strands-agents/sdk'
import { bedrock } from '../__fixtures__/model-providers.js'

const BEDROCK_HAIKU_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0'

/** One decision-model implementation under test. Add new entries as implementations land. */
interface DecisionModelProvider {
  readonly name: string
  readonly skip: boolean
  create(): DecisionModel
}

const providers: readonly DecisionModelProvider[] = [
  {
    name: 'LLMDecisionModel(BedrockModel)',
    skip: bedrock.skip,
    create: () => new LLMDecisionModel(bedrock.createModel({ modelId: BEDROCK_HAIKU_MODEL_ID, maxTokens: 512 })),
  },
]

describe.each(providers)('DecisionModel Integration Tests ($name)', (provider) => {
  const describeOrSkip = provider.skip ? describe.skip : describe

  describeOrSkip('ask', () => {
    it(
      'answers each question with the typed value and reports usage/latency',
      { timeout: 120_000, retry: 1 },
      async () => {
        const decision = provider.create()

        const result = await decision.ask('The fruit is a ripe banana.', {
          color: { instructions: 'What color is the fruit?', choices: ['red', 'yellow', 'blue'] as const },
          isFruit: {
            instructions: 'Is the thing described a fruit?',
            choices: 'boolean',
            uncertainOptions: { allow: false },
          },
        })

        expect(result.answers.color).toBe('yellow')
        expect(result.answers.isFruit).toBe(true)
        expect(result.usage.inputTokens).toBeGreaterThan(0)
        expect(result.usage.outputTokens).toBeGreaterThan(0)
        expect(result.metadata.latencyMs).toBeGreaterThan(0)
      }
    )

    it(
      'returns Uncertain with a reason when the state cannot answer the question',
      { timeout: 120_000, retry: 1 },
      async () => {
        const decision = provider.create()

        const result = await decision.ask('There is a round object on the table.', {
          color: { instructions: 'What color is the object?', choices: ['red', 'green', 'blue'] as const },
        })

        expect(result.answers.color).toBeInstanceOf(Uncertain)
        const answer = result.answers.color as Uncertain
        expect(answer.reason).toBeDefined()
        expect(String(answer)).toMatch(/^Uncertain/)
      }
    )
  })
})
