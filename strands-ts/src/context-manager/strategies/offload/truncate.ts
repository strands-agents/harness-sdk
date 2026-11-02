/**
 * Truncate strategy — replaces oversized content with a preview.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy } from '../../types.js'
import { truncateToolResultBlock, truncateTextBlock, type TruncateConfig } from '../../methods/truncate.js'
import { offloadPlaceholder } from '../../placeholder.js'
import { BaseOffloadStrategy, type OffloadConditions, type OffloadTarget } from './base.js'

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

  protected override _makeRemovalMarker(count: number, stashRef: string | undefined): TextBlock {
    const text = `[... ${count} ${count === 1 ? 'message' : 'messages'} elided ...]`
    return offloadPlaceholder('truncate', text, stashRef, count)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}>, tokens=<${tokens}> | truncated tool result`)
      const truncated = truncateToolResultBlock(block, this._truncateConfig)
      if (truncated !== block) {
        return appendStashRef(truncated, stashRef)
      }
      return truncated
    }
    if (block instanceof TextBlock) {
      logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | truncated text block`)
      const truncated = truncateTextBlock(block, this._truncateConfig)
      return stashRef === undefined
        ? truncated
        : offloadPlaceholder('truncate', `${truncated.text}\n\n[Stashed]`, stashRef)
    }
    logger.debug(`trackingId=<${message.trackingId}>, tokens=<${tokens}> | offloaded media block`)
    return offloadPlaceholder('truncate', `[Offloaded: ~${tokens} tokens]`, stashRef)
  }
}

function appendStashRef(block: ToolResultBlock, stashRef: string | undefined): ToolResultBlock {
  if (stashRef === undefined) return block

  const content = [...block.content]
  for (let index = 0; index < content.length; index++) {
    const item = content[index]!
    if (item instanceof TextBlock) {
      content[index] = offloadPlaceholder('truncate', `${item.text}\n\n[Stashed]`, stashRef)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content,
      })
    }
  }
  return block
}
