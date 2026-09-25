import { Model } from '../../models/model.js'
import type { BaseModelConfig } from '../../models/model.js'
import type { Message } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import type { AudioConfig, BidiModelInput, BidiOutputEvent } from './types.js'

/** Configuration shared by bidirectional model providers. */
export interface BidiModelConfig extends BaseModelConfig {
  /** Explicit provider model identifier. */
  modelId: string
}

/** Initial context and cancellation for a persistent model connection. */
export interface BidiStartOptions {
  /** System instructions for the connection. */
  systemPrompt?: string
  /** Tools that the model may request; execution belongs to the caller. */
  tools?: ToolSpec[]
  /** Conversation history to replay before accepting new input. */
  messages?: Message[]
  /** Cancels connection setup and the resulting live session. */
  cancelSignal?: AbortSignal
}

/** Capability exposed by bidirectional models with audio input and output. */
export interface AudioCapable {
  /** Returns the resolved input and output audio formats. */
  getAudioConfig(): AudioConfig
}

/**
 * Persistent model connection with independent input and output streams.
 *
 * This experimental contract does not execute tools or manage playback. Consumers
 * execute tool requests and send ToolResultBlock values with the original call IDs.
 *
 * @example
 * ```typescript
 * await model.start({ tools: [lookup.toolSpec] })
 * try {
 *   await model.send(new TextBlock('Hello'))
 *   for await (const event of model.receive()) {
 *     console.log(event)
 *   }
 * } finally {
 *   await model.stop()
 * }
 * ```
 */
export abstract class BidiModel<T extends BidiModelConfig = BidiModelConfig> extends Model<T> {
  /** The persistent connection maintains conversation state on the provider. */
  override get stateful(): boolean {
    return true
  }

  /**
   * Establishes a connection before send or receive can be used.
   * @param options - Initial context and session cancellation.
   * @returns Resolves when the provider accepts the session configuration.
   */
  abstract start(options?: BidiStartOptions): Promise<void>

  /** Releases local resources and initiates transport closure. */
  abstract stop(): Promise<void>

  /**
   * Sends content or a tool result over the active connection.
   * @param content - Input content or a result for a provider-requested tool.
   * @returns Resolves after the transport accepts the content locally.
   */
  abstract send(content: BidiModelInput): Promise<void>

  /** Returns the single-consumer event stream for this connection. */
  abstract receive(): AsyncIterable<BidiOutputEvent>

  /**
   * Bidirectional models use start, send, and receive instead of stream.
   * @throws Error - Regular request-response streaming is unsupported.
   */
  override stream(): never {
    throw new Error('Regular streaming is not supported by bidirectional models; use start, send, and receive')
  }
}
