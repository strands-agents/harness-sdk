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
  summarizeContent,
  toolResultToContentBlocks,
  type SummarizeConfig,
} from '../../methods/summarize.js'
import { withPairs } from '../../message-trimming.js'
import { formatOffloaded, formatSummarized } from '../../placeholder.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

export class SummarizeStrategy extends BaseOffloadStrategy {
  private readonly _config: SummarizeConfig

  constructor(target?: OffloadTarget, config?: SummarizeConfig, conditions?: OffloadConditions) {
    super('summarize', target, conditions)
    this._config = config ?? {}
  }

  protected _withConditions(conditions: OffloadConditions): SummarizeStrategy {
    return new SummarizeStrategy(this._target, this._config, conditions)
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (!this._resolveModel(context.agent)) {
      logger.warn('no model available for summarization')
      return false
    }
    return super.apply(context)
  }

  /** Summarizes each contiguous run of eligible messages into its own summary, last run first. */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    // apply returns early without a model.
    const model = this._resolveModel(context.agent)!
    const { messages, invocationContext } = context
    const runs = splitIntoRuns(messages, withPairs(messages, await this._getEligibleMessages(context)))
    let acted = false
    for (const run of runs.reverse()) {
      const summarize = (removed: Message[]): Promise<string | null> =>
        this._summarizeRun(removed, model, invocationContext)
      if (await this._removeMessages(messages, run, summarize)) acted = true
    }
    return acted
  }

  /** The summary marker text for a run of messages; a failure is logged and keeps the run. */
  private async _summarizeRun(
    run: Message[],
    model: Model,
    invocationContext?: InvocationContext
  ): Promise<string | null> {
    let summary: string | null
    try {
      summary = await summarizeContent(flattenMessagesToContent(run), model, this._config, invocationContext)
    } catch (error) {
      logger.warn(`runLength=<${run.length}>, error=<${normalizeError(error).message}> | run summarization failed`)
      return null
    }
    if (!summary) return null

    const totalTokens = await model.countTokens(run)
    logger.debug(`summarized=<${run.length}>, tokens=<${totalTokens}> | summarized message run`)
    return formatSummarized(`${run.length} messages`, totalTokens, summary)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRef: string | undefined,
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null> {
    const model = this._resolveModel(agent)
    if (!model) return null

    const input = summaryInput(block)
    const summary = input ? await this._trySummarize(input.content, model, message, invocationContext) : null
    if (input && summary) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized ${input.description}`)
      const placeholder = this._placeholder(formatSummarized(input.description, tokens, summary), stashRef)
      return block instanceof ToolResultBlock ? block.withContent([placeholder]) : placeholder
    }
    // A tool result or text the summarizer failed on is kept for a later pass; media is offloaded instead.
    if (block instanceof ToolResultBlock || block instanceof TextBlock) return null

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return this._placeholder(formatOffloaded(tokens, mediaKind(block)), stashRef)
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

/** What the summarizer reads for a block and how its marker describes it, or undefined when it can't summarize it. */
function summaryInput(block: ContentBlock): { content: ContentBlock[]; description: string } | undefined {
  if (block instanceof ToolResultBlock) {
    return { content: toolResultToContentBlocks(block.content), description: 'tool result' }
  }
  if (block instanceof TextBlock) return { content: [new TextBlock(block.text)], description: 'text block' }
  if (block instanceof ImageBlock || block instanceof DocumentBlock)
    return { content: [block], description: 'media block' }
  return undefined
}

/** Splits `selected`, in conversation order, into runs of messages adjacent in `messages`. */
function splitIntoRuns(messages: Message[], selected: Message[]): Message[][] {
  const runs: Message[][] = []
  let previousIndex = -2
  for (const message of selected) {
    const index = messages.indexOf(message)
    if (index === previousIndex + 1) runs.at(-1)!.push(message)
    else runs.push([message])
    previousIndex = index
  }
  return runs
}
