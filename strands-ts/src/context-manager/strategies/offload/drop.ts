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
import { formatStashRefs } from '../../stash.js'
import { offloadPlaceholder } from '../../placeholder.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './base.js'

export const DROPPED_MARKER = '[Dropped]'

export class DropStrategy extends BaseOffloadStrategy {
  readonly name = 'offload:drop'

  when(conditions: OffloadConditions): ContextStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected override _makeRemovalMarker(count: number): TextBlock {
    return offloadPlaceholder('drop', `[Dropped: ${count} ${count === 1 ? 'message' : 'messages'}]`, count)
  }

  protected async _replaceBlock(
    block: ContentBlock,
    _tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRefs: string[]
  ): Promise<ContentBlock | null> {
    const marker = offloadPlaceholder('drop', `${DROPPED_MARKER}${formatStashRefs(stashRefs)}`)

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
