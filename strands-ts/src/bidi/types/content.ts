/**
 * Content-related type definitions for bidirectional streaming.
 */

import type { ImageBlock, ImageBlockData } from '../../types/media.js'
import type { TextBlock, TextBlockData, ToolResultBlock, ToolResultBlockData } from '../../types/messages.js'
import type { AudioDelta, AudioDeltaData } from './media.js'

/** A complete text or image block supplied by a user. */
export type BidiUserContentBlock = TextBlock | ImageBlock

/** A complete text, image, or tool result block. */
export type BidiContentBlock = BidiUserContentBlock | ToolResultBlock

/** An audio delta for the live input stream. */
export type BidiContentDelta = AudioDelta

/** JSON form of one user content block. */
export type BidiUserContentBlockData = TextBlockData | { image: ImageBlockData }

/** JSON form of one text, image, or tool result block. */
export type BidiContentBlockData = BidiUserContentBlockData | { toolResult: ToolResultBlockData }

/** JSON form of an audio delta. */
export type BidiContentDeltaData = { audioDelta: AudioDeltaData }

/**
 * An input message containing ordered content blocks.
 *
 * Callers must supply at least one block when sending and must not mix tool results with user
 * text or images. Send streaming deltas individually.
 */
export interface BidiMessage {
  /** Ordered list of complete content blocks. */
  content: BidiContentBlock[]
}

/**
 * Streamed content metadata stored under a message's `metadata.custom.bidi`.
 */
export interface BidiContentMetadata {
  /** Identifies the message as text, reasoning, or a transcript. */
  kind: 'text' | 'reasoning' | 'transcript'

  /** Whether the content is pending, complete, or incomplete. */
  status: 'pending' | 'complete' | 'incomplete'
}

/**
 * Tool-result metadata stored under a message's `metadata.custom.bidi`.
 */
export interface BidiToolMetadata {
  /** Whether the message records dispatch or the completed result. */
  kind: 'toolDispatch' | 'toolResult'
}
