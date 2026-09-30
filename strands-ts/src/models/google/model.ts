/**
 * Google model provider implementation.
 *
 * This module provides integration with Google's Gemini API,
 * supporting streaming responses and configurable model parameters.
 *
 * @see https://ai.google.dev/docs
 */

import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Tool,
} from '@google/genai'
import { Model, resolveConfigMetadata } from '../model.js'
import type { CacheConfig, CountTokensOptions, StreamOptions } from '../model.js'
import type { Message } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'
import { ContextWindowOverflowError, ModelThrottledError, ProviderTokenCountError } from '../../errors.js'
import type { GoogleModelConfig, GoogleModelOptions, GoogleStreamState } from './types.js'
export type { GoogleModelConfig, GoogleModelOptions }
import { classifyGoogleError } from './errors.js'
import { isMissingCache, resolveCachedContent, warnUnsupported } from './cache.js'
import { formatMessages, mapChunkToEvents } from './adapters.js'
import { MODEL_DEFAULTS, defaultModelWarningMessage } from '../defaults.js'
import { warnOnce } from '../../logging/warn-once.js'
import { logger } from '../../logging/logger.js'

/** Internal signal: a managed cachedContent 404'd before any content streamed, so a retry is safe. */
class MissingCacheContentError extends Error {}

/**
 * Google model provider implementation.
 *
 * Implements the Model interface for Google GenAI using the Generative AI API.
 * Supports streaming responses and comprehensive configuration.
 *
 * @example
 * ```typescript
 * const provider = new GoogleModel({
 *   apiKey: 'your-api-key',
 *   modelId: 'gemini-2.5-flash',
 *   params: { temperature: 0.7, maxOutputTokens: 1024 }
 * })
 *
 * const messages: Message[] = [
 *   { role: 'user', content: [{ type: 'textBlock', text: 'Hello!' }] }
 * ]
 *
 * for await (const event of provider.stream(messages)) {
 *   if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
 *     process.stdout.write(event.delta.text)
 *   }
 * }
 * ```
 */
export class GoogleModel extends Model<GoogleModelConfig> {
  private _config: GoogleModelConfig
  private _client: GoogleGenAI

  /**
   * Creates a new GoogleModel instance.
   *
   * @param options - Configuration for model and client
   *
   * @example
   * ```typescript
   * // Minimal configuration with API key
   * const provider = new GoogleModel({
   *   apiKey: 'your-api-key'
   * })
   *
   * // With model configuration
   * const provider = new GoogleModel({
   *   apiKey: 'your-api-key',
   *   modelId: 'gemini-2.5-flash',
   *   params: { temperature: 0.8, maxOutputTokens: 2048 }
   * })
   *
   * // Using environment variable for API key
   * const provider = new GoogleModel({
   *   modelId: 'gemini-2.5-flash'
   * })
   *
   * // Using a pre-configured client instance
   * const client = new GoogleGenAI({ apiKey: 'your-api-key' })
   * const provider = new GoogleModel({
   *   client
   * })
   * ```
   */
  constructor(options?: GoogleModelOptions) {
    super()
    const { apiKey, client, clientConfig, ...modelConfig } = options || {}

    this._config = modelConfig

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.gemini.modelId))
    }

    if (client) {
      this._client = client
    } else {
      const resolvedApiKey = apiKey || GoogleModel._getEnvApiKey()

      if (!resolvedApiKey) {
        throw new Error(
          "Gemini API key is required. Provide it via the 'apiKey' option or set the GEMINI_API_KEY environment variable."
        )
      }

      this._client = new GoogleGenAI({
        apiKey: resolvedApiKey,
        ...clientConfig,
      })
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
   * // Update model parameters
   * provider.updateConfig({
   *   params: { temperature: 0.9, maxOutputTokens: 2048 }
   * })
   * ```
   */
  updateConfig(modelConfig: GoogleModelConfig): void {
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
  getConfig(): GoogleModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.gemini.modelId)
  }

  /**
   * Count tokens using Gemini's native countTokens API.
   *
   * Uses the Gemini countTokens API for message contents. System instructions and tools
   * are estimated via the base class heuristic because the Gemini API (non-Vertex backend)
   * does not support these in CountTokensConfig.
   * Falls back to the base class heuristic on failure.
   *
   * @param messages - Array of conversation messages to count tokens for
   * @param options - Optional options containing system prompt and tool specs
   * @returns Total input token count
   */
  override async countTokens(messages: Message[], options?: CountTokensOptions): Promise<number> {
    if (this._config.useNativeTokenCount !== true) return super.countTokens(messages, options)

    try {
      const params = this._formatRequest(messages, options)
      const modelId = params.model

      // The Gemini API (non-Vertex backend) raises an error for systemInstruction and tools
      // in CountTokensConfig. Use native counting for message contents only, then add the
      // heuristic estimate for system prompt and tools.
      const response = await this._client.models.countTokens({
        model: modelId,
        contents: params.contents,
      })

      if (response.totalTokens == null) {
        throw new ProviderTokenCountError('Gemini countTokens returned null for totalTokens')
      }

      let totalTokens = response.totalTokens

      // Add heuristic estimate for system prompt and tools (not supported by the API)
      if (options?.systemPrompt || options?.toolSpecs) {
        totalTokens += await super.countTokens([], {
          ...(options.systemPrompt && { systemPrompt: options.systemPrompt }),
          ...(options.toolSpecs && { toolSpecs: options.toolSpecs }),
        })
      }

      logger.debug(`total_tokens=<${totalTokens}> | native token count`)
      return totalTokens
    } catch (error) {
      logger.debug(`error=<${error}> | native token counting failed, falling back to estimation`)
      return super.countTokens(messages, options)
    }
  }

  /**
   * Streams a conversation with the Google model.
   * Returns an async iterable that yields streaming events as they occur.
   *
   * @param messages - Array of conversation messages
   * @param options - Optional streaming configuration
   * @returns Async iterable of streaming events
   *
   * @throws \{ContextWindowOverflowError\} When input exceeds the model's context window
   *
   * @example
   * ```typescript
   * const provider = new GoogleModel({ apiKey: 'your-api-key' })
   * const messages: Message[] = [
   *   { role: 'user', content: [{ type: 'textBlock', text: 'What is 2+2?' }] }
   * ]
   *
   * for await (const event of provider.stream(messages)) {
   *   if (event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta') {
   *     process.stdout.write(event.delta.text)
   *   }
   * }
   * ```
   */
  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!messages || messages.length === 0) {
      throw new Error('At least one message is required')
    }

    const cacheConfig = this._config.cacheConfig
    warnUnsupported(cacheConfig)

    try {
      const streamState: GoogleStreamState = {
        messageStarted: false,
        textContentBlockStarted: false,
        reasoningContentBlockStarted: false,
        hasToolCalls: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }

      for await (const chunk of this._contentStream(messages, options, cacheConfig)) {
        yield* mapChunkToEvents(chunk, streamState)
      }

      if (streamState.inputTokens > 0 || streamState.outputTokens > 0) {
        const usage: Usage = {
          inputTokens: streamState.inputTokens,
          outputTokens: streamState.outputTokens,
          totalTokens: streamState.totalTokens,
        }
        if (streamState.cacheReadInputTokens !== undefined) {
          usage.cacheReadInputTokens = streamState.cacheReadInputTokens
        }
        yield { type: 'modelMetadataEvent', usage }
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }
      const errorType = classifyGoogleError(error)

      if (errorType === 'contextOverflow') {
        throw new ContextWindowOverflowError(error.message)
      }

      if (errorType === 'throttling') {
        throw new ModelThrottledError(error.message, { cause: error })
      }

      throw error
    }
  }

  /**
   * Opens the content stream, injecting a managed cachedContent when caching is engaged and
   * recovering once from a cachedContent the server 404s before any content is produced.
   */
  private async *_contentStream(
    messages: Message[],
    options: StreamOptions | undefined,
    cacheConfig: CacheConfig | undefined
  ): AsyncGenerator<GenerateContentResponse> {
    const cachedContent = await this._resolveCachedContent(messages, options, cacheConfig)
    const params = this._formatRequest(messages, options, cachedContent)

    // cachedContent is set only when managed caching injected it, so recovery is attempted only for a
    // cache this provider owns; a user-supplied params.cachedContent is left for the caller to manage.
    try {
      yield* this._openContentStream(params, cachedContent !== undefined)
      return
    } catch (error) {
      if (!(error instanceof MissingCacheContentError)) throw error
    }

    yield* this._recoverContentStream(messages, options, cacheConfig as CacheConfig)
  }

  /**
   * Recovers from a managed cachedContent the server 404'd: recreate once, else drop the cache.
   *
   * Reached only after the initial stream 404'd before producing content. Recreating restores the
   * caching benefit for this and later turns; dropping the cache re-attaches system/tools so the turn
   * still completes.
   */
  private async *_recoverContentStream(
    messages: Message[],
    options: StreamOptions | undefined,
    cacheConfig: CacheConfig
  ): AsyncGenerator<GenerateContentResponse> {
    const recreated = await this._resolveCachedContent(messages, options, cacheConfig, true)
    if (recreated !== undefined) {
      try {
        yield* this._openContentStream(this._formatRequest(messages, options, recreated), true)
        return
      } catch (error) {
        if (!(error instanceof MissingCacheContentError)) throw error
      }
    }

    // Drop the cache; system/tools re-attach via _formatRequest with no cachedContent.
    yield* this._openContentStream(this._formatRequest(messages, options), false)
  }

  /**
   * Opens a stream and yields its events, signaling a pre-content missing-cache 404 for retry.
   *
   * The vendor SDK opens eagerly: `generateContentStream` fires the request and rejects at the await
   * when the referenced cachedContent has expired, before any event is produced. That open-time
   * rejection and a mid-open 404 from `_guardedStream` are both normalized to `MissingCacheContentError`
   * so the caller has a single recoverable signal; either way nothing has streamed, so a retry is safe.
   *
   * @throws MissingCacheContentError - When a managed cachedContent 404s before any event is produced
   *   and `recoverable` is set. Any other error, and any error after the first event, propagates.
   */
  private async *_openContentStream(
    params: GenerateContentParameters,
    recoverable: boolean
  ): AsyncGenerator<GenerateContentResponse> {
    let stream: AsyncIterable<GenerateContentResponse>
    try {
      stream = await this._client.models.generateContentStream(params)
    } catch (error) {
      if (recoverable && error instanceof Error && isMissingCache(error)) {
        throw new MissingCacheContentError()
      }
      throw error
    }
    yield* GoogleModel._guardedStream(stream, recoverable)
  }

  /**
   * Yields events from an opened stream, signaling a pre-content missing-cache 404 for retry.
   *
   * @throws MissingCacheContentError - When a managed cachedContent 404s before any event is produced
   *   and `recoverable` is set. Any other error, and any error after the first event, propagates.
   */
  private static async *_guardedStream(
    stream: AsyncIterable<GenerateContentResponse>,
    recoverable: boolean
  ): AsyncGenerator<GenerateContentResponse> {
    let started = false
    try {
      for await (const chunk of stream) {
        started = true
        yield chunk
      }
    } catch (error) {
      if (recoverable && !started && error instanceof Error && isMissingCache(error)) {
        throw new MissingCacheContentError()
      }
      throw error
    }
  }

  /**
   * Resolves the managed cachedContent resource name to attach, or undefined for implicit caching.
   *
   * An explicit cachedContent in the configured params always wins, so managed resolution runs only
   * when the caller left it unset. The static prefix (system + tools) is derived from a request built
   * without a cache, reusing the same formatting the stream sends.
   */
  private async _resolveCachedContent(
    messages: Message[],
    options: StreamOptions | undefined,
    cacheConfig: CacheConfig | undefined,
    forceCreate = false
  ): Promise<string | undefined> {
    if (!cacheConfig) return undefined
    if (this._config.params?.cachedContent !== undefined) return undefined

    const request = this._formatRequest(messages, options)
    const config = request.config as GenerateContentConfig
    return resolveCachedContent(this._client.caches, {
      cacheConfig,
      modelId: request.model,
      ...(config.systemInstruction !== undefined && { systemInstruction: config.systemInstruction }),
      // _formatRequest only ever populates config.tools with plain Tool objects (function declarations
      // plus builtInTools), never CallableTool, so narrowing the vendor ToolListUnion is safe here.
      ...(config.tools !== undefined && { tools: config.tools as Tool[] }),
      ...(config.toolConfig !== undefined && { toolConfig: config.toolConfig }),
      forceCreate,
    })
  }

  /**
   * Gets API key from environment variables.
   */
  private static _getEnvApiKey(): string | undefined {
    return globalThis?.process?.env?.GEMINI_API_KEY
  }

  /**
   * Formats a request for the Google GenAI API.
   */
  private _formatRequest(
    messages: Message[],
    options?: StreamOptions,
    cachedContent?: string
  ): GenerateContentParameters {
    const contents = formatMessages(messages)
    const config: GenerateContentConfig = {}

    // Add system instruction
    if (options?.systemPrompt !== undefined) {
      if (typeof options.systemPrompt === 'string') {
        if (options.systemPrompt.trim().length > 0) {
          config.systemInstruction = options.systemPrompt
        }
      } else if (Array.isArray(options.systemPrompt) && options.systemPrompt.length > 0) {
        const textBlocks: string[] = []

        for (const block of options.systemPrompt) {
          if (block.type === 'textBlock') {
            textBlocks.push(block.text)
          }
        }

        if (textBlocks.length > 0) {
          config.systemInstruction = textBlocks.join('')
        }
      }
    }

    // Add tool specifications
    if (options?.toolSpecs && options.toolSpecs.length > 0) {
      config.tools = [
        {
          functionDeclarations: options.toolSpecs.map((spec) => ({
            name: spec.name,
            description: spec.description,
            parametersJsonSchema: spec.inputSchema,
          })),
        },
      ]

      if (options.toolChoice) {
        if ('auto' in options.toolChoice) {
          config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
        } else if ('any' in options.toolChoice) {
          config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }
        } else if ('tool' in options.toolChoice) {
          config.toolConfig = {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: [options.toolChoice.tool.name],
            },
          }
        }
      }
    }

    // Append built-in tools (e.g., GoogleSearch, CodeExecution)
    if (this._config.builtInTools && this._config.builtInTools.length > 0) {
      if (!config.tools) {
        config.tools = []
      }
      config.tools.push(...this._config.builtInTools)
    }

    // Spread params object for forward compatibility
    if (this._config.params) {
      Object.assign(config, this._config.params)
    }

    GoogleModel._applyCachedContent(config, cachedContent)

    return {
      model: this._config.modelId ?? MODEL_DEFAULTS.gemini.modelId,
      contents,
      config,
    }
  }

  /**
   * Points the request at a cached prefix and drops the inline system/tools it would duplicate.
   *
   * A cachedContent resource already holds the system instruction and tools; Gemini rejects a request
   * that sends both a cached prefix and an inline one. This covers a cachedContent the caller set in
   * params and one injected by managed caching alike.
   */
  private static _applyCachedContent(config: GenerateContentConfig, cachedContent?: string): void {
    const cached = cachedContent ?? config.cachedContent
    if (!cached) return
    config.cachedContent = cached
    delete config.systemInstruction
    delete config.tools
    delete config.toolConfig
  }
}
