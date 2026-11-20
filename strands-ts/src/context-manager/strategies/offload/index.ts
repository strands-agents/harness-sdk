/**
 * Offload strategies — reduce content in the context window.
 */

import type { TruncateConfig } from '../../methods/truncate.js'
import type { SummarizeConfig } from './summarize.js'
import type { OffloadStrategy } from './base.js'
import type { OffloadTarget } from './target.js'
import { DropStrategy } from './drop.js'
import { TruncateStrategy } from './truncate.js'
import { SummarizeStrategy } from './summarize.js'
import { DeferredToolLoadingStrategy, type DeferStrategy, type DeferTarget } from '../deferred-tool-loading.js'

export { EmergencyTruncateStrategy } from './base.js'
export type { OffloadStrategy } from './base.js'
export type { OffloadConditions } from './conditions.js'
export type { OffloadTarget } from './target.js'
export type { DeferConditions, DeferStrategy, DeferTarget } from '../deferred-tool-loading.js'

/**
 * Offload strategy namespace. Each method returns a strategy; call `.when()` on it to set when and on what it acts.
 *
 * - `Offload.drop(target)` — drop matching content from context window entirely
 * - `Offload.truncate(target, config)` — replace with a preview
 * - `Offload.summarize(target, config)` — replace with LLM-generated summary
 * - `Offload.defer(target)` — (Experimental) keep tools' input schemas out of the context until the model loads them
 */
interface OffloadNamespace {
  /** Drop matching content from context window entirely. Without `.when()` conditions, drops each block on arrival. */
  drop(target: OffloadTarget): OffloadStrategy

  /** Replace oversized content with a preview. Without `.when()` conditions, truncates each block on arrival. */
  truncate(target: OffloadTarget, config?: TruncateConfig): OffloadStrategy

  /** Replace content with an LLM-generated summary. Without `.when()` conditions, summarizes each block on arrival. */
  summarize(target: OffloadTarget, config?: SummarizeConfig): OffloadStrategy
  /**
   * Keep tools' input schemas out of the context until the model loads them with `load_tools`. The model still
   * sees each deferred tool's name and description. Without `.when()` conditions, defers at any tool count. One per
   * agent, the `deferredToolLoading` preset included.
   *
   * @experimental
   */
  defer(target: DeferTarget): DeferStrategy
}

/**
 * Offload strategies — reduce content in the context window.
 *
 * Target `'*'` acts on whole messages; any other target acts on each block. `blockThreshold` measures whichever the
 * target acts on, and `contextUtilization` only gates when the strategy fires. Targets `'*'` and `'media'` need
 * conditions from `.when()`; any other target without them acts on each matching block as it arrives, before the model
 * reads it.
 *
 * `Offload.defer` acts on tool specs instead, and either of its conditions is enough; the other strategies apply all of
 * their conditions together.
 *
 * @example
 * ```typescript
 * // Per-block, eager: truncate each tool result over 1500 tokens to a 750-token preview
 * Offload.truncate("toolResults", { previewTokens: 750 }).when({ blockThreshold: 1500 })
 * // Per-block, eager: truncate specific tools' results over 5% of the context window
 * Offload.truncate(["tool::bash", "tool::read_file"]).when({ blockThreshold: "5%" })
 * // Messages: summarize the oldest messages at 70% context utilization, keeping the newest 4
 * Offload.summarize("*").when({ contextUtilization: "70%", preserveRecent: 4 })
 * // Per-block, eager: with no conditions, drop each failed tool result as it arrives. Warns on init, since a
 * // strategy without conditions acts on content the model has not read yet
 * Offload.drop("toolResultErrors")
 * // Per-block, gated: at 80% context utilization, drop tool results outside the newest 5 messages that hold one
 * Offload.drop("toolResults").when({ contextUtilization: "80%", preserveRecent: 5 })
 * // Per-block, gated: at 80% context utilization, drop media outside the newest message that holds any
 * Offload.drop("media").when({ contextUtilization: "80%", preserveRecent: 1 })
 * // Messages: once the window is full, drop the oldest messages, keeping the newest 70%
 * Offload.drop("*").when({ contextUtilization: "100%", preserveRecent: "70%" })
 * // Messages: at 90% context utilization, summarize messages over 2000 tokens, keeping the newest 4
 * Offload.summarize("*").when({ contextUtilization: "90%", blockThreshold: 2000, preserveRecent: 4 })
 * // Tool specs: from 20 tools, or once their schemas reach 5% of the context window, defer every one but shell's.
 * // Checked on every call, so the same tools give the same tools list
 * Offload.defer(["!shell"]).when({ toolCount: 20, schemaTokens: "5%" })
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
  defer(target: DeferTarget): DeferStrategy {
    return new DeferredToolLoadingStrategy(target)
  },
}
