/**
 * Tests for device audio input and output streams.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BidiAudioDeltaEvent,
  BidiBargeInEvent,
  BidiResponseStopEvent,
  BidiTranscriptStartEvent,
} from '../../types/events.js'
import { AudioBuffer } from '../audio-buffer.js'
import { AudioIO } from '../audio.js'
import { ConsoleIO } from '../console.js'

import type { AudioConfig } from '../../models/configs.js'
import type { BidiAgent } from '../../agent/agent.js'
import type { AudioIOConfig } from '../configs.js'

/** RtAudio stand-in that records opened streams and played frames. */
const rtAudio = vi.hoisted(() => ({
  construct: vi.fn(),
  openStream: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  closeStream: vi.fn(),
  write: vi.fn(),
  clearOutputQueue: vi.fn(),
  isStreamOpen: vi.fn(() => true),
  getDevices: vi.fn(() => []),
  getDefaultInputDevice: vi.fn(() => 0),
  getDefaultOutputDevice: vi.fn(() => 0),
}))

/** The `audify` module shape, reusable when a test reloads the module graph. */
const audifyFactory = vi.hoisted(() => () => ({
  RtAudio: vi.fn(function RtAudioMock() {
    rtAudio.construct()
    return rtAudio
  }),
  RtAudioFormat: { RTAUDIO_SINT16: 0x2 },
}))

vi.mock('audify', audifyFactory)

/** Arguments captured from the single `openStream` call. */
function openStreamCall(): {
  outputParameters: { deviceId?: number; nChannels: number } | null
  inputParameters: { deviceId?: number; nChannels: number } | null
  format: number
  sampleRate: number
  frameSize: number
  inputCallback: ((data: Uint8Array) => void) | null
  frameOutputCallback: (() => void) | null
} {
  expect(rtAudio.openStream).toHaveBeenCalledOnce()
  const call = rtAudio.openStream.mock.calls[0] as unknown[]
  return {
    outputParameters: call[0] as { nChannels: number } | null,
    inputParameters: call[1] as { nChannels: number } | null,
    format: call[2] as number,
    sampleRate: call[3] as number,
    frameSize: call[4] as number,
    inputCallback: call[6] as ((data: Uint8Array) => void) | null,
    frameOutputCallback: call[7] as (() => void) | null,
  }
}

/** Bytes handed to RtAudio by the most recent playback frame. */
function lastPlayedFrame(): Uint8Array {
  const calls = rtAudio.write.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return new Uint8Array(calls[calls.length - 1]![0] as Uint8Array)
}

/** Agent whose model reports the given audio configuration. */
function createAgent(audioConfig: AudioConfig): BidiAgent {
  return { model: { getAudioConfig: () => audioConfig } } as unknown as BidiAgent
}

const audioConfig: AudioConfig = {
  input: { sampleRate: 24000, channels: 2, format: 'pcm' },
  output: { sampleRate: 16000, channels: 2, format: 'pcm' },
}

const config: AudioIOConfig = {
  inputBufferSize: 1,
  inputDeviceIndex: 1,
  inputFramesPerBuffer: 1024,
  outputBufferSize: 2,
  outputDeviceIndex: 2,
  outputFramesPerBuffer: 2048,
}

const audioDeltaEvent = new BidiAudioDeltaEvent({
  type: 'bidiAudioDelta',
  audio: new TextEncoder().encode('test-audio'),
  channels: 2,
  format: 'pcm',
  sampleRate: 16000,
  contentId: 'audio',
})

beforeEach(() => {
  vi.clearAllMocks()
  rtAudio.isStreamOpen.mockReturnValue(true)
})

describe('AudioBuffer', () => {
  let buffer: AudioBuffer

  beforeEach(() => {
    buffer = new AudioBuffer(1)
    buffer.start()
  })

  it('returns the chunk that was put', async () => {
    buffer.put(new TextEncoder().encode('test-chunk'))

    expect(await buffer.get()).toEqual(new TextEncoder().encode('test-chunk'))
  })

  it('drops the oldest chunk when full', async () => {
    buffer.put(new TextEncoder().encode('test-chunk-1'))
    buffer.put(new TextEncoder().encode('test-chunk-2'))

    expect(await buffer.get()).toEqual(new TextEncoder().encode('test-chunk-2'))
  })

  it('pads missing bytes with silence', () => {
    buffer.put(new TextEncoder().encode('test-chunk'))

    expect(buffer.take(11)).toEqual(new TextEncoder().encode('test-chunk\x00'))
  })

  it('returns silence after a clear', () => {
    buffer.put(new TextEncoder().encode('test-chunk'))
    buffer.clear()

    expect(buffer.take(1)).toEqual(new Uint8Array([0]))
  })

  it('discards partial data on clear', () => {
    buffer.put(new TextEncoder().encode('ab'))
    expect(buffer.take(1)).toEqual(new TextEncoder().encode('a'))

    buffer.clear()

    expect(buffer.take(1)).toEqual(new Uint8Array([0]))
  })

  it('stops while full', () => {
    const bounded = new AudioBuffer(2)
    bounded.start()
    bounded.put(new TextEncoder().encode('a'))
    bounded.put(new TextEncoder().encode('b'))

    expect(() => {
      bounded.stop()
    }).not.toThrow()
  })

  it('unblocks a pending read on stop', async () => {
    const pending = buffer.get()
    buffer.stop()

    expect(await pending).toEqual(new Uint8Array(0))
  })
})

describe('AudioIO', () => {
  describe('input', () => {
    it('reads captured audio as an audio delta', async () => {
      const input = new AudioIO(config).input()
      await input.start?.(createAgent(audioConfig))

      openStreamCall().inputCallback?.(new TextEncoder().encode('test-audio'))

      expect(await input.read()).toEqual({
        type: 'audioDelta',
        format: 'pcm',
        source: { type: 'audioSourceBytes', bytes: new TextEncoder().encode('test-audio') },
      })

      await input.stop?.()
    })

    it('opens the capture stream with the configured devices and format', async () => {
      const input = new AudioIO(config).input()
      await input.start?.(createAgent(audioConfig))

      const call = openStreamCall()
      expect(call.outputParameters).toBeNull()
      expect(call.inputParameters).toEqual({ deviceId: 1, nChannels: 2 })
      expect(call.format).toBe(0x2)
      expect(call.sampleRate).toBe(24000)
      expect(call.frameSize).toBe(1024)
      expect(rtAudio.start).toHaveBeenCalledOnce()

      await input.stop?.()
    })

    it('closes the stream on stop', async () => {
      const input = new AudioIO(config).input()
      await input.start?.(createAgent(audioConfig))
      await input.stop?.()

      expect(rtAudio.stop).toHaveBeenCalledOnce()
      expect(rtAudio.closeStream).toHaveBeenCalledOnce()
    })
  })

  describe('output', () => {
    // The pump writes on an interval, so playback assertions need control over the clock.
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Started output stream that plays two-sample frames. */
    async function createOutput(console?: ConsoleIO): Promise<ReturnType<AudioIO['output']>> {
      const output = new AudioIO({
        ...config,
        outputFramesPerBuffer: 2,
        ...(console ? { console } : {}),
      }).output()
      await output.start?.(createAgent(audioConfig))
      return output
    }

    it('plays buffered audio on the next frame', async () => {
      const output = await createOutput()

      await output.write(audioDeltaEvent)
      openStreamCall().frameOutputCallback?.()

      expect(lastPlayedFrame()).toEqual(new TextEncoder().encode('test-aud'))

      await output.stop?.()
    })

    it('keeps playing when the device never reports a played frame', async () => {
      const output = await createOutput()
      const primed = rtAudio.write.mock.calls.length

      await output.write(audioDeltaEvent)
      // audify fires frameOutputCallback only after popping a non-empty queue, so none arrives here.
      await vi.advanceTimersByTimeAsync(10)

      const played = rtAudio.write.mock.calls.slice(primed).map((call) => new Uint8Array(call[0] as Uint8Array))
      expect(played.length).toBeGreaterThan(0)
      expect(played).toContainEqual(new TextEncoder().encode('test-aud'))

      await output.stop?.()
    })

    it('stops the playback pump on stop', async () => {
      const output = await createOutput()
      await output.stop?.()
      const written = rtAudio.write.mock.calls.length

      await vi.advanceTimersByTimeAsync(10)

      expect(rtAudio.write).toHaveBeenCalledTimes(written)
    })

    it('plays frames sized by the frame size openStream reports', async () => {
      rtAudio.openStream.mockReturnValueOnce(4)
      const output = await createOutput()

      await output.write(audioDeltaEvent)
      openStreamCall().frameOutputCallback?.()

      const expected = new Uint8Array(16)
      expected.set(new TextEncoder().encode('test-audio'))
      expect(lastPlayedFrame()).toEqual(expected)

      await output.stop?.()
    })

    it.each([
      { format: 'wav', sampleRate: 16000, channels: 2 },
      { format: 'pcm', sampleRate: 24000, channels: 2 },
      { format: 'pcm', sampleRate: 16000, channels: 1 },
    ] as const)('rejects audio that changed format (%o)', async (stream) => {
      const output = await createOutput()
      const event = new BidiAudioDeltaEvent({
        type: 'bidiAudioDelta',
        audio: new TextEncoder().encode('audio'),
        contentId: 'audio',
        ...stream,
      })

      await expect(output.write(event)).rejects.toThrow('does not match the playback format')

      openStreamCall().frameOutputCallback?.()
      expect(lastPlayedFrame()).toEqual(new Uint8Array(8))

      await output.stop?.()
    })

    it('clears buffered audio on barge-in', async () => {
      const output = await createOutput()

      await output.write(audioDeltaEvent)
      await output.write(new BidiBargeInEvent())

      openStreamCall().frameOutputCallback?.()
      expect(lastPlayedFrame()).toEqual(new Uint8Array(8))
      expect(rtAudio.clearOutputQueue).toHaveBeenCalledOnce()

      await output.stop?.()
    })

    it('opens the playback stream with the configured devices and format', async () => {
      const output = new AudioIO(config).output()
      await output.start?.(createAgent(audioConfig))

      const call = openStreamCall()
      expect(call.inputParameters).toBeNull()
      expect(call.outputParameters).toEqual({ deviceId: 2, nChannels: 2 })
      expect(call.format).toBe(0x2)
      expect(call.sampleRate).toBe(16000)
      expect(call.frameSize).toBe(2048)

      await output.stop?.()
    })

    it('forwards events to the console output', async () => {
      const console = new ConsoleIO()
      const consoleOutput = { start: vi.fn(), stop: vi.fn(), write: vi.fn() }
      vi.spyOn(console, 'output').mockReturnValue(consoleOutput)
      const event = new BidiResponseStopEvent({
        type: 'bidiResponseStop',
        responseId: 'response-1',
      })
      const output = await createOutput(console)

      await output.write(event)

      expect(consoleOutput.write).toHaveBeenCalledWith(event)

      await output.stop?.()
    })

    it('forwards events to a shared console', async () => {
      const console = new ConsoleIO()
      const consoleOutput = { start: vi.fn(), stop: vi.fn(), write: vi.fn() }
      vi.spyOn(console, 'output').mockReturnValue(consoleOutput)
      const output = new AudioIO({ console }).output()
      const event = new BidiTranscriptStartEvent({
        type: 'bidiTranscriptStart',
        role: 'assistant',
        contentId: 'speech',
      })

      await output.write(event)

      expect(consoleOutput.write).toHaveBeenCalledWith(event)
    })

    it('starts and stops the console output', async () => {
      const console = new ConsoleIO()
      const consoleOutput = { start: vi.fn(), stop: vi.fn(), write: vi.fn() }
      vi.spyOn(console, 'output').mockReturnValue(consoleOutput)
      const output = await createOutput(console)

      expect(consoleOutput.start).toHaveBeenCalledOnce()

      await output.stop?.()

      expect(consoleOutput.stop).toHaveBeenCalledOnce()
    })
  })

  describe('validation', () => {
    it.each(['input', 'output'] as const)('rejects a model without audio capability (%s)', async (direction) => {
      const audioIO = new AudioIO()
      const stream = direction === 'input' ? audioIO.input() : audioIO.output()
      const agent = { model: {} } as unknown as BidiAgent

      await expect(stream.start?.(agent)).rejects.toThrow('AudioIO requires a model that implements AudioCapable')
      expect(rtAudio.construct).not.toHaveBeenCalled()
    })

    it.each(['wav', 'opus', 'mp3'] as const)('rejects unsupported input encoding (%s)', async (format) => {
      const audioIO = new AudioIO()
      const agent = createAgent({ ...audioConfig, input: { ...audioConfig.input, format } })

      await expect(audioIO.input().start?.(agent)).rejects.toThrow(
        `AudioIO requires signed 16-bit PCM, received ${format}`
      )
      expect(rtAudio.construct).not.toHaveBeenCalled()
    })

    it.each(['wav', 'opus', 'mp3'] as const)('rejects unsupported output encoding (%s)', async (format) => {
      const audioIO = new AudioIO()
      const agent = createAgent({ ...audioConfig, output: { ...audioConfig.output, format } })

      await expect(audioIO.output().start?.(agent)).rejects.toThrow(
        `AudioIO requires signed 16-bit PCM, received ${format}`
      )
      expect(rtAudio.construct).not.toHaveBeenCalled()
    })

    it('reports the install instruction when the audify module cannot be imported', async () => {
      vi.doMock('audify', () => {
        throw new Error("Cannot find module 'audify'")
      })
      vi.resetModules()

      try {
        const { AudioIO: ReloadedAudioIO } = await import('../audio.js')

        await expect(new ReloadedAudioIO().input().start?.(createAgent(audioConfig))).rejects.toThrow(
          'Audio I/O requires this optional dependency. Install it with: npm install audify'
        )
      } finally {
        vi.doMock('audify', audifyFactory)
        vi.resetModules()
      }
    })

    it('surfaces a device failure unchanged', async () => {
      rtAudio.construct.mockImplementationOnce(() => {
        throw new Error('cannot open shared object file: libasound.so.2')
      })

      await expect(new AudioIO().input().start?.(createAgent(audioConfig))).rejects.toThrow(
        'cannot open shared object file: libasound.so.2'
      )
    })
  })
})
