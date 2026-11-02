/**
 * Offload placeholders: the text block left where content was offloaded.
 */

import { TextBlock, type OffloadMethod } from '../types/messages.js'

/**
 * The text block that stands in for offloaded content: the preview, followed by the stash reference
 * when the original is retrievable, with what it stands for recorded in `metadata.offloaded`.
 *
 * @param method - Offload method that replaced the content
 * @param preview - Text that stands in for the original
 * @param stashRef - Reference the original is retrievable under, or undefined when it was not stashed
 * @param removedMessages - Number of whole messages the placeholder stands for, when it replaces messages
 * @internal
 */
export function offloadPlaceholder(
  method: OffloadMethod,
  preview: string,
  stashRef: string | undefined,
  removedMessages?: number
): TextBlock {
  const offloaded = {
    method,
    ...(stashRef !== undefined && { ref: stashRef }),
    ...(removedMessages !== undefined && { removedMessages }),
  }
  const text = stashRef === undefined ? preview : `${preview} [ref: ${stashRef}]`
  return new TextBlock(text, { metadata: { offloaded } })
}
