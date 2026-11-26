import type { ModelKey } from '../agent/invocation-context.js'
import type { Model } from './model.js'

/**
 * Hostnames of the Bedrock runtime and Bedrock Mantle endpoints; test a parsed hostname, not a URL.
 *
 * @internal
 */
export const BEDROCK_HOSTS =
  /^(?:bedrock-mantle\.[a-z0-9-]+\.api\.aws|bedrock-runtime(-fips)?\.[a-z0-9-]+\.amazonaws\.com)$/

/**
 * Names the provider and model a model instance calls, for per-model usage records. It never throws,
 * since it runs in the model call path on models whose config can be anything.
 *
 * @param model - The model that makes the call
 * @returns The provider name and model id the model's usage is recorded under; `undefined` for what is not known
 * @internal
 */
export function modelKey(model: Model): ModelKey {
  const providerName = stringOrUndefined(() => model._providerName)
  const modelId = stringOrUndefined(() => model.modelId)
  return { ...(providerName !== undefined && { providerName }), ...(modelId !== undefined && { modelId }) }
}

function stringOrUndefined(read: () => unknown): string | undefined {
  try {
    const value = read()
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}
