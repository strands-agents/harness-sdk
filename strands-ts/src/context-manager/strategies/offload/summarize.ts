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
import type { Model, StreamOptions } from '../../../models/model.js'
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
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  insertMarker,
  spliceWithPairs,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

/** A model whose `_supportsServerCompaction` is set. */
type ServerCompactingModel = Model & {
  _compact(
    messages: Message[],
    options?: Pick<StreamOptions, 'systemPrompt' | 'toolSpecs'>
  ): Promise<string | undefined>
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

    if (await this._tryServerCompaction(context)) return true

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

  /**
   * Summarizes the history before the kept turns server side, so their replayed thinking stays valid.
   *
   * Applies only to whole-history summarization on the agent's own model, when that model supports it.
   * The history keeps the same layout as the client-side summary.
   */
  private async _tryServerCompaction(context: ContextState): Promise<boolean> {
    const { agent, messages } = context
    if (this._target !== '*' || this._threshold !== undefined || this._config.model) return false
    if (!agent.model._supportsServerCompaction) return false

    const cut = this._compactionCut(messages)
    if (cut === undefined) return false

    const model = agent.model as ServerCompactingModel
    let summary: string | undefined
    try {
      summary = await model._compact(messages.slice(0, cut), {
        ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
        toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
      })
    } catch (error) {
      logger.warn(
        `model_id=<${model.modelId}>, error=<${normalizeError(error).message}> | server compaction failed, summarizing client side`
      )
      return false
    }
    if (!summary) return false

    const removed = messages.slice(1, cut)
    const totalTokens = await model.countTokens(removed)
    messages.splice(1, removed.length)
    insertMarker(messages, 1, formatSummarized(`${removed.length} messages`, totalTokens, summary))
    logger.debug(`summarized=<${removed.length}>, tokens=<${totalTokens}> | server compaction complete`)
    return true
  }

  /**
   * Index of the first kept message: the latest assistant reply to a user message before the kept turns.
   *
   * Cutting at the end of a request already sent never splits a tool use from its result. Pinned messages are kept.
   */
  private _compactionCut(messages: Message[]): number | undefined {
    const preserve = this._preserveRecent
    const resolved = preserve > 0 && preserve < 1 ? Math.ceil(messages.length * preserve) : Math.floor(preserve)
    const firstPinned = messages.findIndex((_message, index) => index > 0 && isPinned(messages, index))
    let cut = Math.min(messages.length - Math.max(resolved, 1), firstPinned === -1 ? messages.length : firstPinned)
    for (; cut > 1; cut--) {
      if (messages[cut - 1]!.role === 'user' && messages[cut]!.role === 'assistant') return cut
    }
    return undefined
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
