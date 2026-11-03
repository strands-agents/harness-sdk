/**
 * Provider-side summarizer, used when the summarizer model declares server-side compaction.
 *
 * @internal
 */

import { TextBlock } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import type { SummaryRequest, SummaryResult } from '../../models/summary.js'
import type { Summarizer } from './summarizer.js'

/**
 * Summarizes through {@link Model.compact}: the body starts at message 0 and is sent with the live system prompt and
 * tools. The returned block replaces message 0.
 *
 * @internal
 */
export class NativeSummarizer implements Summarizer {
  readonly keepHead = 0
  /** Whether to re-state the replaced message 0 after the summary. Off until mid-conversation system messages land. */
  readonly restateHead = false
  readonly model: Model

  constructor(model: Model) {
    this.model = model
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult | undefined> {
    const result = await this.model.compact(request)
    if (!result) return undefined
    const { block } = result
    const offloaded = { method: 'summarize' as const, removedMessages: request.messages.length }
    return {
      ...result,
      block: new TextBlock(block.text, {
        metadata: { ...block.metadata, offloaded: { ...offloaded, ...block.metadata?.offloaded } },
        ...(block.providerData !== undefined && { providerData: block.providerData }),
      }),
    }
  }
}
