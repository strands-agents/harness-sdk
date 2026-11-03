/**
 * Trimming messages from the context window while keeping it valid for the model: removing them with
 * their tool pairs, marking the gap, and restoring user/assistant alternation.
 *
 * @internal
 */

import { Message, ToolResultBlock, ToolUseBlock } from '../types/messages.js'
import type { MessageMetadata, TextBlock } from '../types/messages.js'

/**
 * Collects a message and its paired partner (if any) for safe removal.
 * If removing a message would orphan a tool-use/tool-result pair, includes the partner
 * so the pair is removed together. Never collects message 0 or the last message, which the
 * next model call responds to.
 */
export function collectRemovableWithPair(messages: Message[], index: number): Message[] {
  const message = messages[index]
  if (!message) return []
  if (index === 0 || index === messages.length - 1) return []

  const result: Message[] = [message]

  const hasToolResult = message.content.some((block) => block instanceof ToolResultBlock)
  if (hasToolResult) {
    const prev = messages[index - 1]
    if (prev && prev.content.some((block) => block instanceof ToolUseBlock)) {
      if (index - 1 > 0) result.push(prev)
      else return []
    }
  }

  const hasToolUse = message.content.some((block) => block instanceof ToolUseBlock)
  if (hasToolUse) {
    const next = messages[index + 1]
    if (next && next.content.some((block) => block instanceof ToolResultBlock)) {
      if (index + 1 < messages.length - 1) result.push(next)
      else return []
    }
  }

  return result
}

/**
 * The removable messages among `toRemove`, with their tool pairs, in conversation order.
 */
export function withPairs(messages: Message[], toRemove: Message[]): Message[] {
  const removable = new Set<Message>()
  for (const message of toRemove) {
    const index = messages.indexOf(message)
    if (index === -1) continue
    for (const partner of collectRemovableWithPair(messages, index)) removable.add(partner)
  }
  return messages.filter((message) => removable.has(message))
}

/**
 * Adds a marker as assistant content at the gap left by removed messages.
 *
 * The marker is appended to an assistant message beside the gap, which keeps that message's
 * tracking id and block indices for stash refs, or becomes its own assistant message. It never
 * joins message 0, and the last message is never removed, so a new marker never ends the history.
 */
export function insertMarker(messages: Message[], index: number, marker: TextBlock): void {
  index = Math.max(1, Math.min(index, messages.length))
  for (const neighbor of [index - 1, index]) {
    const carrier = messages[neighbor]
    if (neighbor > 0 && carrier?.role === 'assistant') {
      messages[neighbor] = carrier.with({ content: [...carrier.content, marker] })
      return
    }
  }
  messages.splice(index, 0, new Message({ role: 'assistant', content: [marker] }))
}

/**
 * Merges consecutive same-role messages to restore the user/assistant alternation
 * that Anthropic/Bedrock APIs require. Called after message-level operations that
 * may leave gaps. Constructs new Message objects for merges to avoid mutating
 * objects that may be referenced elsewhere (session storage, event payloads).
 * A merge keeps the earlier message's tracking id and merges both messages' metadata, so it is pinned if either was.
 */
export function repairAlternation(messages: Message[]): void {
  let writeIndex = 0
  for (let readIndex = 0; readIndex < messages.length; readIndex++) {
    const current = messages[readIndex]!
    if (writeIndex > 0 && messages[writeIndex - 1]!.role === current.role) {
      const prev = messages[writeIndex - 1]!
      const metadata = mergeMetadata(prev.metadata, current.metadata)
      messages[writeIndex - 1] = prev.with({
        content: [...prev.content, ...current.content],
        ...(metadata && { metadata }),
      })
    } else {
      messages[writeIndex] = current
      writeIndex++
    }
  }
  messages.length = writeIndex
}

/** The later message's metadata fields win, and `custom` holds both messages' entries. */
function mergeMetadata(earlier?: MessageMetadata, later?: MessageMetadata): MessageMetadata | undefined {
  if (!earlier || !later) return later ?? earlier
  const custom = { ...earlier.custom, ...later.custom }
  return { ...earlier, ...later, ...(Object.keys(custom).length > 0 && { custom }) }
}
