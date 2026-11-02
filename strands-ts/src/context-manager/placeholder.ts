/**
 * Offload placeholders: the text block left where content was offloaded.
 */

import { TextBlock, type OffloadMethod } from '../types/messages.js'

/**
 * The text block that stands in for offloaded content, with what it stands for recorded in `metadata.offloaded`.
 *
 * @param method - Offload method that replaced the content
 * @param text - Text the model reads in place of the original
 * @param removedMessages - Number of whole messages the placeholder stands for, when it replaces messages
 * @internal
 */
export function offloadPlaceholder(method: OffloadMethod, text: string, removedMessages?: number): TextBlock {
  const offloaded = { method, ...(removedMessages !== undefined && { removedMessages }) }
  return new TextBlock(text, { metadata: { offloaded } })
}
