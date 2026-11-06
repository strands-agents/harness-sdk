import type { SageMakerRuntimeClient, SageMakerRuntimeClientConfig } from '@aws-sdk/client-sagemaker-runtime'

import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../errors.js'
import { DecisionModel } from './decision-model.js'
import {
  askSystemOneWith,
  resolveDefaultMinConfidence,
  type SystemOneRequestConfig,
} from './system-one-http-adapter.js'
import type { DecisionCallOptions, DecisionInput, DecisionResult, Question } from './types.js'

const SAGEMAKER_PROVIDER_NAME = 'sagemaker'
const SAGEMAKER_DEFAULT_MIN_CONFIDENCE = 0.5
// InvokeEndpoint rejects request bodies larger than 6 MB.
const SAGEMAKER_MAX_BODY_BYTES = 6 * 1024 * 1024
const THROTTLING_ERROR_NAMES = new Set(['ThrottlingException', 'ModelNotReadyException', 'ServiceUnavailable'])
const THROTTLING_CONTAINER_STATUSES = new Set([429, 503, 529])

/** Options for constructing a {@link SageMakerDecisionModel}. */
export interface SageMakerDecisionModelOptions {
  /** Name of the SageMaker AI real-time endpoint that serves the System One model. */
  readonly endpointName: string
  /** AWS region of the endpoint. Takes precedence over `clientConfig.region`. */
  readonly region?: string
  /** Configuration for the SageMaker Runtime client. */
  readonly clientConfig?: SageMakerRuntimeClientConfig
  /** Default minimum confidence. Defaults to `0.5`. */
  readonly defaultMinConfidence?: number
}

/**
 * Decision model backed by a System One model hosted on a SageMaker AI real-time endpoint,
 * such as a strands-decider model.
 *
 * Requests are signed with AWS Signature Version 4 using the standard AWS credential chain;
 * callers need `sagemaker:InvokeEndpoint` on the endpoint. `@aws-sdk/client-sagemaker-runtime`
 * is an optional peer dependency, loaded on the first request. Install it with
 * `npm install @aws-sdk/client-sagemaker-runtime`.
 *
 * @example
 * ```typescript
 * const decisions = new SageMakerDecisionModel({ endpointName: 'strands-decider-2b-qwen3-5-v1-2610' })
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   urgent: { question: 'Is this urgent?', choices: 'boolean' },
 * })
 * ```
 */
export class SageMakerDecisionModel extends DecisionModel {
  private readonly _endpointName: string
  private readonly _clientConfig: SageMakerRuntimeClientConfig
  private readonly _requestConfig: SystemOneRequestConfig
  private _client: Promise<SageMakerRuntimeClient> | undefined

  /**
   * @param options - Endpoint, client, and confidence configuration.
   * @throws Error if the endpoint name or confidence threshold is invalid.
   */
  constructor(options: SageMakerDecisionModelOptions) {
    super()
    const endpointName = options.endpointName?.trim()
    if (!endpointName) {
      throw new Error('SageMakerDecisionModel requires an endpointName')
    }
    this._endpointName = endpointName
    this._clientConfig = { ...options.clientConfig, ...(options.region && { region: options.region }) }
    this._requestConfig = {
      providerName: SAGEMAKER_PROVIDER_NAME,
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? SAGEMAKER_DEFAULT_MIN_CONFIDENCE,
        'SageMakerDecisionModel'
      ),
      maxBodyBytes: SAGEMAKER_MAX_BODY_BYTES,
    }
  }

  protected _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    return askSystemOneWith(
      this._requestConfig,
      (body, cancelSignal) => this._invoke(body, cancelSignal),
      state,
      questions,
      options.cancelSignal
    )
  }

  private async _invoke(body: string, cancelSignal?: AbortSignal): Promise<unknown> {
    const { InvokeEndpointCommand } = await loadSageMakerRuntime()
    const client = await this._getClient()
    let responseBody: Uint8Array | undefined
    try {
      const output = await client.send(
        new InvokeEndpointCommand({
          EndpointName: this._endpointName,
          ContentType: 'application/json',
          Accept: 'application/json',
          Body: new TextEncoder().encode(body),
        }),
        cancelSignal !== undefined ? { abortSignal: cancelSignal } : {}
      )
      responseBody = output.Body
    } catch (error) {
      throw translateSageMakerError(error)
    }

    try {
      return JSON.parse(new TextDecoder().decode(responseBody)) as unknown
    } catch (error) {
      throw new ModelError('decision provider returned a non-JSON response', { cause: error })
    }
  }

  private _getClient(): Promise<SageMakerRuntimeClient> {
    this._client ??= loadSageMakerRuntime().then(
      ({ SageMakerRuntimeClient }) => new SageMakerRuntimeClient(this._clientConfig)
    )
    return this._client
  }
}

async function loadSageMakerRuntime(): Promise<typeof import('@aws-sdk/client-sagemaker-runtime')> {
  try {
    return await import('@aws-sdk/client-sagemaker-runtime')
  } catch (cause) {
    throw new Error(
      "SageMakerDecisionModel requires the '@aws-sdk/client-sagemaker-runtime' package | " +
        "install it with: npm install '@aws-sdk/client-sagemaker-runtime'",
      { cause }
    )
  }
}

/**
 * Maps SageMaker Runtime errors to SDK model errors. A container's own HTTP error arrives as a
 * SageMaker `ModelError` that carries the container's status in `OriginalStatusCode`.
 */
function translateSageMakerError(error: unknown): Error {
  const message = `${SAGEMAKER_PROVIDER_NAME} decision request failed: ${normalizeError(error).message}`
  const {
    name,
    OriginalStatusCode: status,
    OriginalMessage: originalMessage,
  } = (error ?? {}) as {
    name?: string
    OriginalStatusCode?: number
    OriginalMessage?: string
  }
  if (
    (name !== undefined && THROTTLING_ERROR_NAMES.has(name)) ||
    (status !== undefined && THROTTLING_CONTAINER_STATUSES.has(status))
  ) {
    return new ModelThrottledError(message, { cause: error })
  }
  // strands-decider refuses a prompt longer than the model's context window with HTTP 422.
  if (status === 413 || (status === 422 && /context window/i.test(originalMessage ?? ''))) {
    return new ContextWindowOverflowError(message)
  }
  return new ModelError(message, { cause: error })
}
