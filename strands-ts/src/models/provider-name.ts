import type { ModelKey } from '../agent/invocation-context.js'
import type { Model } from './model.js'

/**
 * Names the provider and model a model instance calls, for per-model usage records. It never throws,
 * since it runs in the model call path on models whose config can be anything.
 *
 * @param model - The model that makes the call
 * @returns The provider name and model id the model's usage is recorded under; `null` for what is not known
 * @internal
 */
export function modelKey(model: Model): ModelKey {
  return { providerName: stringOrNull(() => model._providerName), modelId: stringOrNull(() => model.modelId) }
}

function stringOrNull(read: () => unknown): string | null {
  try {
    const value = read()
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}
