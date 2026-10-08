/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import {
  flattenMessagesToContent,
  formatSummarized,
  summarizeContent,
  toolResultToContentBlocks,
  type SummarizeConfig,
} from '../../methods/summarize.js'
import { formatStashRefs } from '../../stash.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  spliceWithPairs,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class SummarizeStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:summarize'

  private readonly _config: SummarizeConfig

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

    // A summary landing at index 1 merges into message 0, which is never eligible again. Fold the
    // summaries already merged there into this pass so message 0 holds at most one.
    const folded = this._foldableHeadSummaries(messages, safe)
    const toSummarize = folded ? [folded.message, ...safe] : safe

    const contentBlocks = flattenMessagesToContent(toSummarize)
    const summary = await summarizeContent(contentBlocks, model, this._config)
    if (!summary) return false

    const totalTokens = await model.countTokens(toSummarize)
    const summaryMessage = new Message({
      role: 'user',
      content: [new TextBlock(formatSummarized(`${safe.length} messages`, totalTokens, summary))],
    })

    if (folded) messages[0] = folded.head
    const { lowestIndex } = spliceWithPairs(messages, safe)

    const insertIndex = Math.max(1, Math.min(lowestIndex, messages.length))
    messages.splice(insertIndex, 0, summaryMessage)

    repairAlternation(messages)
    logger.debug(`summarized=<${safe.length}>, tokens=<${totalTokens}> | batched summarization complete`)
    return true
  }

  /**
   * Splits previously merged batch summaries out of message 0 when the new summary would merge into it.
   * Returns the head without them plus a message carrying them, or undefined when nothing should be folded.
   */
  private _foldableHeadSummaries(
    messages: Message[],
    safe: Message[]
  ): { head: Message; message: Message } | undefined {
    const head = messages[0]!
    if (head.role !== 'user' || isPinned(messages, 0)) return undefined

    const lowestIndex = Math.min(...safe.map((message) => messages.indexOf(message)))
    if (Math.min(lowestIndex, messages.length - safe.length) > 1) return undefined

    // Index 0 is the original content: merges only ever append after it.
    const summaries = head.content.filter((block, index) => index > 0 && isBatchSummary(block))
    if (summaries.length === 0) return undefined

    return {
      head: new Message({
        role: head.role,
        content: head.content.filter((block) => !summaries.includes(block)),
        trackingId: head.trackingId,
        ...(head.metadata ? { metadata: head.metadata } : {}),
      }),
      message: new Message({ role: 'user', content: summaries }),
    }
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRefs: string[]
  ): Promise<ContentBlock | null> {
    const model = this._resolveModel(agent)
    if (!model) return null

    if (block instanceof ToolResultBlock) {
      const summary = await summarizeContent(toolResultToContentBlocks(block.content), model, this._config)
      if (!summary) return null

      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | summarized tool result`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [new TextBlock(`${formatSummarized('tool result', tokens, summary)}${formatStashRefs(stashRefs)}`)],
      })
    }

    if (block instanceof TextBlock) {
      const summary = await summarizeContent([new TextBlock(block.text)], model, this._config)
      if (!summary) return null

      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized text block`)
      return new TextBlock(`${formatSummarized('text block', tokens, summary)}${formatStashRefs(stashRefs)}`)
    }

    const summary = await summarizeContent([block], model, this._config)
    if (summary) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized media block`)
      return new TextBlock(`${formatSummarized('media block', tokens, summary)}${formatStashRefs(stashRefs)}`)
    }

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${formatStashRefs(stashRefs)}`)
  }

  private _resolveModel(agent: LocalAgent): Model | undefined {
    return this._config.model ?? agent.model
  }
}

const BATCH_SUMMARY_PATTERN = /^\[Summarized: \d+ messages, ~/

function isBatchSummary(block: ContentBlock): boolean {
  return block instanceof TextBlock && BATCH_SUMMARY_PATTERN.test(block.text)
}
