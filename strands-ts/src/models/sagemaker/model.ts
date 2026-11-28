/**
 * Amazon SageMaker model provider implementation.
 *
 * Sends OpenAI-compatible requests to SageMaker endpoints hosting vLLM, TGI,
 * or DJL inference containers via the SageMaker Runtime API.
 *
 * @example
 * ```typescript
 * import { SageMakerModel } from '@strands-agents/sdk/models/sagemaker'
 *
 * const model = new SageMakerModel({
 *   endpointName: 'my-vllm-endpoint',
 *   region: 'us-west-2',
 *   maxTokens: 4096,
 * })
 * ```
 */

import type { SageMakerRuntimeClient, SageMakerRuntimeClientConfig } from '@aws-sdk/client-sagemaker-runtime'
import { Model, resolveConfigMetadata } from '../model.js'
import type { StreamOptions } from '../model.js'
import type { Message, StopReason } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'
import { ModelThrottledError, normalizeError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { formatChatRequest, mapChatChunkToEvents } from '../openai/chat-adapter.js'
import type { ChatStreamState, OpenAIChatConfig } from '../openai/types.js'
import type { SageMakerModelConfig, SageMakerModelOptions, SageMakerEndpointConfig } from './types.js'
import type { StreamChunk } from './stream-parser.js'
import { parseEventStream, parseResponseBody } from './stream-parser.js'

/**
 * SageMaker model provider.
 *
 * Sends OpenAI Chat Completions–compatible payloads to a SageMaker endpoint
 * via `InvokeEndpointWithResponseStream` (streaming) or `InvokeEndpoint`
 * (non-streaming). The endpoint must host an OpenAI-compatible container
 * such as vLLM, TGI, or DJL LMI.
 *
 * `@aws-sdk/client-sagemaker-runtime` is an optional peer dependency, loaded
 * on the first request. Install it with:
 * ```
 * npm install @aws-sdk/client-sagemaker-runtime
 * ```
 *
 * @example
 * ```typescript
 * import { SageMakerModel } from '@strands-agents/sdk/models/sagemaker'
 * import { Agent } from '@strands-agents/sdk'
 *
 * const model = new SageMakerModel({
 *   endpointName: 'my-vllm-endpoint',
 *   region: 'us-west-2',
 *   maxTokens: 4096,
 *   temperature: 0.7,
 * })
 *
 * const agent = new Agent({ model })
 * const result = await agent.invoke('Hello, how are you?')
 * ```
 */
export class SageMakerModel extends Model<SageMakerModelConfig> {
  private _config: SageMakerModelConfig
  private readonly _endpointConfig: SageMakerEndpointConfig
  private readonly _providedClient: SageMakerRuntimeClient | undefined
  private readonly _clientConfig: SageMakerRuntimeClientConfig
  private _runtime: Promise<SageMakerRuntime> | undefined

  constructor(options: SageMakerModelOptions) {
    super()

    if (!options.endpointName?.trim()) {
      throw new Error('SageMakerModel requires an endpointName')
    }
    if (options.client && options.clientConfig) {
      throw new Error(
        'Cannot specify both client and clientConfig. Configure them on the SageMakerRuntimeClient instead.'
      )
    }

    const {
      // Endpoint config
      endpointName,
      region,
      inferenceComponentName,
      targetModel,
      targetVariant,
      additionalRequestArgs,
      // Client config
      client,
      clientConfig,
      // Model config (rest)
      ...modelConfig
    } = options

    this._endpointConfig = {
      endpointName,
      ...(region !== undefined && { region }),
      ...(inferenceComponentName !== undefined && { inferenceComponentName }),
      ...(targetModel !== undefined && { targetModel }),
      ...(targetVariant !== undefined && { targetVariant }),
      ...(additionalRequestArgs !== undefined && { additionalRequestArgs }),
    }

    this._config = {
      stream: true,
      toolResultsAsUserMessages: false,
      ...modelConfig,
    }

    this._providedClient = client

    const resolvedRegion = region ?? process.env.AWS_REGION ?? 'us-west-2'
    const userAgent: [string, string?][] = [
      ...((clientConfig?.customUserAgent as [string, string?][] | undefined) ?? []),
      ['strands-agents-ts-sdk'],
    ]
    this._clientConfig = {
      ...clientConfig,
      region: resolvedRegion,
      customUserAgent: userAgent,
    }
  }

  updateConfig(modelConfig: SageMakerModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): SageMakerModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? 'sagemaker')
  }

  override get modelId(): string | undefined {
    return this._config.modelId
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!messages || messages.length === 0) {
      throw new Error('At least one message is required')
    }

    const runtime = await this._getRuntime()
    const request = this._buildRequest(messages, options)

    logger.debug(`request=<${JSON.stringify(request).slice(0, 500)}> | invoking SageMaker endpoint`)

    try {
      if (this._config.stream !== false) {
        yield* this._streamResponse(runtime, request)
      } else {
        yield* this._nonStreamResponse(runtime, request)
      }
    } catch (error) {
      throw this._rewrapError(error)
    }

    logger.debug('finished streaming response from model')
  }

  // ── Request building ──────────────────────────────────────────────────

  /**
   * Builds the SageMaker Runtime request by formatting messages into an
   * OpenAI Chat Completions–compatible payload.
   */
  private _buildRequest(
    messages: Message[],
    options?: StreamOptions
  ): { EndpointName: string; Body: string; ContentType: string; Accept: string; [key: string]: unknown } {
    // Reuse the OpenAI chat adapter to format messages and tool specs.
    // We build a temporary OpenAIChatConfig for formatting only.
    const chatConfig: OpenAIChatConfig = {}
    if (this._config.modelId !== undefined) chatConfig.modelId = this._config.modelId
    if (this._config.temperature !== undefined) chatConfig.temperature = this._config.temperature
    if (this._config.maxTokens !== undefined) chatConfig.maxTokens = this._config.maxTokens
    if (this._config.topP !== undefined) chatConfig.topP = this._config.topP
    const formatted = formatChatRequest(chatConfig, messages, options)

    // Build the payload with SageMaker-specific adjustments
    const payload: Record<string, unknown> = {
      messages: formatted.messages,
      stream: this._config.stream !== false,
    }

    // Copy over tool definitions
    if (formatted.tools && formatted.tools.length > 0) {
      payload.tools = formatted.tools
      payload.tool_choice = formatted.tool_choice ?? 'auto'
    }

    // Set model parameters
    if (this._config.maxTokens !== undefined) payload.max_tokens = this._config.maxTokens
    if (this._config.temperature !== undefined) payload.temperature = this._config.temperature
    if (this._config.topP !== undefined) payload.top_p = this._config.topP
    if (this._config.topK !== undefined) payload.top_k = this._config.topK
    if (this._config.stop) payload.stop = this._config.stop

    // Apply additional payload args
    if (this._config.additionalPayloadArgs) {
      Object.assign(payload, this._config.additionalPayloadArgs)
    }

    // Convert tool messages to user messages if configured
    if (this._config.toolResultsAsUserMessages) {
      for (const msg of payload.messages as Array<Record<string, unknown>>) {
        if (msg.role === 'tool') {
          const toolCallId = (msg.tool_call_id as string) ?? 'ABCDEF'
          const content = msg.content as string
          msg.role = 'user'
          msg.content = `Tool call ID '${toolCallId}' returned: ${content}`
          delete msg.tool_call_id
        }
      }
    }

    // Strip assistant-only content:null next to tool_calls (vLLM/TGI compat)
    for (const msg of payload.messages as Array<Record<string, unknown>>) {
      if (msg.role === 'assistant' && msg.tool_calls && !msg.content) {
        delete msg.content
      }
    }

    logger.info(`payload=<${JSON.stringify(payload).slice(0, 1000)}>`)

    // Build the SageMaker request envelope
    const request: Record<string, unknown> = {
      EndpointName: this._endpointConfig.endpointName,
      Body: JSON.stringify(payload),
      ContentType: 'application/json',
      Accept: 'application/json',
    }

    if (this._endpointConfig.inferenceComponentName) {
      request.InferenceComponentName = this._endpointConfig.inferenceComponentName
    }
    if (this._endpointConfig.targetModel) {
      request.TargetModel = this._endpointConfig.targetModel
    }
    if (this._endpointConfig.targetVariant) {
      request.TargetVariant = this._endpointConfig.targetVariant
    }
    if (this._endpointConfig.additionalRequestArgs) {
      Object.assign(request, this._endpointConfig.additionalRequestArgs)
    }

    return request as {
      EndpointName: string
      Body: string
      ContentType: string
      Accept: string
      [key: string]: unknown
    }
  }

  // ── Streaming response handling ───────────────────────────────────────

  private async *_streamResponse(
    runtime: SageMakerRuntime,
    request: Record<string, unknown>
  ): AsyncIterable<ModelStreamEvent> {
    const { client, InvokeEndpointWithResponseStreamCommand } = runtime
    const response = await client.send(
      new InvokeEndpointWithResponseStreamCommand(
        request as import('@aws-sdk/client-sagemaker-runtime').InvokeEndpointWithResponseStreamCommandInput
      )
    )

    if (!response.Body) {
      throw new Error('SageMaker response stream is empty')
    }

    // Emit message start
    yield { type: 'modelMessageStartEvent', role: 'assistant' }

    const streamState: ChatStreamState = {
      messageStarted: true,
      textContentBlockStarted: false,
    }
    const activeToolCalls = new Map<number, boolean>()
    let bufferedUsage: { type: 'modelMetadataEvent'; usage: Usage } | null = null
    let finishReason = ''

    for await (const chunk of parseEventStream(
      response.Body as AsyncIterable<{ PayloadPart?: { Bytes?: Uint8Array } }>
    )) {
      // Handle usage metadata at the top level
      if (chunk.usage && !chunk.choices?.length) {
        bufferedUsage = {
          type: 'modelMetadataEvent',
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          },
        }
        continue
      }

      if (!chunk.choices?.length || finishReason) continue

      const choice = chunk.choices[0]!
      logger.debug(`choice=<${JSON.stringify(choice)}>`)

      // Map chunk to SDK events using the shared OpenAI chat adapter
      // We build a minimal chunk object for mapChatChunkToEvents
      const events = mapChatChunkToEvents(
        { choices: [choice] },
        // Skip the initial messageStart since we emitted it already
        { ...streamState, messageStarted: true },
        activeToolCalls
      )

      for (const event of events) {
        // Filter out the message start since we already emitted it
        if (event.type === 'modelMessageStartEvent') continue

        if (event.type === 'modelMessageStopEvent' && bufferedUsage) {
          yield bufferedUsage
          bufferedUsage = null
        }
        yield event
      }

      // Track usage attached to choices
      const choiceUsage = chunk.usage ?? (choice as { usage?: StreamChunk['usage'] }).usage
      if (choiceUsage) {
        bufferedUsage = {
          type: 'modelMetadataEvent',
          usage: {
            inputTokens: choiceUsage.prompt_tokens ?? 0,
            outputTokens: choiceUsage.completion_tokens ?? 0,
            totalTokens: choiceUsage.total_tokens ?? 0,
          },
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }

    // If the stream ended without a finish_reason from the adapter, close out manually
    if (!finishReason) {
      if (streamState.textContentBlockStarted) {
        yield { type: 'modelContentBlockStopEvent' }
      }
      for (const [index] of activeToolCalls) {
        yield { type: 'modelContentBlockStopEvent' }
        activeToolCalls.delete(index)
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
    }

    if (bufferedUsage) {
      yield bufferedUsage
    }
  }

  // ── Non-streaming response handling ───────────────────────────────────

  private async *_nonStreamResponse(
    runtime: SageMakerRuntime,
    request: Record<string, unknown>
  ): AsyncIterable<ModelStreamEvent> {
    const { client, InvokeEndpointCommand } = runtime
    const response = await client.send(
      new InvokeEndpointCommand(request as import('@aws-sdk/client-sagemaker-runtime').InvokeEndpointCommandInput)
    )

    if (!response.Body) {
      throw new Error('SageMaker response body is empty')
    }

    const body = parseResponseBody(response.Body as Uint8Array)
    logger.info(`response=<${JSON.stringify(body).slice(0, 1000)}>`)

    const choice = body.choices?.[0]
    if (!choice) {
      throw new Error('SageMaker response has no choices')
    }

    const message = (choice as Record<string, unknown>).message as Record<string, unknown> | undefined
    if (!message) {
      throw new Error('SageMaker response has no message')
    }

    const stopReason = mapStopReason(((choice as Record<string, unknown>).finish_reason as string) ?? 'stop')

    // Message start
    yield { type: 'modelMessageStartEvent', role: 'assistant' }

    // Handle text content
    if (message.content && typeof message.content === 'string') {
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: message.content } }
      yield { type: 'modelContentBlockStopEvent' }
    }

    // Handle tool calls
    const toolCalls = message.tool_calls as
      | Array<{
          id: string
          type: string
          function: { name: string; arguments: string | Record<string, unknown> }
        }>
      | undefined

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const args =
          typeof toolCall.function.arguments === 'string'
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments)

        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: toolCall.function.name, toolUseId: toolCall.id },
        }
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: args },
        }
        yield { type: 'modelContentBlockStopEvent' }
      }
    }

    // Message stop
    yield {
      type: 'modelMessageStopEvent',
      stopReason: toolCalls && toolCalls.length > 0 ? 'toolUse' : stopReason,
    }

    // Usage metadata
    if (body.usage) {
      yield {
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: body.usage.prompt_tokens ?? 0,
          outputTokens: body.usage.completion_tokens ?? 0,
          totalTokens: body.usage.total_tokens ?? 0,
        },
      }
    }
  }

  // ── Error handling ────────────────────────────────────────────────────

  private _rewrapError(error: unknown): unknown {
    const err = error as Error & {
      name?: string
      OriginalStatusCode?: number
      $metadata?: { httpStatusCode?: number }
    }
    const name = err.name ?? ''
    const status = err.OriginalStatusCode ?? err.$metadata?.httpStatusCode

    // Container-level throttling (HTTP 429 wrapped in SageMaker ModelError)
    if (status === 429 || name === 'ThrottlingException' || name === 'ModelNotReadyException') {
      return new ModelThrottledError(normalizeError(err).message, { cause: err })
    }

    return error
  }

  // ── SDK lazy loading ──────────────────────────────────────────────────

  private _getRuntime(): Promise<SageMakerRuntime> {
    this._runtime ??= loadSageMakerRuntime().then((sdk) => ({
      client: this._providedClient ?? new sdk.SageMakerRuntimeClient(this._clientConfig),
      InvokeEndpointCommand: sdk.InvokeEndpointCommand,
      InvokeEndpointWithResponseStreamCommand: sdk.InvokeEndpointWithResponseStreamCommand,
    }))
    return this._runtime
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

interface SageMakerRuntime {
  client: SageMakerRuntimeClient
  InvokeEndpointCommand: typeof import('@aws-sdk/client-sagemaker-runtime').InvokeEndpointCommand
  InvokeEndpointWithResponseStreamCommand: typeof import('@aws-sdk/client-sagemaker-runtime').InvokeEndpointWithResponseStreamCommand
}

async function loadSageMakerRuntime(): Promise<typeof import('@aws-sdk/client-sagemaker-runtime')> {
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

const STOP_REASON_MAP: Record<string, StopReason> = {
  stop: 'endTurn',
  tool_calls: 'toolUse',
  length: 'maxTokens',
  content_filter: 'contentFiltered',
}

function mapStopReason(reason: string): StopReason {
  return STOP_REASON_MAP[reason] ?? 'endTurn'
}
