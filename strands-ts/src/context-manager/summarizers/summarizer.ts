/**
 * The summarizer contract the summarize strategy routes a pass through.
 *
 * @internal
 */

import type { Model } from '../../models/model.js'
import type { SummaryRequest, SummaryResult } from '../../models/summary.js'

/**
 * Writes one summary of a cut's body.
 *
 * @internal
 */
export interface Summarizer {
  /** How many opening messages the cut keeps in front of the summary. */
  readonly keepHead: 0 | 1

  /** The model that writes the summary. */
  readonly model: Model

  /**
   * Summarizes `request.messages`.
   *
   * @param request - The messages and request settings
   * @returns The summary, or undefined when none was written
   */
  summarize(request: SummaryRequest): Promise<SummaryResult | undefined>
}
