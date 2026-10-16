/**
 * Hide strategies — filter what the model sees on each call without touching durable state.
 *
 * Not exported from the package barrel while the API is experimental.
 *
 * @internal
 */

import type { HideStrategyBuilder, HideTarget } from './base.js'
import type { HideDropConfig } from './drop.js'
import { HideDropStrategy } from './drop.js'

export type { HideTarget, HideConditions, HideStrategyBuilder } from './base.js'
export type { HideDropConfig, HideFailurePolicy } from './drop.js'
export type { ToolSearchOptions, ToolSearchResult, ToolSearchStrategy } from './search/index.js'
export { KeywordToolSearchStrategy } from './search/index.js'

/**
 * Hide strategy builder namespace.
 *
 * - `Hide.drop(target, config)` — drop the specs that are not relevant to the current turn from the model call
 */
interface HideNamespace {
  /** Drop the specs that are not relevant to the current turn from the model call. */
  drop(target: HideTarget, config?: HideDropConfig): HideStrategyBuilder
}

/**
 * Builder for hide strategies — filters the per-call model input. Reads as
 * `[what].[how](which segment)`, the same grammar as `Offload`, with the difference that nothing
 * durable changes: the registry and the message history keep every tool.
 *
 * @example
 * ```typescript
 * // Alongside the message presets; a strategies list replaces the ContextManager defaults
 * new ContextManager({
 *   strategies: ['largeToolOffloading', 'overflowProtection', Hide.drop('toolSpecs').when({ count: 20 })],
 * })
 * // Keep the 10 most relevant specs once the catalog has 20 or more
 * Hide.drop('toolSpecs').when({ count: 20 })
 * // Same, keeping 5
 * Hide.drop('toolSpecs', { keep: 5 }).when({ count: 20 })
 * // Pin ask_user and finish: always visible, outside keep and count (count sees 18 of 20 tools here)
 * Hide.drop(['toolSpec::*', '!toolSpec::ask_user', '!toolSpec::finish'], { keep: 15 }).when({ count: 18 })
 * // With AgentSkills, pin its tool: the system prompt tells the model to call it
 * Hide.drop(['toolSpec::*', '!toolSpec::skills'])
 * // Only the billing tools are candidates; everything else stays visible
 * Hide.drop(['toolSpec::billing_search', 'toolSpec::billing_summary'], { keep: 1 })
 * // Never show debug_dump, and show only pinned tools if search fails
 * Hide.drop('toolSpecs', { alwaysHide: ['debug_dump'], onFailure: 'none' })
 * // Rank with a custom ToolSearchStrategy (an LLM judge, embeddings, ...)
 * Hide.drop('toolSpecs', { search: myToolSearch })
 * ```
 */
export const Hide: HideNamespace = {
  drop(target: HideTarget, config?: HideDropConfig): HideStrategyBuilder {
    return new HideDropStrategy(target, config)
  },
}
