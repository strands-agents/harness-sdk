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
} from '@google/genai'
import { Model, resolveConfigMetadata } from '../model.js'
import type { CountTokensOptions, StreamOptions } from '../model.js'
import type { Message } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'
import { ContextWindowOverflowError, ModelThrottledError, ProviderTokenCountError } from '../../errors.js'
import type { GoogleModelConfig, GoogleModelOptions, GoogleStreamState } from './types.js'
export type { GoogleModelConfig, GoogleModelOptions }
import { classifyGoogleError } from './errors.js'
import { formatMessages, mapChunkToEvents } from './adapters.js'
import { MODEL_DEFAULTS, defaultModelWarningMessage } from '../defaults.js'
import { warnOnce } from '../../logging/warn-once.js'
import { logger } from '../../logging/logger.js'

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

    try {
      const params = this._formatRequest(messages, options)
      const stream = await this._client.models.generateContentStream(params)

      const streamState: GoogleStreamState = {
        messageStarted: false,
        textContentBlockStarted: false,
        reasoningContentBlockStarted: false,
        hasToolCalls: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }

      for await (const chunk of stream) {
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
   * Gets API key from environment variables.
   */
  private static _getEnvApiKey(): string | undefined {
    return globalThis?.process?.env?.GEMINI_API_KEY
  }

  /**
   * Formats a request for the Google GenAI API.
   */
  private _formatRequest(messages: Message[], options?: StreamOptions): GenerateContentParameters {
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

    return {
      model: this._config.modelId ?? MODEL_DEFAULTS.gemini.modelId,
      contents,
      config,
    }
  }
}
