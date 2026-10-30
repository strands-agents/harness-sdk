/**
 * Offload strategies — reduce content in the context window.
 *
 * @experimental
 */

import type { TruncateConfig } from '../../methods/truncate.js'
import type { SummarizeConfig } from '../../methods/summarize.js'
import type { OffloadStrategy } from './base.js'
import type { OffloadTarget } from './target.js'
import { DropStrategy } from './drop.js'
import { TruncateStrategy } from './truncate.js'
import { SummarizeStrategy } from './summarize.js'

export { EmergencyTruncateStrategy } from './base.js'
export type { OffloadStrategy } from './base.js'
export type { OffloadConditions } from './conditions.js'
export type { OffloadTarget } from './target.js'

/**
 * Offload strategy namespace. Each method returns a strategy; call `.when()` on it to set when and on what it acts.
 *
 * - `Offload.drop(target)` — drop matching content from context window entirely
 * - `Offload.truncate(target, config)` — replace with a preview
 * - `Offload.summarize(target, config)` — replace with LLM-generated summary
 */
interface OffloadNamespace {
  /** Drop matching content from context window entirely. Without `.when()` conditions, drops each block on arrival. */
  drop(target: OffloadTarget): OffloadStrategy

  /** Replace oversized content with a preview. Without `.when()` conditions, truncates each block on arrival. */
  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategy

  /** Replace content with an LLM-generated summary. Without `.when()` conditions, summarizes each block on arrival. */
  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategy
}

/**
 * Offload strategies — reduce content in the context window.
 *
 * Target `'*'` acts on whole messages; any other target acts on each block. `blockThreshold` measures whichever the
 * target acts on, and `contextUtilization` only gates when the strategy fires. Targets `'*'` and `'media'` need
 * conditions from `.when()`; any other target without them acts on each matching block as it arrives, before the model
 * reads it.
 *
 * @example
 * ```typescript
 * // Per-block, eager: truncate each tool result over 1500 tokens to a 750-token preview
 * Offload.truncate("toolResults", { previewTokens: 750 }).when({ blockThreshold: 1500 })
 * // Per-block, eager: truncate specific tools' results over 5% of the context window
 * Offload.truncate(["tool::bash", "tool::read_file"]).when({ blockThreshold: "5%" })
 * // Messages: summarize the oldest messages at 70% context utilization, keeping the newest 4
 * Offload.summarize("*").when({ contextUtilization: "70%", preserveRecent: 4 })
 * // Per-block, eager: with no conditions, drop each failed tool result as it arrives
 * Offload.drop("toolResultErrors")
 * // Per-block, gated: at 80% context utilization, drop tool results outside the newest 5 messages that hold one
 * Offload.drop("toolResults").when({ contextUtilization: "80%", preserveRecent: 5 })
 * // Per-block, gated: at 80% context utilization, drop media outside the newest message that holds any
 * Offload.drop("media").when({ contextUtilization: "80%", preserveRecent: 1 })
 * // Messages: once the window is full, drop the oldest messages, keeping the newest 70%
 * Offload.drop("*").when({ contextUtilization: "100%", preserveRecent: "70%" })
 * // Messages: at 90% context utilization, summarize messages over 2000 tokens, keeping the newest 4
 * Offload.summarize("*").when({ contextUtilization: "90%", blockThreshold: 2000, preserveRecent: 4 })
 * ```
 */
export const Offload: OffloadNamespace = {
  drop(target: OffloadTarget): OffloadStrategy {
    return new DropStrategy(target)
  },

  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategy {
    return new TruncateStrategy(target, config)
  },

  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategy {
    return new SummarizeStrategy(target, config)
  },
}
