/**
 * Summarize strategy — replaces oversized content with LLM-generated summaries.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { normalizeError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock, type Role } from '../../../types/messages.js'
import { DocumentBlock, ImageBlock } from '../../../types/media.js'
import type { ContentBlock } from '../../../types/messages.js'
import { Model } from '../../../models/model.js'
import { type SummarizeOptions, type SummarizeResult } from '../../../models/summarize.js'
import { unwrapInvocationContext, type InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import { formatSummarized, SUMMARIZED_PREFIX, type SummarizeConfig } from '../../methods/summarize.js'
import { formatStashRefs } from '../../stash.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  collectRemovableWithPair,
  prependContent,
  repairAlternation,
  resolvePreserveCount,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

/**
 * Returns the index of the first message a `Model.summarize()` call keeps verbatim.
 *
 * The cut never separates a `toolUse` from its `toolResult`: it moves forward to summarize the pair together,
 * or back when the `toolResult` is the last message, which the next model call responds to and which is never
 * summarized. A one-message prefix is not cut: after a pass it is that pass's summary, and re-summarizing it
 * alone frees nothing.
 *
 * @param messages - Full conversation history
 * @param preservedMessages - Count or ratio (between 0 and 1 exclusive) of trailing messages to keep; the last
 *   message is always kept, so 0 and 1 cut at the same place
 * @returns The split index; messages before it may be summarized. 0 when nothing should be
 * @internal
 */
export function compactionSplitIndex(messages: Message[], preservedMessages: number): number {
  const kept = resolvePreserveCount(messages.length, preservedMessages)
  let split = Math.min(messages.length - kept, messages.length - 1)
  if (split > 0 && splitsToolPair(messages, split)) {
    split = split < messages.length - 1 ? split + 1 : split - 1
  }
  return split > 1 ? split : 0
}

/** Returns the cut of a recency-only pass: the compaction cut, moved off the last message. */
function recencySplit(messages: Message[], preservedMessages: number): number {
  const split = compactionSplitIndex(messages, preservedMessages)
  const last = messages.length - 1
  if (!(split > 0 && split === last)) return split
  // Placed on the last message, the summary would end the history, so one message stays.
  return split - (splitsToolPair(messages, split - 1) ? 2 : 1)
}

/** Whether a cut before `messages[index]` separates a tool result from the tool use before it. */
function splitsToolPair(messages: Message[], index: number): boolean {
  const hasToolResult = messages[index]!.content.some((block) => block instanceof ToolResultBlock)
  return hasToolResult && messages[index - 1]!.content.some((block) => block instanceof ToolUseBlock)
}

/** Returns the indices of the messages in `selected` and their tool-pair partners, in history order. */
function withToolPairs(messages: Message[], selected: Message[]): number[] {
  const indexOf = new Map(messages.map((message, index) => [message, index]))
  const pairs = selected.map((message) => collectRemovableWithPair(messages, indexOf.get(message)!))
  const indices = new Set(pairs.flat().map((removable) => indexOf.get(removable)!))
  return [...indices].sort((left, right) => left - right)
}

/** Where a summary goes in the history, and its role. */
interface SummarySlot {
  start: number
  role: Role
}

/**
 * Returns the indices to summarize and where their summary goes, so no pinned message gains content, or undefined.
 *
 * A summary inside a pinned message would never be summarized again, so each pass would grow that message. The
 * summary goes at the first run of selected messages whose kept neighbors leave it a role: joining an unpinned
 * neighbor of that role, or standing alone between neighbors of the other role. Every other run is removed only
 * when its kept neighbors alternate, so no two kept messages merge; the rest stay in the history. A tool result
 * whose tool use is pinned counts as pinned, as `isPinned` defines it.
 */
function summaryPlan(messages: Message[], indices: number[]): { indices: number[]; slot: SummarySlot } | undefined {
  const all = runs(indices)
  const slot = firstSlot(messages, all)
  if (!slot) return undefined
  const kept = all.filter((run) => run === slot.run || removable(messages, run)).flat()
  return { indices: kept, slot: { start: slot.run[0]!, role: slot.role } }
}

/**
 * Returns `summaryPlan` for `indices`, or for `indices` without message 0 when that plan cannot take it.
 *
 * Only a server-side compaction of the conversation's start takes message 0: a plan for a model that `compacts` and
 * that is {@link isCompactionPrefix}. Any other summary keeps it verbatim, and a summary that finds no slot otherwise
 * can follow it, before a pinned message of the summary's role. A tool result paired with message 0 is kept with it.
 * Undefined when no plan finds a slot, when the one message left after message 0 holds an earlier summary, or when
 * the plan would summarize only an earlier summary.
 */
function planAfterMessageZero(
  messages: Message[],
  indices: number[],
  compacts: boolean
): { indices: number[]; slot: SummarySlot } | undefined {
  const startsAtZero = indices[0] === 0
  let plan = compacts || !startsAtZero ? summaryPlan(messages, indices) : undefined
  const takesMessageZero = compacts && plan !== undefined && isCompactionPrefix(messages, plan.indices)
  if (startsAtZero && !takesMessageZero) {
    const keptHead = messages.length > 1 && splitsToolPair(messages, 1) ? 2 : 1
    const rest = indices.filter((index) => index >= keptHead)
    // After a pass behind a pinned message, the one message left after message 0 holds that pass's summary.
    const loneSummary = rest.length === 1 && holdsSummary(messages[rest[0]!]!)
    plan = rest.length === 0 || loneSummary ? undefined : summaryPlan(messages, rest)
  }
  return plan && !isLoneSummary(messages, plan.indices) ? plan : undefined
}

/** Whether `indices` is the conversation's start, opening with a user turn and alternating. */
function isCompactionPrefix(messages: Message[], indices: number[]): boolean {
  const selected = indices.map((index) => messages[index]!)
  return indices.every((index, position) => index === position) && messages[0]!.role === 'user' && alternates(selected)
}

/** Splits sorted `indices` into runs of consecutive indices. */
function runs(indices: number[]): number[][] {
  const result: number[][] = []
  for (const index of indices) {
    const last = result.at(-1)
    if (last && last.at(-1) === index - 1) last.push(index)
    else result.push([index])
  }
  return result
}

/** Returns the first run a summary can take the place of, and the summary's role there, or undefined. */
function firstSlot(messages: Message[], all: number[][]): { run: number[]; role: Role } | undefined {
  for (const run of all) {
    const role = slotRole(messages, run)
    if (role) return { run, role }
  }
  return undefined
}

/** Whether removing `run` leaves its kept neighbors alternating, so no two kept messages merge. */
function removable(messages: Message[], run: number[]): boolean {
  const start = run[0]!
  const after = messages[run.at(-1)! + 1]
  if (!after) return false
  return (messages[start - 1]?.role ?? 'assistant') !== after.role
}

const OTHER_ROLE: Record<Role, Role> = { user: 'assistant', assistant: 'user' }

/**
 * Returns the role of a summary in place of `run`, preferring to follow the message before it, if any fits.
 *
 * A role fits when no locked neighbor has it.
 */
function slotRole(messages: Message[], run: number[]): Role | undefined {
  const start = run[0]!
  const end = run.at(-1)! + 1
  const locked = lockedRoles(messages, start, end)
  const before = messages[start - 1]?.role
  const after = messages[end]?.role
  let roles: Role[] = ['user']
  if (before) roles = after === before ? [OTHER_ROLE[before]] : [before, OTHER_ROLE[before]]
  return roles.find((role) => !locked.has(role))
}

/** Whether no two consecutive `messages` share a role. */
function alternates(messages: Message[]): boolean {
  return messages.every((message, index) => index === 0 || messages[index - 1]!.role !== message.role)
}

/** Whether `message` holds only `[Summarized: ...]` markers. */
function isSummary(message: Message): boolean {
  return message.content.every((block) => block instanceof TextBlock && block.text.startsWith(SUMMARIZED_PREFIX))
}

/** Whether `message` holds a `[Summarized: ...]` marker, alone or joined to its own content. */
function holdsSummary(message: Message): boolean {
  return message.content.some((block) => block instanceof TextBlock && block.text.startsWith(SUMMARIZED_PREFIX))
}

/** Whether `indices` is one earlier summary, which re-summarizing frees nothing from. */
function isLoneSummary(messages: Message[], indices: number[]): boolean {
  return indices.length === 1 && isSummary(messages[indices[0]!]!)
}

/**
 * Returns the roles of the locked neighbors of `messages.slice(start, end)`.
 *
 * A neighbor is locked when it is pinned, or when it is message 0 and the run starts at 1.
 */
function lockedRoles(messages: Message[], start: number, end: number): Set<Role> {
  const locked = [start - 1, end].filter((index) => index >= 0 && index < messages.length && isPinned(messages, index))
  if (start === 1) locked.push(0)
  return new Set(locked.map((index) => messages[index]!.role))
}

/**
 * Replaces the messages at `indices` with `summary` at `slot`, or leaves `messages` unchanged.
 *
 * A text summary takes the slot's role. When a kept neighbor has that role, the summary joins it, keeping that
 * message's tracking id and metadata, and stash refs to its blocks resolve; otherwise it stands alone.
 *
 * A summary holding other content, such as an override's provider-native compaction block, is placed verbatim:
 * its own message with its own role, never joined with another. It fits only between kept neighbors of the other
 * role, so it must take the role of the last message it summarizes when the kept messages alternate; the provider
 * that returned it decides whether it may open the history. When it does not fit, `messages` is left unchanged.
 *
 * @returns Whether the summary was placed
 */
function placeSummary(messages: Message[], indices: number[], slot: SummarySlot, summary: Message): boolean {
  const removed = new Set(indices)
  const kept = messages.filter((_, index) => !removed.has(index))
  const position = slot.start - indices.filter((index) => index < slot.start).length
  if (isText(summary)) joinOrInsert(kept, position, slot.role, summary)
  else if (alternatesAt(kept, position, summary.role)) kept.splice(position, 0, summary)
  else return false
  repairAlternation(kept)
  messages.splice(0, messages.length, ...kept)
  return true
}

/** Whether `summary` holds only text blocks. */
function isText(summary: Message): boolean {
  return summary.content.every((block) => block instanceof TextBlock)
}

/** Whether a message of `role` inserted at `position` differs in role from both its neighbors. */
function alternatesAt(messages: Message[], position: number, role: Role): boolean {
  return messages.slice(Math.max(position - 1, 0), position + 1).every((neighbor) => neighbor.role !== role)
}

/**
 * Joins `summary`'s content to the kept neighbor of `role` at `position`, or inserts it there alone.
 *
 * The summary covers the history before `position`, so it ends the neighbor before it and opens a user message after
 * it. An assistant message after it gets the summary at its end, so a leading reasoning block stays first; a user
 * message opening with a tool result does too, since tool results come first.
 */
function joinOrInsert(messages: Message[], position: number, role: Role, summary: Message): void {
  const carrier = carrierIndex(messages, position, role)
  if (carrier === undefined) {
    messages.splice(position, 0, new Message({ role, content: summary.content }))
    return
  }
  if (carrier === position && role === 'user' && !(messages[carrier]!.content[0] instanceof ToolResultBlock)) {
    messages[carrier] = prependContent(new Message({ role, content: summary.content }), messages[carrier]!)
    return
  }
  const joined = messages[carrier]!
  messages[carrier] = new Message({
    role: joined.role,
    content: [...joined.content, ...summary.content],
    trackingId: joined.trackingId,
    ...(joined.metadata ? { metadata: joined.metadata } : {}),
  })
}

/**
 * Returns a text summary as one block under a `[Summarized: ...]` header for the `summarized` messages.
 *
 * A summary holding other content, such as an override's provider-native compaction block, is returned unchanged:
 * the provider needs it back as it sent it.
 */
async function withSummarizedMarker(summary: Message, summarized: Message[], model: Model): Promise<Message> {
  if (!isText(summary)) return summary
  const tokens = await model.countTokens(summarized)
  const text = summary.content.map((block) => (block as TextBlock).text).join('\n')
  const marker = formatSummarized(`${summarized.length} messages`, tokens, text)
  return new Message({ role: summary.role, content: [new TextBlock(marker)] })
}

/**
 * Returns the index of the kept neighbor of `role` the summary joins, or undefined when it stands alone.
 *
 * Message 0 is never a carrier unless the summary takes the place of the messages before it.
 */
function carrierIndex(messages: Message[], position: number, role: Role): number | undefined {
  if (position > 1 && messages[position - 1]!.role === role) return position - 1
  if (messages[position]?.role === role) return position
  return undefined
}

/** Whether `model` replaces the base `Model.summarize()`, as a server-side compaction does. */
function overridesSummarize(model: Model): boolean {
  return model.summarize !== Model.prototype.summarize
}

/** Adds a `Model.summarize()` call's usage, if it reported any, to the request it ran in. */
function recordSummaryUsage(invocationContext: InvocationContext | undefined, result: SummarizeResult): void {
  if (result.usage) unwrapInvocationContext(invocationContext)?.recordUsage(result.usage)
}

/** Returns the `toolUse` block with `toolUseId` in `messages`, if any. */
function toolUseFor(messages: Message[], toolUseId: string): ToolUseBlock | undefined {
  const blocks = messages.flatMap((message) => message.content)
  return blocks.find((block): block is ToolUseBlock => block instanceof ToolUseBlock && block.toolUseId === toolUseId)
}

/**
 * Returns the `Model.summarize()` input for one block of `message`.
 *
 * The block goes in a message of `message`'s role. A tool result follows the tool use it answers, when the history
 * holds it, so the summarizer sees which tool produced it.
 */
function blockRequest(block: ContentBlock, message: Message, messages: Message[]): Message[] {
  const request = [new Message({ role: message.role, content: [block] })]
  const toolUse = block instanceof ToolResultBlock ? toolUseFor(messages, block.toolUseId) : undefined
  return toolUse ? [new Message({ role: 'assistant', content: [toolUse] }), ...request] : request
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
   * Returns the indices of the messages this pass summarizes, in history order, leaving out pinned ones.
   *
   * A recency-only pass takes the messages before the compaction cut, message 0 included, which planning keeps
   * unless a server-side compaction replaces it; a target or threshold pass takes the eligible messages and their
   * tool pairs.
   */
  private async _select(context: ContextState): Promise<number[]> {
    const { messages } = context
    const recencyOnly = (this._target === undefined || this._target === '*') && this._threshold === undefined
    if (!recencyOnly) {
      const indices = withToolPairs(messages, await this._getEligibleMessages(context))
      return isLoneSummary(messages, indices) ? [] : indices
    }
    const split = recencySplit(messages, this._preserveRecent)
    const selected: number[] = []
    for (let index = 0; index < split; index++) if (!isPinned(messages, index)) selected.push(index)
    // After a pass behind a pinned message, the only unpinned message before the cut is that pass's summary.
    return selected.length > 1 ? selected : []
  }

  /** Replaces the selected messages with `model.summarize()`'s summary of them. */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const model = this._resolveModel(context.agent)
    if (!model) return false
    const selected = await this._select(context)
    if (selected.length === 0) return false
    const { messages, agent } = context
    const plan = planAfterMessageZero(messages, selected, overridesSummarize(model))
    if (!plan) {
      logger.debug(`summarized=<${selected.length}> | no place for a summary that frees context`)
      return false
    }
    const { indices, slot } = plan

    const summarized = indices.map((index) => messages[index]!)
    const options = this._summarizeOptions(agent)
    // Planning leaves message 0 in only for a provider override's server-side compaction of the conversation's
    // start; any other selection gets the base summary.
    const result =
      indices[0] === 0
        ? await model.summarize(summarized, options)
        : await Model.prototype.summarize.call(model, summarized, options)
    recordSummaryUsage(context.invocationContext, result)
    if (result.summary.content.length === 0) {
      logger.warn(`summarized=<${indices.length}> | model summarize returned no summary | leaving history unchanged`)
      return false
    }

    const summary = await withSummarizedMarker(result.summary, summarized, model)
    if (!placeSummary(messages, indices, slot, summary)) {
      logger.warn(
        `summarized=<${indices.length}>, role=<${summary.role}> | summary does not alternate with the kept messages | leaving history unchanged`
      )
      return false
    }
    logger.debug(`summarized=<${indices.length}> | compacted messages`)
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
      const summary = await this._trySummarize(block, model, message, agent, invocationContext)
      if (!summary) return null

      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | summarized tool result`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [new TextBlock(`${formatSummarized('tool result', tokens, summary)}${formatStashRefs(stashRefs)}`)],
      })
    }

    if (block instanceof TextBlock) {
      const summary = await this._trySummarize(new TextBlock(block.text), model, message, agent, invocationContext)
      if (!summary) return null

      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized text block`)
      return new TextBlock(`${formatSummarized('text block', tokens, summary)}${formatStashRefs(stashRefs)}`)
    }

    const media = block instanceof ImageBlock || block instanceof DocumentBlock
    const summary = media ? await this._trySummarize(block, model, message, agent, invocationContext) : null
    if (summary) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | summarized media block`)
      return new TextBlock(`${formatSummarized('media block', tokens, summary)}${formatStashRefs(stashRefs)}`)
    }

    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${formatStashRefs(stashRefs)}`)
  }

  /** Summarizes one block; a failure is logged and leaves the block unsummarized so the pass continues. */
  private async _trySummarize(
    block: ContentBlock,
    model: Model,
    message: Message,
    agent: LocalAgent,
    invocationContext?: InvocationContext
  ): Promise<string | null> {
    let result: SummarizeResult
    try {
      // A lone block is not the conversation's start, so it gets the base summary.
      result = await Model.prototype.summarize.call(model, blockRequest(block, message, agent.messages), {
        ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
        cancelSignal: agent.cancelSignal,
      })
    } catch (error) {
      logger.warn(
        `trackingId=<${message.trackingId}>, error=<${normalizeError(error).message}> | block summarization failed`
      )
      return null
    }
    recordSummaryUsage(invocationContext, result)
    return (result.summary.content[0] as TextBlock | undefined)?.text ?? null
  }

  /** Returns the `Model.summarize()` options of a message-level summary. */
  private _summarizeOptions(agent: LocalAgent): SummarizeOptions {
    return {
      // A server-side compaction must carry the live system prompt and tools, or the provider
      // treats it as a different conversation.
      ...(agent.systemPrompt !== undefined && { systemPrompt: agent.systemPrompt }),
      toolSpecs: agent.toolRegistry.list().map((tool) => tool.toolSpec),
      ...(this._config.systemPrompt !== undefined && { instructions: this._config.systemPrompt }),
      cancelSignal: agent.cancelSignal,
    }
  }

  private _resolveModel(agent: LocalAgent): Model | undefined {
    return this._config.model ?? agent.auxModel
  }
}
