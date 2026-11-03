/**
 * Client-side summarizer used by every provider.
 *
 * @internal
 */

import { TextBlock } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import { unwrapInvocationContext, type InvocationContext } from '../../agent/invocation-context.js'
import type { SummaryRequest, SummaryResult } from '../../models/summary.js'
import { flattenMessagesToContent, streamSummary } from '../methods/summarize.js'
import type { Summarizer } from './summarizer.js'

/**
 * Writes a text summary through {@link Model.stream}: the flattened body under the summarizer prompt, without the
 * live system prompt or tools. Keeps message 0 in front of the summary. Every completed stream's usage is recorded
 * on the invocation context, including a stream that wrote no summary.
 *
 * @internal
 */
export class BaseSummarizer implements Summarizer {
  readonly keepHead = 1
  readonly model: Model
  private readonly _invocationContext: InvocationContext | undefined

  constructor(model: Model, invocationContext?: InvocationContext) {
    this.model = model
    this._invocationContext = invocationContext
  }

  async summarize(request: SummaryRequest): Promise<SummaryResult | undefined> {
    const { text, usage } = await streamSummary(
      flattenMessagesToContent(request.messages),
      this.model,
      request.instructions,
      request.cancelSignal
    )
    if (usage) unwrapInvocationContext(this._invocationContext)?.recordUsage(usage)
    if (!text) return undefined
    const removedTokens = await this.model.countTokens(request.messages)
    const offloaded = { method: 'summarize' as const, removedMessages: request.messages.length, removedTokens }
    return { block: new TextBlock(text, { metadata: { offloaded } }) }
  }
}
