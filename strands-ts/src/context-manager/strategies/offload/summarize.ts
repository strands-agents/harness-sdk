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
import type { ContextState } from '../../types.js'
import {
  flattenMessagesToContent,
  formatToolResultLabel,
  summarizeContent,
  toolResultToContentBlocks,
  type SummarizeConfig,
} from '../../methods/summarize.js'
import { formatOffloaded, formatSummarized, REMOVED_MESSAGES } from '../../placeholder.js'
import { removedTokens, removeMessages, repairAlternation } from '../../message-trimming.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

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
  private readonly _config: SummarizeConfig
  private _warnedServerSideSkip = false

  constructor(target: OffloadTarget, config?: SummarizeConfig, conditions?: OffloadConditions) {
    super('summarize', target, conditions)
    this._config = config ?? {}
  }

  when(conditions: OffloadConditions = {}): SummarizeStrategy {
    return new SummarizeStrategy(this._target, this._config, conditions)
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (!this._resolveModel(context.agent)) {
      logger.warn('no model available for summarization')
      return false
    }
    return super.apply(context)
  }

  /**
   * Summarizes each contiguous run of eligible messages into its own summary.
   *
   * A server-side summary stands in for the conversation's start as a single block, so it is tried once over every
   * removable message before the per-run pass, which is client-side only.
   */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    // apply returns early without a model.
    const model = this._resolveModel(context.agent)!
    const { messages, invocationContext } = context
    const removable = await this._removableMessages(context)
    if (removable.length === 0) return false
    if (await this._trySummarizeServerSide(context, model, removable)) return true

    const summarize = (run: Message[]): Promise<{ text: string; tokens: number } | null> =>
      this._summarizeRun(run, model, invocationContext)
    return removeMessages(messages, removable, summarize, 'summarize', this._stash)
  }

  /**
   * Whether a server-side summary replaced the opening messages.
   *
   * A `blockThreshold` selects messages by size, which a block covering the conversation's start can't honour, so
   * those passes summarize client-side. The mismatch is in the configuration rather than the history, so it reads
   * the same on every pass and is warned about once.
   */
  private async _trySummarizeServerSide(context: ContextState, model: Model, removable: Message[]): Promise<boolean> {
    if (!this._serverSideSummary(model, context.agent.model)) return false
    if (this._conditions.blockThreshold === undefined) return this._summarizeServerSide(context, model, removable)
    if (!this._warnedServerSideSkip) {
      this._warnedServerSideSkip = true
      logger.warn(
        `model=<${model.constructor.name}>, blockThreshold=<${this._conditions.thresholdTokens(context.agent)}> | ` +
          "a server-side summary covers the conversation's start, so it cannot honour a blockThreshold" +
          ' | summarizing client-side instead'
      )
    }
    return false
  }

  /** Whether both models take a server-side summary. The agent's model replays the block, so it must be the same model. */
  private _serverSideSummary(model: Model, agentModel: Model): boolean {
    return (
      model.modelInfo.capabilities?.serverSideSummary === true &&
      agentModel.modelInfo.capabilities?.serverSideSummary === true &&
      model.constructor === agentModel.constructor &&
      model.modelId === agentModel.modelId
    )
  }

  /** The summary marker for a run and the tokens it stands for; a failure is logged and keeps the run. */
  private async _summarizeRun(
    run: Message[],
    model: Model,
    invocationContext?: InvocationContext
  ): Promise<{ text: string; tokens: number } | null> {
    const content = flattenMessagesToContent(run)
    const summary = await this._trySummarize(content, model, `runLength=<${run.length}>`, invocationContext)
    if (!summary) return null

    const tokens = await removedTokens(run, model)
    logger.debug(`summarized=<${run.length}>, tokens=<${tokens}> | summarized message run`)
    return { text: formatSummarized(REMOVED_MESSAGES, tokens, summary), tokens }
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
    // The summary replaces message 0's tool results, which would orphan a tool use kept there.
    if (messages[0]!.content.some((block) => block.type === 'toolUseBlock')) return false
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
    stashRef: string | undefined,
    toolName: string | undefined,
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null> {
    const model = this._resolveModel(agent)
    if (!model) return null

    const input = summaryInput(block, toolName)
    const logFields = `trackingId=<${message.trackingId}>`
    const summary = input ? await this._trySummarize(input.content, model, logFields, invocationContext) : null
    if (input && summary) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized ${input.description}`)
      const placeholder = this._placeholder(formatSummarized(input.description, tokens, summary), stashRef, tokens)
      return block instanceof ToolResultBlock ? block.with({ content: [placeholder] }) : placeholder
    }
    // A tool result or text the summarizer failed on is kept for a later pass; media is offloaded instead.
    if (block instanceof ToolResultBlock || block instanceof TextBlock) return null

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return this._placeholder(formatOffloaded(tokens, mediaKind(block)), stashRef, tokens)
  }

  /** Summarizes `content`, or logs a failure and returns null so the pass continues and keeps the content. */
  private async _trySummarize(
    content: ContentBlock[],
    model: Model,
    logFields: string,
    invocationContext?: InvocationContext
  ): Promise<string | null> {
    try {
      return await summarizeContent(content, model, this._config, invocationContext)
    } catch (error) {
      logger.warn(`${logFields}, error=<${normalizeError(error).message}> | summarization failed`)
      return null
    }
  }

  private _resolveModel(agent: LocalAgent): Model | undefined {
    return this._config.model ?? agent.auxModel
  }
}

/** What the summarizer reads for a block and how its marker describes it, or undefined when it can't summarize it. */
function summaryInput(
  block: ContentBlock,
  toolName: string | undefined
): { content: ContentBlock[]; description: string } | undefined {
  if (block instanceof ToolResultBlock) {
    const label = new TextBlock(formatToolResultLabel(block, toolName))
    return { content: [label, ...toolResultToContentBlocks(block.content)], description: 'tool result' }
  }
  if (block instanceof TextBlock) return { content: [new TextBlock(block.text)], description: 'text block' }
  if (block instanceof ImageBlock || block instanceof DocumentBlock)
    return { content: [block], description: 'media block' }
  return undefined
}
