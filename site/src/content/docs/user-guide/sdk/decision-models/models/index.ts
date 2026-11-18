import { DecisionModel } from '@strands-agents/sdk'
import type {
  DecisionCallOptions,
  DecisionInput,
  DecisionResult,
  Question,
} from '@strands-agents/sdk'

async function customExample() {
  // --8<-- [start:custom]
  /** Answers yes when the input contains any of the keywords. */
  class KeywordDecisionModel extends DecisionModel {
    constructor(private readonly keywords: string[]) {
      super()
    }

    protected async _ask<const Q extends Record<string, Question>>(
      state: DecisionInput,
      questions: Q,
      _options: DecisionCallOptions
    ): Promise<DecisionResult<Q>> {
      const startedAt = performance.now()
      const text = JSON.stringify(state).toLowerCase()
      const found = this.keywords.some((keyword) => text.includes(keyword))
      const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, found]))
      return {
        answers,
        metadata: { latencyMs: Math.round(performance.now() - startedAt) },
      } as DecisionResult<Q>
    }
  }

  const decisions = new KeywordDecisionModel(['refund', 'charged twice'])
  const result = await decisions.ask('I was charged twice for order 1182.', {
    billing: { question: 'Is this a billing issue?', choices: 'boolean' },
  })
  console.log(result.answers)

  // Output:
  // { billing: true }
  // --8<-- [end:custom]
}
