import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  resolveSystemOneProviderConfig,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionInput, DecisionResult, Question } from './types.js'

const DECISIONS_API_ENDPOINT = 'https://decisionapi.net/v1/systemone'
const DECISIONS_API_DEFAULT_MODEL_ID = '~typesafe/jev-latest'
const DECISIONS_API_DEFAULT_MIN_CONFIDENCE = 0.5
const DECISIONS_API_MAX_QUESTIONS = 8
const DECISIONS_API_MAX_BODY_BYTES = 32 * 1024

/** Options for constructing a {@link DecisionsAPIDecisionModel}. */
export interface DecisionsAPIDecisionModelOptions {
  /** Decisions API key. Defaults to `JEV_API_KEY`. */
  readonly apiKey?: string
  /** Decisions API model identifier. Defaults to `~typesafe/jev-latest`. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by decisionapi.net.
 *
 * @example
 * ```typescript
 * const decisions = new DecisionsAPIDecisionModel()
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
 * })
 * ```
 */
export class DecisionsAPIDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig

  /**
   * @param options - Provider, model, and confidence configuration.
   * @throws Error if the API key, confidence threshold, or fetch implementation is invalid.
   */
  constructor(options: DecisionsAPIDecisionModelOptions = {}) {
    super()
    this._providerConfig = resolveSystemOneProviderConfig(options, {
      className: 'DecisionsAPIDecisionModel',
      providerName: 'decisionsApi',
      endpoint: DECISIONS_API_ENDPOINT,
      apiKeyEnvironmentVariable: 'JEV_API_KEY',
      modelId: DECISIONS_API_DEFAULT_MODEL_ID,
      defaultMinConfidence: DECISIONS_API_DEFAULT_MIN_CONFIDENCE,
      maxQuestions: DECISIONS_API_MAX_QUESTIONS,
      maxBodyBytes: DECISIONS_API_MAX_BODY_BYTES,
    })
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>> {
    return askSystemOne(this._providerConfig, state, questions)
  }
}
