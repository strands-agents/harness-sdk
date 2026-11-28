/**
 * Amazon SageMaker AI model provider implementation.
 *
 * Sends OpenAI Chat Completions requests to SageMaker AI endpoints that host an OpenAI-compatible
 * container, such as vLLM, TGI, or DJL LMI.
 *
 * @see https://docs.aws.amazon.com/sagemaker/latest/APIReference/API_runtime_InvokeEndpointWithResponseStream.html
 */

import type {
  InvokeEndpointCommandInput,
  SageMakerRuntimeClient,
  SageMakerRuntimeClientConfig,
} from '@aws-sdk/client-sagemaker-runtime'
import { Model, resolveConfigMetadata } from '../model.js'
import type { StreamOptions } from '../model.js'
import type { Message } from '../../types/messages.js'
import type { ModelStreamEvent } from '../streaming.js'
import { ContextWindowOverflowError, ModelThrottledError, normalizeError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { classifyOpenAIError } from '../openai/errors.js'
import { buildPayload } from './request.js'
import { ChunkAccumulator, responseToChunk } from './stream-events.js'
import { parseEventStream, parseResponseBody } from './stream-parser.js'
import type { ResponseStreamPart } from './stream-parser.js'
import type { SageMakerEndpointConfig, SageMakerModelConfig, SageMakerModelOptions } from './types.js'

const DEFAULT_REGION = 'us-west-2'
const USER_AGENT: [string] = ['strands-agents-ts-sdk']

/**
 * Model provider for OpenAI-compatible containers hosted on Amazon SageMaker AI real-time endpoints.
 *
 * Streams through `InvokeEndpointWithResponseStream`, or calls `InvokeEndpoint` when `stream` is
 * `false`. Requests are signed with the standard AWS credential chain; callers need
 * `sagemaker:InvokeEndpoint` (and `sagemaker:InvokeEndpointWithResponseStream` to stream).
 *
 * `@aws-sdk/client-sagemaker-runtime` is an optional peer dependency, loaded on the first request.
 * Install it with `npm install @aws-sdk/client-sagemaker-runtime`.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { SageMakerModel } from '@strands-agents/sdk/models/sagemaker'
 *
 * const model = new SageMakerModel({ endpointName: 'my-vllm-endpoint', region: 'us-west-2', maxTokens: 4096 })
 * const agent = new Agent({ model })
 * ```
 */
export class SageMakerModel extends Model<SageMakerModelConfig> {
  private _config: SageMakerModelConfig
  private readonly _endpoint: SageMakerEndpointConfig
  private readonly _providedClient: SageMakerRuntimeClient | undefined
  private readonly _clientConfig: SageMakerRuntimeClientConfig
  private _runtime: Promise<SageMakerRuntime> | undefined

  /**
   * @param options - Endpoint, client, and model configuration.
   * @throws Error if `endpointName` is empty, or if `client` is combined with `region` or `clientConfig`.
   */
  constructor(options: SageMakerModelOptions) {
    super()
    const {
      endpointName,
      region,
      inferenceComponentName,
      targetModel,
      targetVariant,
      additionalRequestArgs,
      client,
      clientConfig,
      ...modelConfig
    } = options

    const trimmedName = endpointName?.trim()
    if (!trimmedName) {
      throw new Error('SageMakerModel requires an endpointName')
    }
    if (client && (region !== undefined || clientConfig !== undefined)) {
      throw new Error(
        'Cannot specify both client and region/clientConfig. Configure them on the SageMakerRuntimeClient instead.'
      )
    }

    this._endpoint = {
      endpointName: trimmedName,
      ...(inferenceComponentName !== undefined && { inferenceComponentName }),
      ...(targetModel !== undefined && { targetModel }),
      ...(targetVariant !== undefined && { targetVariant }),
      ...(additionalRequestArgs !== undefined && { additionalRequestArgs }),
    }
    this._config = { stream: true, toolResultsAsUserMessages: false, ...modelConfig }
    this._providedClient = client
    this._clientConfig = {
      ...clientConfig,
      region: region ?? clientConfig?.region ?? envRegion() ?? DEFAULT_REGION,
      customUserAgent: [...userAgentEntries(clientConfig?.customUserAgent), USER_AGENT],
    }
  }

  /** Merges the given settings into the current configuration. */
  updateConfig(modelConfig: SageMakerModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  /** The current configuration. */
  getConfig(): SageMakerModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? '')
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!messages || messages.length === 0) {
      throw new Error('At least one message is required')
    }
    const runtime = await this._getRuntime()
    const input = this._buildInput(buildPayload(this._config, messages, options))
    const sendOptions = options?.cancelSignal ? { abortSignal: options.cancelSignal } : {}

    try {
      const accumulator = new ChunkAccumulator()
      yield accumulator.start()
      for await (const chunk of this._chunks(runtime, input, sendOptions)) {
        yield* accumulator.push(chunk)
      }
      yield* accumulator.finish()
    } catch (error) {
      throw rewrapError(error)
    }
  }

  private async *_chunks(
    { client, InvokeEndpointCommand, InvokeEndpointWithResponseStreamCommand }: SageMakerRuntime,
    input: InvokeEndpointCommandInput,
    sendOptions: { abortSignal?: AbortSignal }
  ): AsyncGenerator<ReturnType<typeof responseToChunk>> {
    if (this._config.stream === false) {
      const output = await client.send(new InvokeEndpointCommand(input), sendOptions)
      yield responseToChunk(parseResponseBody(output.Body ?? new Uint8Array()))
      return
    }
    const output = await client.send(new InvokeEndpointWithResponseStreamCommand(input), sendOptions)
    if (!output.Body) throw new Error('SageMaker endpoint returned an empty response stream')
    yield* parseEventStream(output.Body as AsyncIterable<ResponseStreamPart>)
  }

  private _buildInput(payload: Record<string, unknown>): InvokeEndpointCommandInput {
    logger.debug(`endpoint_name=<${this._endpoint.endpointName}> | invoking SageMaker endpoint`)
    return {
      ...this._endpoint.additionalRequestArgs,
      EndpointName: this._endpoint.endpointName,
      Body: new TextEncoder().encode(JSON.stringify(payload)),
      ContentType: 'application/json',
      Accept: 'application/json',
      ...(this._endpoint.inferenceComponentName !== undefined && {
        InferenceComponentName: this._endpoint.inferenceComponentName,
      }),
      ...(this._endpoint.targetModel !== undefined && { TargetModel: this._endpoint.targetModel }),
      ...(this._endpoint.targetVariant !== undefined && { TargetVariant: this._endpoint.targetVariant }),
    }
  }

  /** Loads the SDK module and builds the client once; concurrent first calls share the result. */
  private _getRuntime(): Promise<SageMakerRuntime> {
    this._runtime ??= loadSageMakerRuntime().then((sdk) => ({
      client: this._providedClient ?? new sdk.SageMakerRuntimeClient(this._clientConfig),
      InvokeEndpointCommand: sdk.InvokeEndpointCommand,
      InvokeEndpointWithResponseStreamCommand: sdk.InvokeEndpointWithResponseStreamCommand,
    }))
    return this._runtime
  }
}

type SageMakerSdk = typeof import('@aws-sdk/client-sagemaker-runtime')

interface SageMakerRuntime {
  client: SageMakerRuntimeClient
  InvokeEndpointCommand: SageMakerSdk['InvokeEndpointCommand']
  InvokeEndpointWithResponseStreamCommand: SageMakerSdk['InvokeEndpointWithResponseStreamCommand']
}

async function loadSageMakerRuntime(): Promise<SageMakerSdk> {
  try {
    return await import('@aws-sdk/client-sagemaker-runtime')
  } catch (cause) {
    throw new Error(
      "SageMakerModel requires the '@aws-sdk/client-sagemaker-runtime' package | " +
        "install it with: npm install '@aws-sdk/client-sagemaker-runtime'",
      { cause }
    )
  }
}

/** `AWS_REGION`, read only where `process` exists so the module also loads in browsers. */
function envRegion(): string | undefined {
  return typeof process !== 'undefined' ? process.env?.AWS_REGION : undefined
}

function userAgentEntries(userAgent: SageMakerRuntimeClientConfig['customUserAgent']): [string, string?][] {
  if (userAgent === undefined) return []
  return typeof userAgent === 'string' ? [[userAgent]] : [...userAgent]
}

/**
 * Maps SageMaker Runtime errors to SDK errors. A container's own HTTP error arrives as a SageMaker
 * `ModelError` carrying the container's status in `OriginalStatusCode` and its body in `OriginalMessage`.
 */
function rewrapError(error: unknown): unknown {
  const { name, OriginalStatusCode, OriginalMessage, $metadata } = (error ?? {}) as {
    name?: unknown
    OriginalStatusCode?: unknown
    OriginalMessage?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  const status = Number(OriginalStatusCode ?? $metadata?.httpStatusCode)
  const message = normalizeError(error).message

  const containerMessage = typeof OriginalMessage === 'string' ? OriginalMessage : message
  const kind = classifyOpenAIError(new Error(containerMessage))
  if (name === 'ThrottlingException' || name === 'ModelNotReadyException' || status === 429 || kind === 'throttling') {
    return new ModelThrottledError(message, { cause: error })
  }
  if (kind === 'contextOverflow') {
    return new ContextWindowOverflowError(message)
  }
  return error
}
