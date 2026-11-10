/**
 * OpenAI model provider.
 *
 * Defaults to the Responses API. Pass `api: 'chat'` to use Chat Completions.
 *
 * @example
 * ```typescript
 * import { OpenAIModel } from '@strands-agents/sdk/models/openai'
 *
 * // Responses API (default)
 * const model = new OpenAIModel({ modelId: 'gpt-5.4', apiKey: 'sk-...' })
 *
 * // Chat Completions
 * const model = new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-...' })
 * ```
 */

export { OpenAIModel } from './model.js'
export type {
  OpenAIApi,
  OpenAIChatConfig,
  OpenAIModelConfig,
  OpenAIModelOptions,
  OpenAIResponsesConfig,
} from './types.js'
export type { BedrockMantleConfig } from './mantle.js'
