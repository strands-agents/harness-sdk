/**
 * Bidirectional streaming model interface: start a persistent connection, send and receive
 * concurrently, then stop.
 */

import { ModelError } from '../../errors.js'
import { Model } from '../../models/model.js'

import type { ModelStreamEvent } from '../../models/streaming.js'
import type { Message } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import type { BidiContentDelta, BidiMessage } from '../types/content.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { AudioConfig, BidiModelConfig, ConnectionConfig } from './configs.js'

/**
 * Options for establishing or replacing a bidirectional model connection.
 *
 * Providers extend this interface with their own connection options.
 */
export interface BidiModelStartOptions {
  /** System instructions to configure model behavior. */
  systemPrompt?: string

  /** Tool specifications that the model can invoke during the conversation. */
  tools?: ToolSpec[]

  /** Initial conversation history to provide context. */
  messages?: Message[]
}

/**
 * A bidirectional model that can replace its active connection while preserving context.
 */
export interface Restartable {
  /**
   * Replace the active connection while preserving conversation context.
   *
   * @param options - Configuration for the new connection
   */
  restart(options?: BidiModelStartOptions): Promise<void>
}

/**
 * Type guard to check whether a model can restart its connection.
 *
 * @param model - The model to check
 * @returns true if the model implements {@link Restartable}
 */
export function isRestartable(model: unknown): model is Restartable {
  return typeof (model as Partial<Restartable> | undefined)?.restart === 'function'
}

/**
 * A bidirectional model that supports audio input and output.
 */
export interface AudioCapable {
  /**
   * Get the resolved audio configuration.
   *
   * @returns The input and output audio stream formats
   */
  getAudioConfig(): AudioConfig
}

/**
 * Type guard to check whether a model exposes an audio configuration.
 *
 * @param model - The model to check
 * @returns true if the model implements {@link AudioCapable}
 */
export function isAudioCapable(model: unknown): model is AudioCapable {
  return typeof (model as Partial<AudioCapable> | undefined)?.getAudioConfig === 'function'
}

/**
 * Persistent model connection timeout.
 *
 * Unless automatic restarts are disabled, the agent loop restarts the model connection after a
 * timeout. Context recovery depends on the provider's replay or resumption support; a restart
 * may interrupt an active turn.
 */
export class ConnectionTimeoutError extends ModelError {
  /** Provider options forwarded to `restart()`, or to `start()` on the fallback path. */
  readonly restartConfig: BidiModelStartOptions & Record<string, unknown>

  /**
   * Creates a new ConnectionTimeoutError.
   *
   * @param message - Timeout message from the model
   * @param restartConfig - Provider options forwarded to the restart
   * @param options - Optional error options including the cause
   */
  constructor(
    message: string,
    restartConfig: BidiModelStartOptions & Record<string, unknown> = {},
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'ConnectionTimeoutError'
    this.restartConfig = restartConfig
  }
}

/**
 * Abstract base class for bidirectional streaming models.
 *
 * This interface defines the contract for models that support persistent streaming connections
 * with real-time audio and text communication. Implementations handle provider-specific
 * protocols while exposing a standardized event-based API.
 *
 * @typeParam TConfig - Model configuration type extending {@link BidiModelConfig}
 */
export abstract class BidiModel<TConfig extends BidiModelConfig = BidiModelConfig> extends Model<TConfig> {
  /**
   * Get the configured restart timing, or an empty config if unspecified.
   *
   * @returns The declared connection config
   */
  getConnectionConfig(): ConnectionConfig {
    return this.getConfig().connection ?? {}
  }

  /**
   * Bidirectional models use their persistent streaming API instead of request/response
   * streaming.
   *
   * @returns Never returns
   * @throws {@link Error} Always
   */
  override stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error('regular streaming is not supported by bidirectional models')
  }

  /**
   * Establish a persistent streaming connection with the model.
   *
   * Opens a bidirectional connection that remains active for real-time communication. The
   * connection supports concurrent sending and receiving of events until explicitly closed.
   * Must be called before any `send()` or `receive()` operations.
   *
   * @param options - System prompt, tools, and conversation history for the connection
   */
  abstract start(options?: BidiModelStartOptions): Promise<void>

  /**
   * Close the streaming connection and release resources.
   *
   * Terminates the active bidirectional connection and cleans up any associated resources such
   * as network connections, buffers, or background tasks. After calling `stop()`, the model
   * instance cannot be used until `start()` is called again.
   */
  abstract stop(): Promise<void>

  /**
   * Receive streaming events from the model.
   *
   * Text, reasoning, and transcript streams emit start, delta, and stop events. Each stream
   * shares a `contentId` unique within the connection. Transcript streams may interleave, and
   * user transcripts may arrive outside response boundaries.
   *
   * The stream continues until the connection is closed or an error occurs.
   *
   * @returns Async iterable of standardized events containing audio output, transcripts, tool
   *   calls, or control signals
   */
  abstract receive(): AsyncIterable<BidiOutputEvent>

  /**
   * Send a complete message or an individual delta over the active connection.
   *
   * Complete messages preserve block order and request a response after delivery, subject to
   * provider turn and tool scheduling. A message may require several provider events.
   *
   * @param content - A message of text and image blocks, a message of tool results, or a
   *   streaming audio delta
   * @throws {@link Error} If the content is unsupported by the provider
   */
  abstract send(content: BidiMessage | BidiContentDelta): Promise<void>
}
