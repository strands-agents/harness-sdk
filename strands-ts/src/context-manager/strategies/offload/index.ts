/**
 * Offload strategies — reduce content in the context window.
 *
 * @experimental
 */

import type { TruncateConfig } from '../../methods/truncate.js'
import type { SummarizeConfig } from '../../methods/summarize.js'
import type { OffloadStrategyBuilder, OffloadTarget } from './base.js'
import { DropStrategy } from './drop.js'
import { TruncateStrategy } from './truncate.js'
import { SummarizeStrategy } from './summarize.js'

export { EmergencyTruncateStrategy } from './base.js'
export { DROPPED_MARKER } from './drop.js'
export type { OffloadTarget, OffloadConditions, OffloadStrategyBuilder } from './base.js'

/**
 * Offload strategy builder namespace.
 *
 * - `Offload.drop(target)` — drop matching content from context window entirely
 * - `Offload.truncate(target, config)` — replace with a preview
 * - `Offload.summarize(target, config)` — replace with LLM-generated summary
 */
interface OffloadNamespace {
  /** Drop matching content from context window entirely. */
  drop(target: OffloadTarget): OffloadStrategyBuilder

  /** Replace oversized content with a preview. */
  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategyBuilder

  /** Replace oversized content with an LLM-generated summary. */
  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategyBuilder
}

/**
 * Builder for offload strategies — reduces content in the context window.
 *
 * @example
 * ```typescript
 * // Per-block: truncate each result over 2500 tokens, eagerly
 * Offload.truncate("toolResults", { previewTokens: 750 }).when({ threshold: 1500 })
 * // Per-block: truncate specific tools
 * Offload.truncate(["tool::bash", "tool::read_file"]).when({ threshold: 2000 })
 * // Message-level: summarize oldest messages on overflow
 * Offload.summarize("*").when({ utilization: 1, preserveRecent: 4 })
 * // Per-block: drop errors over 500 tokens
 * Offload.drop("toolResultErrors").when({ threshold: 500 })
 * ```
 */
export const Offload: OffloadNamespace = {
  drop(target: OffloadTarget): OffloadStrategyBuilder {
    return new DropStrategy(target)
  },

  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategyBuilder {
    return new TruncateStrategy(target, config)
  },

  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategyBuilder {
    return new SummarizeStrategy(target, config)
  },
}
