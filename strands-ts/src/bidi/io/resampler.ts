/**
 * Sample-rate conversion shared by the Node and browser audio I/O.
 */

/** Bytes per sample of signed 16-bit PCM. */
const SAMPLE_SIZE = 2

/**
 * Streaming linear-interpolation resampler for mono signed 16-bit little-endian PCM.
 *
 * Keeps the last input sample and fractional position across chunks so chunk boundaries stay
 * continuous.
 *
 * @internal
 */
export class PcmResampler {
  private readonly _step: number
  private _position = 0
  private _last = 0

  constructor(
    readonly fromRate: number,
    readonly toRate: number
  ) {
    this._step = fromRate / toRate
  }

  /**
   * Resample one chunk.
   *
   * @param bytes - PCM chunk at `fromRate`
   * @returns PCM chunk at `toRate`
   */
  process(bytes: Uint8Array): Uint8Array {
    if (this.fromRate === this.toRate) return bytes

    const count = bytes.byteLength >> 1
    if (count === 0) return new Uint8Array(0)

    const input = new DataView(bytes.buffer, bytes.byteOffset, count * SAMPLE_SIZE)
    // Index 0 is the previous chunk's last sample; index i >= 1 is this chunk's sample i - 1.
    const sampleAt = (index: number): number => (index === 0 ? this._last : input.getInt16((index - 1) * 2, true))

    // Loop on position alone (never on a precomputed count): floating-point drift can make such a
    // count one short, leaving the carried position negative and the next chunk reading index -1.
    // Stopping strictly before `count` keeps the carried position in [0, step).
    const capacity = Math.ceil((count - this._position) / this._step) + 1
    const out = new Uint8Array(Math.max(0, capacity) * SAMPLE_SIZE)
    const output = new DataView(out.buffer)
    let written = 0
    while (this._position < count && written < capacity) {
      const index = Math.floor(this._position)
      const fraction = this._position - index
      const value = Math.round(sampleAt(index) * (1 - fraction) + sampleAt(index + 1) * fraction)
      output.setInt16(written * 2, Math.max(-32768, Math.min(32767, value)), true)
      written += 1
      this._position += this._step
    }

    this._last = sampleAt(count)
    this._position = Math.max(0, this._position - count)
    return out.subarray(0, written * SAMPLE_SIZE)
  }
}
