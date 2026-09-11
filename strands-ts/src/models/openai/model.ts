/**
 * OpenAI model provider implementation.
 *
 * Supports both the Responses API (default) and the Chat Completions API.
 * Selected via the `api` option at construction time.
 *
 * @see https://platform.openai.com/docs/api-reference/responses
 * @see https://platform.openai.com/docs/api-reference/chat
 */

import OpenAI, { APIUserAbortError } from 'openai'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { Model, resolveConfigMetadata } from '../model.js'
import type { StreamOptions } from '../model.js'
import type { Message } from '../../types/messages.js'
import type { ModelStreamEvent, Usage } from '../streaming.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'
import { MODEL_DEFAULTS, defaultModelWarningMessage } from '../defaults.js'
import { bedrockMantleBaseUrl, createMantleApiKeySetter, resolveMantleRegion } from './mantle.js'
import { classifyOpenAIError } from './errors.js'
import { formatChatRequest, mapChatChunkToEvents, warnManagedParams as warnChatManagedParams } from './chat-adapter.js'
import {
  createResponsesStreamState,
  finalizeResponsesStream,
  formatResponsesRequest,
  mapResponsesEventToSDK,
  warnManagedParams as warnResponsesManagedParams,
} from './responses-adapter.js'
import type {
  ChatStreamState,
  OpenAIApi,
  OpenAIChatConfig,
  OpenAIModelConfig,
  OpenAIModelOptions,
  OpenAIResponsesConfig,
} from './types.js'

/**
 * OpenAI model provider.
 *
 * Defaults to the Responses API. Pass `api: 'chat'` to use Chat Completions.
 * The `api` field is construction-only — it cannot be changed via
 * {@link OpenAIModel.updateConfig}.
 *
 * @example
 * ```typescript
 * // Responses API (default)
 * const model = new OpenAIModel({ modelId: 'gpt-5.4', apiKey: 'sk-...' })
 * ```
 *
 * @example
 * ```typescript
 * // Chat Completions
 * const model = new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-...' })
 * ```
 *
 * @example
 * ```typescript
 * // Responses API with built-in web search
 * const model = new OpenAIModel({
 *   modelId: 'gpt-5.4',
 *   params: { tools: [{ type: 'web_search' }] },
 * })
 * ```
 */
export class OpenAIModel extends Model<OpenAIModelConfig> {
  private readonly _api: OpenAIApi
  private _config: OpenAIModelConfig
  private _client: OpenAI

  constructor(options: OpenAIModelOptions) {
    super()
    const { apiKey, client, clientConfig, bedrockMantleConfig, api = 'responses', ...modelConfig } = options

    if (api !== 'chat' && api !== 'responses') {
      throw new Error(`Unsupported OpenAI API: '${api}'. Supported values: 'chat', 'responses'`)
    }

    this._api = api
    // `stateful` only exists on the responses branch of the discriminated union.
    // Storing as the merged OpenAIModelConfig matches what `getConfig` returns.
    this._config = modelConfig

    if (modelConfig.modelId === undefined) {
      warnOnce(logger, defaultModelWarningMessage(MODEL_DEFAULTS.openai.modelId))
    }

    if (api === 'responses') {
      warnResponsesManagedParams(modelConfig.params)
    } else {
      warnChatManagedParams(modelConfig.params)
    }

    if (bedrockMantleConfig && client) {
      throw new Error("'bedrockMantleConfig' cannot be combined with a pre-built 'client'.")
    }

    if (client) {
      this._client = client
    } else if (bedrockMantleConfig) {
      const modelId = modelConfig.modelId ?? MODEL_DEFAULTS.openai.modelId
      this._client = buildMantleClient(bedrockMantleConfig, apiKey, clientConfig, modelId)
    } else {
      const hasEnvKey =
        typeof process !== 'undefined' && typeof process.env !== 'undefined' && process.env.OPENAI_API_KEY
      if (!apiKey && !hasEnvKey) {
        throw new Error(
          "OpenAI API key is required. Provide it via the 'apiKey' option (string or function) or set the OPENAI_API_KEY environment variable."
        )
      }
      this._client = new OpenAI({
        ...(apiKey ? { apiKey } : {}),
        ...clientConfig,
      })
    }
  }

  /**
   * The OpenAI API mode this model operates in (`'chat'` or `'responses'`).
   * Set at construction and immutable; exposed for debugging and serialization.
   */
  get api(): OpenAIApi {
    return this._api
  }

  /**
   * Whether this model manages conversation state server-side.
   *
   * `true` only for `api: 'responses'` with `stateful === true`. Chat Completions
   * is always stateless, and Responses defaults to stateless.
   */
  override get stateful(): boolean {
    return this._api === 'responses' && this._config.stateful === true
  }

  /**
   * Updates the model configuration.
   *
   * `api` and `stateful` are construction-only — if present in `modelConfig`,
   * they are stripped with a warning. Changing either at runtime would
   * invalidate the invariants the agent builds on top of `stateful` (message
   * history management, `previous_response_id` chaining).
   */
  updateConfig(modelConfig: OpenAIModelConfig & { api?: OpenAIApi }): void {
    const { api, stateful, ...rest } = modelConfig
    if (api !== undefined) {
      logger.warn(`api=<${api}> | 'api' is construction-only and cannot be changed via updateConfig — ignoring`)
    }
    if (stateful !== undefined) {
      logger.warn(
        `stateful=<${stateful}> | 'stateful' is construction-only and cannot be changed via updateConfig — ignoring`
      )
    }

    if (this._api === 'responses') {
      warnResponsesManagedParams(rest.params)
    } else {
      warnChatManagedParams(rest.params)
    }

    this._config = { ...this._config, ...rest }
  }

  getConfig(): OpenAIModelConfig {
    return resolveConfigMetadata(this._config, this._config.modelId ?? MODEL_DEFAULTS.openai.modelId)
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!messages || messages.length === 0) {
      throw new Error('At least one message is required')
    }

    if (this._api === 'chat') {
      yield* this._streamChat(messages, options)
    } else {
      yield* this._streamResponses(messages, options)
    }
  }

  private async *_streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    try {
      const request = formatChatRequest(this._config as OpenAIChatConfig, messages, options)
      const stream = await this._client.chat.completions.create(request, { signal: options?.cancelSignal })

      const streamState: ChatStreamState = {
        messageStarted: false,
        textContentBlockStarted: false,
      }
      const activeToolCalls = new Map<number, boolean>()

      let bufferedUsage: {
        type: 'modelMetadataEvent'
        usage: Usage
      } | null = null

      for await (const chunk of stream) {
        if (!chunk.choices || chunk.choices.length === 0) {
          if (chunk.usage) {
            bufferedUsage = {
              type: 'modelMetadataEvent',
              usage: {
                inputTokens: chunk.usage.prompt_tokens ?? 0,
                outputTokens: chunk.usage.completion_tokens ?? 0,
                totalTokens: chunk.usage.total_tokens ?? 0,
              },
            }
            // Match the Responses path's present-and-positive guard so the two OpenAI paths agree.
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens
            if (typeof cached === 'number' && cached > 0) {
              bufferedUsage.usage.cacheReadInputTokens = cached
            }
          }
          continue
        }

        const events = mapChatChunkToEvents(chunk, streamState, activeToolCalls)
        for (const event of events) {
          if (event.type === 'modelMessageStopEvent' && bufferedUsage) {
            yield bufferedUsage
            bufferedUsage = null
          }
          yield event
        }
      }

      if (options?.cancelSignal?.aborted) {
        throw new APIUserAbortError()
      }

      if (bufferedUsage) {
        yield bufferedUsage
      }
    } catch (error) {
      throw this._rewrapError(error)
    }
  }

  private async *_streamResponses(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    try {
      const request = formatResponsesRequest(this._config as OpenAIResponsesConfig, messages, options, this.stateful)
      const stream = await this._client.responses.create(request, { signal: options?.cancelSignal })

      const state = createResponsesStreamState()

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        for (const sdkEvent of mapResponsesEventToSDK(event, state, this.stateful, options?.modelState)) {
          yield sdkEvent
        }
      }

      if (options?.cancelSignal?.aborted) {
        throw new APIUserAbortError()
      }

      for (const sdkEvent of finalizeResponsesStream(state)) {
        yield sdkEvent
      }
    } catch (error) {
      throw this._rewrapError(error)
    }
  }

  private _rewrapError(error: unknown): unknown {
    const err = error as Error & { status?: number; code?: string }
    const kind = classifyOpenAIError(err)

    if (kind === 'throttling') {
      const message = err.message ?? 'Request was throttled by the model provider'
      logger.debug(`throttled | error_message=<${message}>`)
      return new ModelThrottledError(message, { cause: err })
    }

    if (kind === 'contextOverflow') {
      return new ContextWindowOverflowError(err.message)
    }

    return error
  }
}

function buildMantleClient(
  bedrockMantleConfig: NonNullable<OpenAIModelOptions['bedrockMantleConfig']>,
  apiKey: OpenAIModelOptions['apiKey'],
  clientConfig: OpenAIModelOptions['clientConfig'],
  modelId: string
): OpenAI {
  if (apiKey !== undefined) {
    throw new Error(
      "'apiKey' cannot be combined with 'bedrockMantleConfig'; the API key is derived from the Mantle config automatically."
    )
  }

  const conflicting: string[] = []
  if (clientConfig?.apiKey !== undefined) conflicting.push('apiKey')
  if (clientConfig?.baseURL !== undefined) conflicting.push('baseURL')
  if (conflicting.length > 0) {
    throw new Error(
      `clientConfig must not contain ${conflicting.join(', ')} when bedrockMantleConfig is set; ` +
        'these are derived from the Mantle config automatically.'
    )
  }

  // Resolve the region eagerly so missing-region configuration fails fast.
  const region = resolveMantleRegion(bedrockMantleConfig)

  return new OpenAI({
    ...clientConfig,
    baseURL: bedrockMantleBaseUrl(region, modelId),
    apiKey: createMantleApiKeySetter(bedrockMantleConfig, region),
  })
}
