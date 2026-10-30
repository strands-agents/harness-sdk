import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  resolveSystemOneProviderConfig,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionInput, DecisionResult, Question } from './types.js'

const TYPE_SAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TYPE_SAFE_DEFAULT_MODEL_ID = 'jev-latest'
const TYPE_SAFE_DEFAULT_MIN_CONFIDENCE = 0.5
const TYPE_SAFE_MAX_BODY_BYTES = 32 * 1024 * 1024

/** Options for constructing a {@link TypeSafeDecisionModel}. */
export interface TypeSafeDecisionModelOptions {
  /** TypeSafe API key. Defaults to `TYPESAFE_API_KEY`. */
  readonly apiKey?: string
  /** Jev model identifier. Defaults to `jev-latest`. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by TypeSafe's hosted Jev API.
 *
 * @example
 * ```typescript
 * const decisions = new TypeSafeDecisionModel()
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   urgent: { question: 'Is this urgent?', choices: 'boolean' },
 * })
 * ```
 */
export class TypeSafeDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig

  /**
   * @param options - Provider, model, and confidence configuration.
   * @throws Error if the API key, confidence threshold, or fetch implementation is invalid.
   */
  constructor(options: TypeSafeDecisionModelOptions = {}) {
    super()
    this._providerConfig = resolveSystemOneProviderConfig(options, {
      className: 'TypeSafeDecisionModel',
      providerName: 'typesafe',
      endpoint: TYPE_SAFE_ENDPOINT,
      apiKeyEnvironmentVariable: 'TYPESAFE_API_KEY',
      modelId: TYPE_SAFE_DEFAULT_MODEL_ID,
      defaultMinConfidence: TYPE_SAFE_DEFAULT_MIN_CONFIDENCE,
      maxBodyBytes: TYPE_SAFE_MAX_BODY_BYTES,
    })
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q
  ): Promise<DecisionResult<Q>> {
    return askSystemOne(this._providerConfig, state, questions)
  }
}
