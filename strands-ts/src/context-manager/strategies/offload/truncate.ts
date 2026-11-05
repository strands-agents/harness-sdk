/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { JsonBlock, Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { InvocationContext } from '../../../agent/invocation-context.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState, ContextStrategy } from '../../types.js'
import type { Stash } from '../../stash.js'
import {
  TRUNCATED_PREFIX,
  truncateToolResultBlock,
  truncateTextBlock,
  type TruncateConfig,
} from '../../methods/truncate.js'
import { SUMMARIZED_PREFIX } from '../../methods/summarize.js'
import { formatStashRefs } from '../../stash.js'
import { isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  BaseOffloadStrategy,
  buildToolNameMap,
  insertMarker,
  repairAlternation,
  spliceWithPairs,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  readonly name: string = 'offload:truncate'

  private readonly _truncateConfig: TruncateConfig

  constructor(target?: OffloadTarget, config?: TruncateConfig, conditions?: OffloadConditions) {
    super(target, conditions)
    this._truncateConfig = config ?? {}

    const previewTokens =
      typeof this._truncateConfig.previewTokens === 'number' && Number.isFinite(this._truncateConfig.previewTokens)
        ? this._truncateConfig.previewTokens
        : 1000
    if (
      conditions?.threshold !== undefined &&
      Number.isFinite(conditions.threshold) &&
      conditions.threshold <= previewTokens
    ) {
      throw new Error(
        `threshold (${conditions.threshold}) must be greater than previewTokens (${previewTokens}) to ensure truncation converges`
      )
    }
  }

  when(conditions: OffloadConditions): ContextStrategy {
    return new TruncateStrategy(this._target, this._truncateConfig, conditions)
  }

  protected override _makeRemovalMarker(count: number): string {
    return `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRefs: string[],
    _invocationContext?: InvocationContext,
    config: TruncateConfig = this._truncateConfig
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      const truncated = truncateToolResultBlock(block, config)
      if (truncated !== block) {
        return appendStashRefs(truncated, stashRefs)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, config)
      const refs = formatStashRefs(stashRefs)
      return refs && truncated !== block ? new TextBlock(`${truncated.text}\n\n[Stashed]${refs}`) : truncated
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return new TextBlock(`[Offloaded: ~${tokens} tokens]${formatStashRefs(stashRefs)}`)
  }
}

function appendStashRefs(block: ToolResultBlock, stashRefs: string[]): ToolResultBlock {
  const refs = formatStashRefs(stashRefs)
  if (!refs) return block

  const content = [...block.content]
  for (let index = 0; index < content.length; index++) {
    const item = content[index]!
    if (item instanceof TextBlock) {
      content[index] = new TextBlock(`${item.text}\n\n[Stashed]${refs}`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content,
      })
    }
  }
  return block
}

// --- Emergency truncation strategy ---

const EMERGENCY_REMOVAL_RATIO = 0.2
const EMERGENCY_TARGET_UTILIZATION = 0.9
const EMERGENCY_MIN_CUT = 0.25
const DEFAULT_PREVIEW_TOKENS = 1000
const CHARS_PER_TOKEN = 4
const FULL_PREVIEW_CHARS = DEFAULT_PREVIEW_TOKENS * CHARS_PER_TOKEN

/** Characters of previewable text in a block: its text, or the joined text and JSON items of a tool result. */
function textSize(block: ContentBlock): number {
  if (block instanceof TextBlock) return block.text.length
  if (!(block instanceof ToolResultBlock)) return 0
  const textual: string[] = []
  for (const item of block.content) {
    if (item instanceof TextBlock) textual.push(item.text)
    else if (item instanceof JsonBlock) textual.push(JSON.stringify(item.toJSON()))
  }
  return textual.join('\n').length
}

function firstText(block: ContentBlock): string {
  const first = block instanceof ToolResultBlock ? block.content[0] : block
  return first instanceof TextBlock ? first.text : ''
}

function isTruncated(block: ContentBlock): boolean {
  return firstText(block).startsWith(TRUNCATED_PREFIX)
}

/** The head message, pinned messages and summaries are cut last: they hold the context other strategies kept. */
function isProtected(messages: Message[], index: number, block: ContentBlock): boolean {
  return index === 0 || isPinned(messages, index) || firstText(block).startsWith(SUMMARIZED_PREFIX)
}

function totalTextSize(messages: Message[]): number {
  return messages.reduce((sum, message) => sum + message.content.reduce((s, block) => s + textSize(block), 0), 0)
}

/**
 * Last-resort strategy for a context that still overflows after every user-configured strategy ran.
 * Drops the oldest 20% of messages while more than three remain, then truncates the largest text blocks
 * until the history is estimated to fit, so an overflow carried by a few messages recovers as well.
 * Appended internally by ContextManager — not part of the public builder API.
 *
 * TODO: add a ContextManagerConfig flag to disable this for users who want full control.
 *
 * @internal
 */
export class EmergencyTruncateStrategy extends TruncateStrategy {
  override readonly name = 'offload:emergency-truncate'

  constructor() {
    super('*')
  }

  override init(_agent: LocalAgent, stash?: Stash): void {
    this._stash = stash
  }

  override async apply(context: ContextState): Promise<boolean> {
    let utilization = context.utilization
    if (!context.overflow) {
      const tokens = await context.agent.model.countTokens(context.messages)
      utilization = context.agent.model.estimateUtilization(tokens)
      if (utilization < 1.0) return false
    }
    const charsBefore = totalTextSize(context.messages)
    const dropped = await this._applyPerMessage(context)
    // Scale the utilization by the text that survived the drop to estimate how much is still in excess.
    const fitsChars = utilization > 0 ? (charsBefore * EMERGENCY_TARGET_UTILIZATION) / utilization : 0
    const charsNow = totalTextSize(context.messages)
    let excessChars = charsNow - fitsChars
    // The model rejected the input, so the local count (messages only, no system prompt or tool specs, a
    // heuristic tokenizer) is optimistic by an unknown margin: remove at least a quarter of the text per pass,
    // counting what the drop removed, so the 3-retry cap cannot run out on a context the count undersells by 2x.
    if (context.overflow) {
      excessChars = Math.max(excessChars, charsBefore * EMERGENCY_MIN_CUT - (charsBefore - charsNow))
    }
    const truncated = await this._truncateLargestTextBlocks(context, excessChars)
    return dropped || truncated
  }

  /** Drop the oldest 20% of non-head messages each pass. Pins are ignored so an all-pinned overflow recovers. */
  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 3) return false

    const removable = messages.filter((_, index) => index > 0)
    let removeCount = Math.max(1, Math.floor(removable.length * EMERGENCY_REMOVAL_RATIO))
    // Cut just before an assistant message, which holds no tool result to orphan and never merges into message 0.
    if (removable[removeCount]?.role !== 'assistant') removeCount += 1
    const toRemove = removable.slice(0, removeCount)

    const { removed, lowestIndex } = spliceWithPairs(messages, toRemove)
    if (removed === 0) return false

    insertMarker(messages, lowestIndex, this._makeRemovalMarker(removed))
    repairAlternation(messages)
    return true
  }

  /**
   * Truncate untruncated text blocks, largest first, until `excessChars` characters are gone.
   * Each block keeps at most a quarter of its text as preview (never more than the default preview),
   * so every truncation removes most of the block. Ties go to the oldest block. Protected blocks (head
   * message, pinned messages, summaries) are only cut once every other block is, so an overflow that
   * lives in one of them still recovers. Already truncated blocks are skipped unless they are still larger
   * than a full preview, so a block that merely starts with the marker cannot stall the recovery.
   */
  private async _truncateLargestTextBlocks(context: ContextState, excessChars: number): Promise<boolean> {
    const { messages } = context
    const toolNameMap = buildToolNameMap(messages)
    const candidates: { protected: number; size: number; index: number; blockIndex: number }[] = []
    messages.forEach((message, index) => {
      message.content.forEach((block, blockIndex) => {
        const size = textSize(block)
        if (!this._blockMatchesTarget(block, message, toolNameMap)) return
        if (size > FULL_PREVIEW_CHARS || (size > 0 && !isTruncated(block))) {
          candidates.push({ protected: isProtected(messages, index, block) ? 1 : 0, size, index, blockIndex })
        }
      })
    })
    candidates.sort(
      (a, b) => a.protected - b.protected || b.size - a.size || a.index - b.index || a.blockIndex - b.blockIndex
    )

    let saved = 0
    let truncated = 0
    for (const { size, index, blockIndex } of candidates) {
      if (saved >= excessChars) break
      const message = messages[index]!
      const block = message.content[blockIndex]!
      const config: TruncateConfig = {
        previewTokens: Math.min(DEFAULT_PREVIEW_TOKENS, Math.floor(size / (4 * CHARS_PER_TOKEN))),
      }
      const stashRefs = this._stash?.refsFor(block, message, blockIndex) ?? []
      const tokens = Math.floor(size / CHARS_PER_TOKEN)
      const replacement = await this._replaceBlock(block, tokens, message, context.agent, stashRefs, undefined, config)
      if (!replacement || replacement === block) continue
      ;(message.content as unknown[])[blockIndex] = replacement
      saved += size - textSize(replacement)
      truncated += 1
    }
    if (truncated > 0) {
      logger.warn(
        `truncated_blocks=<${truncated}>, saved_chars=<${saved}> | emergency truncation of the largest text blocks`
      )
    }
    return truncated > 0
  }
}
