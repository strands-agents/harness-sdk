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
import { BaseOffloadStrategy, removeMessages } from './base.js'
import type { OffloadConditions } from './conditions.js'
import { mediaKind, type OffloadTarget } from './target.js'

export class DropStrategy extends BaseOffloadStrategy {
  constructor(target: OffloadTarget, conditions?: OffloadConditions) {
    super('drop', target, conditions)
  }

  when(conditions: OffloadConditions = {}): DropStrategy {
    return new DropStrategy(this._target, conditions)
  }

  protected async _applyPerMessage(context: ContextState): Promise<boolean> {
    const text = async (_removed: Message[], count: number): Promise<string> => formatDroppedMessages(count)
    return removeMessages(context.messages, await this._getEligibleMessages(context), text, 'drop', this._stash)
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
