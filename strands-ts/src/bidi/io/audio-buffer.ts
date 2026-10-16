/**
 * Audio buffering for bidirectional device I/O.
 */

import { logger } from '../../logging/logger.js'

/**
 * Buffer chunks of audio data between an agent and the audio device.
 *
 * Single-consumer: only one reader may await `get()` or `take()` at a time.
 *
 * @internal
 */
export class AudioBuffer {
  private readonly _size: number
  private _chunks: Uint8Array[] = []
  private _data = new Uint8Array(0)
  private _waiter: ((chunk: Uint8Array) => void) | undefined

  /**
   * Initialize buffer settings.
   *
   * @param size - Size of the buffer (default: unbounded)
   */
  constructor(size?: number) {
    this._size = size ?? 0
  }

  /** Setup buffer. */
  start(): void {
    this._chunks = []
    this._data = new Uint8Array(0)
  }

  /** Tear down buffer, unblocking a pending `get()` with an empty chunk. */
  stop(): void {
    this._data = new Uint8Array(0)
    this._chunks = []
    this._waiter?.(new Uint8Array(0))
    this._waiter = undefined
  }

  /**
   * Put a data chunk into the buffer, removing the oldest chunk when full.
   *
   * @param chunk - Audio samples to buffer
   */
  put(chunk: Uint8Array): void {
    // A parked reader means the queue is already drained, so hand the chunk straight over.
    const waiter = this._waiter
    if (waiter) {
      this._waiter = undefined
      waiter(chunk)
      return
    }

    if (this._size > 0 && this._chunks.length >= this._size) {
      logger.debug('buffer is full | removing oldest chunk')
      this._chunks.shift()
    }

    this._chunks.push(chunk)
  }

  /**
   * Get the first chunk put in the buffer, waiting for one if the buffer is empty.
   *
   * @returns Buffered bytes, including any leftover partial data
   */
  async get(): Promise<Uint8Array> {
    const chunk = this._chunks.shift() ?? (await this._wait())
    this._append(chunk)

    return this.take(this._data.length)
  }

  /**
   * Take the number of bytes specified from the buffer.
   *
   * @param byteCount - Number of bytes to take; the return is padded with silence when fewer are
   *   available
   * @returns Specified number of bytes
   */
  take(byteCount: number): Uint8Array {
    while (this._data.length < byteCount) {
      const chunk = this._chunks.shift()
      if (!chunk) break
      this._append(chunk)
    }

    const data = new Uint8Array(byteCount)
    data.set(this._data.subarray(0, byteCount))
    this._data = this._data.subarray(Math.min(byteCount, this._data.length))

    return data
  }

  /** Clear the buffer. */
  clear(): void {
    this._data = new Uint8Array(0)
    this._chunks = []
  }

  private _append(chunk: Uint8Array): void {
    const data = new Uint8Array(this._data.length + chunk.length)
    data.set(this._data)
    data.set(chunk, this._data.length)
    this._data = data
  }

  private async _wait(): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve) => {
      this._waiter = resolve
    })
  }
}
