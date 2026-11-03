/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock, ProviderData } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import { summarizeWithStream, type SummarizeOptions, type SummarizeResult } from '../../../models/summarize.js'
import { unwrapInvocationContext, type InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import { formatStashRefs } from '../../stash.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  insertMarker,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

const SUMMARIZED_PREFIX = '[Summarized:'

/**
 * Configuration for the summarize method.
 *
 * @experimental
 */
export interface SummarizeConfig {
  /** Model used for summarization. Resolution order: `this model > agent.auxModel > agent.model`. */
  model?: Model

  /** Custom system prompt for the summarization model. */
  systemPrompt?: string
}

/**
 * Format a `[Summarized: ...]` marker with an optional summary body.
 *
 * @internal
 */
export function formatSummarized(description: string, tokens: number, summary?: string): string {
  const header = `${SUMMARIZED_PREFIX} ${description}, ~${tokens.toLocaleString('en-US')} tokens]`
  return summary ? `${header}\n\n${summary}` : header
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

  /**
   * Summarizes each contiguous run of eligible messages into its own summary. For a model with server-side
   * compaction, the run right after message 0 is compacted together with message 0 into a message of its own.
   */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false

    const { messages } = context
    const runs = messageRuns(messages, await this._getEligibleMessages(context))
    const opening = compactsServerSide(model) ? openingRun(messages, runs) : undefined
    let acted = false
    // Last run first, so replacing a run leaves the earlier runs' positions unchanged.
    for (const run of runs.reverse()) {
      // An opening run compaction left in place gets the base summary instead.
      const compacted = run === opening && (await this._compactOpening(context, model, run))
      if (compacted || (await this._summarizeRun(context, model, run))) acted = true
    }
    if (acted) repairAlternation(messages)
    return acted
  }

  /** Replaces `run` with a summary marker; a failure is logged and keeps the run. */
  private async _summarizeRun(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    if (holdsOnlySummaries(run)) return false
    const summary = summaryText(await this._trySummarize(run, model, context.agent, context.invocationContext))
    if (!summary) return false

    const { messages } = context
    const totalTokens = await model.countTokens(run)
    const start = messages.indexOf(run[0]!)
    messages.splice(start, run.length)
    insertMarker(messages, start, formatSummarized(`${run.length} messages`, totalTokens, summary))
    logger.debug(`summarized=<${run.length}>, tokens=<${totalTokens}> | summarized message run`)
    return true
  }

  /**
   * Compacts message 0 and the run after it server-side, keeping message 0 in place. The summary takes the run's
   * place as an assistant message, ahead of any assistant content that follows, and the provider sends its block,
   * which covers message 0, in place of the text.
   */
  private async _compactOpening(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    if (holdsOnlySummaries(run)) return false
    const { messages, agent, invocationContext } = context
    const result = await this._trySummarize([messages[0]!, ...run], model, agent, invocationContext, true)
    const summary = summaryText(result)
    if (!result || !summary) return false

    const totalTokens = await model.countTokens(run)
    const providerData = providerDataOf(result.content)
    const text = formatSummarized(`${run.length} messages`, totalTokens, summary)
    const block = new TextBlock(text, providerData ? { metadata: { providerData } } : undefined)
    messages.splice(1, run.length, new Message({ role: 'assistant', content: [block] }))
    logger.debug(`summarized=<${run.length}>, tokens=<${totalTokens}> | compacted opening messages`)
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

    const refs = formatStashRefs(stashRefs)
    const summarizable =
      block instanceof ToolResultBlock ||
      block instanceof TextBlock ||
      block instanceof ImageBlock ||
      block instanceof DocumentBlock
    const request = summarizable ? blockRequest(block, message, agent.messages) : undefined
    const summary = request ? summaryText(await this._trySummarize(request, model, agent, invocationContext)) : ''

    if (block instanceof ToolResultBlock) {
      if (!summary) return null
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | summarized tool result`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [new TextBlock(`${formatSummarized('tool result', tokens, summary)}${refs}`)],
      })
    }

    if (block instanceof TextBlock) {
      if (!summary) return null
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized text block`)
      return new TextBlock(`${formatSummarized('text block', tokens, summary)}${refs}`)
    }

    if (summary) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized media block`)
      return new TextBlock(`${formatSummarized('media block', tokens, summary)}${refs}`)
    }

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${refs}`)
  }

  /**
   * Summarizes `messages` and records the call's usage, or logs a failure and returns null so the pass continues and
   * keeps them. A model with server-side compaction is called through its `summarize()` only for `opening`
   * messages; its other summaries use the base implementation.
   */
  private async _trySummarize(
    messages: Message[],
    model: Model,
    agent: LocalAgent,
    invocationContext: InvocationContext | undefined,
    opening = false
  ): Promise<SummarizeResult | null> {
    const options: SummarizeOptions = {
      ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
      cancelSignal: agent.cancelSignal,
    }
    try {
      const result =
        opening || !compactsServerSide(model)
          ? await model.summarize(messages, {
              ...options,
              ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
              toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
            })
          : await summarizeWithStream(model, messages, options)
      if (result.usage) unwrapInvocationContext(invocationContext)?.recordUsage(result.usage)
      return result
    } catch (error) {
      logger.warn(`messages=<${messages.length}>, error=<${normalizeError(error).message}> | summarization failed`)
      return null
    }
  }

  private _resolveModel(agent: LocalAgent): Model | undefined {
    return this._config.model ?? agent.auxModel
  }
}

/** Whether `model` declares server-side compaction, so its `summarize()` may cover the conversation's opening. */
function compactsServerSide(model: Model): boolean {
  return model.modelInfo?.capabilities?.serverSideCompaction === true
}

/** Splits `selected` and their tool pairs into runs of messages adjacent in `messages`, in history order. */
function messageRuns(messages: Message[], selected: Message[]): Message[][] {
  const removable = new Set<Message>()
  for (const message of selected) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    for (const partner of collectRemovableWithPair(messages, index)) removable.add(partner)
  }
  const runs: Message[][] = []
  messages.forEach((message, index) => {
    if (!removable.has(message)) return
    const previous = messages[index - 1]
    if (previous && removable.has(previous)) runs.at(-1)!.push(message)
    else runs.push([message])
  })
  return runs
}

/**
 * The run right after message 0 that server-side compaction may cover together with message 0: the covered messages
 * start with a user message and alternate roles.
 */
function openingRun(messages: Message[], runs: Message[][]): Message[] | undefined {
  const run = runs[0]
  if (!run || run[0] !== messages[1]) return undefined
  const covered = messages.slice(0, run.length + 1)
  const alternates = covered.every((message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant'))
  return alternates ? run : undefined
}

/** Whether every block of `run` is an earlier summary, so summarizing it would only restate that summary. */
function holdsOnlySummaries(run: Message[]): boolean {
  return run.every((message) =>
    message.content.every((block) => block instanceof TextBlock && block.text.startsWith(SUMMARIZED_PREFIX))
  )
}

/** The summary's text blocks, one per line, or empty without a result. */
function summaryText(result: SummarizeResult | null): string {
  if (!result) return ''
  return result.content
    .flatMap((block) => (block instanceof TextBlock ? [block.text] : []))
    .join('\n')
    .trim()
}

function providerDataOf(content: ContentBlock[]): ProviderData | undefined {
  for (const block of content) {
    if (block instanceof TextBlock && block.metadata?.providerData) return block.metadata.providerData
  }
  return undefined
}

/**
 * The `Model.summarize()` input for one block of `message`: the block in a message of `message`'s role, after the
 * tool use it answers when it is a tool result the history holds, so the summarizer sees which tool produced it.
 */
function blockRequest(block: ContentBlock, message: Message, history: Message[]): Message[] {
  const request = [new Message({ role: message.role, content: [block] })]
  if (!(block instanceof ToolResultBlock)) return request
  const toolUse = history
    .flatMap((turn) => turn.content)
    .find((candidate) => candidate instanceof ToolUseBlock && candidate.toolUseId === block.toolUseId)
  return toolUse ? [new Message({ role: 'assistant', content: [toolUse] }), ...request] : request
}
