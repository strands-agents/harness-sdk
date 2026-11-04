/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { Model } from '../../../models/model.js'
import {
  SUMMARIZED_PREFIX,
  formatSummarized,
  summarizeWithStream,
  type SummarizeOptions,
  type SummarizeResult,
} from '../../../models/summarize.js'
import { unwrapInvocationContext, type InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import { formatStashRefs, mergedMessages } from '../../stash.js'
import { hasPinnedFlag } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  insertMarker,
  markerMessage,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

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

export class SummarizeStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:summarize'

  private readonly _config: SummarizeConfig

  constructor(target?: OffloadTarget, config?: SummarizeConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._config = config ?? {}
  }

  // Pinned messages join a run and are kept after its summary, so the opening run still starts at message 1.
  protected override get _skipsPinned(): boolean {
    return false
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
   * Summarizes each contiguous run of eligible messages into its own summary. When both the summarizer and the
   * agent's model have server-side summaries, the run right after message 0 is summarized server-side together with message 0
   * into a message of its own.
   */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false

    const { messages } = context
    const runs = messageRuns(messages, await this._getEligibleMessages(context))
    // The agent's model sends the stored block natively only when it declares the capability too.
    const opening = this.summarizesServerSide(context.agent) ? openingRun(messages, runs) : undefined
    let acted = false
    // Last run first, so replacing a run leaves the earlier runs' positions unchanged.
    for (const run of runs.reverse()) {
      const summarized =
        run === opening
          ? await this._summarizeOpening(context, model, run)
          : await this._summarizeRun(context, model, run)
      if (summarized) acted = true
    }
    if (acted) repairAlternation(messages)
    return acted
  }

  /**
   * Replaces `run` with a summary marker; a failure is logged and keeps the run. The marker joins the assistant
   * message before the gap, or leads the run's pinned messages and any assistant message after it.
   */
  private async _summarizeRun(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    const { kept, summarized } = splitPinned(run)
    if (summarized.length === 0 || holdsOnlySummaries(summarized)) return false
    const summary = summaryText(await this._trySummarize(run, model, context.agent, context.invocationContext))
    if (!summary) return false

    const { messages } = context
    const totalTokens = await model.countTokens(summarized)
    const start = messages.indexOf(run[0]!)
    const marker = formatSummarized(`${summarized.length} messages`, totalTokens, summary)
    messages.splice(start, run.length, ...kept)
    if (kept.length === 0 && start > 1 && messages[start - 1]!.role === 'assistant') {
      insertMarker(messages, start, marker)
    } else {
      // Its own message, so it leads any assistant content after the gap once alternation is repaired.
      messages.splice(start, 0, markerMessage([new TextBlock(marker)]))
    }
    logger.debug(`summarized=<${summarized.length}>, tokens=<${totalTokens}> | summarized message run`)
    return true
  }

  /**
   * Summarizes the opening run server-side, pinned messages included; without a summary it gets the base one. A
   * message the server-side summary covers can't be kept after its block without breaking the thinking bound to the
   * messages after it, so pins don't keep messages out of it.
   */
  private async _summarizeOpening(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    return (
      (await this._summarizeOpeningServerSide(context, model, run)) || (await this._summarizeRun(context, model, run))
    )
  }

  /**
   * Summarizes message 0 and `run` server-side, keeping message 0 in place. The summary
   * takes the run's place as an assistant message, ahead of any assistant content that follows, and the provider
   * sends its block, which covers message 0, in place of the text. A server-side summary is kept verbatim, since the
   * provider reads it back from the marker.
   */
  private async _summarizeOpeningServerSide(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    if (holdsOnlySummaries(run)) return false
    const { messages, agent, invocationContext } = context
    const result = await this._trySummarize([messages[0]!, ...run], model, agent, invocationContext, true)
    const serverSide = serverSideSummaryOf(result)
    const summary = serverSide?.text ?? summaryText(result)
    if (!result || !summary) return false

    const totalTokens = await model.countTokens(run)
    const text = formatSummarized(`${run.length} messages`, totalTokens, summary)
    const serverSideSummary = serverSide?.metadata?.serverSideSummary
    const block = new TextBlock(text, serverSideSummary ? { metadata: { serverSideSummary } } : undefined)
    messages.splice(1, run.length, markerMessage([block]))
    logger.debug(`summarized=<${run.length}>, tokens=<${totalTokens}> | summarized opening messages server-side`)
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
   * keeps them. A model with server-side summaries is called through its `summarize()` only for `opening`
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
        opening || model.modelInfo?.capabilities?.serverSideSummary !== true
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

  /**
   * Whether this strategy summarizes blocks of older messages the model has already seen. Without `preserveRecent`, a
   * per-block strategy rewrites each block before the model sees it.
   *
   * @internal
   */
  get rewritesSeenBlocks(): boolean {
    return !this._isMessageLevel && this._preserveRecent > 0
  }

  /**
   * Whether this strategy summarizes runs of messages and its summarizer and the agent's model both summarize
   * server-side.
   *
   * @internal
   */
  summarizesServerSide(agent: LocalAgent): boolean {
    const model = this._resolveModel(agent)
    return (
      this._isMessageLevel &&
      model !== undefined &&
      model.modelInfo?.capabilities?.serverSideSummary === true &&
      agent.model.modelInfo?.capabilities?.serverSideSummary === true
    )
  }
}

type SummaryLimit = 'pinned messages' | 'per-block summarization'

const LIMIT_STATEMENTS: Record<SummaryLimit, string> = {
  'pinned messages': 'pinned messages are summarized like any other message by a server-side summary',
  'per-block summarization':
    'per-block summarization with preserveRecent rewrites blocks the model has already seen' +
    ' | thinking from earlier turns will be dropped on the next turns',
}

/**
 * The features in use that a server-side summary doesn't support, for an agent whose model has it. Per-block
 * summarization with `preserveRecent` rewrites blocks the model has already seen, and pinned messages are summarized
 * like any other message.
 *
 * @internal
 */
export function serverSideSummaryLimits(agent: LocalAgent, strategies: ContextStrategy[]): SummaryLimit[] {
  if (agent.model.modelInfo?.capabilities?.serverSideSummary !== true) return []
  const summarizers = strategies.filter((strategy) => strategy instanceof SummarizeStrategy)
  const features: SummaryLimit[] = []
  if (summarizers.some((strategy) => strategy.summarizesServerSide(agent)) && agent.messages.some(hasPinnedFlag)) {
    features.push('pinned messages')
  }
  if (summarizers.some((strategy) => strategy.rewritesSeenBlocks)) features.push('per-block summarization')
  return features
}

/**
 * Logs a warning describing how a server-side summary treats the features in use, if any.
 *
 * @internal
 */
export function warnOnServerSideSummaryLimits(agent: LocalAgent, strategies: ContextStrategy[]): void {
  const features = serverSideSummaryLimits(agent, strategies)
  if (features.length === 0) return
  const statements = features.map((feature) => LIMIT_STATEMENTS[feature])
  logger.warn(`model_id=<${agent.model.modelId}> | ${statements.join(' | ')}`)
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
 * The run right after message 0 that a server-side summary may cover together with message 0: the covered messages
 * start with a user message and alternate roles.
 */
function openingRun(messages: Message[], runs: Message[][]): Message[] | undefined {
  const run = runs[0]
  if (!run || run[0] !== messages[1]) return undefined
  const covered = messages.slice(0, run.length + 1)
  const alternates = covered.every((message, index) => message.role === (index % 2 === 0 ? 'user' : 'assistant'))
  return alternates ? run : undefined
}

/** Splits `message` into the messages merged into it when one of those is pinned, or returns it whole. */
function pieces(message: Message): Message[] {
  const parts = mergedMessages(message)
  if (!parts.some((part) => part.metadata.custom?.pinned === true)) return [message]
  return parts.map(
    (part, index) =>
      new Message({
        role: message.role,
        content: message.content.slice(part.offset, parts[index + 1]?.offset ?? message.content.length),
        trackingId: part.trackingId,
        metadata: part.metadata,
      })
  )
}

function toolUseIds(message: Message): string[] {
  return message.content.flatMap((block) =>
    block instanceof ToolUseBlock || block instanceof ToolResultBlock ? [block.toolUseId] : []
  )
}

/**
 * Splits `run` into its pinned messages, with their tool-pair partners, and the rest, both in history order. A merged
 * message is split into the messages it combines, so only its pinned ones are kept.
 */
function splitPinned(run: Message[]): { kept: Message[]; summarized: Message[] } {
  const all = run.flatMap(pieces).filter((piece) => piece.content.length > 0)
  const pinnedIds = new Set(all.filter(hasPinnedFlag).flatMap(toolUseIds))
  const isKept = (piece: Message): boolean => hasPinnedFlag(piece) || toolUseIds(piece).some((id) => pinnedIds.has(id))
  return { kept: all.filter(isKept), summarized: all.filter((piece) => !isKept(piece)) }
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

function serverSideSummaryOf(result: SummarizeResult | null): TextBlock | undefined {
  return result?.content.find(
    (block): block is TextBlock => block instanceof TextBlock && block.metadata?.serverSideSummary !== undefined
  )
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
