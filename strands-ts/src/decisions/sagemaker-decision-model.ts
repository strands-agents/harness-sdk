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
const THROTTLING_STATUSES = new Set([429, 503, 529])
// strands-decider reports a prompt longer than the context window with 422, vLLM with 400.
const CONTEXT_OVERFLOW_STATUSES = new Set([400, 422])

/** Options for constructing a {@link SageMakerDecisionModel}. */
export interface SageMakerDecisionModelOptions {
  /** Name of the SageMaker AI real-time endpoint that serves the System One model. */
  readonly endpointName: string
  /** AWS region of the endpoint. Takes precedence over `clientConfig.region`. Cannot be combined with `client`. */
  readonly region?: string
  /** Configuration for the SageMaker Runtime client. Cannot be combined with `client`. */
  readonly clientConfig?: SageMakerRuntimeClientConfig
  /**
   * Pre-built SageMaker Runtime client, for example one shared with other components or configured
   * with custom credentials, middleware, or an endpoint override. Used as is. Cannot be combined
   * with `region` or `clientConfig`.
   */
  readonly client?: SageMakerRuntimeClient
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
 * import { SageMakerDecisionModel } from '@strands-agents/sdk/decisions/sagemaker'
 *
 * const decisions = new SageMakerDecisionModel({ endpointName: 'my-decider-endpoint' })
 * const result = await decisions.ask('A customer needs a refund today.', {
 *   urgent: { question: 'Is this urgent?', choices: 'boolean' },
 * })
 * ```
 */
export class SageMakerDecisionModel extends DecisionModel {
  private readonly _endpointName: string
  private readonly _clientConfig: SageMakerRuntimeClientConfig
  private readonly _requestConfig: SystemOneRequestConfig
  private readonly _providedClient: SageMakerRuntimeClient | undefined
  private _runtime: Promise<SageMakerRuntime> | undefined

  /**
   * @param options - Endpoint, client, and confidence configuration.
   * @throws Error if the endpoint name or confidence threshold is invalid, or if `client` is
   * combined with `region` or `clientConfig`.
   */
  constructor(options: SageMakerDecisionModelOptions) {
    super()
    const endpointName = options.endpointName?.trim()
    if (!endpointName) {
      throw new Error('SageMakerDecisionModel requires an endpointName')
    }
    if (options.client && (options.region || options.clientConfig)) {
      throw new Error(
        'Cannot specify both client and region/clientConfig. Configure them on the SageMakerRuntimeClient instead.'
      )
    }
    this._endpointName = endpointName
    this._providedClient = options.client
    const customUserAgent = options.clientConfig?.customUserAgent
      ? `${options.clientConfig.customUserAgent} strands-agents-ts-sdk`
      : 'strands-agents-ts-sdk'
    this._clientConfig = {
      ...options.clientConfig,
      ...(options.region && { region: options.region }),
      customUserAgent,
    }
    this._requestConfig = {
      providerName: SAGEMAKER_PROVIDER_NAME,
      defaultMinConfidence: resolveDefaultMinConfidence(
        options.defaultMinConfidence ?? SAGEMAKER_DEFAULT_MIN_CONFIDENCE,
        'SageMakerDecisionModel'
      ),
      maxBodyBytes: SAGEMAKER_MAX_BODY_BYTES,
    }
  }

  protected async _ask<const Q extends Record<string, Question>>(
    state: DecisionInput,
    questions: Q,
    options: DecisionCallOptions
  ): Promise<DecisionResult<Q>> {
    // Load the SDK and build the client before the shared adapter starts its latency timer, so
    // `metadata.latencyMs` measures the request alone, not that one-time setup.
    const runtime = await this._getRuntime()
    return askSystemOneWith(
      this._requestConfig,
      (body, cancelSignal) => this._invoke(runtime, body, cancelSignal),
      state,
      questions,
      options.cancelSignal
    )
  }

  private async _invoke(
    { client, InvokeEndpointCommand }: SageMakerRuntime,
    body: string,
    cancelSignal?: AbortSignal
  ): Promise<unknown> {
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

  /** Loads the SDK module and resolves the client once; concurrent first calls share the result. */
  private _getRuntime(): Promise<SageMakerRuntime> {
    this._runtime ??= loadSageMakerRuntime().then(({ SageMakerRuntimeClient, InvokeEndpointCommand }) => ({
      client: this._providedClient ?? new SageMakerRuntimeClient(this._clientConfig),
      InvokeEndpointCommand,
    }))
    return this._runtime
  }
}

interface SageMakerRuntime {
  client: SageMakerRuntimeClient
  InvokeEndpointCommand: typeof import('@aws-sdk/client-sagemaker-runtime').InvokeEndpointCommand
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
 * SageMaker `ModelError` that carries the container's status in `OriginalStatusCode`; any other
 * failure carries the HTTP status of the SageMaker response in `$metadata.httpStatusCode`.
 */
function translateSageMakerError(error: unknown): Error {
  const message = `${SAGEMAKER_PROVIDER_NAME} decision request failed: ${normalizeError(error).message}`
  const { name, OriginalStatusCode, OriginalMessage, $metadata } = (error ?? {}) as {
    name?: unknown
    OriginalStatusCode?: unknown
    OriginalMessage?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  const status = Number(OriginalStatusCode ?? $metadata?.httpStatusCode)
  if ((typeof name === 'string' && THROTTLING_ERROR_NAMES.has(name)) || THROTTLING_STATUSES.has(status)) {
    return new ModelThrottledError(message, { cause: error })
  }
  if (status === 413 || (CONTEXT_OVERFLOW_STATUSES.has(status) && isContextOverflowMessage(OriginalMessage))) {
    return new ContextWindowOverflowError(message)
  }
  return new ModelError(message, { cause: error })
}

/**
 * Whether a container's 400 or 422 body reports a prompt longer than the model's context window.
 * strands-decider sends 422 `{"detail": "... exceeds the context window ..."}`; vLLM sends 400
 * `{"message": "... maximum context length ..."}`. Validation errors also use these statuses, but
 * their `detail` is a list that echoes the request, so only a string `detail` or `message` is matched.
 */
function isContextOverflowMessage(originalMessage: unknown): boolean {
  if (typeof originalMessage !== 'string') return false
  let text: unknown = originalMessage
  try {
    const body = JSON.parse(originalMessage) as unknown
    if (typeof body === 'object' && body !== null) {
      const { detail, message } = body as { detail?: unknown; message?: unknown }
      text = typeof detail === 'string' ? detail : message
    }
  } catch {
    // A non-JSON body is matched as plain text.
  }
  return typeof text === 'string' && /context (window|length)/i.test(text)
}
