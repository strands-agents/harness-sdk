/**
 * Type definitions for the Google model provider.
 */

import type { GoogleGenAI, GoogleGenAIOptions, Tool } from '@google/genai'
import type { BaseModelConfig, CacheConfig } from '../model.js'

/**
 * Configuration interface for Google model provider.
 *
 * @example
 * ```typescript
 * const config: GoogleModelConfig = {
 *   modelId: 'gemini-2.5-flash',
 *   params: { temperature: 0.7, maxOutputTokens: 1024 }
 * }
 * ```
 *
 * @see https://ai.google.dev/api/generate-content#generationconfig
 */
export interface GoogleModelConfig extends BaseModelConfig {
  /**
   * Gemini model identifier (e.g., gemini-2.5-flash, gemini-2.5-pro).
   *
   * @defaultValue 'gemini-2.5-flash'
   * @see https://ai.google.dev/gemini-api/docs/models
   */
  modelId?: string

  /**
   * Additional parameters to pass to the Gemini API (e.g., temperature, maxOutputTokens).
   *
   * @see https://ai.google.dev/api/generate-content#generationconfig
   */
  params?: Record<string, unknown>

  /**
   * Built-in tools (e.g., GoogleSearch, CodeExecution, UrlContext).
   * These are appended as separate Tool objects alongside any functionDeclarations.
   *
   * @see https://ai.google.dev/gemini-api/docs/function-calling
   */
  builtInTools?: Tool[]

  /**
   * Whether to use the native Gemini countTokens API.
   *
   * When `true`, `countTokens()` calls the Gemini token counting API for
   * accurate counts. When `false` or not set (default), skips the API call and uses
   * the character-based heuristic estimator.
   *
   * @defaultValue false
   */
  useNativeTokenCount?: boolean

  /**
   * Prompt-caching configuration. When set, Google manages a native `CachedContent` resource holding
   * the static prefix (system instruction + tools): `cacheKey` fixes its identity,
   * `systemPromptTTL`/`ttl` its lifetime; other fields have no effect. Managed caching engages only
   * when a honored field names a duration or key: a `ttl`, a `systemPromptTTL` duration string, or a
   * `cacheKey`. The default `systemPromptTTL: true` alone does not engage - pass a duration such as
   * `systemPromptTTL: '1h'` to cache the system prompt. A bare `{}` and an explicit `cachedContent` in
   * `params` both leave the request unchanged.
   */
  cacheConfig?: CacheConfig
}

/**
 * Options interface for creating a GoogleModel instance.
 */
export interface GoogleModelOptions extends GoogleModelConfig {
  /**
   * Gemini API key (falls back to GEMINI_API_KEY environment variable).
   */
  apiKey?: string

  /**
   * Pre-configured Google GenAI client instance.
   * If provided, this client will be used instead of creating a new one.
   */
  client?: GoogleGenAI

  /**
   * Additional Google GenAI client configuration.
   * Only used if client is not provided.
   */
  clientConfig?: Omit<GoogleGenAIOptions, 'apiKey'>
}

/**
 * Internal state for tracking streaming progress.
 */
export interface GoogleStreamState {
  messageStarted: boolean
  textContentBlockStarted: boolean
  reasoningContentBlockStarted: boolean
  hasToolCalls: boolean
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadInputTokens?: number
}
