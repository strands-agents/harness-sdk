/**
 * Drop strategy — removes matching content from the context window entirely.
 *
 * @internal
 */

import { logger } from '../../../logging/logger.js'
import { Message, ToolResultBlock } from '../../../types/messages.js'
import type { ContentBlock } from '../../../types/messages.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { ContextState } from '../../types.js'
import { formatDropped, formatDroppedMessages } from '../../placeholder.js'
import { BaseOffloadStrategy } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

export class DropStrategy extends BaseOffloadStrategy {
  constructor(target?: OffloadTarget, conditions?: OffloadConditions) {
    super('drop', target, conditions)
  }

  protected _withConditions(conditions: OffloadConditions): DropStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const eligible = await this._getEligibleMessages(context)
    return this._removeMessages(context.messages, eligible, async ({ length }) => formatDroppedMessages(length))
  }

  protected async _replaceBlock(
    block: ContentBlock,
    tokens: number,
    message: Message,
    _agent: LocalAgent,
    stashRef: string | undefined
  ): Promise<ContentBlock | null> {
    logger.debug(`trackingId=<${message.trackingId}>, block=<${block.type}> | dropped block from context window`)
    const placeholder = this._placeholder(formatDropped(tokens, mediaKind(block)), stashRef)
    return block instanceof ToolResultBlock ? block.withContent([placeholder]) : placeholder
  }
}
