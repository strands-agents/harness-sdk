import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  REFUSED_ANSWER_TYPE,
  resolveSystemOneProviderConfig,
  toWireQuestions,
  toWireState,
  type SystemOneProviderConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/decisions'
const OPENAI_DEFAULT_MODEL_ID = 'gpt-6-luna'
const OPENAI_DEFAULT_MIN_CONFIDENCE = 0.5
const OPENAI_MAX_QUESTIONS = 400

/** Options for constructing an {@link OpenAIDecisionModel}. */
export interface OpenAIDecisionModelOptions {
  /** OpenAI API key. Defaults to `OPENAI_API_KEY`. */
  readonly apiKey?: string
  /** OpenAI decision model identifier. Defaults to `gpt-6-luna`. */
  readonly modelId?: string
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
  /** Custom fetch implementation, primarily for transport configuration and tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Decision model backed by the OpenAI Decisions API.
 *
 * String state is sent as the request input. Content block and message state is sent as JSON text.
 *
 * Boolean questions are sent as `predicate` questions. The API returns only a probability for them, so
 * their confidence is `|2p - 1|`, the scale every System One provider shares.
 *
 * The API can decline one question and answer the rest. A declined question is reported as `Uncertain`,
 * so the remaining answers stay usable; it throws only for a question that set `uncertainty: false`.
 *
 * @example
 * ```typescript
 * const decisions = new OpenAIDecisionModel()
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   department: { question: 'Which team should handle this?', choices: ['billing', 'support'] },
 * })
 * ```
 */
export class OpenAIDecisionModel extends DecisionModel {
  private readonly _providerConfig: SystemOneProviderConfig

  /**
   * @param options - Provider, model, and confidence configuration.
   * @throws Error if the API key, confidence threshold, or fetch implementation is invalid.
   */
  constructor(options: OpenAIDecisionModelOptions = {}) {
    super()
    const providerConfig = resolveSystemOneProviderConfig(options, {
      className: 'OpenAIDecisionModel',
      providerName: 'openai',
      endpoint: OPENAI_ENDPOINT,
      apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
      modelId: OPENAI_DEFAULT_MODEL_ID,
      defaultMinConfidence: OPENAI_DEFAULT_MIN_CONFIDENCE,
      maxQuestions: OPENAI_MAX_QUESTIONS,
    })
    this._providerConfig = {
      ...providerConfig,
      buildRequestBody: (state, questions): Record<string, unknown> => ({
        model: providerConfig.modelId,
        input: toOpenAIInput(state),
        questions: toOpenAIQuestions(questions),
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
        toSystemOneResponse(await transport(body, cancelSignal), questions, this._providerConfig.modelId),
      state,
      questions,
      options.cancelSignal
    )
  }
}

function toOpenAIInput(state: DecisionInput): string {
  return typeof state === 'string' ? state : JSON.stringify(toWireState(state))
}

/** OpenAI takes an ordered question array, named by question id, with `predicate` in place of `noul`. */
function toOpenAIQuestions(questions: Record<string, Question>): Record<string, unknown>[] {
  return Object.entries(toWireQuestions(questions)).map(([name, question]) =>
    question.type === 'noul'
      ? { name, type: 'predicate', instructions: question.instructions }
      : {
          name,
          type: 'choice',
          instructions: question.instructions,
          choices: Object.keys(question.criteria).map((value) => ({ value })),
        }
  )
}

/**
 * Maps an OpenAI response to the System One shape: answers arrive as an array named by question id,
 * the documented response omits `model`, `predicate` answers carry `probability`, and choice
 * probabilities are a `{ value, probability }` list. Answers naming a question that was not asked are
 * dropped. Anything else passes through for the shared parser to validate.
 */
function toSystemOneResponse(payload: unknown, questions: Record<string, Question>, modelId: string): unknown {
  if (!isRecord(payload) || !Array.isArray(payload['answers'])) return payload
  const answers = Object.fromEntries(
    payload['answers']
      .filter(isRecord)
      .filter((answer) => typeof answer['name'] === 'string' && Object.hasOwn(questions, answer['name']))
      .map((answer) => [String(answer['name']), toSystemOneAnswer(answer)])
  )
  return { ...payload, model: payload['model'] ?? modelId, answers }
}

function toSystemOneAnswer(answer: Record<string, unknown>): unknown {
  if (answer['type'] === 'refusal') return { type: REFUSED_ANSWER_TYPE, reason: 'openai declined to answer' }
  if (answer['type'] === 'predicate') return { type: 'noul', noul: answer['probability'] }
  if (answer['type'] !== 'choice' || !Array.isArray(answer['probabilities'])) return answer
  return {
    ...answer,
    probabilities: Object.fromEntries(
      answer['probabilities'].filter(isRecord).map((entry) => [String(entry['value']), entry['probability']])
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
