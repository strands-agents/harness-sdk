/**
 * AWS Bedrock model provider implementation.
 *
 * This module provides integration with AWS Bedrock's Converse API,
 * supporting streaming responses, tool use, and prompt caching.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
 */

import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  type CachePointBlock as BedrockCachePointBlock,
  type CacheTTL as BedrockSdkCacheTTL,
  type ContentBlock as BedrockContentBlock,
  type ContentBlockDeltaEvent as BedrockContentBlockDeltaEvent,
  type ContentBlockStartEvent as BedrockContentBlockStartEvent,
  ConverseCommand,
  type ConverseCommandOutput,
  ConverseStreamCommand,
  CountTokensCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamMetadataEvent as BedrockConverseStreamMetadataEvent,
  type ConverseStreamOutput,
  type InferenceConfiguration,
  type Message as BedrockMessage,
  type MessageStartEvent as BedrockMessageStartEvent,
  type MessageStopEvent as BedrockMessageStopEvent,
  type ReasoningContentBlock,
  type ReasoningContentBlockDelta,
  type Tool,
  type ToolConfiguration,
  type ToolUseBlockDelta,
  type AudioSource as BedrockAudioSource,
  type ImageSource as BedrockImageSource,
  type VideoSource as BedrockVideoSource,
  type DocumentSource as BedrockDocumentSource,
  type SystemContentBlock,
  AudioFormat,
  DocumentFormat,
  ImageFormat,
  VideoFormat,
  type BedrockRuntimeClientResolvedConfig,
  type CitationLocation as BedrockCitationLocation,
  type Citation as BedrockCitation,
  type CitationsContentBlock as BedrockCitationsContentBlock,
  type CitationsDelta as BedrockCitationsDelta,
  type GuardrailTraceAssessment,
} from '@aws-sdk/client-bedrock-runtime'
import { FetchHttpHandler, type FetchHttpHandlerOptions } from '@smithy/fetch-http-handler'
import {
  type BaseModelConfig,
  type CacheConfig,
  type CacheTTL,
  type CountTokensOptions,
  Model,
  type StreamOptions,
  resolveCacheSection,
  resolveConfigMetadata,
} from '../models/model.js'
import type { ContentBlock, Message, StopReason, ToolUseBlock } from '../types/messages.js'
import type { AudioSource, ImageSource, VideoSource, DocumentSource } from '../types/media.js'
import type { CitationsDelta, ModelStreamEvent, ReasoningContentDelta, Usage } from '../models/streaming.js'
import type { Citation, CitationLocation, CitationsBlockData } from '../types/citations.js'
import type { JSONValue } from '../types/json.js'
import { ContextWindowOverflowError, ModelThrottledError, ProviderTokenCountError, normalizeError } from '../errors.js'
import { ensureDefined } from '../types/validation.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { NOOP_TOOL_SPEC } from '../tools/noop-tool.js'
import { ensureStrictJsonSchema } from './_strict-schema.js'
import { MODEL_DEFAULTS, defaultModelWarningMessage } from './defaults.js'

const DEFAULT_BEDROCK_REGION_SUPPORTS_FIP = false

/**
 * Default request timeout in milliseconds. The AWS SDK defaults to 0 (disabled), which lets
 * a stuck connection hang indefinitely — we pick 120s to bound that. Callers can override
 * via `clientConfig.requestHandler.requestTimeout`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

/**
 * Models that require the status field in tool results.
 * According to AWS Bedrock API documentation, the status field is only supported by Anthropic Claude models.
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html
 */
const MODELS_INCLUDE_STATUS = ['anthropic.claude']

/**
 * Models that support the Anthropic-style prompt caching strategy.
 * Used to auto-detect when `cacheConfig.strategy` is `'auto'`.
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 */
const MODELS_SUPPORTING_ANTHROPIC_CACHING = ['anthropic', 'claude']

/**
 * Error messages that indicate context window overflow.
 * Used to detect when input exceeds the model's context window.
 */
const BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES = [
  'Input is too long for requested model',
  'input length and `max_tokens` exceed context limit',
  'too many total text bytes',
  'prompt is too long',
]

/**
 * Cache of model IDs for which CountTokens API calls should be skipped.
 * Prevents repeated failing API calls that will never succeed for the lifetime of the process.
 */
const SKIP_COUNT_TOKENS_MODELS = new Set<string>()

/**
 * Mapping of Bedrock stop reasons to SDK stop reasons.
 */
const STOP_REASON_MAP = {
  end_turn: 'endTurn',
  tool_use: 'toolUse',
  max_tokens: 'maxTokens',
  stop_sequence: 'stopSequence',
  content_filtered: 'contentFiltered',
  guardrail_intervened: 'guardrailIntervened',
} as const

/**
 * Default message for redacted input.
 */
const DEFAULT_REDACT_INPUT_MESSAGE = '[User input redacted.]'

/**
 * Default message for redacted output.
 */
const DEFAULT_REDACT_OUTPUT_MESSAGE = '[Assistant output redacted.]'

/**
 * TTL durations accepted by Bedrock for prompt-cache checkpoints.
 *
 * Bedrock accepts `'5m'` (default) and `'1h'`, and validates the value server-side, rejecting
 * unsupported values with `ValidationException`.
 *
 * Bedrock also requires checkpoint TTLs to be **non-increasing** across
 * `toolConfig` → system → messages — setting a longer TTL on a later checkpoint than an
 * earlier one will be rejected by the service.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_CachePointBlock.html
 */
export type BedrockCacheTTL = CacheTTL

/**
 * Prompt-caching configuration for the Bedrock provider.
 */
export type BedrockCacheConfig = CacheConfig

/**
 * Redaction configuration for Bedrock guardrails.
 * Controls whether and how blocked content is replaced.
 */
export interface BedrockGuardrailRedactionConfig {
  /** Redact input when blocked. @defaultValue true */
  input?: boolean

  /** Replacement message for redacted input. @defaultValue '[User input redacted.]' */
  inputMessage?: string

  /** Redact output when blocked. @defaultValue false */
  output?: boolean

  /** Replacement message for redacted output. @defaultValue '[Assistant output redacted.]' */
  outputMessage?: string
}

/**
 * Configuration for Bedrock guardrails.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
 */
export interface BedrockGuardrailConfig {
  /** Guardrail identifier */
  guardrailIdentifier: string

  /** Guardrail version (e.g., "1", "DRAFT") */
  guardrailVersion: string

  /** Trace mode for evaluation. @defaultValue 'enabled' */
  trace?: 'enabled' | 'disabled' | 'enabled_full'

  /** Stream processing mode */
  streamProcessingMode?: 'sync' | 'async'

  /** Redaction behavior when content is blocked */
  redaction?: BedrockGuardrailRedactionConfig

  /**
   * Only evaluate the latest user message with guardrails.
   * When true, wraps the latest user message's text/image content in guardContent blocks.
   * This can improve performance and reduce costs in multi-turn conversations.
   *
   * @remarks
   * The implementation finds the last user message containing text or image content
   * (not just the last message), ensuring correct behavior during tool execution cycles
   * where toolResult messages may follow the user's actual input.
   *
   * @defaultValue false
   */
  guardLatestUserMessage?: boolean
}

/**
 * Converts a snake_case string to camelCase.
 * Used for mapping unknown stop reasons from Bedrock to SDK format.
 *
 * @param str - Snake case string
 * @returns Camel case string
 */
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Configuration interface for AWS Bedrock model provider.
 *
 * Extends BaseModelConfig with Bedrock-specific configuration options
 * for model parameters, caching, and additional request/response fields.
 *
 * @example
 * ```typescript
 * const config: BedrockModelConfig = {
 *   modelId: 'global.anthropic.claude-sonnet-4-6',
 *   maxTokens: 1024,
 *   temperature: 0.7,
 *   cacheConfig: { strategy: 'auto' }
 * }
 * ```
 */
export interface BedrockModelConfig extends BaseModelConfig {
  /**
   * Maximum number of tokens to generate in the response.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html
   */
  maxTokens?: number

  /**
   * Controls randomness in generation.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html
   */
  temperature?: number

  /**
   * Controls diversity via nucleus sampling.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html
   */
  topP?: number

  /**
   * Array of sequences that will stop generation when encountered.
   */
  stopSequences?: string[]

  /**
   * Configuration for prompt caching.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
   */
  cacheConfig?: BedrockCacheConfig

  /**
   * Additional fields to include in the Bedrock request.
   */
  additionalRequestFields?: JSONValue

  /**
   * Additional response field paths to extract from the Bedrock response.
   */
  additionalResponseFieldPaths?: string[]

  /**
   * Additional arguments to pass through to the Bedrock Converse API.
   * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseStreamCommand/
   */
  additionalArgs?: JSONValue

  /**
   * Whether or not to stream responses from the model.
   *
   * This will use the ConverseStream API instead of the Converse API.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
   */
  stream?: boolean

  /**
   * Flag to include status field in tool results.
   * - `true`: Always include status field
   * - `false`: Never include status field
   * - `'auto'`: Automatically determine based on model ID (default)
   */
  includeToolResultStatus?: 'auto' | boolean

  /**
   * Guardrail configuration for content filtering and safety controls.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html
   */
  guardrailConfig?: BedrockGuardrailConfig

  /**
   * Whether to use the native Bedrock CountTokens API.
   *
   * When `true`, `countTokens()` calls the Bedrock CountTokens API for
   * accurate counts. When `false` or not set (default), skips the API call and uses
   * the character-based heuristic estimator.
   *
   * @defaultValue false
   */
  useNativeTokenCount?: boolean

  /**
   * Apply strict (structured-output) enforcement to every tool sent to this model.
   *
   * When `true`, injects `strict: true` into each `toolSpec`. Incompatible with citations
   * for Anthropic models.
   *
   * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html
   *
   * @defaultValue false
   */
  strictTools?: boolean
}

/**
 * Options for creating a BedrockModel instance.
 */
export interface BedrockModelOptions extends BedrockModelConfig {
  /**
   * AWS region to use for the Bedrock service.
   */
  region?: string

  /**
   * Configuration for the Bedrock Runtime client.
   */
  clientConfig?: BedrockRuntimeClientConfig

  /**
   * Amazon Bedrock API key for bearer token authentication.
   * When provided, requests use the API key instead of SigV4 signing.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html
   */
  apiKey?: string
}

/**
 * AWS Bedrock model provider implementation.
 *
 * Implements the Model interface for AWS Bedrock using the Converse Stream API.
 * Supports streaming responses, tool use, prompt caching, and comprehensive error handling.
 *
 * @example
 * ```typescript
 * const provider = new BedrockModel({
 *   modelConfig: {
 *     modelId: 'global.anthropic.claude-sonnet-4-6',
 *     maxTokens: 1024,
 *     temperature: 0.7
 *   },
 *   clientConfig: {
 *     region: 'us-west-2'
 *   }
 * })
 *
 * const messages: Message[] = [
 *   { type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hello!' }] }
 * ]
 *
 * for await (const event of provider.stream(messages)) {
 *   if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
 *     process.stdout.write(event.delta.text)
 *   }
 * }
 * ```
 */
export class BedrockModel extends Model<BedrockModelConfig> {
  private _config: BedrockModelConfig
  private _client: BedrockRuntimeClient

  /**
   * Clears the cache of model IDs for which CountTokens is skipped.
   * After calling this, the next countTokens invocation will attempt the API again.
   *
   * @internal
   */
  static clearCountTokensCache(): void {
    SKIP_COUNT_TOKENS_MODELS.clear()
  }

  /**
   * Creates a new BedrockModel instance.
   *
   * @param options - Optional configuration for model and client
   *
   * @example
   * ```typescript
   * // Minimal configuration with defaults
   * const provider = new BedrockModel({
   *   region: 'us-west-2'
   * })
   *
   * // With model configuration
   * const provider = new BedrockModel({
   *   region: 'us-west-2',
   *   modelId: 'global.anthropic.claude-sonnet-4-6',
   *   maxTokens: 2048,
   *   temperature: 0.8,
   *   cacheConfig: { strategy: 'auto' }
   * })
   *
   * // With client configuration
   * const provider = new BedrockModel({
   *   region: 'us-east-1',
   *   clientConfig: {
   *     credentials: myCredentials
   *   }
   * })
   * ```
   */
  constructor(options?: BedrockModelOptions) {
    super()

    const { region, clientConfig, apiKey, ...modelConfig } = options ?? {}

    // Initialize model config with default model ID if not provided
    this._config = {
      modelId: MODEL_DEFAULTS.bedrock.modelId,
      ...modelConfig,
    }

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.bedrock.modelId))
    }

    // Build user agent string (extend if provided, otherwise use SDK identifier)
    const customUserAgent = clientConfig?.customUserAgent
      ? `${clientConfig.customUserAgent} strands-agents-ts-sdk`
      : 'strands-agents-ts-sdk'

    const requestHandler = withDefaultRequestTimeout(clientConfig?.requestHandler)
    this._client = new BedrockRuntimeClient({
      ...(clientConfig ?? {}),
      requestHandler,
      // region takes precedence over clientConfig
      ...(region ? { region: region } : {}),
      customUserAgent,
    })
    applyAbortAwareBrowserRequestHandler(this._client.config, requestHandler)

    if (apiKey) {
      applyApiKey(this._client, apiKey)
    }

    applyDefaultRegion(this._client.config)
  }

  /**
   * Returns the cache strategy for this model based on its model ID.
   * Returns the appropriate cache strategy name, or null if automatic caching is not supported.
   *
   * @returns Cache strategy name or null
   */
  private _getCacheStrategy(): 'anthropic' | null {
    return MODELS_SUPPORTING_ANTHROPIC_CACHING.some((pattern) => this._config.modelId?.includes(pattern))
      ? 'anthropic'
      : null
  }

  /**
   * Determines if caching should be enabled.
   * Returns true when:
   * - strategy is 'anthropic' (explicit enable)
   * - strategy is 'auto' (the default) and the model supports caching (auto-detect)
   *
   * @returns True if caching should be enabled.
   */
  private _shouldEnableCaching(): boolean {
    const cacheConfig = this._config.cacheConfig
    if (!cacheConfig) {
      return false
    }

    let strategy = cacheConfig.strategy ?? 'auto'

    if (strategy === 'auto') {
      const detectedStrategy = this._getCacheStrategy()
      if (!detectedStrategy) {
        logger.warn(
          `model_id=<${this._config.modelId}> | cache_config is enabled but this model does not support automatic caching`
        )
        return false
      }
      strategy = detectedStrategy
    }

    return strategy === 'anthropic'
  }

  /**
   * Whether to auto-inject a cache point at the end of the system prompt.
   *
   * @param system - The system content blocks that will be sent to Bedrock.
   * @returns True if a cache point should be appended.
   */
  private _shouldCacheSystem(system: SystemContentBlock[] | undefined): system is SystemContentBlock[] {
    if (!this._shouldEnableCaching()) {
      return false
    }
    if (this._config.cacheConfig?.systemPromptTTL === false) {
      return false
    }
    if (!system || system.length === 0) {
      return false
    }
    return !system.some((block) => 'cachePoint' in block)
  }

  /**
   * Fills the resolved system-section TTL into a system cache point that carries none of its own,
   * whether auto-injected or caller-placed.
   *
   * @param request - The formatted request, with `system` and `toolConfig` already populated.
   */
  private _applySystemCacheTTL(request: ConverseStreamCommandInput): void {
    const system = request.system
    if (!system || !this._shouldEnableCaching()) {
      return
    }
    const cacheConfig = this._config.cacheConfig
    const systemSection = resolveCacheSection(cacheConfig?.systemPromptTTL, cacheConfig?.ttl)
    let ttl = systemSection.ttl

    if (ttl && typeof cacheConfig?.systemPromptTTL !== 'string') {
      const toolsPoint = request.toolConfig?.tools?.find((tool) => 'cachePoint' in tool)
      if (toolsPoint && 'cachePoint' in toolsPoint && toolsPoint.cachePoint?.ttl !== ttl) {
        ttl = undefined
      }
    }

    for (const block of system) {
      if ('cachePoint' in block && block.cachePoint && !block.cachePoint.ttl) {
        delete block.cachePoint.ttl
        if (ttl) {
          block.cachePoint.ttl = ttl as BedrockSdkCacheTTL
        }
      }
    }
  }

  /**
   * Updates the model configuration.
   * Merges the provided configuration with existing settings.
   *
   * @param modelConfig - Configuration object with model-specific settings to update
   *
   * @example
   * ```typescript
   * // Update temperature and maxTokens
   * provider.updateConfig({
   *   temperature: 0.9,
   *   maxTokens: 2048
   * })
   * ```
   */
  updateConfig(modelConfig: BedrockModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  /**
   * Retrieves the current model configuration.
   *
   * @returns The current configuration object
   *
   * @example
   * ```typescript
   * const config = provider.getConfig()
   * console.log(config.modelId)
   * ```
   */
  getConfig(): BedrockModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.bedrock.modelId)
  }

  /**
   * Count tokens using Bedrock's native CountTokens API.
   *
   * Uses the same message format as the Converse API to get accurate token counts
   * directly from the Bedrock service. Falls back to the base class heuristic on failure.
   *
   * @param messages - Array of conversation messages to count tokens for
   * @param options - Optional options containing system prompt and tool specs
   * @returns Total input token count
   */
  override async countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    if (this._config.useNativeTokenCount !== true) return super.countTokens(messages, options)

    const modelId = this._config.modelId ?? MODEL_DEFAULTS.bedrock.modelId

    if (SKIP_COUNT_TOKENS_MODELS.has(modelId)) {
      return super.countTokens(messages, options)
    }

    try {
      const request = this._formatRequest(messages, options)
      const converseInput: Record<string, unknown> = {}
      if (request.messages) converseInput.messages = request.messages
      if (request.system) converseInput.system = request.system
      if (request.toolConfig) converseInput.toolConfig = request.toolConfig

      const response = await this._client.send(
        new CountTokensCommand({
          modelId: this._config.modelId,
          input: { converse: converseInput },
        })
      )

      if (response.inputTokens == null) {
        throw new ProviderTokenCountError('Bedrock CountTokens returned undefined for inputTokens')
      }

      logger.debug(`total_tokens=<${response.inputTokens}> | native token count`)
      return response.inputTokens
    } catch (error) {
      if (error instanceof Error && error.name === 'AccessDeniedException') {
        warnOnce(
          logger,
          `model_id=<${modelId}> | bedrock:CountTokens permission denied, falling back to heuristic estimation`
        )
        SKIP_COUNT_TOKENS_MODELS.add(modelId)
      } else if (
        error instanceof Error &&
        error.name === 'ValidationException' &&
        error.message.includes("doesn't support counting tokens")
      ) {
        logger.debug(
          `model_id=<${modelId}> | model does not support CountTokens, caching for future calls, falling back to estimation`
        )
        SKIP_COUNT_TOKENS_MODELS.add(modelId)
      } else {
        logger.debug(`error=<${error}> | native token counting failed, falling back to estimation`)
      }
      return super.countTokens(messages, options)
    }
  }

  /**
   * Streams a conversation with the Bedrock model.
   * Returns an async iterable that yields streaming events as they occur.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async iterable of streaming events
   *
   * @throws \{ContextWindowOverflowError\} When input exceeds the model's context window
   * @throws \{ModelThrottledError\} When Bedrock service throttles requests
   *
   * @example
   * ```typescript
   * const messages: Message[] = [
   *   { type: 'message', role: $1, content: [{ type: 'textBlock', text: 'What is 2+2?' }] }
   * ]
   *
   * const options: StreamOptions = {
   *   systemPrompt: 'You are a helpful math assistant.',
   *   toolSpecs: [calculatorTool]
   * }
   *
   * for await (const event of provider.stream(messages, options)) {
   *   if (event.type === 'modelContentBlockDeltaEvent') {
   *     console.log(event.delta)
   *   }
   * }
   * ```
   */
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    try {
      // Format the request for Bedrock
      const request = this._formatRequest(messages, options)
      if (this._config.stream !== false) {
        // Create and send the command
        const command = new ConverseStreamCommand(request)
        const response = options?.cancelSignal
          ? await this._client.send(command, { abortSignal: options.cancelSignal })
          : await this._client.send(command)
        // Stream the response
        if (response.stream) {
          let lastStopReason: string | undefined
          let redactionEmitted = false
          let sawGuardrailTrace = false
          for await (const chunk of response.stream) {
            const result = this._mapStreamedBedrockEventToSDKEvent(chunk, lastStopReason)
            lastStopReason = result.stopReason
            // The guardrail trace arrives with the metadata event and is authoritative for
            // BLOCKED vs ANONYMIZED (masking) — Bedrock reports guardrail_intervened for both
            // but only BLOCKED content warrants SDK redaction. Wait for the metadata chunk to
            // decide, and fall back to the stop reason only when no trace was carried.
            if (!redactionEmitted && this._config.guardrailConfig && 'metadata' in chunk) {
              const guardrailData = chunk.metadata?.trace?.guardrail
              if (guardrailData !== undefined) {
                sawGuardrailTrace = true
                if (this._hasBlockedGuardrailPolicy(guardrailData)) {
                  redactionEmitted = true
                  yield* this._generateRedactionEvents(guardrailData)
                }
              } else if (lastStopReason === 'guardrail_intervened') {
                redactionEmitted = true
                yield* this._generateRedactionEvents({})
              }
            }
            for (const event of result.events) {
              yield event
            }
          }

          // Safety net: guardrail_intervened but no metadata event ever arrived.
          if (
            !redactionEmitted &&
            !sawGuardrailTrace &&
            lastStopReason === 'guardrail_intervened' &&
            this._config.guardrailConfig
          ) {
            yield* this._generateRedactionEvents({})
          }
        }
      } else {
        const command = new ConverseCommand(request)
        const response = options?.cancelSignal
          ? await this._client.send(command, { abortSignal: options.cancelSignal })
          : await this._client.send(command)
        for (const event of this._mapBedrockEventToSDKEvent(response)) {
          yield event
        }
      }
    } catch (unknownError) {
      const error = normalizeError(unknownError)

      // Check for context window overflow
      if (BEDROCK_CONTEXT_WINDOW_OVERFLOW_MESSAGES.some((msg) => error.message.includes(msg))) {
        throw new ContextWindowOverflowError(error.message)
      }

      // Re-throw other errors as-is
      throw error
    }
  }

  /**
   * Formats a request for the Bedrock Converse Stream API.
   *
   * @param messages - Conversation messages
   * @param options - Stream options
   * @returns Formatted Bedrock request
   */
  private _formatRequest(messages: Message[], options?: StreamOptions): ConverseStreamCommandInput {
    const request: ConverseStreamCommandInput = {
      modelId: this._config.modelId,
      messages: this._formatMessages(messages, options?.dynamicTrailingBlocks ?? 0),
    }

    // Add system prompt
    if (options?.systemPrompt !== undefined) {
      if (typeof options.systemPrompt === 'string') {
        request.system = [{ text: options.systemPrompt }]
      } else if (options.systemPrompt.length > 0) {
        request.system = options.systemPrompt.map((block) => this._formatContentBlock(block) as SystemContentBlock)
      }
    }

    if (this._shouldCacheSystem(request.system)) {
      request.system!.push({ cachePoint: { type: 'default' } })
    }

    // Add tool configuration
    // Bedrock requires toolConfig when messages contain tool use/result blocks.
    // When no tools were provided but messages reference past tool usage (e.g. during
    // summarization), inject a noop tool to satisfy the API requirement.
    let toolSpecs = options?.toolSpecs ?? []
    if (toolSpecs.length === 0) {
      const hasToolBlocks = messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' || block.type === 'toolResultBlock')
      )
      if (hasToolBlocks) {
        toolSpecs = [NOOP_TOOL_SPEC]
      }
    }

    if (toolSpecs.length > 0) {
      const strictTools = this._config.strictTools === true
      const tools: Tool[] = toolSpecs.map(
        (spec) =>
          ({
            toolSpec: {
              name: spec.name,
              description: spec.description,
              inputSchema: {
                json: strictTools && spec.inputSchema ? ensureStrictJsonSchema(spec.inputSchema) : spec.inputSchema,
              },
              ...(strictTools ? { strict: true } : {}),
            },
          }) as Tool
      )

      const cacheConfig = this._config.cacheConfig
      const toolsCache = this._shouldEnableCaching()
        ? resolveCacheSection(cacheConfig?.toolsTTL, cacheConfig?.ttl)
        : { enabled: false }
      if (toolsCache.enabled) {
        const cachePoint: BedrockCachePointBlock = { type: 'default' }
        if (toolsCache.ttl) {
          // Bedrock validates TTL values server-side, so accept any string here.
          cachePoint.ttl = toolsCache.ttl as BedrockSdkCacheTTL
        }
        tools.push({ cachePoint })
      }

      const toolConfig: ToolConfiguration = {
        tools: tools,
      }

      if (options?.toolChoice) {
        toolConfig.toolChoice = options.toolChoice
      }

      request.toolConfig = toolConfig
    }

    // Runs after toolConfig so the tools checkpoint ahead of the system one is known.
    this._applySystemCacheTTL(request)

    // Add inference configuration
    const inferenceConfig: InferenceConfiguration = {}
    if (this._config.maxTokens !== undefined) inferenceConfig.maxTokens = this._config.maxTokens
    if (this._config.temperature !== undefined) inferenceConfig.temperature = this._config.temperature
    if (this._config.topP !== undefined) inferenceConfig.topP = this._config.topP
    if (this._config.stopSequences !== undefined) inferenceConfig.stopSequences = this._config.stopSequences

    if (Object.keys(inferenceConfig).length > 0) {
      request.inferenceConfig = inferenceConfig
    }

    // Add additional request fields
    const additionalRequestFields = this._getAdditionalRequestFields(options)
    if (additionalRequestFields) {
      request.additionalModelRequestFields = additionalRequestFields
    }

    // Add additional response field paths
    if (this._config.additionalResponseFieldPaths) {
      request.additionalModelResponseFieldPaths = this._config.additionalResponseFieldPaths
    }

    // Add additional args (spread them into the request for forward compatibility)
    if (this._config.additionalArgs) {
      Object.assign(request, this._config.additionalArgs)
    }

    // Add guardrail configuration
    if (this._config.guardrailConfig) {
      request.guardrailConfig = {
        guardrailIdentifier: this._config.guardrailConfig.guardrailIdentifier,
        guardrailVersion: this._config.guardrailConfig.guardrailVersion,
        trace: this._config.guardrailConfig.trace ?? 'enabled',
        ...(this._config.guardrailConfig.streamProcessingMode && {
          streamProcessingMode: this._config.guardrailConfig.streamProcessingMode,
        }),
      }
    }

    return request
  }

  /**
   * Get additional request fields, adjusted for compatibility with the current stream options.
   *
   * Certain additional request fields are incompatible with specific API options. For example,
   * Bedrock does not allow thinking mode when tool_choice forces tool use.
   *
   * @param options - The stream options for the current request
   * @returns The additional request fields, or undefined if none
   */
  private _getAdditionalRequestFields(options?: StreamOptions): JSONValue | undefined {
    const fields = this._config.additionalRequestFields as Record<string, JSONValue> | undefined
    if (!fields || !('thinking' in fields)) {
      return fields
    }

    const toolChoice = options?.toolChoice
    if (!toolChoice || 'auto' in toolChoice) {
      return fields
    }

    const { thinking: _, ...rest } = fields
    return Object.keys(rest).length > 0 ? rest : undefined
  }

  /**
   * Formats messages for Bedrock API.
   *
   * @param messages - SDK messages
   * @returns Bedrock-formatted messages
   */
  private _formatMessages(messages: Message[], dynamicTrailingBlocks = 0): BedrockMessage[] {
    // Pre-compute the index of the last user message containing text/image content
    // This ensures guardContent wrapping is maintained across tool execution cycles
    const lastUserTextIdx = this._config.guardrailConfig?.guardLatestUserMessage
      ? this._findLastUserTextMessageIndex(messages)
      : undefined

    const formattedMessages = messages.reduce<BedrockMessage[]>((acc, message, idx) => {
      const shouldApplyGuardBlocks = idx === lastUserTextIdx
      const content = message.content
        .map((block: ContentBlock) => {
          const formattedBlock = this._formatContentBlock(block)
          return shouldApplyGuardBlocks ? this._applyGuardBlocks(formattedBlock) : formattedBlock
        })
        .filter((block) => block !== undefined)

      if (content.length > 0) {
        acc.push({ role: message.role, content })
      }

      return acc
    }, [])

    const cacheConfig = this._config.cacheConfig
    const messagesCache = this._shouldEnableCaching()
      ? resolveCacheSection(cacheConfig?.messagesTTL, cacheConfig?.ttl)
      : { enabled: false }
    if (messagesCache.enabled) {
      this._injectCachePoint(formattedMessages, messagesCache.ttl, dynamicTrailingBlocks)
    }

    return formattedMessages
  }

  /**
   * Keep a caller-placed cache point, applying the configured TTL and the document rule.
   *
   * The caller's position is honored; their TTL is not. Bedrock processes cache points in the order
   * toolConfig, system, messages and rejects a longer TTL that follows a shorter one (see CacheConfig),
   * so a TTL written here can turn a working configuration into a rejected request. Normalizing to
   * `cacheConfig.messagesTTL` is what makes the honored path TTL-identical to the automatic one.
   *
   * @param content - Content blocks of the last user message (modified in place)
   * @param placedIdx - Index of the caller-placed cache point
   * @param msgIdx - Index of the message, for logging
   * @param ttl - TTL for the honored cache point. Falsy leaves the Bedrock default.
   * @returns True when the point was kept, possibly relocated. False when nothing cacheable precedes
   *   it, so the point was removed: Bedrock rejects a cache point with no content ahead of it ("There
   *   is nothing available to cache"). The caller then retries automatic placement, which lands a point
   *   only if the remaining content allows one - for a leading document it declines too.
   */
  private _honorPlacedCachePoint(
    content: BedrockContentBlock[],
    placedIdx: number,
    msgIdx: number,
    ttl?: CacheTTL
  ): boolean {
    // Unreachable in practice - the caller scans for cache points to get this index - but the
    // compiler cannot know that under noUncheckedIndexedAccess.
    const placed = content[placedIdx]
    if (!placed || !('cachePoint' in placed)) {
      return false
    }

    if (placedIdx === 0) {
      content.splice(placedIdx, 1)
      logger.warn(
        `msg_idx=<${msgIdx}> | removed cache point with no content ahead of it, falling back to automatic placement`
      )
      return false
    }

    // Honor the caller's position, not their TTL: Bedrock processes cache points in the order
    // toolConfig, system, messages and rejects a longer TTL that follows a shorter one, so a TTL
    // written here can invalidate a request against one configured for tools or system. Deleting it
    // unconditionally also handles null and "", which are rejected before placement is even judged.
    delete placed.cachePoint.ttl
    if (ttl) {
      // Bedrock validates TTL values server-side, so accept any string here. An empty configured TTL
      // is not a TTL, matching the Python side rather than forwarding "" for the enum to reject.
      placed.cachePoint.ttl = ttl as BedrockSdkCacheTTL
    }

    // Bedrock only rejects a cache point *directly* preceded by a non-PDF document, so step back over
    // the adjacent run of them. Moving further would evict durable content - usually the document
    // itself, the expensive part - from the cached prefix for no reason.
    let targetIdx = placedIdx
    while (targetIdx > 0) {
      const previous = content[targetIdx - 1]
      if (!previous || !('document' in previous) || previous.document?.format === 'pdf') {
        break
      }
      targetIdx--
    }

    if (targetIdx !== placedIdx) {
      content.splice(placedIdx, 1)
      if (targetIdx === 0) {
        // Nothing precedes the documents, so there is no prefix to cache.
        logger.warn(`msg_idx=<${msgIdx}> | dropped cache point ahead of a leading document`)
        return false
      }
      content.splice(targetIdx, 0, placed)
      logger.debug(`msg_idx=<${msgIdx}>, block_idx=<${targetIdx}> | relocated caller-placed cache point`)
      return true
    }

    logger.debug(`msg_idx=<${msgIdx}>, block_idx=<${placedIdx}> | honored caller-placed cache point`)
    return true
  }

  /**
   * Ensure the last user message carries exactly one cache point.
   *
   * A cache point already present in the last user message is honored where it sits rather than
   * replaced: a caller places one to mark where its reusable prefix ends, ahead of content that is
   * rebuilt every call. Moving it to the end of the message would put that per-call content inside
   * the cached prefix, so every request would write a new entry and none would ever read one.
   *
   * Cache points in earlier messages are still removed, so they cannot accumulate one per turn
   * against the provider's cache-point budget.
   *
   * @param messages - List of messages to inject cache point into (modified in place)
   * @param ttl - TTL for the injected cache point. Falsy leaves the Bedrock default.
   */
  private _injectCachePoint(messages: BedrockMessage[], ttl?: CacheTTL, dynamicTrailingBlocks = 0): void {
    if (messages.length === 0) {
      return
    }

    let lastUserIdx: number | null = null
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      if (messages[msgIdx]?.role === 'user') {
        lastUserIdx = msgIdx
      }
    }

    // Strip cache points everywhere except the last user message, whose own point is the caller's
    // boundary and is handled below.
    for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
      if (msgIdx === lastUserIdx) continue
      const msg = messages[msgIdx]
      if (!msg) continue

      const content = msg.content ?? []

      for (let blockIdx = content.length - 1; blockIdx >= 0; blockIdx--) {
        const block = content[blockIdx]
        if (block && 'cachePoint' in block) {
          content.splice(blockIdx, 1)
          logger.warn(
            `msg_idx=<${msgIdx}>, block_idx=<${blockIdx}> | stripped existing cache point (auto mode manages cache points)`
          )
        }
      }
    }

    // Add cache point to last user message
    if (lastUserIdx !== null) {
      const lastMsg = messages[lastUserIdx]
      if (lastMsg && lastMsg.content) {
        const content = lastMsg.content

        const placedIdxs: number[] = []
        for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
          const block = content[blockIdx]
          if (block && 'cachePoint' in block) {
            placedIdxs.push(blockIdx)
          }
        }

        if (placedIdxs.length > 0) {
          // One boundary per message, so this message contributes a single cache point to the budget.
          // Extras are not worthless - a second point ahead of the per-call tail doubles the cached
          // prefix - but Bedrock allows only four cache points per request and the budget is shared
          // across toolConfig, system and messages. The SDK already spends up to two of them via
          // cacheTools and cachePrompt, so honoring a caller's extras needs that arithmetic first, or
          // three caller points become a hard rejection rather than weaker caching. Descending, so
          // each removal is above every index still to be used.
          for (const extraIdx of placedIdxs.slice(1).reverse()) {
            content.splice(extraIdx, 1)
            logger.warn(
              `msg_idx=<${lastUserIdx}>, block_idx=<${extraIdx}> | stripped existing cache point (auto mode manages cache points)`
            )
          }
          if (this._honorPlacedCachePoint(content, placedIdxs[0] as number, lastUserIdx, ttl)) {
            return
          }
          if (content.length === 0) {
            // Removing the point emptied the message, so there is nothing left to cache and
            // re-adding one would rebuild the request Bedrock just refused.
            logger.debug(`msg_idx=<${lastUserIdx}> | no content left to cache`)
            return
          }
          // The point could not legally stay, so fall through to automatic placement below.
        }

        const cachePoint: BedrockCachePointBlock = { type: 'default' }
        if (ttl) {
          // Bedrock validates TTL values server-side, so accept any string here.
          cachePoint.ttl = ttl as BedrockSdkCacheTTL
        }

        if (dynamicTrailingBlocks > 0) {
          // Per-call content sits at the end, so the reusable prefix ends where that content begins.
          // Routed through the honor path so the document rule and configured TTL apply identically.
          const boundaryIdx = Math.max(0, content.length - dynamicTrailingBlocks)
          if (boundaryIdx === 0) {
            logger.debug(`msg_idx=<${lastUserIdx}> | skipped cache point, no durable prefix`)
            return
          }
          content.splice(boundaryIdx, 0, { cachePoint })
          // A false here means a leading document left no prefix to cache; automatic placement declines
          // for the same reason, so there is nothing to fall back to.
          this._honorPlacedCachePoint(content, boundaryIdx, lastUserIdx, ttl)
          return
        }

        // Locate the first non-PDF document block
        let firstNonPdfDocIdx: number | null = null
        for (let i = 0; i < content.length; i++) {
          const block = content[i]
          if (block && 'document' in block && block.document?.format !== 'pdf') {
            firstNonPdfDocIdx = i
            break
          }
        }

        // Insert the cache point before the first non-PDF document so it is not directly
        // preceded by that block, which Bedrock rejects with a ValidationException
        if (firstNonPdfDocIdx === null) {
          content.push({ cachePoint })
        } else if (firstNonPdfDocIdx > 0) {
          content.splice(firstNonPdfDocIdx, 0, { cachePoint })
        } else {
          // A leading non-PDF document leaves no prefix to cache and Bedrock rejects it
          logger.debug(`msg_idx=<${lastUserIdx}> | skipped cache point for leading non-PDF document`)
          return
        }

        logger.debug(`msg_idx=<${lastUserIdx}> | added cache point to last user message`)
      }
    }
  }

  /**
   * Wraps a formatted content block in guardContent for guardrail evaluation.
   *
   * When guardLatestUserMessage is enabled, this method wraps text and image blocks
   * in guardContent blocks to signal to Bedrock's guardrails to evaluate only that content.
   * Other content types (toolUse, toolResult, etc.) pass through unchanged.
   *
   * @param formattedBlock - The formatted content block to potentially wrap
   * @returns The block wrapped in guardContent if applicable, or the original block
   */
  private _applyGuardBlocks(formattedBlock: BedrockContentBlock | undefined): BedrockContentBlock | undefined {
    if (formattedBlock === undefined) {
      return undefined
    }

    if ('text' in formattedBlock) {
      return {
        guardContent: {
          text: {
            text: formattedBlock.text,
          },
        },
      }
    }

    if ('image' in formattedBlock) {
      // Extract image data and validate for guardContent compatibility
      const imageBlock = formattedBlock.image
      if (!imageBlock?.format || !imageBlock?.source) {
        return formattedBlock
      }

      const format = imageBlock.format

      // Bedrock guardrails only support png/jpeg formats
      if (format !== 'png' && format !== 'jpeg') {
        logger.warn(
          `image_format=<${format}> | format not supported by bedrock guardrails | skipping guardContent wrap`
        )
        return formattedBlock
      }

      // Bedrock guardrails only support bytes source (not S3 or URL)
      if (!('bytes' in imageBlock.source)) {
        logger.warn(
          'source_type=<non-bytes> | image source must be bytes for bedrock guardrails | skipping guardContent wrap'
        )
        return formattedBlock
      }

      return {
        guardContent: {
          image: {
            format: format as 'png' | 'jpeg',
            source: imageBlock.source as { bytes: Uint8Array },
          },
        },
      }
    }

    // Other content types (toolUse, toolResult, etc.) pass through unchanged
    return formattedBlock
  }

  /**
   * Find the index of the last user message containing text or image content.
   *
   * This is used for guardLatestUserMessage guardrail evaluation to ensure that guardContent
   * wrapping targets the correct message even when toolResult messages (role='user') follow
   * the actual user text/image input during tool execution cycles.
   *
   * @param messages - Array of messages to search
   * @returns Index of the last user message with text/image content, or undefined if not found
   */
  private _findLastUserTextMessageIndex(messages: Message[]): number | undefined {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      const msg = messages[idx]
      if (msg === undefined) continue
      if (
        msg.role === 'user' &&
        msg.content.some((block) => block.type === 'textBlock' || block.type === 'imageBlock')
      ) {
        return idx
      }
    }
    return undefined
  }

  /**
   * Determines whether to include the status field in tool results.
   *
   * Uses the includeToolResultStatus config option:
   * - If explicitly true, always include status
   * - If explicitly false, never include status
   * - If 'auto' (default), check if model ID matches known patterns
   *
   * @returns True if status field should be included, false otherwise
   */
  private _shouldIncludeToolResultStatus(): boolean {
    const includeStatus = this._config.includeToolResultStatus ?? 'auto'

    if (includeStatus === true) return true
    if (includeStatus === false) return false

    // Auto-detection mode: check if modelId contains any pattern
    const shouldInclude = MODELS_INCLUDE_STATUS.some((pattern) => this._config.modelId?.includes(pattern))

    // Log debug message for auto-detection
    logger.debug(
      `model_id=<${this._config.modelId}>, include_tool_result_status=<${shouldInclude}> | auto-detected includeToolResultStatus`
    )

    return shouldInclude
  }

  /**
   * Formats a content block for Bedrock API.
   *
   * @param block - SDK content block
   * @returns Bedrock-formatted content block
   */
  private _formatContentBlock(block: ContentBlock): BedrockContentBlock | undefined {
    switch (block.type) {
      case 'textBlock':
        return { text: block.text }

      case 'toolUseBlock':
        return {
          toolUse: {
            toolUseId: block.toolUseId,
            name: block.name,
            input: block.input,
          },
        }

      case 'toolResultBlock': {
        const content = block.content.map((content) => {
          switch (content.type) {
            case 'textBlock':
              return { text: content.text }
            case 'jsonBlock':
              return { json: content.json }
            case 'imageBlock':
              return {
                image: {
                  format: content.format as ImageFormat,
                  source: this._formatMediaSource(content.source),
                },
              }
            case 'videoBlock':
              return {
                video: {
                  format: content.format === '3gp' ? 'three_gp' : (content.format as VideoFormat),
                  source: this._formatMediaSource(content.source),
                },
              }
            case 'documentBlock':
              return {
                document: {
                  name: content.name,
                  format: content.format as DocumentFormat,
                  source: this._formatDocumentSource(content.source),
                  ...(content.citations && { citations: content.citations }),
                  ...(content.context && { context: content.context }),
                },
              }
          }
        })

        return {
          toolResult: {
            toolUseId: block.toolUseId,
            content,
            ...(this._shouldIncludeToolResultStatus() && { status: block.status }),
          },
        }
      }

      case 'reasoningBlock': {
        if (block.text !== undefined || block.signature !== undefined) {
          return {
            reasoningContent: {
              reasoningText: {
                text: block.text ?? '',
                ...(block.signature !== undefined && { signature: block.signature }),
              },
            },
          }
        } else if (block.redactedContent) {
          return {
            reasoningContent: {
              redactedContent: block.redactedContent,
            },
          }
        } else {
          throw Error("reasoning content requires one of 'text', 'signature', or 'redactedContent' to be set")
        }
      }

      case 'cachePointBlock': {
        const cachePoint: BedrockCachePointBlock = { type: block.cacheType }
        if (block.ttl) {
          // Bedrock validates non-empty TTL values server-side, so do not restrict them to known values here.
          cachePoint.ttl = block.ttl as BedrockSdkCacheTTL
        }
        return { cachePoint }
      }

      case 'audioBlock':
        return {
          audio: {
            format: block.format as AudioFormat,
            source: this._formatMediaSource(block.source),
          },
        }

      case 'imageBlock':
        return {
          image: {
            format: block.format as ImageFormat,
            source: this._formatMediaSource(block.source),
          },
        }

      case 'videoBlock':
        return {
          video: {
            format: block.format === '3gp' ? 'three_gp' : block.format,
            source: this._formatMediaSource(block.source),
          },
        }

      case 'documentBlock':
        return {
          document: {
            name: block.name,
            format: block.format as DocumentFormat,
            source: this._formatDocumentSource(block.source),
            ...(block.citations && { citations: block.citations }),
            ...(block.context && { context: block.context }),
          },
        }

      case 'citationsBlock':
        return {
          citationsContent: {
            citations: block.citations.map((c) => this._mapCitationToBedrock(c)),
            content: block.content,
          },
        }

      case 'guardContentBlock': {
        if (block.text) {
          return {
            guardContent: {
              text: {
                text: block.text.text,
                qualifiers: block.text.qualifiers,
              },
            },
          }
        } else if (block.image) {
          return {
            guardContent: {
              image: {
                format: block.image.format,
                source: { bytes: block.image.source.bytes },
              },
            },
          }
        } else {
          throw new Error('guardContent must have either text or image')
        }
      }
    }
  }

  /**
   * Format media source (audio/image/video) for Bedrock API.
   * Handles bytes, S3 locations, and s3:// URLs.
   *
   * @param source - Media source
   * @returns Formatted source for Bedrock API
   */
  private _formatMediaSource(
    source: AudioSource | ImageSource | VideoSource
  ):
    | BedrockAudioSource.BytesMember
    | BedrockAudioSource.S3LocationMember
    | BedrockImageSource.BytesMember
    | BedrockImageSource.S3LocationMember
    | BedrockVideoSource.BytesMember
    | BedrockVideoSource.S3LocationMember
    | undefined {
    switch (source.type) {
      case 'audioSourceBytes':
      case 'imageSourceBytes':
      case 'videoSourceBytes':
        return { bytes: source.bytes }

      case 'imageSourceUrl':
        // Check if URL is actually an S3 URI
        if (source.url.startsWith('s3://')) {
          return {
            s3Location: {
              uri: source.url,
            },
          }
        }
        logger.warn('source_type=<imageSourceUrl> | not supported by bedrock | skipping')
        return

      case 'audioSourceS3Location':
      case 'imageSourceS3Location':
      case 'videoSourceS3Location':
        return {
          s3Location: {
            uri: source.location.uri,
            ...(source.location.bucketOwner && { bucketOwner: source.location.bucketOwner }),
          },
        }

      default:
        throw new Error('Invalid media source')
    }
  }

  /**
   * Format document source for Bedrock API.
   * Handles bytes, text, content, and S3 locations.
   * Note: Bedrock API only accepts bytes, content, or s3Location - text is converted to bytes.
   *
   * @param source - Document source
   * @returns Formatted source for Bedrock API
   */
  private _formatDocumentSource(
    source: DocumentSource
  ): BedrockDocumentSource.BytesMember | BedrockDocumentSource.ContentMember | BedrockDocumentSource.S3LocationMember {
    switch (source.type) {
      case 'documentSourceBytes':
        return {
          bytes: source.bytes,
        }

      case 'documentSourceText': {
        // Convert text to bytes - Bedrock API doesn't accept text directly
        const encoder = new TextEncoder()
        return { bytes: encoder.encode(source.text) }
      }

      case 'documentSourceContentBlock':
        return {
          content: source.content.map((block) => ({
            text: block.text,
          })),
        }

      case 'documentSourceS3Location':
        return {
          s3Location: {
            uri: source.location.uri,
            ...(source.location.bucketOwner && { bucketOwner: source.location.bucketOwner }),
          },
        }

      default:
        throw new Error('Invalid document source')
    }
  }

  private _mapBedrockEventToSDKEvent(event: ConverseCommandOutput): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = []

    // Message start
    const output = ensureDefined(event.output, 'event.output')
    const message = ensureDefined(output.message, 'output.message')
    const role = ensureDefined(message.role, 'message.role')
    if (role !== 'user' && role !== 'assistant') {
      throw new Error(`Unexpected role from Bedrock: '${role}'`)
    }
    events.push({
      type: 'modelMessageStartEvent',
      role,
    })

    // Match on content blocks
    const blockHandlers = {
      text: (textBlock: string): void => {
        events.push({ type: 'modelContentBlockStartEvent' })
        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: textBlock },
        })
        events.push({ type: 'modelContentBlockStopEvent' })
      },
      toolUse: (block: ToolUseBlock): void => {
        events.push({
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: ensureDefined(block.name, 'toolUse.name'),
            toolUseId: ensureDefined(block.toolUseId, 'toolUse.toolUseId'),
          },
        })
        events.push({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: JSON.stringify(ensureDefined(block.input, 'toolUse.input')) },
        })
        events.push({ type: 'modelContentBlockStopEvent' })
      },
      reasoningContent: (block: ReasoningContentBlock): void => {
        if (!block) return
        events.push({ type: 'modelContentBlockStartEvent' })

        const delta: ReasoningContentDelta = { type: 'reasoningContentDelta' }
        if (block.reasoningText) {
          delta.text = ensureDefined(block.reasoningText.text, 'reasoningText.text')
          if (block.reasoningText.signature) delta.signature = block.reasoningText.signature
        } else if (block.redactedContent) {
          delta.redactedContent = block.redactedContent
        }

        if (Object.keys(delta).length > 1) {
          events.push({ type: 'modelContentBlockDeltaEvent', delta })
        }

        events.push({ type: 'modelContentBlockStopEvent' })
      },
      citationsContent: (block: BedrockCitationsContentBlock): void => {
        if (!block) return
        events.push({ type: 'modelContentBlockStartEvent' })

        const mapped = this._mapBedrockCitationsData(block)
        const delta: CitationsDelta = {
          type: 'citationsDelta',
          citations: mapped.citations,
          content: mapped.content,
        }
        events.push({ type: 'modelContentBlockDeltaEvent', delta })
        events.push({ type: 'modelContentBlockStopEvent' })
      },
    }

    const content = ensureDefined(message.content, 'message.content')
    content.forEach((block) => {
      for (const key in block) {
        if (key in blockHandlers) {
          const handlerKey = key as keyof typeof blockHandlers
          // @ts-expect-error - We know the value type corresponds to the handler key.
          blockHandlers[handlerKey](block[handlerKey])
        } else {
          logger.warn(`block_key=<${key}> | skipping unsupported block key`)
        }
      }
    })

    const stopReasonRaw = ensureDefined(event.stopReason, 'event.stopReason') as string
    events.push({
      type: 'modelMessageStopEvent',
      stopReason: this._transformStopReason(stopReasonRaw, event),
    })

    const usage = ensureDefined(event.usage, 'output.usage')
    const metadataEvent: ModelStreamEvent = {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens: ensureDefined(usage.inputTokens, 'usage.inputTokens'),
        outputTokens: ensureDefined(usage.outputTokens, 'usage.outputTokens'),
        totalTokens: ensureDefined(usage.totalTokens, 'usage.totalTokens'),
      },
    }

    if (event.metrics) {
      metadataEvent.metrics = {
        latencyMs: ensureDefined(event.metrics.latencyMs, 'metrics.latencyMs'),
      }
    }

    // Handle trace and guardrail check for non-streaming responses
    if (event.trace) {
      metadataEvent.trace = event.trace
    }

    // Bedrock reports guardrail_intervened for both BLOCKED and ANONYMIZED (masking). When the
    // trace is carried it is authoritative — only BLOCKED policies warrant redaction. When it
    // isn't (typically guardrailConfig.trace='disabled'), fall back to the stop reason.
    if (this._config.guardrailConfig && stopReasonRaw === 'guardrail_intervened') {
      const guardrail = event.trace?.guardrail
      const shouldRedact = guardrail !== undefined ? this._hasBlockedGuardrailPolicy(guardrail) : true
      if (shouldRedact) {
        for (const redactionEvent of this._generateRedactionEvents(guardrail ?? {})) {
          events.push(redactionEvent)
        }
      }
    }

    events.push(metadataEvent)

    return events
  }

  /**
   * Maps a Bedrock event to SDK streaming events.
   *
   * @param chunk - Bedrock event chunk
   * @param lastStopReason - Stop reason from previous messageStop event
   * @returns Object containing events array and optional stopReason
   */
  private _mapStreamedBedrockEventToSDKEvent(
    chunk: ConverseStreamOutput,
    lastStopReason?: string
  ): { events: ModelStreamEvent[]; stopReason?: string } {
    const events: ModelStreamEvent[] = []
    let stopReason = lastStopReason

    // Extract the event type key
    const eventType = ensureDefined(Object.keys(chunk)[0], 'eventType') as keyof ConverseStreamOutput
    const eventData = chunk[eventType as keyof ConverseStreamOutput]

    switch (eventType) {
      case 'messageStart': {
        const data = eventData as BedrockMessageStartEvent
        const role = ensureDefined(data.role, 'messageStart.role')
        if (role !== 'user' && role !== 'assistant') {
          throw new Error(`Unexpected role from Bedrock: '${role}'`)
        }
        events.push({
          type: 'modelMessageStartEvent',
          role,
        })
        break
      }

      case 'contentBlockStart': {
        const data = eventData as BedrockContentBlockStartEvent

        const event: ModelStreamEvent = {
          type: 'modelContentBlockStartEvent',
        }

        if (data.start?.toolUse) {
          const toolUse = data.start.toolUse
          event.start = {
            type: 'toolUseStart',
            name: ensureDefined(toolUse.name, 'toolUse.name'),
            toolUseId: ensureDefined(toolUse.toolUseId, 'toolUse.toolUseId'),
          }
        }

        events.push(event)
        break
      }

      case 'contentBlockDelta': {
        const data = eventData as BedrockContentBlockDeltaEvent
        const delta = ensureDefined(data.delta, 'contentBlockDelta.delta')
        const deltaHandlers = {
          text: (textValue: string): void => {
            events.push({
              type: 'modelContentBlockDeltaEvent',
              delta: { type: 'textDelta', text: textValue },
            })
          },
          toolUse: (toolUse: ToolUseBlockDelta): void => {
            if (!toolUse?.input) return
            events.push({
              type: 'modelContentBlockDeltaEvent',
              delta: { type: 'toolUseInputDelta', input: toolUse.input },
            })
          },
          reasoningContent: (reasoning: ReasoningContentBlockDelta): void => {
            if (!reasoning) return
            const reasoningDelta: ReasoningContentDelta = { type: 'reasoningContentDelta' }
            if (reasoning.text) reasoningDelta.text = reasoning.text
            if (reasoning.signature) reasoningDelta.signature = reasoning.signature
            if (reasoning.redactedContent) reasoningDelta.redactedContent = reasoning.redactedContent

            if (Object.keys(reasoningDelta).length > 1) {
              events.push({ type: 'modelContentBlockDeltaEvent', delta: reasoningDelta })
            }
          },
          citation: (citation: BedrockCitationsDelta): void => {
            const location = citation.location ? this._mapBedrockCitationLocation(citation.location) : undefined
            if (!location) return
            events.push({
              type: 'modelContentBlockDeltaEvent',
              delta: {
                type: 'citationsDelta',
                citations: [
                  {
                    location,
                    sourceContent: (citation.sourceContent ?? []).map((sc) => ({ text: sc.text! })),
                    source: citation.source ?? '',
                    title: citation.title ?? '',
                  },
                ],
                content: [],
              },
            })
          },
        }

        for (const key in delta) {
          if (key in deltaHandlers) {
            const handlerKey = key as keyof typeof deltaHandlers
            // @ts-expect-error - We know the value type corresponds to the handler key.
            deltaHandlers[handlerKey](delta[handlerKey])
          } else {
            logger.warn(`delta_key=<${key}> | skipping unsupported delta key`)
          }
        }

        break
      }

      case 'contentBlockStop': {
        events.push({
          type: 'modelContentBlockStopEvent',
        })
        break
      }

      case 'messageStop': {
        const data = eventData as BedrockMessageStopEvent

        const stopReasonRaw = ensureDefined(data.stopReason, 'messageStop.stopReason') as string
        stopReason = stopReasonRaw
        const event: ModelStreamEvent = {
          type: 'modelMessageStopEvent',
          stopReason: this._transformStopReason(stopReasonRaw, data),
        }

        if (data.additionalModelResponseFields) {
          event.additionalModelResponseFields = data.additionalModelResponseFields
        }

        events.push(event)
        break
      }

      case 'metadata': {
        const data = eventData as BedrockConverseStreamMetadataEvent

        const event: ModelStreamEvent = {
          type: 'modelMetadataEvent',
        }

        if (data.usage) {
          const usage = data.usage

          const usageInfo: Usage = {
            inputTokens: ensureDefined(usage.inputTokens, 'usage.inputTokens'),
            outputTokens: ensureDefined(usage.outputTokens, 'usage.outputTokens'),
            totalTokens: ensureDefined(usage.totalTokens, 'usage.totalTokens'),
          }

          if (usage.cacheReadInputTokens !== undefined) {
            usageInfo.cacheReadInputTokens = usage.cacheReadInputTokens
          }
          if (usage.cacheWriteInputTokens !== undefined) {
            usageInfo.cacheWriteInputTokens = usage.cacheWriteInputTokens
          }

          event.usage = usageInfo
        }

        if (data.metrics) {
          event.metrics = {
            latencyMs: ensureDefined(data.metrics.latencyMs, 'metrics.latencyMs'),
          }
        }

        if (data.trace) {
          event.trace = data.trace
        }

        events.push(event)
        break
      }
      case 'internalServerException':
      case 'modelStreamErrorException':
      case 'serviceUnavailableException':
      case 'validationException': {
        throw eventData
      }
      case 'throttlingException': {
        const message = (eventData as { message?: string }).message ?? 'Request was throttled by the model provider'
        logger.debug(`throttled | error_message=<${message}>`)
        throw new ModelThrottledError(message, { cause: eventData })
      }
      default:
        // Log warning for unsupported event types (for forward compatibility)
        logger.warn(`event_type=<${eventType}> | unsupported bedrock event type`)
        break
    }

    return stopReason !== undefined ? { events, stopReason } : { events }
  }

  /**
   * Transforms a Bedrock stop reason into the SDK's format.
   *
   * @param stopReasonRaw - The raw stop reason string from Bedrock.
   * @param event - The full event output, used to check for tool_use adjustments.
   * @returns The transformed stop reason.
   */
  private _transformStopReason(
    stopReasonRaw: string,
    event?: ConverseCommandOutput | BedrockMessageStopEvent
  ): StopReason {
    let mappedStopReason: StopReason

    if (stopReasonRaw in STOP_REASON_MAP) {
      mappedStopReason = STOP_REASON_MAP[stopReasonRaw as keyof typeof STOP_REASON_MAP]
    } else {
      const camelCaseReason = snakeToCamel(stopReasonRaw)
      logger.warn(
        `stop_reason=<${stopReasonRaw}>, fallback=<${camelCaseReason}> | unknown stop reason, converting to camelCase`
      )
      mappedStopReason = camelCaseReason
    }

    // Adjust for tool_use, which is sometimes incorrectly reported as end_turn
    if (
      mappedStopReason === 'endTurn' &&
      event &&
      'output' in event &&
      event.output?.message?.content?.some((block) => 'toolUse' in block)
    ) {
      mappedStopReason = 'toolUse'
      logger.warn('stop_reason=<end_turn> | adjusting to tool_use due to tool use in content blocks')
    }

    return mappedStopReason
  }

  /**
   * Maps a Bedrock object-key citation location to the SDK's type-field format.
   *
   * Bedrock uses object-key discrimination (`{ documentChar: { ... } }`) while the SDK uses
   * type-field discrimination (`{ type: 'documentChar', ... }`). Also normalizes Bedrock's
   * `searchResultLocation` key to the shorter `searchResult`.
   *
   * @param bedrockLocation - Bedrock citation location with object-key discrimination
   * @returns SDK CitationLocation with type field discrimination
   */
  private _mapBedrockCitationLocation(bedrockLocation: BedrockCitationLocation): CitationLocation | undefined {
    if (bedrockLocation.documentChar) {
      const loc = bedrockLocation.documentChar
      return { type: 'documentChar', documentIndex: loc.documentIndex!, start: loc.start!, end: loc.end! }
    }
    if (bedrockLocation.documentPage) {
      const loc = bedrockLocation.documentPage
      return { type: 'documentPage', documentIndex: loc.documentIndex!, start: loc.start!, end: loc.end! }
    }
    if (bedrockLocation.documentChunk) {
      const loc = bedrockLocation.documentChunk
      return { type: 'documentChunk', documentIndex: loc.documentIndex!, start: loc.start!, end: loc.end! }
    }
    if (bedrockLocation.searchResultLocation) {
      const loc = bedrockLocation.searchResultLocation
      return { type: 'searchResult', searchResultIndex: loc.searchResultIndex!, start: loc.start!, end: loc.end! }
    }
    if (bedrockLocation.web) {
      const loc = bedrockLocation.web
      return { type: 'web', url: loc.url!, ...(loc.domain && { domain: loc.domain }) }
    }
    logger.warn(`citation_location=<${JSON.stringify(bedrockLocation)}> | unknown citation location type`)
    return undefined
  }

  /**
   * Maps a Bedrock CitationsContentBlock to SDK CitationsBlockData.
   *
   * @param bedrockData - Bedrock CitationsContentBlock
   * @returns SDK CitationsBlockData with type-field CitationLocations
   */
  private _mapBedrockCitationsData(bedrockData: BedrockCitationsContentBlock): CitationsBlockData {
    return {
      citations: (bedrockData.citations ?? [])
        .map((citation) => {
          const location = citation.location ? this._mapBedrockCitationLocation(citation.location) : undefined
          if (!location) return undefined
          return {
            source: citation.source ?? '',
            title: citation.title ?? '',
            sourceContent: (citation.sourceContent ?? []).map((sc) => ({ text: sc.text! })),
            location,
          }
        })
        .filter((c) => c !== undefined),
      content: (bedrockData.content ?? []).map((gc) => ({ text: gc.text! })),
    }
  }

  /**
   * Maps an SDK Citation to Bedrock's Citation format.
   *
   * @param citation - SDK Citation with type-field location
   * @returns Bedrock Citation with object-key location
   */
  private _mapCitationToBedrock(citation: Citation): BedrockCitation {
    return {
      location: this._mapCitationLocationToBedrock(citation.location),
      sourceContent: citation.sourceContent.map((sc) => ({ text: sc.text })),
      source: citation.source,
      title: citation.title,
    }
  }

  /**
   * Maps an SDK CitationLocation to Bedrock's object-key format.
   *
   * @param location - SDK CitationLocation with type field
   * @returns Bedrock CitationLocation with object-key discrimination
   */
  private _mapCitationLocationToBedrock(location: CitationLocation): BedrockCitationLocation {
    switch (location.type) {
      case 'documentChar': {
        const { type: _, ...fields } = location
        return { documentChar: fields }
      }
      case 'documentPage': {
        const { type: _, ...fields } = location
        return { documentPage: fields }
      }
      case 'documentChunk': {
        const { type: _, ...fields } = location
        return { documentChunk: fields }
      }
      case 'searchResult': {
        const { type: _, ...fields } = location
        return { searchResultLocation: fields }
      }
      case 'web':
        return { web: { url: location.url, ...(location.domain && { domain: location.domain }) } }
      default:
        return location as unknown as BedrockCitationLocation
    }
  }

  /**
   * Recursively check a guardrail trace assessment for any detected-and-blocked policy.
   *
   * Bedrock reports guardrail_intervened for both BLOCKED and ANONYMIZED (masking) actions, so
   * the trace is the only signal that distinguishes them: only BLOCKED entries warrant
   * SDK-level redaction — masked spans have already been substituted in place server-side.
   *
   * @param guardrailData - The guardrail trace assessment
   * @returns True if any assessment contains action='BLOCKED' with detected=true
   */
  private _hasBlockedGuardrailPolicy(guardrailData: GuardrailTraceAssessment): boolean {
    const visit = (value: unknown): boolean => {
      if (value === null || value === undefined) return false
      if (Array.isArray(value)) return value.some(visit)
      if (typeof value !== 'object') return false
      const record = value as Record<string, unknown>
      if (record.action === 'BLOCKED' && record.detected === true) return true
      return Object.values(record).some(visit)
    }
    return visit(guardrailData)
  }

  /**
   * Generate redaction events based on guardrail configuration.
   *
   * @param guardrailData - The guardrail trace assessment data
   * @returns Array of redaction events to emit
   */
  private _generateRedactionEvents(guardrailData: GuardrailTraceAssessment): ModelStreamEvent[] {
    const events: ModelStreamEvent[] = []
    const redaction = this._config.guardrailConfig?.redaction

    // Default: redact input is true unless explicitly set to false
    if (redaction?.input !== false) {
      logger.debug('redacting input due to guardrail')
      events.push({
        type: 'modelRedactionEvent',
        inputRedaction: {
          replaceContent: redaction?.inputMessage ?? DEFAULT_REDACT_INPUT_MESSAGE,
        },
      })
    }

    // Only redact output if explicitly enabled
    if (redaction?.output) {
      logger.debug('redacting output due to guardrail')
      const outputRedactionEvent: ModelStreamEvent = {
        type: 'modelRedactionEvent',
        outputRedaction: {
          replaceContent: redaction?.outputMessage ?? DEFAULT_REDACT_OUTPUT_MESSAGE,
        },
      }

      // Include the original model output if available
      if (guardrailData.modelOutput && guardrailData.modelOutput.length > 0) {
        outputRedactionEvent.outputRedaction!.redactedContent = guardrailData.modelOutput.join('')
      }

      events.push(outputRedactionEvent)
    }

    return events
  }
}

/**
 * Merges a default request timeout into the caller's requestHandler options.
 *
 * The SDK's `requestHandler` slot accepts either a constructed handler instance
 * or an options bag that the SDK uses to build its default handler. We only
 * inject a default in the options-bag case: a handler instance has its timeouts
 * baked in at construction time, so we pass it through untouched.
 *
 * The handler-vs-options discriminator mirrors the SDK's own check — see
 * `NodeHttp2Handler.create` in `@smithy/node-http-handler`.
 */
function withDefaultRequestTimeout(
  handler: BedrockRuntimeClientConfig['requestHandler']
): NonNullable<BedrockRuntimeClientConfig['requestHandler']> {
  if (handler && typeof (handler as { handle?: unknown }).handle === 'function') {
    return handler
  }
  const options = (handler ?? {}) as { requestTimeout?: number; [key: string]: unknown }
  // Use `??` rather than spread order so an explicit `requestTimeout: undefined` still gets
  // the default (spread would otherwise overwrite the default with `undefined`, disabling it).
  return { ...options, requestTimeout: options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS }
}

/**
 * Replaces the AWS browser default WebSocket wrapper for this model's HTTPS
 * requests. The wrapper drops HttpHandlerOptions when delegating to fetch, so
 * abortSignal never reaches the transport. Node defaults and caller-provided
 * handler instances are left unchanged.
 */
function applyAbortAwareBrowserRequestHandler(
  config: BedrockRuntimeClientResolvedConfig,
  requestHandler: NonNullable<BedrockRuntimeClientConfig['requestHandler']>
): void {
  if (typeof (requestHandler as { handle?: unknown }).handle === 'function') {
    return
  }
  if (config.requestHandler?.metadata?.handlerProtocol !== 'websocket/h1.1') {
    return
  }
  config.requestHandler = new FetchHttpHandler(requestHandler as FetchHttpHandlerOptions)
}

/**
 * Adds middleware to override the Authorization header with a Bearer token.
 * Runs after SigV4 signing to replace the signature with the API key.
 *
 * @param client - BedrockRuntimeClient instance
 * @param apiKey - Bedrock API key
 */
function applyApiKey(client: BedrockRuntimeClient, apiKey: string): void {
  client.middlewareStack.add(
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    (next) => async (args) => {
      const request = args.request as { headers: Record<string, string> }
      request.headers['authorization'] = `Bearer ${apiKey}`
      return next(args)
    },
    {
      step: 'finalizeRequest',
      priority: 'low',
      name: 'bedrockApiKeyMiddleware',
    }
  )
}

/**
 * What region is used for the BedrockConfiguration can't be known at construction-time so to apply a default
 * we have to use an async function to intercept "Region is missing" errors and then apply our default (this
 * is actually how many bedrock configuration parameters are implemented).
 *
 * We need to override both region & useFipsEndpoint because the region is used in both of those places:
 * https://github.com/smithy-lang/smithy-typescript/blob/e11f7499c1bad30a515217f82a07b9e3e69a1f60/packages/config-resolver/src/regionConfig/resolveRegionConfig.ts#L42
 *
 * We do this unconditionally so that if a region is updated dynamically (environment variable or profile value) we
 * also pick up those changes and stop applying the default.
 */
function applyDefaultRegion(config: BedrockRuntimeClientResolvedConfig): void {
  // Bind original region function and wrap with error handling
  const originalRegion = config.region.bind(config)
  config.region = async (): Promise<string> => {
    try {
      return await originalRegion()
    } catch (error) {
      // Note: it was observed that the browser version of the BedrockClient
      // uses a string instead of an error object - thus the normalizeError call
      if (normalizeError(error).message === 'Region is missing') {
        return MODEL_DEFAULTS.bedrock.region
      }

      throw error
    }
  }

  // Bind original useFipsEndpoint function and wrap with error handling
  const originalUseFipsEndpoint = config.useFipsEndpoint.bind(config)
  config.useFipsEndpoint = async (): Promise<boolean> => {
    try {
      return await originalUseFipsEndpoint()
    } catch (error) {
      // Note: it was observed that the browser version of the BedrockClient
      // uses a string instead of an error object - thus the normalizeError call
      if (normalizeError(error).message === 'Region is missing') {
        return DEFAULT_BEDROCK_REGION_SUPPORTS_FIP
      }
      throw error
    }
  }
}
