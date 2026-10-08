/**
 * Recovery of assistant messages truncated by the model's maximum token limit.
 */

import { logger } from '../logging/logger.js'
import { Message, TextBlock, ToolUseBlock } from '../types/messages.js'
import type { ContentBlock } from '../types/messages.js'

/**
 * Sanitizes a message truncated by the model's maximum token limit so it can be kept in history.
 *
 * Every tool use is replaced with a text block explaining it was incomplete, because a truncated
 * response's tool uses cannot be trusted and would otherwise leave an unmatched tool use in history.
 * All other content blocks, the role, tracking id, and metadata are preserved.
 *
 * @param message - The truncated message produced by the model
 * @returns A new message with every tool use replaced by explanatory text
 * @internal
 */
export function recoverMessageOnMaxTokensReached(message: Message): Message {
  logger.info('handling maxTokens stop reason - replacing all tool uses with error messages')

  const content: ContentBlock[] = message.content.map((block) => {
    if (!(block instanceof ToolUseBlock)) {
      return block
    }
    const displayName = block.name || '<unknown>'
    logger.warn(`tool_name=<${displayName}> | replacing with error message due to max_tokens truncation`)
    return new TextBlock(
      `The selected tool ${displayName}'s tool use was incomplete due to maximum token limits being reached.`
    )
  })

  return new Message({
    role: message.role,
    content,
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}
