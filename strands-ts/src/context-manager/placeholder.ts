/**
 * Offload placeholders: the text block left where content was offloaded, and the wording of each marker it carries.
 */

import { TextBlock, type OffloadMethod } from '../types/messages.js'

/** A bare marker reads to the model as media that never arrived, so it doubts what it saw. */
const AFTER_RECEIVING = 'removed from context after it was received'

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
    preview,
    ...(stashRef !== undefined && { ref: stashRef }),
    ...(removedMessages !== undefined && { removedMessages }),
  }
  const text = stashRef === undefined ? preview : `${preview} [ref: ${stashRef}]`
  return new TextBlock(text, { metadata: { offloaded } })
}

/**
 * Marker for a dropped block, naming the media kind when it was media.
 *
 * @internal
 */
export function formatDropped(tokens: number, mediaKind?: string): string {
  return marker('Dropped', mediaKind, approxTokens(tokens), mediaKind && AFTER_RECEIVING)
}

/**
 * Marker for `count` dropped messages.
 *
 * @internal
 */
export function formatDroppedMessages(count: number): string {
  return marker('Dropped', countOf(count, 'message'))
}

/**
 * Marker for a block replaced without a preview, naming the media kind when it was media.
 *
 * @internal
 */
export function formatOffloaded(tokens: number, mediaKind?: string): string {
  return marker('Offloaded', mediaKind, approxTokens(tokens), mediaKind && AFTER_RECEIVING)
}

/**
 * Marker for summarized content, followed by the summary when there is one.
 *
 * @param description - What was summarized, such as `'tool result'` or `'3 messages'`
 * @param tokens - Size of the original
 * @param summary - The summary text
 * @internal
 */
export function formatSummarized(description: string, tokens: number, summary?: string): string {
  return withBody(marker('Summarized', description, approxTokens(tokens)), summary)
}

/**
 * Marker for `blockCount` blocks shortened to `preview`, followed by the preview.
 *
 * @internal
 */
export function formatTruncated(blockCount: number, tokens: number, preview: string): string {
  return withBody(marker('Truncated', countOf(blockCount, 'block'), approxTokens(tokens)), preview)
}

/**
 * Marker left where `count` messages were removed from the context window.
 *
 * @internal
 */
export function formatElided(count: number): string {
  return `[... ${countOf(count, 'message')} elided ...]`
}

/** `[Label: detail, detail]`, leaving out empty details, or `[Label]` when none remain. */
function marker(label: string, ...details: (string | undefined)[]): string {
  const shown = details.filter(Boolean)
  return shown.length > 0 ? `[${label}: ${shown.join(', ')}]` : `[${label}]`
}

/** The size as `~2,525 tokens`, or empty when the token count could not measure it. */
function approxTokens(tokens: number): string {
  return tokens ? `~${tokens.toLocaleString('en-US')} tokens` : ''
}

function countOf(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}

function withBody(header: string, body: string | undefined): string {
  return body ? `${header}\n\n${body}` : header
}
