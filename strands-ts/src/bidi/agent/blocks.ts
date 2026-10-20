/**
 * Accumulate streamed content for completed events and conversation history.
 *
 * @internal
 */

import { Message, ReasoningBlock, TextBlock, type MessageMetadata, type Role } from '../../types/messages.js'
import type { BidiContentMetadata } from '../types/content.js'
import {
  BidiReasoningBlockEvent,
  BidiTextBlockEvent,
  BidiTranscriptBlockEvent,
  type BidiOutputEvent,
} from '../types/events.js'

/** Kind of streamed content a block accumulates. */
type BlockKind = BidiContentMetadata['kind']

/** Build the `metadata.custom.bidi` payload for a streamed content message. */
function blockMetadata(kind: BlockKind, status: BidiContentMetadata['status']): MessageMetadata {
  const metadata: BidiContentMetadata = { kind, status }
  return { custom: { bidi: { ...metadata } } }
}

/**
 * Text accumulated for one reserved history message.
 *
 * @internal
 */
export class StreamedTextBlock {
  /** Identifies the content stream these fragments belong to. */
  readonly contentId: string

  /** The pending history message reserved for this content. */
  readonly message: Message

  /** Text accumulated so far. */
  text = ''

  /** Kind of content this block accumulates. */
  protected get kind(): BlockKind {
    return 'text'
  }

  /**
   * @param contentId - Identifier shared by the content stream's events.
   * @param role - Role of the reserved history message.
   */
  constructor(contentId: string, role: Role = 'assistant') {
    this.contentId = contentId
    this.message = new Message({ role, content: [], metadata: blockMetadata(this.kind, 'pending') })
  }

  /**
   * Append the next text fragment.
   *
   * @param delta - The incremental text.
   */
  append(delta: string): void {
    this.text += delta
  }

  /**
   * Build a history message with its completion status.
   *
   * @param options - `complete` marks the content as finished; defaults to `true`.
   * @returns The history message.
   */
  toMessage(options?: { complete?: boolean }): Message {
    const complete = options?.complete ?? true
    return new Message({
      role: this.message.role,
      content: [new TextBlock(this.text)],
      trackingId: this.message.trackingId,
      metadata: blockMetadata(this.kind, complete ? 'complete' : 'incomplete'),
    })
  }

  /**
   * Build the completed content event.
   *
   * @returns The completed output event.
   */
  toEvent(): BidiOutputEvent {
    return new BidiTextBlockEvent({ type: 'bidiTextBlock', text: this.text, contentId: this.contentId })
  }
}

/**
 * Reasoning accumulated for one reserved history message.
 *
 * @internal
 */
export class StreamedReasoningBlock extends StreamedTextBlock {
  protected override get kind(): BlockKind {
    return 'reasoning'
  }

  /**
   * Build a reasoning history message.
   *
   * @param options - `complete` marks the content as finished; defaults to `true`.
   * @returns The history message.
   */
  override toMessage(options?: { complete?: boolean }): Message {
    const message = super.toMessage(options)
    return new Message({
      role: message.role,
      content: [new ReasoningBlock({ text: this.text })],
      trackingId: message.trackingId,
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    })
  }

  /**
   * Build the completed reasoning event.
   *
   * @returns The completed reasoning event.
   */
  override toEvent(): BidiReasoningBlockEvent {
    return new BidiReasoningBlockEvent({
      type: 'bidiReasoningBlock',
      text: this.text,
      contentId: this.contentId,
    })
  }
}

/**
 * Speech transcription accumulated for one reserved history message.
 *
 * @internal
 */
export class StreamedTranscriptBlock extends StreamedTextBlock {
  protected override get kind(): BlockKind {
    return 'transcript'
  }

  /**
   * @param contentId - Identifier shared by the transcript's events.
   * @param role - Who is speaking.
   */
  constructor(contentId: string, role: Role) {
    super(contentId, role)
  }

  /**
   * Build a transcript message with its completion status.
   *
   * @param options - `complete` marks the transcript as finished; defaults to `true`.
   * @returns The history message.
   */
  override toMessage(options?: { complete?: boolean }): Message {
    const complete = options?.complete ?? true
    const message = super.toMessage(options)
    return new Message({
      role: message.role,
      content: complete ? message.content : [new TextBlock('[Transcript unavailable.]')],
      trackingId: message.trackingId,
      ...(message.metadata !== undefined && { metadata: message.metadata }),
    })
  }

  /**
   * Build the completed transcript event.
   *
   * @returns The completed transcript event.
   */
  override toEvent(): BidiTranscriptBlockEvent {
    return new BidiTranscriptBlockEvent({
      type: 'bidiTranscriptBlock',
      transcript: this.text,
      role: this.message.role,
      contentId: this.contentId,
    })
  }
}
