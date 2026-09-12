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

/** Default context window limit (in tokens) when the model does not report one. */
export const DEFAULT_CONTEXT_WINDOW_LIMIT = 200_000

/**
 * Context window limits (in tokens) for known model IDs.
 *
 * Best-effort lookup table — unknown models return `undefined` and callers
 * fall back gracefully (e.g. proactive compression is disabled).
 * Entries can be pruned when a model is no longer available from the provider.
 * Users can always override with an explicit `contextWindowLimit` in their model config.
 *
 * Values sourced from provider documentation and
 * https://github.com/BerriAI/litellm/blob/litellm_internal_staging/model_prices_and_context_window.json
 *
 * For Bedrock models with cross-region prefixes (e.g. `us.`, `eu.`, `global.`),
 * {@link getContextWindowLimit} strips the prefix before lookup so only the base model ID is needed here.
 */
const CONTEXT_WINDOW_LIMITS: Record<string, number> = {
  // Anthropic (direct API)
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-4-20250514': 1_000_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-6-20260205': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-7-20260416': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-5-20251101': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-opus-4-1': 200_000,
  'claude-opus-4-1-20250805': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-3-7-sonnet-20250219': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-sonnet-20240620': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  'claude-3-opus-20240229': 200_000,
  'claude-3-haiku-20240307': 200_000,

  // Bedrock Anthropic (base model IDs — cross-region prefixes stripped by getContextWindowLimit)
  'anthropic.claude-sonnet-4-6': 1_000_000,
  'anthropic.claude-sonnet-4-20250514-v1:0': 1_000_000,
  'anthropic.claude-sonnet-4-5-20250929-v1:0': 200_000,
  'anthropic.claude-opus-4-6-v1': 1_000_000,
  'anthropic.claude-opus-4-7': 1_000_000,
  'anthropic.claude-opus-4-8': 1_000_000,
  'anthropic.claude-opus-5': 1_000_000,
  'anthropic.claude-fable-5': 1_000_000,
  'anthropic.claude-sonnet-5': 1_000_000,
  'anthropic.claude-opus-4-5-20251101-v1:0': 200_000,
  'anthropic.claude-opus-4-20250514-v1:0': 200_000,
  'anthropic.claude-opus-4-1-20250805-v1:0': 200_000,
  'anthropic.claude-haiku-4-5-20251001-v1:0': 200_000,
  'anthropic.claude-haiku-4-5@20251001': 200_000,
  'anthropic.claude-3-7-sonnet-20250219-v1:0': 200_000,
  'anthropic.claude-3-7-sonnet-20240620-v1:0': 200_000,
  'anthropic.claude-3-5-sonnet-20241022-v2:0': 200_000,
  'anthropic.claude-3-5-sonnet-20240620-v1:0': 200_000,
  'anthropic.claude-3-5-haiku-20241022-v1:0': 200_000,
  'anthropic.claude-3-opus-20240229-v1:0': 200_000,
  'anthropic.claude-3-haiku-20240307-v1:0': 200_000,
  'anthropic.claude-3-sonnet-20240229-v1:0': 200_000,
  'anthropic.claude-mythos-preview': 1_000_000,

  // Bedrock Amazon Nova
  'amazon.nova-pro-v1:0': 300_000,
  'amazon.nova-lite-v1:0': 300_000,
  'amazon.nova-micro-v1:0': 128_000,
  'amazon.nova-premier-v1:0': 1_000_000,
  'amazon.nova-2-lite-v1:0': 1_000_000,
  'amazon.nova-2-pro-preview-20251202-v1:0': 1_000_000,

  // OpenAI
  'gpt-6-astra': 1_050_000,
  'gpt-5.6': 1_050_000,
  'gpt-5.6-sol': 1_050_000,
  'gpt-5.6-terra': 1_050_000,
  'gpt-5.6-luna': 1_050_000,
  'gpt-5.5': 1_050_000,
  'gpt-5.5-pro': 1_050_000,
  'gpt-5.4': 1_050_000,
  'gpt-5.4-pro': 1_050_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5.4-nano': 272_000,
  'gpt-5.2': 272_000,
  'gpt-5.2-pro': 272_000,
  'gpt-5.1': 272_000,
  'gpt-5': 272_000,
  'gpt-5-mini': 272_000,
  'gpt-5-nano': 272_000,
  'gpt-5-pro': 128_000,
  'gpt-4.1': 1_047_576,
  'gpt-4.1-mini': 1_047_576,
  'gpt-4.1-nano': 1_047_576,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  o3: 200_000,
  'o3-mini': 200_000,
  'o3-pro': 200_000,
  'o4-mini': 200_000,
  o1: 200_000,

  // Google Gemini
  'gemini-2.5-flash': 1_048_576,
  'gemini-2.5-flash-lite': 1_048_576,
  'gemini-2.5-pro': 1_048_576,
  'gemini-2.0-flash': 1_048_576,
  'gemini-2.0-flash-lite': 1_048_576,
  'gemini-3-pro-preview': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  'gemini-3.6-flash': 1_048_576,
  'gemini-3.5-flash': 1_048_576,
  'gemini-3.5-flash-lite': 1_048_576,
  'gemini-3.1-flash-lite': 1_048_576,
  'gemini-3.1-pro-preview': 1_048_576,
  'gemini-3.1-flash-lite-preview': 1_048_576,
}

/**
 * Known Bedrock cross-region routing prefixes.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html
 */
const BEDROCK_REGION_PREFIXES = new Set(['us', 'eu', 'ap', 'global', 'apac', 'au', 'jp', 'us-gov'])

/**
 * Looks up the context window limit for a model ID.
 *
 * For Bedrock cross-region model IDs (e.g. `us.anthropic.claude-sonnet-4-6`),
 * the region prefix is stripped before lookup.
 *
 * @param modelId - The model ID to look up
 * @returns The context window limit in tokens, or undefined if not found
 */
export function getContextWindowLimit(modelId: string): number | undefined {
  const direct = CONTEXT_WINDOW_LIMITS[modelId]
  if (direct !== undefined) return direct

  // Strip known Bedrock cross-region prefixes
  const dotIndex = modelId.indexOf('.')
  if (dotIndex !== -1) {
    const prefix = modelId.substring(0, dotIndex)
    if (BEDROCK_REGION_PREFIXES.has(prefix)) {
      return CONTEXT_WINDOW_LIMITS[modelId.substring(dotIndex + 1)]
    }
  }

  return undefined
}
