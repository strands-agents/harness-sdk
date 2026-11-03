/**
 * The cut a summary pass makes: which messages it keeps in front, summarizes, and keeps behind.
 *
 * @internal
 */

import { ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { Message } from '../../types/messages.js'
import { isPinned } from '../../conversation-manager/compression/pin-message.js'
import { resolvePreserveCount } from '../strategies/offload/base.js'
import { isSummary } from '../render.js'

/**
 * A partition of a history: `head + body + tail` is the history, in order.
 *
 * @internal
 */
export interface Cut {
  /** Messages kept in front of the summary. */
  head: Message[]

  /** Contiguous messages the summary replaces. Never empty. */
  body: Message[]

  /** Messages kept behind the summary, unchanged. */
  tail: Message[]
}

/**
 * Plans where a summary pass cuts a history. Pure: reads `messages` and returns slices of it.
 *
 * - `head` is the first `keepHead` messages, plus a tool result that answers a tool call in them.
 * - `tail` keeps the most recent `preserveRecent` messages and always the last message, which the next model
 *   call responds to. A tool pair split by the boundary moves into `body`, unless its result is the last message.
 * - `body` stops in front of the first pinned message.
 * - The boundary never splits a tool pair, and the last summarized and first kept messages differ in role.
 * - An earlier summary rolls into `body`; a body that would hold only that summary is no cut.
 *
 * @internal
 * @param messages - The history
 * @param keepHead - How many opening messages to keep in front of the summary
 * @param preserveRecent - Integer (1 or above): absolute count. Decimal (between 0 and 1 exclusive): ratio of the
 *   history to keep.
 * @param endOnUser - Whether the body must end with a user message, as a whole-prefix compaction request does
 * @returns The cut, or undefined when no legal cut summarizes anything
 */
export function planCut(
  messages: Message[],
  keepHead: number,
  preserveRecent: number,
  endOnUser = false
): Cut | undefined {
  const bodyStart = headEnd(messages, keepHead)
  const tailStart = tailBoundary(messages, bodyStart, preserveRecent, endOnUser)
  if (tailStart <= bodyStart) return undefined
  // Summarizing only an earlier summary reclaims nothing.
  if (tailStart - bodyStart === 1 && messages[bodyStart]!.content.every(isSummary)) return undefined
  return {
    head: messages.slice(0, bodyStart),
    body: messages.slice(bodyStart, tailStart),
    tail: messages.slice(tailStart),
  }
}

function headEnd(messages: Message[], keepHead: number): number {
  const end = Math.min(keepHead, messages.length)
  return end > 0 && splitsToolPair(messages, end) ? end + 1 : end
}

function tailBoundary(messages: Message[], bodyStart: number, preserveRecent: number, endOnUser: boolean): number {
  const last = messages.length - 1
  let tailStart = Math.min(messages.length - resolvePreserveCount(messages.length, preserveRecent), last)
  if (splitsToolPair(messages, tailStart) && tailStart < last) tailStart += 1
  tailStart = Math.min(tailStart, firstPin(messages, bodyStart, tailStart))
  while (tailStart > bodyStart && !isLegalBoundary(messages, tailStart, endOnUser)) tailStart -= 1
  return tailStart
}

function firstPin(messages: Message[], from: number, to: number): number {
  for (let index = from; index < to; index++) {
    if (isPinned(messages, index)) return index
  }
  return to
}

function isLegalBoundary(messages: Message[], index: number, endOnUser: boolean): boolean {
  const last = messages[index - 1]!
  if (endOnUser && last.role !== 'user') return false
  return !splitsToolPair(messages, index) && last.role !== messages[index]!.role
}

/** Whether `messages[index]` holds a tool result answering a tool call in the message before it. */
function splitsToolPair(messages: Message[], index: number): boolean {
  const message = messages[index]
  const previous = messages[index - 1]
  if (!message || !previous) return false
  return (
    message.content.some((block) => block instanceof ToolResultBlock) &&
    previous.content.some((block) => block instanceof ToolUseBlock)
  )
}
