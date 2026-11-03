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
 * - A client-side summary is sent as `[Summarized: N messages, ~T tokens]` followed by its text, the cue the model
 *   has always been given. A provider's native summary is sent as stored.
 * - A summary message is merged with a neighbor of the same role, so roles alternate on the wire.
 *
 * Returns new messages where anything changes; the stored messages and blocks are never modified.
 *
 * @internal
 * @param messages - The stored history
 * @returns The history to send
 */
export function renderHistory(messages: Message[]): Message[] {
  const rendered: Message[] = []
  let previousHoldsSummary = false
  for (const message of messages) {
    const current = renderSummaries(message)
    const holds = holdsSummary(message)
    const previous = rendered.at(-1)
    if (previous && previous.role === current.role && (previousHoldsSummary || holds)) {
      rendered[rendered.length - 1] = merge(previous, current)
      previousHoldsSummary = true
    } else {
      rendered.push(current)
      previousHoldsSummary = holds
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

function holdsSummary(message: Message): boolean {
  return message.content.some(isSummary)
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

function merge(previous: Message, current: Message): Message {
  return new Message({
    role: previous.role,
    content: [...previous.content, ...current.content],
    trackingId: previous.trackingId,
    ...(previous.metadata !== undefined && { metadata: previous.metadata }),
  })
}
