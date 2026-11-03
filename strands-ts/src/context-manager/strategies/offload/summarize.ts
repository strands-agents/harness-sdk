/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { warnOnce } from '../../../logging/warn-once.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import { normalizeError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import type { SummaryRequest, SummaryResult } from '../../../models/summary.js'
import { unwrapInvocationContext } from '../../../agent/invocation-context.js'
import { planCut, type Cut } from '../../summarizers/cut.js'
import { renderHistory } from '../../render.js'
import { BaseSummarizer } from '../../summarizers/base-summarizer.js'
import { NativeSummarizer } from '../../summarizers/native-summarizer.js'
import type { Summarizer } from '../../summarizers/summarizer.js'
import {
  flattenMessagesToContent,
  formatSummarized,
  summarizeContent,
  toolResultToContentBlocks,
  type SummarizeConfig,
} from '../../methods/summarize.js'
import { formatStashRefs } from '../../stash.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  insertMarker,
  spliceWithPairs,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class SummarizeStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:summarize'

  private readonly _config: SummarizeConfig
  /** Message 0 as it was when a native summary first replaced it, kept for re-statement. */
  private _openingMessage: Message | undefined

  constructor(target?: OffloadTarget, config?: SummarizeConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._config = config ?? {}
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return new SummarizeStrategy(this._target, this._config, conditions)
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (!this._resolveModel(context.agent)) {
      logger.warn('no model available for summarization')
      return false
    }
    return super.apply(context)
  }

  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    if (this._summarizesHistory) return this._applySummarizer(context)
    return this._applyToSelection(context)
  }

  /**
   * Picks the summarizer for a pass: native when the summarizer model declares server-side compaction, base
   * otherwise.
   *
   * @param agent - The agent whose history is summarized
   * @param invocationContext - Where the base summarizer records its usage
   * @returns The summarizer, or undefined when no summarizer model resolves
   */
  resolve(agent: LocalAgent, invocationContext?: InvocationContext): Summarizer | undefined {
    const model = this._resolveModel(agent)
    if (!model) return undefined
    if (model.modelInfo?.capabilities?.serverSideCompaction === true) return new NativeSummarizer(model)
    return new BaseSummarizer(model, invocationContext)
  }

  /**
   * Plans the cut of a pass, keeping `preserveRecent` messages. A native cut (`keepHead` 0) ends on a user message.
   *
   * @param messages - The history
   * @param keepHead - How many opening messages to keep in front of the summary
   * @returns The cut, or undefined when nothing can be summarized
   */
  planCut(messages: Message[], keepHead: number): Cut | undefined {
    // A whole-prefix compaction request ends on the user turn whose reply the kept turns begin with.
    return planCut(messages, keepHead, this._preserveRecent, keepHead === 0)
  }

  /**
   * Replaces the cut's body with the summary as its own message: `head + [summary] + tail`.
   *
   * @param messages - The history, changed in place
   * @param cut - The cut the summary was written for
   * @param block - The summary
   */
  place(messages: Message[], cut: Cut, block: TextBlock): void {
    if (cut.head.length === 0 && !this._openingMessage) this._openingMessage = cut.body[0]
    messages.splice(0, messages.length, ...cut.head, new Message({ role: 'assistant', content: [block] }), ...cut.tail)
  }

  /** Whether message-level passes summarize the history through a summarizer, rather than a target selection. */
  private get _summarizesHistory(): boolean {
    return (this._target === undefined || this._target === '*') && this._threshold === undefined
  }

  /** Runs one pass; when the native summarizer writes no summary, the base summarizer re-cuts and runs instead. */
  private async _applySummarizer(context: ContextState): Promise<boolean> {
    const summarizer = this.resolve(context.agent, context.invocationContext)
    if (!summarizer) return false
    const outcome = await this._summarizeCut(context, summarizer)
    if (outcome !== 'noSummary' || summarizer.keepHead === 1) return outcome === 'placed'
    logger.debug(
      `model_id=<${summarizer.model.modelId}> | native compaction wrote no summary so summarizing client-side`
    )
    return (
      (await this._summarizeCut(context, new BaseSummarizer(summarizer.model, context.invocationContext))) === 'placed'
    )
  }

  private async _summarizeCut(
    context: ContextState,
    summarizer: Summarizer
  ): Promise<'placed' | 'noCut' | 'noSummary'> {
    const cut = this.planCut(context.messages, summarizer.keepHead)
    if (!cut) {
      if (summarizer.keepHead === 0 && context.messages.length > 0 && isPinned(context.messages, 0)) {
        warnOnce(logger, `model_id=<${summarizer.model.modelId}> | message 0 is pinned, skipping native compaction`)
      }
      return 'noCut'
    }
    const result = await summarizer.summarize(summaryRequest(context, cut, summarizer, this._config.systemPrompt))
    if (!result) return 'noSummary'
    this.place(context.messages, cut, result.block)
    recordSummaryUsage(context, result)
    logger.debug(
      `summarized=<${cut.body.length}>, keep_head=<${summarizer.keepHead}> | summarized the opening of the history`
    )
    return 'placed'
  }

  /** Summarizes the messages a target or threshold selects, joining the summary to a neighbor. */
  private async _applyToSelection(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false

    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    // Expand to include paired messages so we don't orphan tool pairs
    const safeSet = new Set<Message>()
    for (const message of eligible) {
      const index = messages.indexOf(message)
      if (index === -1) continue
      for (const removable of collectRemovableWithPair(messages, index)) {
        safeSet.add(removable)
      }
    }
    const safe = messages.filter((message) => safeSet.has(message))
    if (safe.length === 0) return false

    const contentBlocks = flattenMessagesToContent(safe)
    const summary = await summarizeContent(contentBlocks, model, this._config, context.invocationContext)
    if (!summary) return false

    const totalTokens = await model.countTokens(safe)
    const { lowestIndex } = spliceWithPairs(messages, safe)
    insertMarker(messages, lowestIndex, formatSummarized(`${safe.length} messages`, totalTokens, summary))

    repairAlternation(messages)
    logger.debug(`summarized=<${safe.length}>, tokens=<${totalTokens}> | batched summarization complete`)
    return true
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRefs: string[],
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null> {
    const model = this._resolveModel(agent)
    if (!model) return null

    if (block instanceof ToolResultBlock) {
      const summary = await this._trySummarize(
        toolResultToContentBlocks(block.content),
        model,
        message,
        invocationContext
      )
      if (!summary) return null

      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | summarized tool result`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [new TextBlock(`${formatSummarized('tool result', tokens, summary)}${formatStashRefs(stashRefs)}`)],
      })
    }

    if (block instanceof TextBlock) {
      const summary = await this._trySummarize([new TextBlock(block.text)], model, message, invocationContext)
      if (!summary) return null

      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized text block`)
      return new TextBlock(`${formatSummarized('text block', tokens, summary)}${formatStashRefs(stashRefs)}`)
    }

    if (block instanceof ImageBlock || block instanceof DocumentBlock) {
      const summary = await this._trySummarize([block], model, message, invocationContext)
      if (summary) {
        logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized media block`)
        return new TextBlock(`${formatSummarized('media block', tokens, summary)}${formatStashRefs(stashRefs)}`)
      }
    }

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${formatStashRefs(stashRefs)}`)
  }

  /** Summarizes one block; a failure is logged and leaves the block unsummarized so the pass continues. */
  private async _trySummarize(
    content: ContentBlock[],
    model: Model,
    message: Message,
    invocationContext?: InvocationContext
  ): Promise<string | null> {
    try {
      return await summarizeContent(content, model, this._config, invocationContext)
    } catch (error) {
      logger.warn(
        `trackingId=<${message.trackingId}>, error=<${normalizeError(error).message}> | block summarization failed`
      )
      return null
    }
  }

  private _resolveModel(agent: LocalAgent): Model | undefined {
    return this._config.model ?? agent.auxModel
  }
}

function summaryRequest(
  context: ContextState,
  cut: Cut,
  summarizer: Summarizer,
  instructions: string | undefined
): SummaryRequest {
  const { agent } = context
  const live =
    summarizer.keepHead === 0
      ? {
          ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
          toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
        }
      : {}
  return {
    // A native request sends the body as the model saw it; the base summarizer flattens it instead.
    messages: summarizer.keepHead === 0 ? renderHistory(cut.body) : cut.body,
    ...live,
    ...(instructions !== undefined && { instructions }),
    ...(agent.cancelSignal && { cancelSignal: agent.cancelSignal }),
  }
}

function recordSummaryUsage(context: ContextState, result: SummaryResult): void {
  if (result.usage) unwrapInvocationContext(context.invocationContext)?.recordUsage(result.usage)
}
