/**
 * Client-side summarizer used by every provider.
 *
 * @internal
 */

import { TextBlock } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import type { SummaryRequest, SummaryResult } from '../../models/summary.js'
import { flattenMessagesToContent, streamSummary } from '../methods/summarize.js'
import type { Summarizer } from './summarizer.js'

/**
 * Writes a text summary through {@link Model.stream}: the flattened body under the summarizer prompt, without the
 * live system prompt or tools. Keeps message 0 in front of the summary.
 *
 * @internal
 */
export class BaseSummarizer implements Summarizer {
  readonly keepHead = 1
  readonly model: Model

  constructor(model: Model) {
    this.model = model
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult | undefined> {
    const { text, usage } = await streamSummary(
      flattenMessagesToContent(request.messages),
      this.model,
      request.instructions,
      request.cancelSignal
    )
    if (!text) return undefined
    const removedTokens = await this.model.countTokens(request.messages)
    const offloaded = { method: 'summarize' as const, removedMessages: request.messages.length, removedTokens }
    return {
      block: new TextBlock(text, { metadata: { offloaded } }),
      ...(usage !== undefined && { usage }),
    }
  }
}
