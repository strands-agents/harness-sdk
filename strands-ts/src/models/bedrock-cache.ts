/**
 * Prompt-caching facts about Bedrock Converse models, shared by `BedrockModel` and `VercelModel`'s amazon-bedrock
 * route.
 *
 * @internal
 */

import type { ModelInfo } from './model-info.js'

/**
 * The Nova models Converse caches at cache points (measured on Converse). Nova Premier is end-of-life and Nova 2 Pro
 * is not in the Bedrock prompt-caching docs, so neither is listed. Kept here rather than in the shared model info
 * until the Python SDK places Nova cache points too.
 */
const NOVA_CACHE_POINT_MODELS = [
  'amazon.nova-pro-v1',
  'amazon.nova-lite-v1',
  'amazon.nova-micro-v1',
  'amazon.nova-2-lite-v1',
]

const IMPLICIT_CACHE: ModelInfo = Object.freeze({ capabilities: { promptCaching: 'auto' as const } })
const CACHE_POINTS: ModelInfo = Object.freeze({ capabilities: { promptCaching: 'cachePoints' as const } })

/**
 * Whether Converse limits where this model takes cache points. Nova takes a cache point only directly after text: it
 * rejects one after the tool definitions or directly after an image, PDF, video, `toolResult` or `toolUse` block, and
 * rejects any `ttl` (each a ValidationException, measured on Converse).
 *
 * @internal
 * @param modelId - A Bedrock model id, inference profile id, or ARN
 * @returns True for a Nova model that takes cache points
 */
export function bedrockLimitsCachePoints(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return NOVA_CACHE_POINT_MODELS.some((nova) => id.includes(nova))
}

/**
 * How Converse caches this model, where it differs from the shared model info. The shared info lists cache points
 * for the OpenAI models' own APIs, but Converse caches OpenAI GPT (not gpt-oss, which it does not cache) and xAI
 * implicitly, so they need no cache points. The shared info lists no caching for Nova, which takes cache points.
 *
 * @internal
 * @param modelId - A Bedrock model id, inference profile id, or ARN
 * @returns The `promptCaching` override, or undefined when the shared model info applies
 */
export function bedrockCacheModelInfo(modelId: string): ModelInfo | undefined {
  const id = modelId.toLowerCase()
  if ((id.includes('openai.') && !id.includes('gpt-oss')) || id.includes('xai.')) return IMPLICIT_CACHE
  return bedrockLimitsCachePoints(id) ? CACHE_POINTS : undefined
}
