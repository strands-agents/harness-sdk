import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  isRecord,
  resolveSystemOneProviderConfig,
  toWireQuestions,
  toWireStateText,
  type RequestBodyBuilder,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions'
const GEMINI_DEFAULT_MODEL_ID = 'gemini-decision-1'
// Gemini's confidence is the top answer's probability: 0.5-1 for Noul, 1/N-1 for Choice. 0.75 keeps Noul answers
// Uncertain between p = 0.25 and 0.75; Choice keeps 0.5 so a clear favorite (e.g. 0.7 of 4 options) still commits.
const GEMINI_DEFAULT_MIN_CONFIDENCE = 0.75
const GEMINI_DEFAULT_CHOICE_MIN_CONFIDENCE = 0.5
const GEMINI_MAX_QUESTIONS = 1000
// Gemini rounds each Choice probability on the server (about 2 significant figures). That moves each value by
// at most 5% of itself, so a distribution can sum anywhere within 1 +/- 0.05 (e.g. 6 x 0.17 = 1.02); the default
// 4-decimal tolerance rejects that.
const GEMINI_PROBABILITY_SUM_TOLERANCE = 0.05

/** Options for constructing a {@link GeminiDecisionModel}. */
export interface GeminiDecisionModelOptions {
  /** Gemini API key. Defaults to `GEMINI_API_KEY`. */
  readonly apiKey?: string
  /** Gemini decision model identifier. Defaults to `gemini-decision-1`. */
  readonly modelId?: string
  /**
   * Default minimum confidence for both question types, on Gemini's confidence scale. Defaults to `0.75` for
   * boolean questions and `0.5` for choice questions.
   */
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
 * Confidence is Gemini's own: the probability of the top answer, `max(p, 1 - p)` for boolean questions
 * (range `0.5`-`1`) and the top option's probability for choice questions. `metadata.confidence` reports it
 * and `minConfidence` is compared against it, so thresholds tuned for another provider need retuning.
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
    this._providerConfig = resolveSystemOneProviderConfig(options, {
      className: 'GeminiDecisionModel',
      providerName: 'gemini',
      endpoint: GEMINI_ENDPOINT,
      apiKeyEnvironmentVariable: 'GEMINI_API_KEY',
      authHeaders: (apiKey) => ({ 'x-goog-api-key': apiKey }),
      modelId: GEMINI_DEFAULT_MODEL_ID,
      defaultMinConfidence: GEMINI_DEFAULT_MIN_CONFIDENCE,
      defaultChoiceMinConfidence: GEMINI_DEFAULT_CHOICE_MIN_CONFIDENCE,
      maxQuestions: GEMINI_MAX_QUESTIONS,
      probabilitySumTolerance: GEMINI_PROBABILITY_SUM_TOLERANCE,
      buildRequestBody: geminiRequestBody,
    })
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

const geminiRequestBody: RequestBodyBuilder = (state, questions, modelId) => ({
  ...(modelId !== undefined && { model: modelId }),
  input: toWireStateText(state),
  questions: toWireQuestions(questions, ''),
})

/**
 * Maps a Gemini response to the System One shape: Gemini does not echo the model and reports usage as
 * `total_input_tokens` and `total_output_tokens`. A Noul answer without `confidence` gets Gemini's documented
 * `max(p, 1 - p)`, so it stays on Gemini's scale. Anything else passes through for the shared parser to validate.
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
  const answers = payload['answers']
  return {
    ...payload,
    model: payload['model'] ?? modelId,
    ...(isRecord(answers) && {
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, withNoulConfidence(answer)])),
    }),
    ...(isRecord(usage) && {
      usage: { input_tokens: usage['total_input_tokens'], output_tokens: usage['total_output_tokens'] },
    }),
  }
}

function withNoulConfidence(answer: unknown): unknown {
  if (!isRecord(answer) || answer['type'] !== 'noul' || answer['confidence'] !== undefined) return answer
  const probability = answer['noul']
  return typeof probability === 'number' ? { ...answer, confidence: Math.max(probability, 1 - probability) } : answer
}
