/**
 * Send and receive audio data from devices.
 *
 * Reads user audio from the input device and sends agent audio to the output device using RtAudio
 * (the `audify` package). If a user barges in, the output buffer is cleared to stop playback.
 *
 * Audio configuration is provided by models that implement `AudioCapable`.
 *
 * Node-only: `audify` is imported lazily so the module stays importable without the optional
 * dependency installed.
 */

import type { Buffer } from 'node:buffer'

import type { RtAudio } from 'audify'

import type { BidiAgent } from '../agent/agent.js'
import type { AudioStreamConfig } from '../models/configs.js'
import type { BidiAudioDeltaEventData, BidiOutputEvent } from '../types/events.js'
import type { BidiInputStream, BidiOutputStream } from '../types/io.js'
import type { AudioIOConfig } from './configs.js'

import { logger } from '../../logging/logger.js'
import { isAudioCapable } from '../models/model.js'
import { AudioDelta } from '../types/media.js'
import { AudioBuffer } from './audio-buffer.js'
import { PcmResampler } from './resampler.js'
import { ConsoleIO } from './console.js'

/** Default number of samples per frame read from or written to a device. */
const FRAMES_PER_BUFFER = 512

/** Bytes per sample of signed 16-bit PCM. */
const SAMPLE_SIZE = 2

/** Frames kept queued inside RtAudio so an event-loop stall cannot starve the output device. */
const OUTPUT_QUEUE_DEPTH = 4

/** Device selection and channel count passed to `RtAudio.openStream`. */
interface StreamParameters {
  deviceId?: number
  nChannels: number
}

/** The `audify` exports used here; its typings omit the format constants. */
interface AudifyModule {
  RtAudio: new () => RtAudio
  RtAudioFormat: { RTAUDIO_SINT16: number }
}

/** RtAudio instance, the format constant needed to open a stream, and a PCM buffer wrapper. */
interface RtAudioModule {
  rtAudio: RtAudio
  format: number
  toPcm: (data: Uint8Array) => Buffer
}

/**
 * Load `audify` and construct an RtAudio instance.
 *
 * @returns The RtAudio instance and the signed 16-bit PCM format constant
 * @throws Error if the optional `audify` dependency is not installed
 */
async function loadRtAudio(): Promise<RtAudioModule> {
  let audify: AudifyModule
  // Only a failed import means the dependency is missing; device failures must surface as they are.
  try {
    // audify is CommonJS: Node's ESM interop exposes RtAudio only on the default export.
    const imported = (await import('audify')) as unknown as Partial<AudifyModule> & { default: AudifyModule }
    audify = imported.RtAudio ? (imported as AudifyModule) : imported.default
  } catch (error: unknown) {
    throw new Error('Audio I/O requires this optional dependency. Install it with: npm install audify', {
      cause: error,
    })
  }

  const { Buffer: nodeBuffer } = await import('node:buffer')
  return {
    rtAudio: new audify.RtAudio(),
    format: audify.RtAudioFormat.RTAUDIO_SINT16,
    toPcm: (data) => nodeBuffer.from(data.buffer, data.byteOffset, data.byteLength),
  }
}

/**
 * Require PCM for microphone and speaker audio.
 *
 * @param config - Audio stream configuration reported by the model
 * @throws Error if the configured format is not PCM
 */
function validateAudioConfig(config: AudioStreamConfig): void {
  if (config.format !== 'pcm') {
    throw new Error(`AudioIO requires signed 16-bit PCM, received ${config.format}`)
  }
}

/**
 * Pick the rate to open a device at: the model's rate when the device supports it, otherwise the
 * device's preferred rate. RtAudio (unlike PortAudio) does not convert rates, and devices such as
 * built-in MacBook microphones reject 16 kHz outright.
 *
 * @param rtAudio - RtAudio instance used to query devices
 * @param deviceId - Device to open
 * @param modelRate - Sample rate the model expects
 * @returns The sample rate to open the device at
 */
function resolveDeviceRate(rtAudio: RtAudio, deviceId: number, modelRate: number): number {
  const device = rtAudio.getDevices().find((info) => info.id === deviceId)
  if (!device || device.sampleRates.length === 0 || device.sampleRates.includes(modelRate)) return modelRate
  return device.preferredSampleRate > 0 ? device.preferredSampleRate : Math.max(...device.sampleRates)
}

/**
 * Read the model's audio configuration.
 *
 * @param agent - The agent that owns the stream
 * @param direction - Stream direction to read
 * @returns Resolved audio stream configuration
 * @throws Error if the agent's model is not audio capable
 */
function getAudioConfig(agent: BidiAgent, direction: 'input' | 'output'): AudioStreamConfig {
  if (!isAudioCapable(agent.model)) {
    throw new Error('AudioIO requires a model that implements AudioCapable')
  }

  return agent.model.getAudioConfig()[direction]
}

/**
 * Handle audio input from the user.
 *
 * @internal
 */
export class AudioInputStream implements BidiInputStream {
  private readonly _buffer: AudioBuffer
  private readonly _deviceIndex: number | undefined
  private readonly _framesPerBuffer: number
  private _audioConfig: AudioStreamConfig | undefined
  private _rtAudio: RtAudio | undefined
  private _resampler: PcmResampler | undefined

  /**
   * Initialize input settings.
   *
   * @param config - Audio device configuration
   */
  constructor(config: AudioIOConfig) {
    this._buffer = new AudioBuffer(config.inputBufferSize)
    this._deviceIndex = config.inputDeviceIndex
    this._framesPerBuffer = config.inputFramesPerBuffer ?? FRAMES_PER_BUFFER
  }

  /**
   * Start the input stream.
   *
   * @param agent - The agent that owns this stream, providing access to model configuration
   * @throws Error if the model is not audio capable or the audio format is unsupported
   */
  async start(agent: BidiAgent): Promise<void> {
    logger.debug('starting audio input stream')

    const audioConfig = getAudioConfig(agent, 'input')
    validateAudioConfig(audioConfig)
    this._audioConfig = audioConfig

    const { rtAudio, format } = await loadRtAudio()
    const deviceRate = resolveDeviceRate(
      rtAudio,
      this._deviceIndex ?? rtAudio.getDefaultInputDevice(),
      audioConfig.sampleRate
    )
    this._resampler = new PcmResampler(deviceRate, audioConfig.sampleRate)
    logger.debug(`device_rate=<${deviceRate}>, model_rate=<${audioConfig.sampleRate}> | opening audio input`)
    this._buffer.start()
    this._rtAudio = rtAudio
    rtAudio.openStream(
      null,
      this._streamParameters(audioConfig),
      format,
      deviceRate,
      this._framesPerBuffer,
      'strands-audio-input',
      (data: Buffer) => {
        this._callback(data)
      },
      null
    )
    rtAudio.start()

    logger.debug('audio input stream started')
  }

  /** Stop the input stream. */
  async stop(): Promise<void> {
    logger.debug('stopping audio input stream')

    closeStream(this._rtAudio)
    this._rtAudio = undefined
    this._buffer.stop()

    logger.debug('audio input stream stopped')
  }

  /**
   * Read audio from the input stream.
   *
   * @returns Microphone audio chunk
   */
  async read(): Promise<AudioDelta> {
    const bytes = await this._buffer.get()
    return new AudioDelta({ format: 'pcm', source: { bytes } })
  }

  /**
   * Receive audio data from RtAudio.
   *
   * @param data - Captured microphone samples
   */
  private _callback(data: Uint8Array | undefined): void {
    const chunk = data ?? new Uint8Array(0)
    this._buffer.put(this._resampler ? this._resampler.process(chunk) : chunk)
  }

  private _streamParameters(config: AudioStreamConfig): StreamParameters {
    return this._deviceIndex === undefined
      ? { nChannels: config.channels }
      : { deviceId: this._deviceIndex, nChannels: config.channels }
  }
}

/**
 * Handle audio output from the bidi agent.
 *
 * @internal
 */
export class AudioOutputStream implements BidiOutputStream {
  private readonly _buffer: AudioBuffer
  private readonly _consoleOutput: BidiOutputStream
  private readonly _deviceIndex: number | undefined
  private readonly _framesPerBuffer: number
  /** Frame size the device settled on, which `RtAudio.write` requires every frame to match. */
  private _deviceFramesPerBuffer: number
  private _audioConfig: AudioStreamConfig | undefined
  private _rtAudio: RtAudio | undefined
  private _toPcm: ((data: Uint8Array) => Buffer) | undefined
  private _resampler: PcmResampler | undefined
  private _queuedFrames = 0
  private _framePlayed = false
  private _pump: ReturnType<typeof setInterval> | undefined

  /**
   * Initialize output settings.
   *
   * @param config - Audio device configuration
   * @param console - Shared terminal display
   */
  constructor(config: AudioIOConfig, console: ConsoleIO) {
    this._buffer = new AudioBuffer(config.outputBufferSize)
    this._consoleOutput = console.output()
    this._deviceIndex = config.outputDeviceIndex
    this._framesPerBuffer = config.outputFramesPerBuffer ?? FRAMES_PER_BUFFER
    this._deviceFramesPerBuffer = this._framesPerBuffer
  }

  /**
   * Start the output stream.
   *
   * @param agent - The agent that owns this stream, providing access to model configuration
   * @throws Error if the model is not audio capable or the output encoding is unsupported
   */
  async start(agent: BidiAgent): Promise<void> {
    logger.debug('starting audio output stream')

    const audioConfig = getAudioConfig(agent, 'output')
    validateAudioConfig(audioConfig)
    this._audioConfig = audioConfig

    const { rtAudio, format, toPcm } = await loadRtAudio()
    const deviceRate = resolveDeviceRate(
      rtAudio,
      this._deviceIndex ?? rtAudio.getDefaultOutputDevice(),
      audioConfig.sampleRate
    )
    this._resampler = new PcmResampler(audioConfig.sampleRate, deviceRate)
    logger.debug(`device_rate=<${deviceRate}>, model_rate=<${audioConfig.sampleRate}> | opening audio output`)
    this._buffer.start()
    this._rtAudio = rtAudio
    this._toPcm = toPcm
    const frameSize = rtAudio.openStream(
      this._streamParameters(audioConfig),
      null,
      format,
      deviceRate,
      this._framesPerBuffer,
      'strands-audio-output',
      null,
      () => {
        this._callback()
      }
    )
    // openStream reports the frame size the device settled on; write() rejects any other size.
    this._deviceFramesPerBuffer = frameSize > 0 ? frameSize : this._framesPerBuffer
    rtAudio.start()
    this._startPump(deviceRate)
    await this._consoleOutput.start?.(agent)

    logger.debug('audio output stream started')
  }

  /** Stop the output stream. */
  async stop(): Promise<void> {
    logger.debug('stopping audio output stream')

    if (this._pump !== undefined) clearInterval(this._pump)
    this._pump = undefined
    this._queuedFrames = 0
    await this._consoleOutput.stop?.()
    closeStream(this._rtAudio)
    this._rtAudio = undefined
    this._buffer.stop()

    logger.debug('audio output stream stopped')
  }

  /**
   * Send audio to the output stream and forward every event to the console.
   *
   * @param event - Output event from the agent
   * @throws Error if the audio encoding, rate, or channels differ from the playback stream
   */
  async write(event: BidiOutputEvent): Promise<void> {
    await this._consoleOutput.write(event)

    if (event.type === 'bidiAudioDelta') {
      this._validateAudioEvent(event)

      this._buffer.put(this._resampler ? this._resampler.process(event.audio) : event.audio)
      logger.debug(`audio_bytes=<${event.audio.length}> | audio chunk buffered for playback`)
    } else if (event.type === 'bidiBargeIn') {
      logger.debug('clearing audio buffer due to barge-in')
      this._buffer.clear()
      this._rtAudio?.clearOutputQueue()
      this._queuedFrames = 0
    }
  }

  /**
   * Refill the device queue at the frame period.
   *
   * RtAudio reports a played frame only when it popped a non-empty queue, so a callback-driven pump
   * stalls for good once the queue runs dry. The interval keeps writing regardless, matching the
   * pull semantics of Python's pyaudio callback.
   *
   * @param sampleRate - Playback sample rate used to derive the frame period
   */
  private _startPump(sampleRate: number): void {
    const periodMs = Math.max(1, Math.floor((this._deviceFramesPerBuffer / sampleRate) * 1000))
    this._pump = setInterval(() => {
      if (!this._framePlayed) this._queuedFrames = Math.max(0, this._queuedFrames - 1)
      this._framePlayed = false
      this._fillQueue()
    }, periodMs)
    this._fillQueue()
  }

  /** Count the frame RtAudio just played and top the queue back up. */
  private _callback(): void {
    this._queuedFrames = Math.max(0, this._queuedFrames - 1)
    this._framePlayed = true
    this._fillQueue()
  }

  /** Write buffered audio, zero-padded with silence, until the device holds `OUTPUT_QUEUE_DEPTH` frames. */
  private _fillQueue(): void {
    if (!this._rtAudio || !this._toPcm) return

    const channels = this._audioConfig?.channels ?? 1
    const byteCount = this._deviceFramesPerBuffer * channels * SAMPLE_SIZE
    while (this._queuedFrames < OUTPUT_QUEUE_DEPTH) {
      this._rtAudio.write(this._toPcm(this._buffer.take(byteCount)))
      this._queuedFrames += 1
    }
  }

  /**
   * Require audio to match the playback format.
   *
   * @param event - Audio delta emitted by the model
   * @throws Error if the event format, sample rate, or channels differ from the playback stream
   */
  private _validateAudioEvent(event: BidiAudioDeltaEventData): void {
    const config = this._audioConfig
    if (
      event.format !== config?.format ||
      event.sampleRate !== config.sampleRate ||
      event.channels !== config.channels
    ) {
      throw new Error('Audio output does not match the playback format. Restart audio I/O to reconfigure it.')
    }
  }

  private _streamParameters(config: AudioStreamConfig): StreamParameters {
    return this._deviceIndex === undefined
      ? { nChannels: config.channels }
      : { deviceId: this._deviceIndex, nChannels: config.channels }
  }
}

/**
 * Close an open RtAudio stream.
 *
 * @param rtAudio - RtAudio instance, if a stream was opened
 */
function closeStream(rtAudio: RtAudio | undefined): void {
  if (!rtAudio?.isStreamOpen()) return

  rtAudio.stop()
  rtAudio.closeStream()
}

/**
 * Send and receive audio data from devices using RtAudio.
 *
 * Reads microphone audio via `input()`, plays agent audio via `output()`, and displays user and
 * assistant transcripts. Barge-ins clear the playback buffer to stop audio playback mid-response.
 *
 * Device audio requires the optional `audify` dependency (`npm install audify`). Sample rates,
 * channels, and encoding are set through the model's audio configuration.
 *
 * @example
 * ```ts
 * import { AudioIO } from '@strands-agents/sdk/bidi/io/audio'
 *
 * const audioIO = new AudioIO()
 * await agent.run({ inputs: [audioIO.input()], outputs: [audioIO.output()] })
 * ```
 */
export class AudioIO {
  private readonly _config: AudioIOConfig
  private readonly _console: ConsoleIO

  /**
   * Initialize audio devices.
   *
   * @param config - Optional configuration:
   *
   * - console: Shared display. Defaults to a console with transcripts and tool calls enabled and a
   *   "Speak…" placeholder.
   * - inputBufferSize: Maximum microphone buffer size (default: unbounded).
   * - inputDeviceIndex: Specific input device (default: system default).
   * - inputFramesPerBuffer: Microphone samples per frame (default: 512).
   * - outputBufferSize: Maximum playback buffer size (default: unbounded).
   * - outputDeviceIndex: Specific output device (default: system default).
   * - outputFramesPerBuffer: Playback samples per frame (default: 512).
   */
  constructor(config: AudioIOConfig = {}) {
    this._config = config
    this._console = config.console ?? new ConsoleIO({ placeholder: 'Speak…', showText: false, showReasoning: false })
  }

  /**
   * Return the microphone input stream.
   *
   * @returns Input stream that reads captured audio
   */
  input(): BidiInputStream {
    return new AudioInputStream(this._config)
  }

  /**
   * Return the speaker and console output stream.
   *
   * @returns Output stream that plays audio and renders transcripts
   */
  output(): BidiOutputStream {
    return new AudioOutputStream(this._config, this._console)
  }
}

export type { AudioIOConfig } from './configs.js'
