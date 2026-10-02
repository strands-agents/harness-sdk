/**
 * Hide strategies — filter what the model sees on each call without touching durable state.
 *
 * Not exported from the package barrel while the API is experimental.
 *
 * @internal
 */

import type { HideStrategyBuilder } from './base.js'
import type { HideToolSpecsConfig, HideToolSpecsTarget } from './tool-specs.js'
import { HideToolSpecsStrategy } from './tool-specs.js'

export type { HideConditions, HideStrategyBuilder } from './base.js'
export type { HideFailurePolicy, HideToolSpecsConfig, HideToolSpecsTarget } from './tool-specs.js'
export { HideToolSpecsStrategy } from './tool-specs.js'
export type { ToolSearchResult, ToolSearchStrategy } from './tool-search.js'
export { KeywordToolSearch } from './tool-search.js'

/**
 * Hide strategy builder namespace.
 *
 * - `Hide.toolSpecs(target, config)` — show the model only the tool specs relevant to the current turn
 */
interface HideNamespace {
  /** Show the model only the tool specs relevant to the current turn. */
  toolSpecs(target?: HideToolSpecsTarget, config?: HideToolSpecsConfig): HideStrategyBuilder
}

/**
 * Builder for hide strategies — filters the per-call model input.
 *
 * @example
 * ```typescript
 * // Keep the 10 most relevant specs once the catalog has 20 or more
 * Hide.toolSpecs().when({ count: 20 })
 * // Pin ask_user and finish: always visible, never counted against keep
 * Hide.toolSpecs(['toolSpec::*', '!toolSpec::ask_user', '!toolSpec::finish'], { keep: 15 }).when({ count: 20 })
 * // Only the billing tools are candidates; everything else stays visible
 * Hide.toolSpecs(['toolSpec::billing_search', 'toolSpec::billing_summary'], { keep: 1 })
 * // Never show debug_dump, and show only pinned tools if search fails
 * Hide.toolSpecs('toolSpecs', { alwaysHide: ['debug_dump'], onFailure: 'none' })
 * // Rank with a custom ToolSearchStrategy (an LLM judge, embeddings, ...)
 * Hide.toolSpecs('toolSpecs', { search: myToolSearch })
 * ```
 */
export const Hide: HideNamespace = {
  toolSpecs(target: HideToolSpecsTarget = 'toolSpecs', config?: HideToolSpecsConfig): HideStrategyBuilder {
    return new HideToolSpecsStrategy(target, config)
  },
}
