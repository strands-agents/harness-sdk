/**
 * Drop strategy — removes matching content from the context window entirely.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, TextBlock, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextStrategy } from '../../types.js'
import { offloadPlaceholder } from '../../placeholder.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './base.js'

export const DROPPED_MARKER = '[Dropped]'

export class DropStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:drop'
  protected override readonly _replacesOtherPlaceholders = true

  when(conditions: OffloadConditions): ContextStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected override _makeRemovalMarker(count: number, stashRef: string | undefined): TextBlock {
    return offloadPlaceholder('drop', `[Dropped: ${count} ${count === 1 ? 'message' : 'messages'}]`, stashRef, count)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    _tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    const marker = offloadPlaceholder('drop', DROPPED_MARKER, stashRef)

    if (block instanceof ToolResultBlock) {
      logger.debug(`toolUseId=<${block.toolUseId}> | dropped tool result from context window`)
      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: block.status,
        content: [marker],
      })
    }
    logger.debug(`trackingId=<${message.trackingId}> | dropped block from context window`)
    return marker
  }
}
