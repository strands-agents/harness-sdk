/**
 * Offload placeholders: the text block left where content was offloaded, and the wording of each marker it carries.
 */

import { TextBlock, ToolResultBlock } from '../types/messages.js'
import type { ContentBlock, OffloadMetadata, OffloadMethod, TextBlockMetadata } from '../types/messages.js'

/** A bare marker reads to the model as media that never arrived, so it doubts what it saw. */
const AFTER_RECEIVING = 'removed from context after it was received'

/** What a message-level marker stands for. */
export const REMOVED_MESSAGES = 'earlier messages'

/**
 * The text block that stands in for offloaded content: the preview, followed by the stash reference
 * when the original is retrievable, with what it stands for recorded in `metadata.offloaded`.
 *
 * @param method - Offload method that replaced the content
 * @param preview - Text that stands in for the original
 * @param stashRef - Reference the original is retrievable under, or undefined when it was not stashed
 * @param tokens - Size of the content it stands for, when the token count measured it
 * @internal
 */
export function offloadPlaceholder(
  method: OffloadMethod,
  preview: string,
  stashRef: string | undefined,
  tokens = 0
): TextBlock {
  const offloaded = { method, ...(stashRef !== undefined && { ref: stashRef }), ...(tokens > 0 && { tokens }) }
  const text = stashRef === undefined ? preview : `${preview} [ref: ${stashRef}]`
  return new TextBlock(text, { metadata: { offloaded } })
}

/**
 * Whether a block is a placeholder the context manager left where it offloaded content.
 *
 * @internal
 */
export function isOffloaded(
  block: unknown
): block is TextBlock & { metadata: TextBlockMetadata & { offloaded: OffloadMetadata } } {
  return block instanceof TextBlock && block.metadata?.offloaded !== undefined
}

/**
 * The tokens the placeholders among `blocks` already stand for, including ones inside a tool result, so replacing a
 * placeholder reports the content behind it rather than its own few tokens.
 *
 * @internal
 */
export function carriedTokens(blocks: readonly ContentBlock[]): number {
  return blocks
    .flatMap((block): unknown[] => (block instanceof ToolResultBlock ? block.content : [block]))
    .reduce<number>((total, block) => total + (isOffloaded(block) ? (block.metadata.offloaded.tokens ?? 0) : 0), 0)
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
 * Marker for dropped messages of `tokens` in total.
 *
 * @internal
 */
export function formatDroppedMessages(tokens: number): string {
  return marker('Dropped', REMOVED_MESSAGES, approxTokens(tokens))
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
 * @param description - What was summarized, such as `'tool result'` or `'earlier messages'`
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
 * Marker left where messages of `tokens` in total were removed from the context window.
 *
 * @internal
 */
export function formatElided(tokens: number): string {
  return `[... ${[`${REMOVED_MESSAGES} elided`, approxTokens(tokens)].filter(Boolean).join(', ')} ...]`
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
