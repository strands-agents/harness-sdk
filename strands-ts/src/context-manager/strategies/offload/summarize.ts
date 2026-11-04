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
import { formatStashRefs } from '../../stash.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  insertMarker,
  markerMessage,
  repairAlternation,
  spliceWithPairs,
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

type SummaryLimit = 'pinned messages' | 'per-block summarization'

const LIMIT_STATEMENTS: Record<SummaryLimit, string> = {
  'pinned messages':
    'pinned messages are kept after a server-side summary' +
    ' | thinking in the messages kept after the summary will be dropped',
  'per-block summarization':
    'per-block summarization with preserveRecent rewrites blocks the model has already seen' +
    ' | thinking from earlier turns will be dropped on the next turns',
}

export class SummarizeStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:summarize'

  private readonly _config: SummarizeConfig
  private readonly _warned = new Set<SummaryLimit>()

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
   * Summarizes the eligible messages other than pinned ones into one summary, leaving pinned messages in place. When
   * both the summarizer and the agent's model have server-side summaries, the run right after message 0, pinned
   * messages included, is summarized server-side together with message 0 first, and its pinned messages are kept after
   * the summary.
   */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false

    const { messages } = context
    let unpinned = await this._getEligibleMessages(context)
    let acted = false
    if (this.summarizesServerSide(context.agent)) {
      const selected = await this._getEligibleMessages(context, false)
      const opening = openingRun(messages, messageRuns(messages, selected))
      if (opening && (await this._summarizeOpeningServerSide(context, model, opening))) {
        const covered = new Set(opening)
        unpinned = unpinned.filter((message) => !covered.has(message))
        acted = true
      }
    }
    if (await this._summarizeClientSide(context, model, unpinned)) acted = true
    if (acted) repairAlternation(messages)
    return acted
  }

  /**
   * Replaces `selected` and their tool pairs with one summary marker; a failure is logged and keeps them. The marker
   * joins the assistant message before the earliest removed message, or becomes its own message there, which leads
   * any assistant content after it once alternation is repaired.
   */
  private async _summarizeClientSide(context: ContextState, model: Model, selected: Message[]): Promise<boolean> {
    const { messages, agent, invocationContext } = context
    const removable = new Set<Message>()
    for (const message of selected) {
      const index = messages.indexOf(message)
      if (index === -1) continue
      for (const partner of collectRemovableWithPair(messages, index)) removable.add(partner)
    }
    const summarized = messages.filter((message) => removable.has(message))
    if (summarized.length === 0 || holdsOnlySummaries(summarized)) return false
    const summary = summaryText(await this._trySummarize(summarized, model, agent, invocationContext))
    if (!summary) return false

    const totalTokens = await model.countTokens(summarized)
    const { removed, lowestIndex: start } = spliceWithPairs(messages, summarized)
    const marker = formatSummarized(`${removed} messages`, totalTokens, summary)
    if (start > 1 && messages[start - 1]!.role === 'assistant') {
      insertMarker(messages, start, marker)
    } else {
      // Its own message, so it leads any assistant content after the gap once alternation is repaired.
      messages.splice(start, 0, markerMessage([new TextBlock(marker)]))
    }
    logger.debug(`summarized=<${removed}>, tokens=<${totalTokens}> | summarized messages`)
    return true
  }

  /**
   * Summarizes message 0 and `run`, pinned messages included, server-side, keeping message 0 in place. The summary
   * takes the run's place as an assistant message, followed by the run's pinned messages and their tool-pair partners,
   * without earlier summaries merged into them. The provider sends its block, which covers message 0, in place of the
   * text; a server-side summary is kept verbatim, since the provider reads it back from the marker. Pinned messages
   * kept after the block invalidate the thinking in the messages after them.
   */
  private async _summarizeOpeningServerSide(context: ContextState, model: Model, run: Message[]): Promise<boolean> {
    const { messages, agent, invocationContext } = context
    const start = messages.indexOf(run[0]!)
    const pinned = new Set(run.filter((_, offset) => isPinned(messages, start + offset)))
    const replaced = run.filter((message) => !pinned.has(message))
    if (replaced.length === 0 || holdsOnlySummaries(replaced)) return false
    const result = await this._trySummarize([messages[0]!, ...run], model, agent, invocationContext, true)
    const serverSide = serverSideSummaryOf(result)
    const summary = serverSide?.text ?? summaryText(result)
    if (!result || !summary) return false

    const totalTokens = await model.countTokens(replaced)
    const text = formatSummarized(`${replaced.length} messages`, totalTokens, summary)
    const serverSideSummary = serverSide?.metadata?.serverSideSummary
    const block = new TextBlock(text, serverSideSummary ? { metadata: { serverSideSummary } } : undefined)
    const kept = run.flatMap((message) => (pinned.has(message) ? withoutSummaries(message) : []))
    messages.splice(1, run.length, markerMessage([block]), ...kept)
    if (kept.length > 0) this._warnOnce(agent, 'pinned messages')
    logger.debug(
      `summarized=<${replaced.length}>, kept=<${kept.length}>, tokens=<${totalTokens}> | summarized opening messages server-side`
    )
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
    if (this._preserveRecent > 0 && agent.model.modelInfo?.capabilities?.serverSideSummary === true) {
      this._warnOnce(agent, 'per-block summarization')
    }

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

  /** Logs, once per strategy, how a server-side summary treats `feature`. */
  private _warnOnce(agent: LocalAgent, feature: SummaryLimit): void {
    if (this._warned.has(feature)) return
    this._warned.add(feature)
    logger.warn(`model_id=<${agent.model.modelId}> | ${LIMIT_STATEMENTS[feature]}`)
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

/** `message` without the earlier summaries merged into it, or nothing when nothing else is left. */
function withoutSummaries(message: Message): Message[] {
  const content = message.content.filter(
    (block) => !(block instanceof TextBlock && block.text.startsWith(SUMMARIZED_PREFIX))
  )
  if (content.length === message.content.length) return [message]
  if (content.length === 0) return []
  return [
    new Message({
      role: message.role,
      content,
      ...(message.trackingId !== undefined && { trackingId: message.trackingId }),
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    }),
  ]
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
