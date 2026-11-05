/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
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

    if (
      model.modelInfo.capabilities?.serverSideSummary === true &&
      (await this._summarizeServerSide(context, model, safe))
    )
      return true

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

  /**
   * Summarizes message 0 through the last of `safe` server-side, keeping message 0 in place.
   *
   * A server-side summary can only stand in for the conversation's exact start, so every message up to the last of
   * `safe` is covered, even ones `safe` leaves out (such as pinned messages). The summary becomes an assistant message
   * at index 1, leading any assistant content after it once alternation is repaired.
   *
   * @returns False when the model wrote no summary, so the caller summarizes client-side instead
   */
  private async _summarizeServerSide(context: ContextState, model: Model, safe: Message[]): Promise<boolean> {
    const { messages, agent } = context
    const safeSet = new Set(safe)
    let end = messages.length
    while (end > 0 && !safeSet.has(messages[end - 1]!)) end--
    if (end - 1 > safe.length) {
      logger.warn(
        `covered=<${end - 1}>, eligible=<${safe.length}> | a server-side summary covers the conversation's start` +
          ' | summarizing messages that were not eligible too'
      )
    }
    const summary = await model.summarize(messages.slice(0, end), {
      toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
      ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
      ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
    })
    if (!summary) return false
    if (agent.model.modelInfo.capabilities?.serverSideSummary !== true) {
      logger.warn("the agent's model does not declare serverSideSummary | it will read the summary as plain text")
    }
    messages.splice(1, end - 1, new Message({ role: 'assistant', content: [summary] }))
    repairAlternation(messages)
    logger.debug(`summarized=<${end - 1}> | summarized opening messages server-side`)
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
