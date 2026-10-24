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
import type { ContextState } from '../../types.js'
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
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class SummarizeStrategy extends BaseOffloadStrategy {
  private readonly _config: SummarizeConfig

  constructor(target?: OffloadTarget, config?: SummarizeConfig, conditions?: OffloadConditions) {
    super('offload:summarize', target, conditions)
    this._config = config ?? {}
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (!this._resolveModel(context.agent)) {
      logger.warn('no model available for summarization')
      return false
    }
    return super.apply(context)
  }

  /** Summarizes each contiguous run of eligible messages into its own summary, last run first. */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false

    const { messages } = context
    if (messages.length <= 1) return false

    const runs = splitIntoRuns(indicesWithPairs(messages, this._getEligibleMessages(context)))
    let acted = false
    for (const run of runs.reverse()) {
      if (await this._summarizeRun(messages, run, model, context.invocationContext)) acted = true
    }
    if (acted) repairAlternation(messages)
    return acted
  }

  /** Replaces the messages at `run` (contiguous indices) with one summary marker; a failure leaves the run intact. */
  private async _summarizeRun(
    messages: Message[],
    run: number[],
    model: Model,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    const start = run[0]!
    const runMessages = messages.slice(start, start + run.length)
    let summary: string | null
    try {
      summary = await summarizeContent(flattenMessagesToContent(runMessages), model, this._config, invocationContext)
    } catch (error) {
      logger.warn(`runLength=<${run.length}>, error=<${normalizeError(error).message}> | run summarization failed`)
      return false
    }
    if (!summary) return false

    const totalTokens = await model.countTokens(runMessages)
    messages.splice(start, runMessages.length)
    insertMarker(messages, start, formatSummarized(`${runMessages.length} messages`, totalTokens, summary))
    logger.debug(`summarized=<${runMessages.length}>, tokens=<${totalTokens}> | summarized message run`)
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

/** Sorted indices of `eligible` plus the tool-pair partners that must be removed with them. */
function indicesWithPairs(messages: Message[], eligible: Message[]): number[] {
  const indices = new Set<number>()
  for (const message of eligible) {
    for (const removable of collectRemovableWithPair(messages, messages.indexOf(message))) {
      indices.add(messages.indexOf(removable))
    }
  }
  return [...indices].sort((left, right) => left - right)
}

/** Splits sorted indices into runs of consecutive indices. */
function splitIntoRuns(indices: number[]): number[][] {
  const runs: number[][] = []
  for (const index of indices) {
    const run = runs.at(-1)
    if (run && run.at(-1) === index - 1) run.push(index)
    else runs.push([index])
  }
  return runs
}
