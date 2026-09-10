/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy, ContextState } from '../../types.js'
import { truncateToolResultBlock, truncateTextBlock, type TruncateConfig } from '../../methods/truncate.js'
import { formatStashRefs } from '../../stash.js'
import {
  BaseOffloadStrategy,
  spliceWithPairs,
  repairAlternation,
  type OffloadConditions,
  type OffloadTarget,
} from './base.js'

export class TruncateStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:truncate'

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

  protected override async _applyPerMessage(context: ContextState): Promise<boolean> {
    const { messages } = context
    if (messages.length <= 1) return false

    const eligible = await this._getEligibleMessages(context)
    if (eligible.length === 0) return false

    // Determine head/tail split based on config (default: favor tail — 30% head, 70% tail)
    const previewMode = this._truncateConfig.preview ?? 'headTail'
    const headShare = { head: 1, tail: 0, headTail: 0.3 }[previewMode]
    const targetRemoval = Math.max(1, Math.floor(eligible.length * this._removalRatio))
    const keepCount = eligible.length - targetRemoval

    const headKeep = Math.floor(keepCount * headShare)
    const tailKeep = keepCount - headKeep

    const middleMessages = eligible.slice(headKeep, eligible.length - tailKeep)

    if (middleMessages.length === 0) return false

    const { removed, lowestIndex } = spliceWithPairs(messages, middleMessages)
    if (removed === 0) return false

    const marker = this._makeRemovalMarker(removed)
    const insertIndex = Math.max(1, Math.min(lowestIndex, messages.length))
    messages.splice(insertIndex, 0, new Message({ role: 'user', content: [new TextBlock(marker)] }))

    repairAlternation(messages)
    return true
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRefs: string[]
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      const truncated = truncateToolResultBlock(block, this._truncateConfig)
      if (truncated !== block) {
        return appendStashRefs(truncated, stashRefs)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, this._truncateConfig)
      const refs = formatStashRefs(stashRefs)
      return refs ? new TextBlock(`${truncated.text}\n\n[Stashed]${refs}`) : truncated
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
