/**
 * Configuration types for bidirectional I/O.
 */

import type { ConsoleIO } from './console.js'

/**
 * Configure audio devices and the console display shared with audio output.
 */
export interface AudioIOConfig {
  /** Shared display. Defaults to a console with transcripts and tool calls enabled. */
  console?: ConsoleIO

  /** Maximum number of chunks held in the microphone buffer (default: unbounded). */
  inputBufferSize?: number

  /** Specific input device id (default: system default). */
  inputDeviceIndex?: number

  /** Number of microphone samples per frame (default: 512). */
  inputFramesPerBuffer?: number

  /** Maximum number of chunks held in the playback buffer (default: unbounded). */
  outputBufferSize?: number

  /** Specific output device id (default: system default). */
  outputDeviceIndex?: number

  /** Number of playback samples per frame (default: 512). */
  outputFramesPerBuffer?: number
}

/**
 * Event delivered to a {@link BidiWebSocket} listener.
 *
 * Only the fields the I/O streams read are declared, so the browser `MessageEvent`, `CloseEvent`,
 * and `ErrorEvent` all satisfy it, as do the `ws` package's equivalents.
 */
export interface BidiWebSocketEvent {
  /** Event name: `message`, `close`, or `error`. */
  type: string

  /** Frame payload of a `message` event. */
  data?: unknown

  /** Error description of an `error` event, when the implementation provides one. */
  message?: string
}

/**
 * Minimal WebSocket shape used by {@link WebSocketIO}.
 *
 * Satisfied by the browser `WebSocket`, Node's global `WebSocket`, and the `ws` package.
 */
export interface BidiWebSocket {
  /** Current connection state, following the WebSocket readyState values. */
  readyState: number

  /** Send a text frame. */
  send(data: string): void

  /** Close the connection. */
  close(code?: number, reason?: string): void

  /** Register a listener for `message`, `close`, or `error`. */
  addEventListener(type: 'message' | 'close' | 'error', listener: (event: BidiWebSocketEvent) => void): void

  /** Remove a previously registered listener. */
  removeEventListener(type: 'message' | 'close' | 'error', listener: (event: BidiWebSocketEvent) => void): void
}

/**
 * Configure WebSocket input and output.
 */
export interface WebSocketIOConfig {
  /** Connected socket owned by the caller. */
  socket: BidiWebSocket
}

/**
 * Configure console input display and text, reasoning, transcript, and tool call output.
 */
export interface ConsoleIOConfig {
  /** Hint displayed when the input block is empty. */
  placeholder?: string

  /** Display agent text responses. */
  showText?: boolean

  /** Display agent reasoning. */
  showReasoning?: boolean

  /** Display user and agent speech transcripts. */
  showTranscript?: boolean

  /** Display tool call names. */
  showTools?: boolean
}
