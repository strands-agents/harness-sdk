/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError, NotImplementedError } from '../../../errors.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock, SummaryBlock } from '../../../types/messages.js'
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

function warnClientSideFallback(model: Model, reason: string, error?: unknown): void {
  const message =
    `model=<${model.constructor.name}>, reason=<${reason}> | server-side summary failed, falling back to client-side summary` +
    ' | the client-side summary rewrites history, so thinking blocks kept after it will be dropped'
  if (error === undefined) logger.warn(message)
  else logger.warn(message, error)
}

// Message 0 counts too: it stays in history, but requests start at the compaction block after it.
function pinnedBefore(messages: Message[], end: number): Message[] {
  return messages.slice(0, end).filter((_, index) => isPinned(messages, index))
}

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

    // The agent's model replays the summary block, so it must be the same provider and model as the summarizer.
    const agentModel = context.agent.model
    const serverSide =
      model.modelInfo.capabilities?.serverSideSummary === true &&
      agentModel.modelInfo.capabilities?.serverSideSummary === true &&
      model.constructor === agentModel.constructor &&
      model.modelId === agentModel.modelId
    if (serverSide && (await this._summarizeServerSide(context, model, safe))) return true

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
   * A server-side summary can only stand in for the conversation's exact start, so every message up to the last
   * of `safe` is sent, even ones `safe` leaves out. The summary becomes an assistant message at index 1. A pin
   * among the summarized messages hands the pass to the client-side summary.
   *
   * @returns False when the server-side summary was skipped or failed, so the caller summarizes client-side instead
   */
  private async _summarizeServerSide(context: ContextState, model: Model, safe: Message[]): Promise<boolean> {
    const { messages } = context
    const safeSet = new Set(safe)
    let end = 0
    messages.forEach((message, index) => {
      if (safeSet.has(message)) end = index + 1
    })
    if (end <= 1) return false
    const pinned = pinnedBefore(messages, end)
    if (pinned.length > 0) {
      logger.warn(
        `model=<${model.constructor.name}>, pinned=<${pinned.length}> | server-side summary does not support pinned messages` +
          ' | falling back to client-side summary'
      )
      return false
    }
    const replaced = end - 1
    if (replaced > safe.length) {
      logger.warn(
        `covered=<${replaced}>, eligible=<${safe.length}> | a server-side summary covers the conversation's start` +
          ' | summarizing messages that were not eligible too'
      )
    }
    const summary = await this._requestServerSideSummary(model, context.agent, messages.slice(0, end))
    if (summary === undefined) return false
    messages.splice(1, replaced, new Message({ role: 'assistant', content: [summary] }))
    repairAlternation(messages)
    logger.debug(`summarized=<${replaced}> | summarized opening messages server-side`)
    return true
  }

  /** Returns the model's server-side summary of `messages`, or undefined after warning that client-side takes over. */
  private async _requestServerSideSummary(
    model: Model,
    agent: LocalAgent,
    messages: Message[]
  ): Promise<SummaryBlock | undefined> {
    try {
      return await model.summarize(messages, {
        toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
        ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
        ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
      })
    } catch (error) {
      const normalized = normalizeError(error)
      const reason = `${normalized.name}(${normalized.message})`
      warnClientSideFallback(model, reason, error instanceof NotImplementedError ? undefined : error)
      return undefined
    }
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
