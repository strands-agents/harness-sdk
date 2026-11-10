import { Message, type ToolUseBlock, type ToolResultBlock } from '../../types/messages.js'

/**
 * Check if a message is pinned, including tool-pair partner protection.
 * Returns `true` if the message at `index` is pinned, or if it is the
 * adjacent tool-pair partner (toolUse/toolResult) of a pinned message,
 * matched by toolUseId.
 *
 * @param messages - The full messages array.
 * @param index - The index to check.
 * @returns `true` if the message or its tool-pair partner is pinned.
 */
export function isPinned(messages: Message[], index: number): boolean {
  const msg = messages[index]!

  if (msg.metadata?.custom?.pinned === true) return true

  // Tool-pair partner protection: if this is a toolResult, check if prev toolUse is pinned
  const toolResultBlocks = msg.content.filter((b): b is ToolResultBlock => b.type === 'toolResultBlock')
  if (toolResultBlocks.length > 0 && index > 0) {
    const prev = messages[index - 1]!
    if (prev.metadata?.custom?.pinned === true) {
      const resultIds = new Set(toolResultBlocks.map((b) => b.toolUseId))
      if (prev.content.some((b) => b.type === 'toolUseBlock' && resultIds.has((b as ToolUseBlock).toolUseId))) {
        return true
      }
    }
  }

  // Tool-pair partner protection: if this is a toolUse, check if next toolResult is pinned
  const toolUseBlocks = msg.content.filter((b): b is ToolUseBlock => b.type === 'toolUseBlock')
  if (toolUseBlocks.length > 0 && index + 1 < messages.length) {
    const next = messages[index + 1]!
    if (next.metadata?.custom?.pinned === true) {
      const useIds = new Set(toolUseBlocks.map((b) => b.toolUseId))
      if (next.content.some((b) => b.type === 'toolResultBlock' && useIds.has((b as ToolResultBlock).toolUseId))) {
        return true
      }
    }
  }

  return false
}

/**
 * Pin a message so it is protected from eviction during context reduction.
 * Mutates the message in place by setting `metadata.custom.pinned = true`.
 *
 * @param messages - The messages array containing the message to pin.
 * @param index - The index of the message to pin.
 */
export function pinMessage(messages: Message[], index: number): void {
  const message = messages[index]!
  message.metadata = {
    ...message.metadata,
    custom: { ...message.metadata?.custom, pinned: true },
  }
}

/**
 * Pin the first N messages in the array permanently.
 *
 * @param messages - The messages array.
 * @param count - Number of messages from the start to pin.
 */
export function applyPinFirst(messages: Message[], count: number): void {
  for (let i = 0; i < Math.min(count, messages.length); i++) {
    pinMessage(messages, i)
  }
}

/**
 * Partition a range of messages into pinned (protected) and unpinned arrays.
 *
 * @param messages - The full messages array.
 * @param start - Start index of the range (inclusive).
 * @param end - End index of the range (exclusive).
 * @returns A tuple of [pinned, unpinned] message arrays.
 */
export function partitionPinned(messages: Message[], start: number, end: number): [Message[], Message[]] {
  const pinned: Message[] = []
  const unpinned: Message[] = []
  for (let i = start; i < end; i++) {
    if (isPinned(messages, i)) {
      pinned.push(messages[i]!)
    } else {
      unpinned.push(messages[i]!)
    }
  }
  return [pinned, unpinned]
}

/**
 * Unpin a message so it can be evicted during context reduction.
 * Mutates the message in place by removing the `pinned` flag from metadata.
 *
 * @param messages - The messages array containing the message to unpin.
 * @param index - The index of the message to unpin.
 */
export function unpinMessage(messages: Message[], index: number): void {
  const message = messages[index]!
  const { pinned: _, ...restCustom } = message.metadata?.custom ?? {}
  const { custom: __, ...restMetadata } = message.metadata ?? {}
  const hasCustom = Object.keys(restCustom).length > 0
  const hasMetadata = hasCustom || Object.keys(restMetadata).length > 0
  if (hasMetadata) {
    message.metadata = { ...restMetadata, ...(hasCustom ? { custom: restCustom } : {}) }
  } else {
    delete message.metadata
  }
}
