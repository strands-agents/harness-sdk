/**
 * Base offload strategy and shared infrastructure.
 */

import { logger } from '../../../logging/logger.js'
import { MessageAddedEvent } from '../../../hooks/events.js'
import {
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  CachePointBlock,
  ReasoningBlock,
} from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import type { Stash } from '../../stash.js'
import { RETRIEVAL_TOOL_NAME } from '../../retrieval-tool.js'

/**
 * Target for offload operations. This union is intentionally extensible — new
 * string-literal members can be added freely as new content categories emerge.
 *
 * - `"toolResults"` — all successful tool result blocks
 * - `"toolResultErrors"` — all failed tool result blocks
 * - `"assistantText"` — text blocks in assistant messages
 * - `"userText"` — text blocks in user messages (excluding tool results)
 * - `string[]` — tool results from specific tools, namespaced with `tool::` (e.g. `['tool::bash']`); prefix with `!` to exclude
 * - `"*"` — all content in the context window (tool results + text blocks)
 *
 * @experimental
 */
export type OffloadTarget = '*' | 'toolResults' | 'toolResultErrors' | 'assistantText' | 'userText' | string[]

/**
 * Conditions that determine when an offload strategy fires.
 *
 * Granularity is determined by which conditions are set:
 * - `threshold` only → per-block, eager (act on each block above this size on message arrival)
 * - `utilization` only → message-level (remove/summarize oldest messages when utilization exceeded)
 * - Both → message-level, targeting only messages with blocks over the threshold
 *
 * When multiple strategies target the same content, they don't conflict — strategies
 * run as an ordered pipeline, and once an earlier strategy shrinks a block, it falls
 * below the next strategy's threshold and gets skipped automatically.
 *
 * @experimental
 */
export interface OffloadConditions {
  /** Token threshold above which individual blocks are offloaded. */
  threshold?: number

  /** Context utilization ratio (0-1+) above which the strategy fires. */
  utilization?: number

  /** Number of most recent matching messages to leave untouched. */
  preserveRecent?: number
}

/**
 * Intermediate builder result that allows chaining `.when()` conditions.
 * Also implements `ContextStrategy` directly so it can be used without `.when()`.
 */
export interface OffloadStrategyBuilder extends ContextStrategy {
  /** Add conditions that determine when this strategy fires. */
  when(conditions: OffloadConditions): ContextStrategy
}

// --- Shared helpers ---

function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined
}

/**
 * Builds a toolUseId → toolName map from all assistant messages in the conversation.
 * Called once per apply() to avoid O(messages × toolResults) scanning.
 */
export function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) {
        map.set(block.toolUseId, block.name)
      }
    }
  }
  return map
}

export function toolMatchesTarget(
  block: ToolResultBlock,
  target: OffloadTarget,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): boolean {
  if (target === '*') return true
  if (target === 'toolResults') return block.status === 'success'
  if (target === 'toolResultErrors') return block.status === 'error'

  const toolName = toolNameMap.get(block.toolUseId)
  if (!toolName) return false

  if (toolExcludeFilter) return !toolExcludeFilter.has(toolName)
  if (toolIncludeFilter) return toolIncludeFilter.has(toolName)

  return false
}

export function targetMatchesMessage(target: OffloadTarget | undefined, message: Message): boolean {
  if (target === undefined || target === '*') return true
  if (target === 'assistantText')
    return message.role === 'assistant' && message.content.some((b) => b instanceof TextBlock)
  if (target === 'userText') return message.role === 'user' && message.content.some((b) => b instanceof TextBlock)
  return false
}

export function messageMatchesTarget(
  message: Message,
  target: OffloadTarget | undefined,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): boolean {
  if (targetMatchesMessage(target, message)) return true
  if (!target) return false

  // Tool result targets — must be a user message with a matching tool result
  if (message.role !== 'user') return false
  for (const block of message.content) {
    if (block instanceof ToolResultBlock) {
      if (toolMatchesTarget(block, target, toolNameMap, toolIncludeFilter, toolExcludeFilter)) return true
    }
  }
  return false
}

/**
 * Returns target-matching messages excluding the N most recent matches.
 * First filters to only messages that match the target, then removes the last N from that set.
 */
export function getOldestMatches(
  messages: Message[],
  target: OffloadTarget | undefined,
  count: number,
  toolNameMap: Map<string, string>,
  toolIncludeFilter: Set<string> | undefined,
  toolExcludeFilter: Set<string> | undefined
): Message[] {
  const matching = messages.filter((message) =>
    messageMatchesTarget(message, target, toolNameMap, toolIncludeFilter, toolExcludeFilter)
  )
  if (count >= matching.length) return []
  return matching.slice(0, -count)
}

/**
 * Collects a message and its paired partner (if any) for safe removal.
 * If removing a message would orphan a tool-use/tool-result pair, includes the partner
 * so the pair is removed together. Skips messages[0] (head-pin).
 */
export function collectRemovableWithPair(messages: Message[], index: number): Message[] {
  const message = messages[index]
  if (!message) return []
  if (index === 0) return []

  const result: Message[] = [message]

  const hasToolResult = message.content.some((block) => block instanceof ToolResultBlock)
  if (hasToolResult) {
    const prev = messages[index - 1]
    if (prev && prev.content.some((block) => block instanceof ToolUseBlock)) {
      if (index - 1 > 0) result.push(prev)
      else return []
    }
  }

  const hasToolUse = message.content.some((block) => block instanceof ToolUseBlock)
  if (hasToolUse && index < messages.length - 1) {
    const next = messages[index + 1]
    if (next && next.content.some((block) => block instanceof ToolResultBlock)) {
      result.push(next)
    }
  }

  return result
}

/**
 * Collects removable messages (with their tool pairs), then splices them from the array.
 * Returns the number of messages removed and the lowest index that was removed.
 */
export function spliceWithPairs(messages: Message[], toRemove: Message[]): { removed: number; lowestIndex: number } {
  const toSplice = new Set<Message>()
  for (const message of toRemove) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    for (const removable of collectRemovableWithPair(messages, index)) {
      toSplice.add(removable)
    }
  }

  let removed = 0
  let lowestIndex = messages.length
  for (const message of toSplice) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    if (index < lowestIndex) lowestIndex = index
    messages.splice(index, 1)
    removed++
  }
  return { removed, lowestIndex }
}

/**
 * Merges consecutive same-role messages to restore the user/assistant alternation
 * that Anthropic/Bedrock APIs require. Called after message-level operations that
 * may leave gaps. Constructs new Message objects for merges to avoid mutating
 * objects that may be referenced elsewhere (session storage, event payloads).
 */
export function repairAlternation(messages: Message[]): void {
  let writeIndex = 0
  for (let readIndex = 0; readIndex < messages.length; readIndex++) {
    const current = messages[readIndex]!
    if (writeIndex > 0 && messages[writeIndex - 1]!.role === current.role) {
      const prev = messages[writeIndex - 1]!
      messages[writeIndex - 1] = new Message({
        role: prev.role,
        content: [...prev.content, ...current.content],
        trackingId: prev.trackingId,
      })
    } else {
      messages[writeIndex] = current
      writeIndex++
    }
  }
  messages.length = writeIndex
}

/**
 * Parses a string[] target into include/exclude filter sets.
 * Entries must be prefixed with `tool::` (e.g. `'tool::bash'`).
 * An additional `!` prefix excludes (e.g. `'!tool::bash'`).
 */
export function resolveToolFilter(target: OffloadTarget | undefined): { include?: Set<string>; exclude?: Set<string> } {
  if (!Array.isArray(target)) return {}

  const TOOL_PREFIX = 'tool::'
  const includes: string[] = []
  const excludes: string[] = []

  for (const entry of target) {
    if (entry.startsWith('!')) {
      const name = entry.slice(1)
      excludes.push(name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name)
    } else {
      includes.push(entry.startsWith(TOOL_PREFIX) ? entry.slice(TOOL_PREFIX.length) : entry)
    }
  }

  if (excludes.length > 0 && includes.length > 0) {
    logger.warn('tool filter contains both includes and excludes, excludes will be ignored')
    return { include: new Set(includes) }
  }
  if (excludes.length > 0) {
    return { exclude: new Set(excludes) }
  }
  if (includes.length > 0) {
    return { include: new Set(includes) }
  }

  return {}
}

// --- Base strategy class ---

/** Shared offload logic: target routing, eager hooks, preserveRecent. */
export abstract class BaseOffloadStrategy implements ContextStrategy {
  abstract readonly name: string

  protected readonly _target: OffloadTarget | undefined
  protected readonly _threshold: number | undefined
  protected readonly _utilizationThreshold: number | undefined
  protected readonly _preserveRecent: number
  protected readonly _removalRatio: number = 0.3
  protected readonly _includeFilter: Set<string> | undefined
  protected readonly _excludeFilter: Set<string> | undefined
  protected _stash: Stash | undefined

  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    if (Array.isArray(target) && target.length === 0) {
      throw new Error('Empty array target matches nothing — provide at least one target')
    }

    this._target = target
    this._threshold = finiteOrUndefined(conditions?.threshold)
    this._utilizationThreshold = finiteOrUndefined(conditions?.utilization)
    this._preserveRecent = Math.floor(finiteOrUndefined(conditions?.preserveRecent) ?? 0)

    const resolved = resolveToolFilter(target)
    this._includeFilter = resolved.include
    this._excludeFilter = resolved.exclude
  }

  /** Whether this strategy operates at message-level (batch) vs per-block. */
  protected get _isMessageLevel(): boolean {
    return this._utilizationThreshold !== undefined
  }

  init(agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
    if (this._isMessageLevel) return
    if (this._preserveRecent > 0) return
    agent.addHook(MessageAddedEvent, async (event) => {
      const messages = event.agent.messages
      const toolNameMap = buildToolNameMap(messages)
      await this._transformBlocks(event.message, messages, toolNameMap, event.agent)
    })
  }

  async apply(context: ContextState): Promise<boolean> {
    if (context.stash) this._stash = context.stash
    if (this._isMessageLevel) {
      if (context.utilization < this._utilizationThreshold!) return false
      return this._applyPerMessage(context)
    }

    return this._applyPerBlock(context)
  }

  /** Per-block execution: walk each message, transform individual blocks above threshold. */
  private async _applyPerBlock(context: ContextState): Promise<boolean> {
    const { messages, agent } = context
    const toolNameMap = buildToolNameMap(messages)
    const eligible =
      this._preserveRecent > 0
        ? getOldestMatches(
            messages,
            this._target,
            this._preserveRecent,
            toolNameMap,
            this._includeFilter,
            this._excludeFilter
          )
        : messages
    let acted = false

    for (const message of eligible) {
      if (await this._transformBlocks(message, messages, toolNameMap, agent)) {
        acted = true
      }
    }

    return acted
  }

  /** Message-level execution: remove oldest 30% of eligible messages with pair safety. */
  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    const targetRemoval = Math.max(1, Math.floor(eligible.length * this._removalRatio))
    const toRemove = eligible.slice(0, targetRemoval)

    const { removed, lowestIndex } = spliceWithPairs(messages, toRemove)
    if (removed === 0) return false

    const marker = this._makeRemovalMarker(removed)
    if (marker) {
      const insertIndex = Math.max(1, Math.min(lowestIndex, messages.length))
      messages.splice(insertIndex, 0, new Message({ role: 'user', content: [new TextBlock(marker)] }))
    }

    repairAlternation(messages)
    return true
  }

  /** Override to insert a marker when messages are removed. Return null for no marker. */
  protected _makeRemovalMarker(_count: number): string | null {
    return null
  }

  /** Whether a block is eligible for offload given the current target and filters. */
  protected _blockMatchesTarget(block: ContentBlock, message: Message, toolNameMap: Map<string, string>): boolean {
    if (block instanceof ToolUseBlock) return false
    if (block instanceof CachePointBlock) return false
    if (block instanceof ReasoningBlock) return false
    if (block instanceof TextBlock) return targetMatchesMessage(this._target, message)
    if (block instanceof ToolResultBlock) {
      if (this._stash && toolNameMap.get(block.toolUseId) === RETRIEVAL_TOOL_NAME) return false
      return (
        this._target === undefined ||
        toolMatchesTarget(block, this._target, toolNameMap, this._includeFilter, this._excludeFilter)
      )
    }
    if (this._target === '*' || this._target === undefined) return true
    return false
  }

  /** Process eligible blocks in a message. */
  protected async _transformBlocks(
    message: Message,
    messages: Message[],
    toolNameMap: Map<string, string>,
    agent: LocalAgent
  ): Promise<boolean> {
    const effectiveThreshold = this._threshold ?? 0
    let acted = false
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex]!
      if (!this._blockMatchesTarget(block, message, toolNameMap)) continue

      const tokens = await agent.model.countTokens([new Message({ role: message.role, content: [block] })])
      if (tokens <= effectiveThreshold) continue

      const stashRefs = this._stash?.refsFor(block, message, blockIndex) ?? []
      const replacement = await this._replaceBlock(block, tokens, message, agent, stashRefs)
      if (replacement && replacement !== block) {
        ;(message.content as unknown[])[blockIndex] = replacement
        acted = true
      }
    }
    return acted
  }

  /** Collect eligible messages for message-level operations, respecting preserveRecent, head-pin, and threshold. */
  protected async _getEligibleMessages(context: ContextState): Promise<Message[]> {
    const { messages, agent } = context
    const toolNameMap = buildToolNameMap(messages)

    let candidates: Message[]
    if (this._preserveRecent > 0) {
      candidates = getOldestMatches(
        messages,
        this._target,
        this._preserveRecent,
        toolNameMap,
        this._includeFilter,
        this._excludeFilter
      ).filter((message) => messages.indexOf(message) > 0)
    } else {
      candidates = messages.filter(
        (message, index) =>
          index > 0 &&
          messageMatchesTarget(message, this._target, toolNameMap, this._includeFilter, this._excludeFilter)
      )
    }

    if (this._threshold === undefined) return candidates

    const eligible: Message[] = []
    for (const message of candidates) {
      let hasOversize = false
      for (const block of message.content) {
        if (!this._blockMatchesTarget(block, message, toolNameMap)) continue

        const tokens = await agent.model.countTokens([new Message({ role: message.role, content: [block] })])
        if (tokens > this._threshold!) {
          hasOversize = true
          break
        }
      }
      if (hasOversize) eligible.push(message)
    }
    return eligible
  }

  /** Transform a block. Return the replacement, or null to skip. */
  protected abstract _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    agent: LocalAgent,
    stashRefs: string[]
  ): Promise<ContentBlock | null>
}

// --- Emergency truncation strategy ---

/**
 * Last-resort strategy that recomputes utilization and drops the oldest 20% of messages
 * when the context window is still overflowing after all user-configured strategies have run.
 * Appended internally by ContextManager — not part of the public builder API.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:emergency-truncate'
  protected override readonly _removalRatio = 0.2

  constructor() {
    super('*')
  }

  override init(_agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
  }

  override async apply(context: ContextState): Promise<boolean> {
    if (context.messages.length <= 3) return false
    const tokens = await context.agent.model.countTokens(context.messages)
    const utilization = context.agent.model.estimateUtilization(tokens)
    if (utilization < 1.0) return false
    return this._applyPerMessage({ ...context, utilization })
  }

  protected async _replaceBlock(): Promise<ContentBlock | null> {
    return null
  }
}
