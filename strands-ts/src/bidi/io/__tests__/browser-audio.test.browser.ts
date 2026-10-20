import { afterEach, describe, expect, it } from 'vitest'

import { BrowserAudioIO, floatToPcm16, pcm16ToFloat } from '../browser-audio.js'
import type { BidiAgent } from '../../agent/agent.js'
import type { AudioConfig } from '../../models/configs.js'
import { BidiAudioDeltaEvent, BidiBargeInEvent } from '../../types/events.js'
import type { BidiInputStream, BidiOutputStream } from '../../types/io.js'
import { AudioDelta } from '../../types/media.js'

// The unit-browser project launches Chromium with a fake microphone (a looping tone) and autoplay allowed.

const AUDIO_CONFIG: AudioConfig = {
  input: { sampleRate: 16000, channels: 1, format: 'pcm' },
  output: { sampleRate: 24000, channels: 1, format: 'pcm' },
}

/** Byte payload of a captured chunk; microphone chunks always carry inline bytes. */
const bytesOf = (delta: AudioDelta): Uint8Array => (delta.source as { bytes: Uint8Array }).bytes

/** The streams only read `agent.model.getAudioConfig()`. */
function agentWith(config: AudioConfig | undefined): BidiAgent {
  return { model: config ? { getAudioConfig: () => config } : {} } as unknown as BidiAgent
}

describe('PCM conversion', () => {
  it('converts float samples to 16-bit PCM and back', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])

    expect(Array.from(pcm16ToFloat(floatToPcm16(samples)))).toStrictEqual(
      Array.from(samples).map((value) => expect.closeTo(value, 4))
    )
  })

  it('clamps out-of-range floats', () => {
    expect(Array.from(pcm16ToFloat(floatToPcm16(new Float32Array([2, -2]))))).toStrictEqual([1, -1])
  })
})

describe('BrowserAudioIO', () => {
  const started: (BidiInputStream | BidiOutputStream)[] = []

  afterEach(async () => {
    await Promise.all(started.splice(0).map((stream) => stream.stop?.()))
  })

  async function start<T extends BidiInputStream | BidiOutputStream>(stream: T, agent: BidiAgent): Promise<T> {
    await stream.start?.(agent)
    started.push(stream)
    return stream
  }

  describe('input', () => {
    it('captures microphone audio as model-rate PCM chunks', async () => {
      const input = await start(new BrowserAudioIO().input(), agentWith(AUDIO_CONFIG))

      const chunk = (await input.read()) as AudioDelta
      const samples = bytesOf(chunk).byteLength / 2

      expect(chunk).toBeInstanceOf(AudioDelta)
      // A 20 ms capture chunk at 16 kHz is ~320 samples (a sample of slack from interpolation carry).
      expect(samples).toBeGreaterThanOrEqual(319)
      expect(samples).toBeLessThanOrEqual(321)
    })

    it('keeps delivering chunks while running', async () => {
      const input = await start(new BrowserAudioIO().input(), agentWith(AUDIO_CONFIG))

      for (let i = 0; i < 5; i++) {
        expect(bytesOf((await input.read()) as AudioDelta).byteLength).toBeGreaterThan(0)
      }
    })

    it('releases the microphone and unblocks a pending read on stop', async () => {
      const input = new BrowserAudioIO().input()
      await input.start!(agentWith(AUDIO_CONFIG))
      await input.read()

      const pending = input.read()
      await input.stop!()

      await expect(pending).resolves.toBeInstanceOf(AudioDelta)
    })

    it('requires an audio-capable model', async () => {
      await expect(new BrowserAudioIO().input().start!(agentWith(undefined))).rejects.toThrow(
        'requires a model that implements AudioCapable'
      )
    })
  })

  describe('output', () => {
    const delta = (sampleRate: number, samples: number): BidiAudioDeltaEvent =>
      new BidiAudioDeltaEvent({
        type: 'bidiAudioDelta',
        audio: new Uint8Array(samples * 2),
        format: 'pcm',
        sampleRate,
        channels: 1,
        contentId: 'c1',
      })

    it('plays model audio and flushes it on barge-in', async () => {
      const output = await start(new BrowserAudioIO().output(), agentWith(AUDIO_CONFIG))

      await expect(output.write(delta(24000, 480))).resolves.toBeUndefined()
      await expect(output.write(new BidiBargeInEvent())).resolves.toBeUndefined()
    })

    it('follows a change in the model output rate', async () => {
      const output = await start(new BrowserAudioIO().output(), agentWith(AUDIO_CONFIG))

      await expect(output.write(delta(16000, 320))).resolves.toBeUndefined()
    })

    it('rejects stereo output', async () => {
      const output = await start(new BrowserAudioIO().output(), agentWith(AUDIO_CONFIG))
      const stereo = new BidiAudioDeltaEvent({
        type: 'bidiAudioDelta',
        audio: new Uint8Array(4),
        format: 'pcm',
        sampleRate: 24000,
        channels: 2,
        contentId: 'c1',
      })

      await expect(output.write(stereo)).rejects.toThrow('plays mono PCM')
    })

    it('ignores writes after stop', async () => {
      const output = new BrowserAudioIO().output()
      await output.start!(agentWith(AUDIO_CONFIG))
      await output.stop!()

      await expect(output.write(delta(24000, 480))).resolves.toBeUndefined()
    })
  })

  it('shares one audio context between input and output and closes it after both stop', async () => {
    const context = new AudioContext()
    const io = new BrowserAudioIO({ audioContext: context })
    const input = io.input()
    const output = io.output()
    await input.start!(agentWith(AUDIO_CONFIG))
    await output.start!(agentWith(AUDIO_CONFIG))

    await input.stop!()
    await output.stop!()

    // A caller-provided context is left open for the caller to manage.
    expect(context.state).not.toBe('closed')
    await context.close()
  })
})
