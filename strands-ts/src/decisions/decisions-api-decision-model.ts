import { ModelError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOne,
  httpTransport,
  isRecord,
  requireRecord,
  resolveSystemOneProviderConfig,
  type SystemOneProviderConfig,
  type SystemOneTransport,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const DECISIONS_API_ENDPOINT = 'https://decisionapi.net/v1/systemone'
const DECISIONS_API_DEFAULT_MODEL_ID = '~typesafe/jev-latest'
const DECISIONS_API_DEFAULT_MIN_CONFIDENCE = 0.5
const DECISIONS_API_MAX_QUESTIONS = 8

/** Options for constructing a {@link DecisionsAPIDecisionModel}. */
export interface DecisionsAPIDecisionModelOptions {
  /** Decisions API key. Defaults to `JEV_API_KEY`. */
  readonly apiKey?: string
  /** Decisions API model identifier. Defaults to `~typesafe/jev-latest`. */
  readonly modelId?: string
  /** Default minimum confidence, in `[0.0, 1.0]`. Defaults to `0.5`. */
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
    })
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    const transport = httpTransport(this._providerConfig)
    const unwrappingTransport: SystemOneTransport = async (body, cancelSignal) =>
      this._unwrapEnvelope(await transport(body, cancelSignal))
    return askSystemOne(this._providerConfig, unwrappingTransport, state, questions, options.cancelSignal)
  }

  /**
   * Returns the System One result from decisionapi.net's `{ code, message, data: { result } }` envelope.
   * The envelope does not carry the model, so the result reports the requested one unless it names its own.
   * A payload that is not enveloped is returned unchanged.
   */
  private _unwrapEnvelope(payload: unknown): unknown {
    if (!isRecord(payload) || (!('code' in payload) && !('data' in payload))) return payload

    const code = payload['code']
    if (code !== 0) {
      const detail = typeof payload['message'] === 'string' ? `: ${payload['message']}` : ''
      throw new ModelError(`decision provider returned error code ${String(code)}${detail}`)
    }

    const data = requireRecord(payload['data'], 'decision provider data')
    const result = requireRecord(data['result'], 'decision provider result')
    return { model: this._providerConfig.modelId, ...result }
  }
}
