/**
 * WebSocket input and output for bidirectional conversations.
 *
 * Runs anywhere a WebSocket is available: the browser, Node's global `WebSocket`, or the `ws`
 * package on a server relaying frames from a browser client.
 */

import { logger } from '../../logging/logger.js'
import { Queue } from '../../queue.js'
import { ImageBlock, encodeBase64 } from '../../types/media.js'
import { TextBlock } from '../../types/messages.js'
import { AudioDelta } from '../types/media.js'

import type { MaybeSerializedInput } from '../../types/json.js'
import type { ImageBlockData } from '../../types/media.js'
import type { TextBlockData } from '../../types/messages.js'
import type { BidiAgent } from '../agent/agent.js'
import type { BidiAgentInput } from '../types/agent.js'
import type { BidiUserContentBlock } from '../types/content.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { BidiInputStream, BidiOutputStream } from '../types/io.js'
import type { AudioDeltaData } from '../types/media.js'
import type { BidiWebSocket, BidiWebSocketEvent, WebSocketIOConfig } from './configs.js'

/** `WebSocket.OPEN`, inlined so the module needs no WebSocket global. */
const OPEN = 1

/** Queued in place of a frame when the socket closes, to wake a pending `read()`. */
const closed = Symbol('closed')

/** Parse a frame, returning undefined instead of throwing on malformed JSON. */
function parseJSON(frame: string): unknown {
  try {
    return JSON.parse(frame)
  } catch {
    return undefined
  }
}

/**
 * Convert one JSON text or image block form to its block class.
 *
 * @param value - Parsed frame element
 * @returns The block, or undefined if the form is unrecognized
 */
function toContentBlock(value: unknown): string | BidiUserContentBlock | undefined {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return undefined
  if ('text' in value) return TextBlock.fromJSON(value as TextBlockData)
  if ('image' in value) return ImageBlock.fromJSON(value as { image: MaybeSerializedInput<ImageBlockData> })
  return undefined
}

/**
 * Convert a parsed inbound frame to agent input.
 *
 * @param value - Parsed frame
 * @returns Agent input, or undefined if the frame is not a supported input form
 */
function toAgentInput(value: unknown): BidiAgentInput | undefined {
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined
    const blocks = value.map(toContentBlock)
    return blocks.every((block) => block !== undefined) ? (blocks as BidiAgentInput) : undefined
  }

  if (typeof value === 'object' && value !== null && 'audioDelta' in value) {
    return AudioDelta.fromJSON(value as { audioDelta: MaybeSerializedInput<AudioDeltaData> })
  }

  return toContentBlock(value)
}

/**
 * Prepare an output event for `JSON.stringify`.
 *
 * Event classes serialize themselves through `toJSON()`. A provider may instead yield a plain
 * object, whose `Uint8Array` audio would stringify as an index map, so it is base64-encoded here.
 *
 * @param event - Output event from the agent
 * @returns A value that stringifies to the wire form
 */
function toFrame(event: BidiOutputEvent): unknown {
  if ('toJSON' in event) return event
  if (event.type === 'bidiAudioDelta') return { ...event, audio: encodeBase64(event.audio) }
  return event
}

/**
 * Read agent input from inbound WebSocket text frames.
 *
 * @internal
 */
export class WebSocketInputStream implements BidiInputStream {
  private readonly _socket: BidiWebSocket
  private readonly _frames = new Queue<BidiAgentInput | typeof closed>()
  private _closed = false
  private _detach?: (() => void) | undefined

  /**
   * Read frames from the caller's socket.
   *
   * @param socket - Connected socket owned by the caller
   */
  constructor(socket: BidiWebSocket) {
    this._socket = socket
  }

  /**
   * Queue inbound frames until the socket closes.
   *
   * @param _agent - The agent that owns this stream
   */
  async start(_agent: BidiAgent): Promise<void> {
    // A socket that is already closing or closed will never emit `close`, so a read must not park.
    this._closed = this._socket.readyState > OPEN
    const onMessage = (event: BidiWebSocketEvent): void => this._queueFrame(event.data)
    const onClose = (): void => {
      this._closed = true
      this._frames.push(closed)
    }
    const onError = (event: BidiWebSocketEvent): void => {
      logger.warn(`error=<${event.message ?? 'unknown'}> | websocket error`)
    }

    this._socket.addEventListener('message', onMessage)
    this._socket.addEventListener('close', onClose)
    this._socket.addEventListener('error', onError)

    this._detach = (): void => {
      this._socket.removeEventListener('message', onMessage)
      this._socket.removeEventListener('close', onClose)
      this._socket.removeEventListener('error', onError)
    }
  }

  /** Detach the socket listeners, leaving the socket open for its owner to close. */
  async stop(): Promise<void> {
    // No `close` event can arrive once detached, so wake any read parked on the queue.
    this._closed = true
    this._frames.push(closed)
    this._detach?.()
    this._detach = undefined
  }

  /**
   * Read the next queued frame.
   *
   * @returns The agent input carried by the frame
   * @throws Error if the socket closes before another frame arrives.
   */
  async read(): Promise<BidiAgentInput> {
    for (;;) {
      const entry = this._frames.shift()
      if (entry === undefined) {
        if (this._closed) throw new Error('websocket closed')
        await this._frames.wait()
      } else if (entry.data !== closed) {
        return entry.data
      }
    }
  }

  /** Parse one frame payload and queue it, dropping anything unsupported. */
  private _queueFrame(data: unknown): void {
    const input = typeof data === 'string' ? toAgentInput(parseJSON(data)) : undefined
    if (input === undefined) {
      const length = typeof data === 'string' ? data.length : undefined
      logger.warn(`type=<${typeof data}>, length=<${length}> | ignoring malformed websocket frame`)
      return
    }

    this._frames.push(input)
  }
}

/**
 * Write agent output events as outbound WebSocket text frames.
 *
 * @internal
 */
export class WebSocketOutputStream implements BidiOutputStream {
  private readonly _socket: BidiWebSocket

  /**
   * Write frames to the caller's socket.
   *
   * @param socket - Connected socket owned by the caller
   */
  constructor(socket: BidiWebSocket) {
    this._socket = socket
  }

  /**
   * Send one event as a JSON text frame, dropping it if the socket is not open.
   *
   * @param event - Output event from the agent
   */
  async write(event: BidiOutputEvent): Promise<void> {
    if (this._socket.readyState !== OPEN) {
      logger.debug(`type=<${event.type}>, readyState=<${this._socket.readyState}> | dropping output event`)
      return
    }

    this._socket.send(JSON.stringify(toFrame(event)))
  }
}

/**
 * WebSocket input and output for a bidirectional agent.
 *
 * The caller opens the socket and closes it; the streams only attach and detach listeners. Both
 * directions carry JSON text frames.
 *
 * Inbound frames (client to agent) carry any JSON form of `BidiAgentInput`:
 *
 * ```json
 * "hello"
 * { "text": "hello" }
 * { "image": { "format": "png", "source": { "bytes": "<base64>" } } }
 * { "audioDelta": { "format": "pcm", "source": { "bytes": "<base64>" } } }
 * ["look at this", { "image": { "format": "png", "source": { "bytes": "<base64>" } } }]
 * ```
 *
 * Text frames only: a binary frame, a frame that is not valid JSON, or a frame that is not one of
 * these forms is logged and skipped. Outbound frames
 * (agent to client) are the JSON form of one `BidiOutputEvent`, discriminated by `type`, with
 * `bidiAudioDelta` audio base64-encoded.
 *
 * @example
 * ```typescript
 * const agent = new BidiAgent({ model })
 * const io = new WebSocketIO({ socket })
 * await agent.run({ inputs: [io.input()], outputs: [io.output()] })
 * ```
 */
export class WebSocketIO {
  private readonly _socket: BidiWebSocket

  /**
   * Serve one connection.
   *
   * @param config - Configuration:
   * - socket: Connected socket owned by the caller.
   */
  constructor(config: WebSocketIOConfig) {
    this._socket = config.socket
  }

  /**
   * Return the inbound frame input stream.
   *
   * @returns Input stream that reads agent input from the socket
   */
  input(): BidiInputStream {
    return new WebSocketInputStream(this._socket)
  }

  /**
   * Return the outbound event output stream.
   *
   * @returns Output stream that sends agent events to the socket
   */
  output(): BidiOutputStream {
    return new WebSocketOutputStream(this._socket)
  }
}
