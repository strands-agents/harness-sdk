/**
 * Prepares the stored history for a model request, without changing it.
 *
 * @internal
 */

import { Message, TextBlock } from '../types/messages.js'
import type { ContentBlock } from '../types/messages.js'
import { formatSummarized } from './methods/summarize.js'

/**
 * Renders the history sent to the model.
 *
 * - A client-side summary is sent as `[Summarized: N messages, ~T tokens]` followed by its text. A provider's native
 *   summary is sent as stored.
 * - A client-side summary message followed by a message of the same role is sent after that message's content, in
 *   one message, so roles alternate and the kept message's own blocks stay first. A native summary message is
 *   never merged: its block must stay first in its own message.
 *
 * Returns new messages where anything changes; the stored messages and blocks are never modified.
 *
 * @internal
 * @param messages - The stored history
 * @returns The history to send
 */
export function renderHistory(messages: Message[]): Message[] {
  const rendered: Message[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    const next = messages[index + 1]
    if (next && next.role === message.role && message.content.some(isClientSummary)) {
      rendered.push(appendContent(renderSummaries(next), renderSummaries(message)))
      index++
    } else {
      rendered.push(renderSummaries(message))
    }
  }
  return rendered
}

/**
 * Whether a block is a summary the context manager wrote or a provider returned.
 *
 * @internal
 * @param block - A content block
 * @returns True for a summary block
 */
export function isSummary(block: ContentBlock): block is TextBlock {
  return block instanceof TextBlock && block.metadata?.offloaded?.method === 'summarize'
}

function renderSummaries(message: Message): Message {
  if (!message.content.some(isClientSummary)) return message
  return new Message({
    role: message.role,
    content: message.content.map((block) => (isClientSummary(block) ? withHeader(block) : block)),
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}

function isClientSummary(block: ContentBlock): block is TextBlock {
  return isSummary(block) && block.providerData === undefined
}

function withHeader(block: TextBlock): TextBlock {
  const { removedMessages, removedTokens } = block.metadata!.offloaded!
  return new TextBlock(formatSummarized(`${removedMessages ?? 0} messages`, removedTokens ?? 0, block.text))
}

function appendContent(message: Message, appended: Message): Message {
  return new Message({
    role: message.role,
    content: [...message.content, ...appended.content],
    trackingId: message.trackingId,
    ...(message.metadata !== undefined && { metadata: message.metadata }),
  })
}
