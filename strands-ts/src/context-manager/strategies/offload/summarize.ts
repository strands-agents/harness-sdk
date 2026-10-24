/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError } from '../../../errors.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock, Message } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import {
  formatSummarized,
  summarizeContent,
  summarizeMessages,
  toolResultToContentBlocks,
  type SummarizeConfig,
} from '../../methods/summarize.js'
import { formatStashRefs } from '../../stash.js'
import { BaseOffloadStrategy, type OffloadConditions, type OffloadTarget } from './base.js'

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

  /**
   * Whether the messages this strategy summarizes are fully determined by `preserveRecent`, which is
   * the only selection `Model.compact()` receives.
   */
  private get _selectsByRecencyOnly(): boolean {
    return (this._target === undefined || this._target === '*') && this._threshold === undefined
  }

  /** Replaces the history with `model.compact()`'s result, keeping `preservedMessages` trailing messages. */
  private async _compact(context: ContextState, model: Model, preservedMessages: number): Promise<boolean> {
    const { messages, agent } = context
    const compacted = await model.compact(
      messages,
      {
        preservedMessages,
        // A server-side compaction must carry the live system prompt and tools, or the provider
        // treats it as a different conversation.
        ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
        toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
        ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
      },
      context.invocationContext
    )
    if (!compacted) return false

    messages.splice(0, messages.length, ...compacted)
    return true
  }

  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false
    if (this._selectsByRecencyOnly) return this._compact(context, model, this._preserveRecent)

    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    return summarizeMessages(messages, eligible, model, this._config, context.invocationContext)
  }

  /**
   * A retroactive per-block summary invalidates later thinking on a model that compacts server-side, so it
   * compacts the history instead, but only when a block it targets is eligible.
   */
  protected override async _applyPerBlock(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model || !this._isRetroactive || model.serverCompaction !== true) return super._applyPerBlock(context)

    const { messages } = context
    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false
    // `preserveRecent` counts only matching messages, so the cut is set just after the newest eligible one.
    const newestEligible = messages.indexOf(eligible[eligible.length - 1]!)
    return this._compact(context, model, messages.length - newestEligible - 1)
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
