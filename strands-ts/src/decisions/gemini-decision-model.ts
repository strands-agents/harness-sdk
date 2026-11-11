import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  resolveSystemOneProviderConfig,
  toWireQuestions,
  toWireState,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
const GEMINI_DEFAULT_MODEL_ID = 'gemini-decision-1'
const GEMINI_DEFAULT_MIN_CONFIDENCE = 0.5
const GEMINI_MAX_QUESTIONS = 1000

/** Options for constructing a {@link GeminiDecisionModel}. */
export interface GeminiDecisionModelOptions {
  /** Gemini API key. Defaults to `GEMINI_API_KEY`. */
  readonly apiKey?: string
  /** Gemini decision model identifier. Defaults to `gemini-decision-1`. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by the Gemini Decisions API.
 *
 * String state is sent as the request input. Content block and message state is sent as JSON text,
 * because the API does not accept conversation history.
 *
 * @example
 * ```typescript
 * const decisions = new GeminiDecisionModel()
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
 * })
 * ```
 */
export class GeminiDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig

  /**
   * @param options - Provider, model, and confidence configuration.
   * @throws Error if the API key, confidence threshold, or fetch implementation is invalid.
   */
  constructor(options: GeminiDecisionModelOptions = {}) {
    super()
    const providerConfig = resolveSystemOneProviderConfig(options, {
      className: 'GeminiDecisionModel',
      providerName: 'gemini',
      endpoint: GEMINI_ENDPOINT,
      apiKeyEnvironmentVariable: 'GEMINI_API_KEY',
      apiKeyHeader: 'x-goog-api-key',
      modelId: GEMINI_DEFAULT_MODEL_ID,
      defaultMinConfidence: GEMINI_DEFAULT_MIN_CONFIDENCE,
      maxQuestions: GEMINI_MAX_QUESTIONS,
    })
    this._providerConfig = {
      ...providerConfig,
      buildRequestBody: (state, questions): Record<string, unknown> => ({
        model: providerConfig.modelId,
        input: toGeminiInput(state),
        questions: toWireQuestions(questions, ''),
      }),
    }
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    return askSystemOne(
      this._providerConfig,
      httpTransport(this._providerConfig),
      state,
      questions,
      options.cancelSignal
    )
  }
}

function toGeminiInput(state: DecisionInput): string {
  return typeof state === 'string' ? state : JSON.stringify(toWireState(state))
}
