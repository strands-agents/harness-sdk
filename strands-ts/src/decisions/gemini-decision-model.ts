import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  isRecord,
  resolveSystemOneProviderConfig,
  toWireQuestions,
  toWireStateText,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
const GEMINI_DEFAULT_MODEL_ID = 'gemini-decision-1'
const GEMINI_DEFAULT_MIN_CONFIDENCE = 0.5
const GEMINI_MAX_QUESTIONS = 1000
// Gemini rounds each Choice probability on the server (about 2 significant figures), so a distribution can
// sum to 0.999 or 1.001; the default 4-decimal tolerance rejects that.
const GEMINI_PROBABILITY_SUM_TOLERANCE = 0.01

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
 * Boolean answers report Gemini's own confidence, `max(p, 1 - p)`, in `metadata.confidence`. Whether
 * an answer is `Uncertain` is still decided on the `|2p - 1|` scale every System One provider shares,
 * so a `minConfidence` means the same thing across providers.
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
      noulConfidenceFromProvider: true,
      probabilitySumTolerance: GEMINI_PROBABILITY_SUM_TOLERANCE,
    })
    this._providerConfig = {
      ...providerConfig,
      buildRequestBody: (state, questions): Record<string, unknown> => ({
        model: providerConfig.modelId,
        input: toWireStateText(state),
        questions: toWireQuestions(questions, ''),
      }),
    }
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    const transport = httpTransport(this._providerConfig)
    return askSystemOne(
      this._providerConfig,
      async (body, cancelSignal) =>
        toSystemOneResponse(await transport(body, cancelSignal), this._providerConfig.modelId),
      state,
      questions,
      options.cancelSignal
    )
  }
}

/**
 * Maps a Gemini response to the System One shape: Gemini does not echo the model and reports usage as
 * `total_input_tokens` and `total_output_tokens`. Anything else passes through for the shared parser to validate.
 */
function toSystemOneResponse(payload: unknown, modelId: string): unknown {
  if (!isRecord(payload)) return payload
  // A prompt blocked by Gemini's input policy can come back as a success with empty `answers`.
  const feedback = payload['prompt_feedback']
  if (isRecord(feedback) && feedback['block_reason'] !== undefined) {
    const detail = typeof feedback['block_reason_message'] === 'string' ? `: ${feedback['block_reason_message']}` : ''
    throw new ModelError(`gemini decision prompt was blocked (${String(feedback['block_reason'])})${detail}`)
  }
  const usage = payload['usage']
  return {
    ...payload,
    model: payload['model'] ?? modelId,
    ...(isRecord(usage) && {
      usage: { input_tokens: usage['total_input_tokens'], output_tokens: usage['total_output_tokens'] },
    }),
  }
}
