/**
 * Default values for model providers.
 *
 * These defaults are subject to change between versions. Set values explicitly
 * on model configurations to pin behavior across upgrades.
 */

export const MODEL_DEFAULTS = {
  anthropic: {
    modelId: 'claude-sonnet-4-6',
    maxTokens: 64_000,
  },
  bedrock: {
    modelId: 'global.anthropic.claude-sonnet-4-6',
    region: 'us-west-2',
  },
  openai: {
    modelId: 'gpt-5.4',
  },
  gemini: {
    modelId: 'gemini-2.5-flash',
  },
} as const

/**
 * Builds a warning message for when the default model ID is used.
 *
 * @param defaultModelId - The default model ID being used
 * @returns Formatted warning message string
 */
export function defaultModelWarningMessage(defaultModelId: string): string {
  return `model_id=<${defaultModelId}> | using default modelId, which is subject to change | set modelId explicitly to pin the value`
}

/**
 * Builds a warning message for when the default max tokens value is used.
 *
 * @param defaultMaxTokens - The default max tokens value being used
 * @returns Formatted warning message string
 */
export function defaultMaxTokensWarningMessage(defaultMaxTokens: number): string {
  return `max_tokens=<${defaultMaxTokens}> | using default maxTokens, which is subject to change | set maxTokens explicitly to pin the value`
}

export { DEFAULT_CONTEXT_WINDOW_LIMIT, getContextWindowLimit } from './model-info.js'
