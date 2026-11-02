/**
 * Base offload strategy: conditions, target routing, eager hooks, and the shared per-block and
 * message-level execution paths.
 */

import { logger } from '../../../logging/logger.js'
import { warnOnce } from '../../../logging/warn-once.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import { isOffloaded, Message, TextBlock, type OffloadMethod, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import type { Stash } from '../../stash.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'
import { formatElided, offloadPlaceholder } from '../../placeholder.js'
import { insertMarker, repairAlternation, withPairs } from '../../message-trimming.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import { ResolvedConditions, type OffloadConditions } from './conditions.js'
import { buildToolNameMap, isMediaBlock, isProtocolBlock, OffloadTargetMatcher, type OffloadTarget } from './target.js'

/**
 * Strategy returned by `Offload.drop/truncate/summarize`. Without conditions it acts on each matching block as it
 * arrives, including the one the model answers next; targets `'*'` and `'media'` need conditions from `.when()`. A
 * strategy keeps per-agent state, so give each agent its own.
 *
 * @experimental
 */
export interface OffloadStrategy extends ContextStrategy {
  /** Returns a copy of this strategy with these conditions in place of its current ones. */
  when(conditions?: OffloadConditions): OffloadStrategy
}

/**
 * Writes the placeholder text, such as `[Dropped: 3 messages]` or a summary, for messages about to be removed with
 * their tool pairs. `count` is how many original messages they stand for. Returning null keeps them, as summarize
 * does when its model call fails.
 */
type PlaceholderText = (removed: Message[], count: number) => Promise<string | null>

/** How many original messages `message` stands for: each removal marker counts the messages it replaced. */
function messagesRepresented(message: Message): number {
  let replaced = 0
  let hasContent = false
  for (const block of message.content) {
    const removedMessages = isOffloaded(block) ? block.metadata.offloaded.removedMessages : undefined
    if (removedMessages === undefined) hasContent = true
    else replaced += removedMessages
  }
  return hasContent || replaced === 0 ? replaced + 1 : replaced
}

/**
 * Removes messages with their tool pairs and leaves one placeholder for each contiguous run of them, each stashed
 * under its own reference. A run whose text is null is kept, and a failed stash write leaves the placeholder without
 * a reference. Callers restore alternation once they are done.
 *
 * @returns Whether anything was removed
 * @internal
 */
export async function removeMessages(
  messages: Message[],
  toRemove: Message[],
  textFor: PlaceholderText,
  method: OffloadMethod,
  stash: Stash | undefined
): Promise<boolean> {
  let acted = false
  // Last run first, so removing a run leaves the earlier runs' positions unchanged.
  for (const run of splitIntoRuns(messages, withPairs(messages, toRemove)).reverse()) {
    if (await removeRun(messages, run, textFor, method, stash)) acted = true
  }
  return acted
}

/** Replaces a contiguous run of messages with one placeholder. */
async function removeRun(
  messages: Message[],
  run: Message[],
  textFor: PlaceholderText,
  method: OffloadMethod,
  stash: Stash | undefined
): Promise<boolean> {
  const count = run.reduce((total, message) => total + messagesRepresented(message), 0)
  const text = await textFor(run, count)
  if (text === null) return false

  const start = messages.indexOf(run[0]!)
  messages.splice(start, run.length)
  let stashRef: string | undefined
  try {
    stashRef = await stash?.storeRemoved(run)
  } catch (error) {
    logger.warn(`method=<${method}>, error=<${error}> | failed to stash removed messages`)
  }
  insertMarker(messages, start, offloadPlaceholder(method, text, stashRef, count))
  return true
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

/** Shared offload logic: conditions, firing, granularity, eager hooks, preserveRecent. */
export abstract class BaseOffloadStrategy implements OffloadStrategy {
  readonly name: string

  protected readonly _method: OffloadMethod
  protected readonly _target: OffloadTarget
  protected readonly _matcher: OffloadTargetMatcher
  protected readonly _conditions: ResolvedConditions
  /** Whether the eager hook processes each message as it arrives. */
  private readonly _runsEagerly: boolean
  protected _stash: Stash | undefined

  /**
   * @param method - Offload method; the strategy is named `offload:<method>`
   * @param target - Content the strategy acts on
   * @param conditions - When and how the strategy fires; omitted, it acts on each matching block as it arrives
   * @throws Error when the target is empty or excludes every tool it includes, a condition value is invalid, or
   *   conditions are given that leave the strategy unable to run (see {@link BaseOffloadStrategy.init})
   */
  constructor(method: OffloadMethod, target: OffloadTarget, conditions?: OffloadConditions) {
    this.name = `offload:${method}`
    this._method = method
    this._target = target
    this._matcher = new OffloadTargetMatcher(target)
    this._conditions = new ResolvedConditions(conditions)
    this._runsEagerly = target !== '*' && !this._conditions.defersArrival
    if (conditions) this._checkRunnable()
  }

  /**
   * Returns a copy of this strategy, with the same target and config, under these conditions.
   *
   * @param conditions - When and how the strategy fires
   * @returns The strategy with these conditions. A strategy keeps per-agent state, so give each agent its own.
   * @throws Error when a condition value is invalid, or the conditions leave the strategy unable to run
   */
  abstract when(conditions?: OffloadConditions): BaseOffloadStrategy

  /** Throws if the conditions leave the strategy acting on every message, or removing media unseen. */
  private _checkRunnable(): void {
    const method = this._method
    if (this._target === '*' && this._conditions.isEmpty) {
      throw new Error(
        `Offload.${method}("*") would act on every message; use .when() to set contextUtilization, blockThreshold, or a preserveRecent above 0`
      )
    }
    if (this._target === 'media' && this._runsEagerly) {
      throw new Error(
        `Offload.${method}("media") would remove media before the model sees it; use .when() to set contextUtilization or a preserveRecent above 0`
      )
    }
  }

  /**
   * Checks the conditions can run on this agent, then registers the eager hook if this runs eagerly.
   *
   * @param agent - The agent this strategy is attached to
   * @param stash - The stash offloaded content is stored in
   * @throws Error when a whole-message strategy has none of `contextUtilization`, `blockThreshold`, or
   *   `preserveRecent`, a `'media'` strategy has neither `contextUtilization` nor `preserveRecent`, or
   *   `contextUtilization` is a token count larger than the model's context window
   */
  init(agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
    this._checkRunnable()
    this._conditions.checkFits(agent)
    if (!this._runsEagerly) return
    if (this._conditions.isEmpty) {
      warnOnce(
        logger,
        `strategy=<${this.name}>, target=<${JSON.stringify(this._target)}> | strategy has no conditions, so it acts on every matching block as it arrives, before the model reads it | use .when() to set blockThreshold, contextUtilization, or preserveRecent`
      )
    }
    agent.addHook(MessageAddedEvent, async (event) => {
      const messages = event.agent.messages
      const index = messages.indexOf(event.message)
      if (index >= 0 && isPinned(messages, index)) return
      const threshold = this._conditions.thresholdTokens(event.agent)
      await this._transformBlocks(event.message, messages, buildToolNameMap(messages), threshold, event.agent)
    })
  }

  async apply(context: ContextState): Promise<boolean> {
    if (context.stash) this._stash = context.stash
    if (!this._conditions.reached(context)) return false
    if (this._target !== '*') return this._applyPerBlock(context)
    const acted = await this._applyPerMessage(context)
    if (acted) repairAlternation(context.messages)
    return acted
  }

  /**
   * Message-level execution for target `'*'`, on the messages {@link _getEligibleMessages} returns. `apply` restores
   * alternation afterwards.
   */
  protected abstract _applyPerMessage(context: ContextState): Promise<boolean>

  /** Per-block execution: walk each message, transform individual blocks above threshold. */
  private async _applyPerBlock(context: ContextState): Promise<boolean> {
    const { messages, agent, invocationContext } = context
    const toolNameMap = buildToolNameMap(messages)
    const threshold = this._conditions.thresholdTokens(agent)
    let acted = false
    for (const message of this._candidates(messages, toolNameMap)) {
      // Without the eager hook, message 0 is the task and the last message is one the model has not yet responded to.
      if (!this._runsEagerly && (message === messages[0] || message === messages.at(-1))) continue
      if (await this._transformBlocks(message, messages, toolNameMap, threshold, agent, invocationContext)) acted = true
    }
    return acted
  }

  /** Matching messages outside `preserveRecent`, without pinned ones, in history order. */
  private _candidates(messages: Message[], toolNameMap: Map<string, string>): Message[] {
    const matching = messages.filter((message) => this._matcher.matchesMessage(message, toolNameMap))
    return this._conditions
      .withoutPreserved(matching)
      .filter((message) => !isPinned(messages, messages.indexOf(message)))
  }

  /** Messages outside `preserveRecent` and larger than `blockThreshold`, excluding message 0 and pinned messages. */
  protected async _getEligibleMessages(context: ContextState): Promise<Message[]> {
    const { messages, agent } = context
    const eligible = this._candidates(messages, buildToolNameMap(messages)).filter((message) => message !== messages[0])
    const threshold = this._conditions.thresholdTokens(agent)
    if (threshold === undefined) return eligible

    const sizes = await Promise.all(eligible.map((message) => agent.model.countTokens([message])))
    return eligible.filter((_message, index) => sizes[index]! > threshold)
  }

  /** The placeholder this strategy leaves for a block it replaced. */
  protected _placeholder(preview: string, stashRef: string | undefined): TextBlock {
    return offloadPlaceholder(this._method, preview, stashRef)
  }

  /** Whether a block in `message` is content this strategy may replace. */
  private _isOffloadable(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (isProtocolBlock(block) || isOffloaded(block) || (block instanceof TextBlock && block.text.trim() === ''))
      return false
    if (block instanceof ToolResultBlock && this._isProtectedResult(block, toolNameMap)) return false
    return this._matcher.matchesBlock(block, message, toolNameMap)
  }

  /**
   * Whether a tool result is the retrieval tool's output, or already holds a placeholder this strategy shouldn't
   * replace. Only drop goes further, since truncate and summarize would read the placeholder as the content.
   */
  private _isProtectedResult(block: ToolResultBlock, toolNameMap: Map<string, string>): boolean {
    if (this._stash && toolNameMap.get(block.toolUseId) === RETRIEVAL_TOOL_NAME) return true
    const placeholder = block.content.find(isOffloaded)
    return placeholder !== undefined && (this._method !== 'drop' || placeholder.metadata.offloaded.method === 'drop')
  }

  /** Process eligible blocks in a message, replacing each one larger than `threshold` tokens, or every one if unset. */
  protected async _transformBlocks(
    message: Message,
    messages: Message[],
    toolNameMap: Map<string, string>,
    threshold: number | undefined,
    agent: LocalAgent,
    invocationContext?: InvocationContext
  ): Promise<boolean> {
    let acted = false
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (!this._isOffloadable(block, message, toolNameMap)) continue

      const tokens = await agent.model.countTokens([new Message({ role: message.role, content: [block] })])
      // The token heuristic counts media as 0, so unmeasured media is never treated as within the threshold.
      if (threshold !== undefined && tokens <= threshold && !(tokens === 0 && isMediaBlock(block))) continue

      const stashRef = this._stash ? await this._stash.ensureStashed(block, message, blockIndex) : undefined
      const replacement = await this._replaceBlock(block, tokens, message, agent, stashRef, invocationContext)
      if (replacement && replacement !== block) {
        ;(message.content as unknown[])[blockIndex] = replacement
        acted = true
      }
    }
    return acted
  }

  /**
   * Transform a block. Return the replacement, or null to skip.
   * `stashRef` is the reference the original is retrievable under, or `undefined` when there is no stash.
   */
  protected abstract _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRef: string | undefined,
    invocationContext?: InvocationContext
  ): Promise<ContentBlock | null>
}

// --- Emergency truncation strategy ---

const EMERGENCY_REMOVAL_RATIO = 0.2

/**
 * Last-resort strategy that recomputes utilization and drops the oldest 20% of messages
 * when the context window is still overflowing after all user-configured strategies have run.
 * Appended internally by ContextManager — not part of the public builder API.
 * Pins are ignored so an all-pinned overflow is still recoverable.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy implements ContextStrategy {
  readonly name = 'offload:emergency-truncate'

  async apply(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    if (messages.length <= 3) return false
    if (!context.overflow && agent.model.estimateUtilization(await agent.model.countTokens(messages)) < 1.0) {
      return false
    }

    const removable = messages.slice(1)
    let removeCount = Math.max(1, Math.floor(removable.length * EMERGENCY_REMOVAL_RATIO))
    // Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
    if (removable[removeCount]?.role !== 'assistant') removeCount += 1
    const textFor = async (_removed: Message[], count: number): Promise<string> => formatElided(count)
    if (!(await removeMessages(messages, removable.slice(0, removeCount), textFor, 'truncate', context.stash))) {
      return false
    }
    repairAlternation(messages)
    return true
  }
}
