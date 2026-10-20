/**
 * Agent-related type definitions for bidirectional streaming.
 */

import type {
  BidiContentDelta,
  BidiContentDeltaData,
  BidiUserContentBlock,
  BidiUserContentBlockData,
} from './content.js'

/**
 * User input accepted by `BidiAgent.send()` and returned by input streams.
 *
 * Supported forms:
 *
 * - Text: a string, `TextBlock`, or an object with a `text` key.
 * - Image: `ImageBlock` or an object with an `image` key.
 * - Streaming audio: `AudioDelta` or an object with an `audioDelta` key.
 * - Grouped content: a nonempty array of strings, text/image blocks, or their JSON forms.
 *
 * An array forms one user message and preserves block order. Send audio deltas individually,
 * outside these arrays.
 */
export type BidiAgentInput =
  | string
  | BidiUserContentBlock
  | BidiUserContentBlockData
  | BidiContentDelta
  | BidiContentDeltaData
  | (string | BidiUserContentBlock | BidiUserContentBlockData)[]
