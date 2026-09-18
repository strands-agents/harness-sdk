/**
 * LiteLLM AI Gateway model provider implementation.
 *
 * @see https://docs.litellm.ai/docs/proxy/quick_start
 */

import OpenAI from 'openai'
import type { ApiKeySetter } from 'openai/client'
import type { ClientOptions } from 'openai'
import type { Stream } from 'openai/core/streaming'
import { Model, resolveConfigMetadata } from './model.js'
import type { StreamOptions } from './model.js'
import type { Message } from '../types/messages.js'
import type { ModelStreamEvent } from './streaming.js'
import type { OpenAIChatConfig } from './openai/types.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../errors.js'
import { classifyOpenAIError } from './openai/errors.js'
import { formatLiteLLMRequest } from './litellm/request.js'
import { mapNonStreamingResponse, mapStreamingResponse } from './litellm/response.js'

const DEFAULT_BASE_URL = 'http://localhost:4000'
const DEFAULT_API_KEY = 'sk-no-key-required'

/** Configuration fields passed to a model served by LiteLLM. */
export interface LiteLLMModelConfig extends OpenAIChatConfig {
  /** LiteLLM model identifier or configured model alias. */
  modelId?: string
  /** Whether the gateway response should use server-sent event streaming. Defaults to `true`. */
  stream?: boolean
}

/** Options for constructing a {@link LiteLLMModel}. */
export interface LiteLLMModelOptions extends LiteLLMModelConfig {
  /** LiteLLM model identifier or configured model alias. */
  modelId: string
  /** LiteLLM gateway URL. Defaults to the local gateway at `http://localhost:4000`. */
  baseURL?: string
  /** LiteLLM virtual key. Unauthenticated local gateways do not require one. */
  apiKey?: string | ApiKeySetter
  /** Pre-configured OpenAI-compatible client instance. */
  client?: OpenAI
  /** OpenAI client settings other than `apiKey` and `baseURL`. */
  clientConfig?: Omit<ClientOptions, 'apiKey' | 'baseURL'>
}

/**
 * Model provider for the OpenAI-compatible LiteLLM AI Gateway.
 *
 * LiteLLM's in-process SDK is Python-only. TypeScript applications connect to
 * the LiteLLM gateway through its Chat Completions-compatible API.
 *
 * @example
 * ```typescript
 * import { LiteLLMModel } from '@strands-agents/sdk/models/litellm'
 *
 * const model = new LiteLLMModel({
 *   modelId: 'anthropic/claude-sonnet-4-20250514',
 *   baseURL: 'http://localhost:4000',
 *   apiKey: process.env.LITELLM_API_KEY,
 * })
 * ```
 */
export class LiteLLMModel extends Model<LiteLLMModelConfig> {
  private _config: LiteLLMModelOptions
  private readonly _client: OpenAI

  constructor(options: LiteLLMModelOptions) {
    super()
    const { baseURL = DEFAULT_BASE_URL, apiKey = DEFAULT_API_KEY, client, clientConfig, ...modelConfig } = options
    this._config = modelConfig
    this._client =
      client ??
      new OpenAI({
        apiKey,
        ...clientConfig,
        baseURL,
      })
  }

  /** The OpenAI-compatible API mode used by LiteLLM gateways. */
  get api(): 'chat' {
    return 'chat'
  }

  updateConfig(modelConfig: LiteLLMModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): LiteLLMModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? '')
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (messages.length === 0) {
      throw new Error('At least one message is required')
    }

    try {
      const request = formatLiteLLMRequest(this._config, messages, options)
      const requestOptions = {
        body: request,
        ...(options?.cancelSignal !== undefined && { signal: options.cancelSignal }),
      }

      if (request.stream) {
        const response = await this._client.post<Stream<unknown>>('/chat/completions', {
          ...requestOptions,
          stream: true,
        })
        yield* mapStreamingResponse(response)
        return
      }

      const response = await this._client.post<unknown>('/chat/completions', requestOptions)
      yield* mapNonStreamingResponse(response)
    } catch (error) {
      throw this._wrapError(error)
    }
  }

  private _wrapError(error: unknown): ModelError {
    const providerError = error instanceof Error ? error : new Error(String(error))
    const errorKind = classifyOpenAIError(providerError)
    if (errorKind === 'contextOverflow') {
      return new ContextWindowOverflowError(providerError.message, { cause: providerError })
    }
    if (errorKind === 'throttling') {
      return new ModelThrottledError(providerError.message, { cause: providerError })
    }
    return new ModelError(providerError.message, { cause: providerError })
  }
}
