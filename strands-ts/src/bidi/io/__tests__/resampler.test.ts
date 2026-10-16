import { describe, expect, it } from 'vitest'

import { PcmResampler } from '../resampler.js'

/** Deterministic PRNG so chunk sizes are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true))
  return bytes
}

function samples(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true))
}

describe('PcmResampler', () => {
  it('passes audio through unchanged when the rates match', () => {
    const chunk = pcm([1, 2, 3])
    expect(new PcmResampler(16000, 16000).process(chunk)).toBe(chunk)
  })

  it('interpolates between samples across chunk boundaries', () => {
    const resampler = new PcmResampler(16000, 32000)
    // Output lags input by one sample: each chunk interpolates from the previous chunk's last sample.
    expect(samples(resampler.process(pcm([100, 200])))).toStrictEqual([0, 50, 100, 150])
    expect(samples(resampler.process(pcm([300])))).toStrictEqual([200, 250])
  })

  it('keeps the carried position non-negative when drift lands it on a chunk boundary', () => {
    // 241-sample chunks at 24 kHz -> 44.1 kHz once left the carried position at -1e-14, so the next
    // chunk read sample index -1 and threw a RangeError.
    const resampler = new PcmResampler(24000, 44100)
    for (let i = 0; i < 50; i++) {
      expect(() => resampler.process(new Uint8Array(241 * 2))).not.toThrow()
    }
  })

  it.each([
    [24000, 44100],
    [16000, 44100],
    [16000, 48000],
    [24000, 48000],
    [48000, 16000],
    [44100, 16000],
    [44100, 24000],
  ])('streams %i Hz to %i Hz over arbitrary chunk sizes without drifting', (from, to) => {
    const random = prng(from * 31 + to)
    const resampler = new PcmResampler(from, to)
    let inputSamples = 0
    let outputSamples = 0
    for (let i = 0; i < 500; i++) {
      const count = 1 + Math.floor(random() * 1000)
      inputSamples += count
      outputSamples += resampler.process(new Uint8Array(count * 2)).byteLength / 2
    }
    expect(Math.abs(outputSamples - (inputSamples * to) / from)).toBeLessThanOrEqual(2)
  })
})
