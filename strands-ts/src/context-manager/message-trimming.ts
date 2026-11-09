/**
 * Trimming messages from the context window while keeping it valid for the model: removing them with
 * their tool pairs, leaving a placeholder for each removed run, and restoring user/assistant alternation.
 *
 * @internal
 */

import { logger } from '../logging/logger.js'
import { Message, ToolResultBlock, ToolUseBlock } from '../types/messages.js'
import type { MessageMetadata, OffloadMethod, TextBlock } from '../types/messages.js'
import { carriedTokens, offloadPlaceholder } from './placeholder.js'
import type { Stash } from './stash.js'
import type { Model } from '../models/model.js'

/**
 * The tokens a run stands for once it is removed: its current content plus what any marker it carries already stood
 * for, so re-removing a marker's carrier reports the whole size rather than the marker's own few tokens.
 *
 * @internal
 */
export async function removedTokens(run: Message[], model: Pick<Model, 'countTokens'>): Promise<number> {
  const carried = carriedTokens(run.flatMap((message) => message.content))
  return (await model.countTokens(run)) + carried
}

/**
 * A {@link removeMessages} placeholder reading `format(tokens)`, for the methods that always leave a marker.
 * Summarize writes its own, since a failed summary keeps the run.
 *
 * @internal
 */
export function placeholderFor(
  model: Pick<Model, 'countTokens'>,
  format: (tokens: number) => string
): (removed: Message[]) => Promise<{ text: string; tokens: number }> {
  return async (removed) => {
    const tokens = await removedTokens(removed, model)
    return { text: format(tokens), tokens }
  }
}

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

/**
 * Writes the placeholder for messages about to be removed with their tool pairs: its text, such as
 * `[Dropped: earlier messages, ~1,200 tokens]` or a summary, and the tokens it stands for. Returning null keeps
 * them, as summarize does when its model call fails.
 */
type PlaceholderText = (removed: Message[]) => Promise<{ text: string; tokens: number } | null>

/**
 * Removes messages with their tool pairs and leaves one placeholder for each contiguous run of them, each stashed
 * under its own reference. A run whose text is null is kept, and a failed stash write leaves the placeholder without
 * a reference. Callers restore alternation once they are done.
 *
 * @returns Whether anything was removed
 * @internal
 */
export async function removeMessages(
  messages: Message[],
  toRemove: Message[],
  textFor: PlaceholderText,
  method: OffloadMethod,
  stash: Stash | undefined
): Promise<boolean> {
  let acted = false
  // Last run first, so removing a run leaves the earlier runs' positions unchanged.
  for (const run of splitIntoRuns(messages, withPairs(messages, toRemove)).reverse()) {
    if (await removeRun(messages, run, textFor, method, stash)) acted = true
  }
  return acted
}

/** Replaces a contiguous run of messages with one placeholder. */
async function removeRun(
  messages: Message[],
  run: Message[],
  textFor: PlaceholderText,
  method: OffloadMethod,
  stash: Stash | undefined
): Promise<boolean> {
  const placeholder = await textFor(run)
  if (placeholder === null) return false

  const start = messages.indexOf(run[0]!)
  messages.splice(start, run.length)
  let stashRef: string | undefined
  try {
    stashRef = await stash?.storeRemoved(run)
  } catch (error) {
    logger.warn(`method=<${method}>, error=<${error}> | failed to stash removed messages`)
  }
  insertMarker(messages, start, offloadPlaceholder(method, placeholder.text, stashRef, placeholder.tokens))
  return true
}

/** Splits `selected`, in conversation order, into runs of messages adjacent in `messages`. */
function splitIntoRuns(messages: Message[], selected: Message[]): Message[][] {
  const runs: Message[][] = []
  let previousIndex = -2
  for (const message of selected) {
    const index = messages.indexOf(message)
    if (index === previousIndex + 1) runs.at(-1)!.push(message)
    else runs.push([message])
    previousIndex = index
  }
  return runs
}
