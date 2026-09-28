/**
 * Type definitions for the OpenAI model provider.
 */

import type OpenAI from 'openai'
import type { ApiKeySetter } from 'openai/client'
import type { ClientOptions } from 'openai'
import type { BaseModelConfig, CacheConfig } from '../model.js'
import type { BedrockMantleConfig } from './mantle.js'

/**
 * Supported OpenAI API modes.
 * - `'chat'`: Chat Completions API (stateless)
 * - `'responses'`: Responses API (optional server-managed conversation state via `stateful: true`)
 *
 * @see https://platform.openai.com/docs/api-reference/chat
 * @see https://platform.openai.com/docs/api-reference/responses
 */
export type OpenAIApi = 'chat' | 'responses'

/**
 * Fields shared by both Chat Completions and Responses API configurations.
 */
interface OpenAIBaseConfig extends BaseModelConfig {
  /**
   * OpenAI model identifier (e.g., `gpt-5.4`, `gpt-5.4-mini`, `gpt-4o`).
   * Defaults depend on the selected `api`.
   */
  modelId?: string

  /**
   * Controls randomness in generation.
   */
  temperature?: number

  /**
   * Maximum number of tokens to generate in the response.
   */
  maxTokens?: number

  /**
   * Controls diversity via nucleus sampling.
   */
  topP?: number

  /**
   * Additional parameters passed through to the OpenAI API for forward compatibility.
   *
   * Provider-managed fields cannot be overridden via `params` — use the dedicated
   * config properties instead. A warning is logged at config time if any are present:
   * - Chat Completions: `model`, `messages`, `stream`, `stream_options`
   * - Responses API: `model`, `input`, `stream`, `store`
   */
  params?: Record<string, unknown>

  /**
   * Prompt-caching configuration. OpenAI routes cache reads on `cacheKey` and honors `ttl` when it names an OpenAI retention literal. Any other `ttl` and the placement fields have no effect here. An explicit `prompt_cache_key` / `prompt_cache_retention` in `params` takes precedence.
   */
  cacheConfig?: CacheConfig
}

/**
 * Configuration fields specific to the Chat Completions API.
 */
export interface OpenAIChatConfig extends OpenAIBaseConfig {
  /**
   * Reduces repetition of token sequences (-2.0 to 2.0).
   * Chat Completions only.
   */
  frequencyPenalty?: number

  /**
   * Encourages the model to talk about new topics (-2.0 to 2.0).
   * Chat Completions only.
   */
  presencePenalty?: number
}

/**
 * Configuration fields specific to the Responses API.
 */
export interface OpenAIResponsesConfig extends OpenAIBaseConfig {
  /**
   * When `true`, the server manages conversation state: the request sets
   * `store: true` and chains turns via `previous_response_id`, the Agent
   * clears its local message history after each invocation, and a
   * `conversationManager` cannot be supplied. Defaults to `false` — the
   * Responses API is used in stateless mode, where the full message history
   * is sent on every turn.
   */
  stateful?: boolean
}

/**
 * Runtime configuration shape returned by {@link OpenAIModel.getConfig}.
 *
 * Shared fields are required-shaped (still optional as per `BaseModelConfig`), and
 * api-specific fields are optional because this is a merged view — callers cannot
 * narrow on `api` from the returned config.
 */
export interface OpenAIModelConfig extends OpenAIBaseConfig {
  frequencyPenalty?: number
  presencePenalty?: number
  stateful?: boolean
}

interface OpenAIClientOptions {
  /**
   * OpenAI API key (falls back to `OPENAI_API_KEY` environment variable).
   *
   * Accepts either a static string or an async function that resolves to a string.
   * When a function is provided, it is invoked before each request.
   */
  apiKey?: string | ApiKeySetter

  /**
   * Pre-configured OpenAI client instance. If provided, this client will be used
   * instead of creating a new one.
   */
  client?: OpenAI

  /**
   * Additional OpenAI client configuration. Only used if `client` is not provided.
   */
  clientConfig?: ClientOptions

  /**
   * Route requests through Amazon Bedrock's OpenAI-compatible "Mantle"
   * endpoint. When set, the OpenAI client's `baseURL` and `apiKey` are derived
   * from this config; the top-level `apiKey`, `clientConfig.apiKey`, and
   * `clientConfig.baseURL` options must not be passed alongside it. Cannot be
   * combined with a pre-built `client`. Requires the optional peer dependency
   * `@aws/bedrock-token-generator`.
   * @see https://docs.aws.amazon.com/bedrock/latest/userguide/inference-openai.html
   */
  bedrockMantleConfig?: BedrockMantleConfig
}

/**
 * Options for constructing an {@link OpenAIModel}.
 *
 * Discriminated on `api` so that selecting `'chat'` type-narrows to expose
 * `frequencyPenalty` / `presencePenalty`, and selecting `'responses'` (or
 * omitting `api`) narrows to expose `stateful`.
 *
 * `api` is construction-only: it cannot be changed via {@link OpenAIModel.updateConfig}.
 */
export type OpenAIModelOptions =
  | ({ api?: 'responses' } & OpenAIResponsesConfig & OpenAIClientOptions)
  | ({ api: 'chat' } & OpenAIChatConfig & OpenAIClientOptions)

/**
 * Internal stream state for the Chat Completions adapter.
 *
 * @internal
 */
export interface ChatStreamState {
  messageStarted: boolean
  textContentBlockStarted: boolean
}
