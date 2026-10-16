/**
 * Browser microphone and speaker I/O for bidi agents, built on `getUserMedia` and AudioWorklets.
 *
 * Browser-only: requires `navigator.mediaDevices`, `AudioContext`, and `AudioWorkletNode`.
 */

import type { BidiAgent } from '../agent/agent.js'
import type { AudioStreamConfig } from '../models/configs.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { BidiInputStream, BidiOutputStream } from '../types/io.js'

import { logger } from '../../logging/logger.js'
import { isAudioCapable } from '../models/model.js'
import { AudioDelta } from '../types/media.js'
import { PcmResampler } from './resampler.js'

/**
 * Configuration for {@link BrowserAudioIO}.
 */
export interface BrowserAudioIOConfig {
  /**
   * Microphone constraints passed to `getUserMedia`. Defaults enable the browser's echo cancellation,
   * noise suppression, and automatic gain control, so the agent does not hear its own voice.
   */
  audioConstraints?: MediaTrackConstraints

  /** Audio context to use instead of creating one. It is left open when the streams stop. */
  audioContext?: AudioContext

  /** Microphone capture chunk length in milliseconds (default: 20). */
  captureChunkMs?: number
}

/** Default microphone processing: the browser's built-in WebRTC audio processing. */
const DEFAULT_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

const CAPTURE_PROCESSOR = 'strands-bidi-capture'
const PLAYBACK_PROCESSOR = 'strands-bidi-playback'

/**
 * AudioWorklet processors. Capture batches mono Float32 frames into fixed-size chunks; playback drains a
 * queue of Float32 chunks and outputs silence when empty, flushing the queue on a `clear` message.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    // Kept separately: transferring a chunk detaches its buffer, so chunk.length reads 0 afterwards.
    this.size = options.processorOptions.chunkFrames
    this.chunk = new Float32Array(this.size)
    this.filled = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    let offset = 0
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.size - this.filled)
      this.chunk.set(channel.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === this.size) {
        this.port.postMessage(this.chunk, [this.chunk.buffer])
        this.chunk = new Float32Array(this.size)
        this.filled = 0
      }
    }
    return true
  }
}
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data === 'clear') {
        this.queue = []
        this.offset = 0
      } else {
        this.queue.push(event.data)
      }
    }
  }
  process(_inputs, outputs) {
    const output = outputs[0][0]
    let written = 0
    while (written < output.length && this.queue.length > 0) {
      const head = this.queue[0]
      const count = Math.min(output.length - written, head.length - this.offset)
      output.set(head.subarray(this.offset, this.offset + count), written)
      written += count
      this.offset += count
      if (this.offset === head.length) {
        this.queue.shift()
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('${CAPTURE_PROCESSOR}', CaptureProcessor)
registerProcessor('${PLAYBACK_PROCESSOR}', PlaybackProcessor)
`

/**
 * Convert Float32 samples in [-1, 1] to signed 16-bit little-endian PCM.
 *
 * @internal
 */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return bytes
}

/**
 * Convert signed 16-bit little-endian PCM to Float32 samples in [-1, 1].
 *
 * @internal
 */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array {
  const count = bytes.byteLength >> 1
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  const samples = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const value = view.getInt16(i * 2, true)
    samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff
  }
  return samples
}

/** Read the model's audio format for one direction, requiring mono PCM. */
function getAudioConfig(agent: BidiAgent, direction: 'input' | 'output'): AudioStreamConfig {
  if (!isAudioCapable(agent.model)) {
    throw new Error('BrowserAudioIO requires a model that implements AudioCapable')
  }
  const config = agent.model.getAudioConfig()[direction]
  if (config.format !== 'pcm') {
    throw new Error(`BrowserAudioIO requires PCM audio, received ${config.format}`)
  }
  return config
}

/**
 * Owns the shared AudioContext and worklet module for one {@link BrowserAudioIO}, closing the context
 * once both streams have released it.
 */
class AudioContextHandle {
  private readonly _external: AudioContext | undefined
  private _context: Promise<AudioContext> | undefined
  private _users = 0

  constructor(external: AudioContext | undefined) {
    this._external = external
  }

  async acquire(): Promise<AudioContext> {
    this._users += 1
    this._context ??= this._create()
    const context = await this._context
    // Contexts created outside a user gesture start suspended; resuming relies on the page's sticky activation.
    if (context.state === 'suspended') await context.resume()
    return context
  }

  async release(): Promise<void> {
    this._users = Math.max(0, this._users - 1)
    if (this._users > 0 || !this._context) return
    const context = await this._context
    this._context = undefined
    if (context !== this._external && context.state !== 'closed') await context.close()
  }

  private async _create(): Promise<AudioContext> {
    const context = this._external ?? new AudioContext()
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    return context
  }
}

/**
 * Microphone input stream.
 *
 * @internal
 */
export class BrowserAudioInputStream implements BidiInputStream {
  private readonly _handle: AudioContextHandle
  private readonly _constraints: MediaTrackConstraints
  private readonly _chunkMs: number
  private readonly _chunks: Uint8Array[] = []
  private _waiter: (() => void) | undefined
  private _media: MediaStream | undefined
  private _source: MediaStreamAudioSourceNode | undefined
  private _node: AudioWorkletNode | undefined
  private _resampler: PcmResampler | undefined
  private _stopped = false

  constructor(handle: AudioContextHandle, config: BrowserAudioIOConfig) {
    this._handle = handle
    this._constraints = config.audioConstraints ?? DEFAULT_AUDIO_CONSTRAINTS
    this._chunkMs = config.captureChunkMs ?? 20
  }

  /**
   * Open the microphone and start capturing at the model's input rate.
   *
   * @param agent - The agent that owns this stream, providing the model's audio format
   */
  async start(agent: BidiAgent): Promise<void> {
    const audioConfig = getAudioConfig(agent, 'input')
    this._stopped = false
    this._media = await globalThis.navigator.mediaDevices.getUserMedia({ audio: this._constraints })
    const context = await this._handle.acquire()

    this._resampler = new PcmResampler(context.sampleRate, audioConfig.sampleRate)
    this._source = context.createMediaStreamSource(this._media)
    this._node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { chunkFrames: Math.round((context.sampleRate * this._chunkMs) / 1000) },
    })
    this._node.port.onmessage = (event: MessageEvent<Float32Array>): void => this._onChunk(event.data)
    this._source.connect(this._node)
    // The capture node outputs silence; connecting it keeps the graph pulling it every render quantum.
    this._node.connect(context.destination)
    logger.debug(
      `device_rate=<${context.sampleRate}>, model_rate=<${audioConfig.sampleRate}> | browser audio input started`
    )
  }

  /** Stop capturing and release the microphone. */
  async stop(): Promise<void> {
    if (this._stopped) return
    this._stopped = true
    this._node?.port.close()
    this._node?.disconnect()
    this._source?.disconnect()
    this._media?.getTracks().forEach((track) => track.stop())
    this._node = undefined
    this._source = undefined
    this._media = undefined
    this._wake()
    await this._handle.release()
  }

  /**
   * Read the next microphone chunk as model-rate PCM.
   *
   * @returns Microphone audio chunk
   */
  async read(): Promise<AudioDelta> {
    while (this._chunks.length === 0 && !this._stopped) {
      await new Promise<void>((resolve) => {
        this._waiter = resolve
      })
    }
    const bytes = this._chunks.shift() ?? new Uint8Array(0)
    return new AudioDelta({ format: 'pcm', source: { bytes } })
  }

  private _onChunk(samples: Float32Array): void {
    const bytes = this._resampler!.process(floatToPcm16(samples))
    if (bytes.byteLength === 0) return
    this._chunks.push(bytes)
    this._wake()
  }

  private _wake(): void {
    const waiter = this._waiter
    this._waiter = undefined
    waiter?.()
  }
}

/**
 * Speaker output stream.
 *
 * @internal
 */
export class BrowserAudioOutputStream implements BidiOutputStream {
  private readonly _handle: AudioContextHandle
  private _node: AudioWorkletNode | undefined
  private _contextRate = 0
  private _resampler: PcmResampler | undefined

  constructor(handle: AudioContextHandle) {
    this._handle = handle
  }

  /**
   * Start the speaker output.
   *
   * @param agent - The agent that owns this stream, providing the model's audio format
   */
  async start(agent: BidiAgent): Promise<void> {
    const audioConfig = getAudioConfig(agent, 'output')
    const context = await this._handle.acquire()
    this._contextRate = context.sampleRate
    this._resampler = new PcmResampler(audioConfig.sampleRate, context.sampleRate)
    this._node = new AudioWorkletNode(context, PLAYBACK_PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    this._node.connect(context.destination)
    logger.debug(
      `device_rate=<${context.sampleRate}>, model_rate=<${audioConfig.sampleRate}> | browser audio output started`
    )
  }

  /** Stop the speaker output, dropping anything still queued. */
  async stop(): Promise<void> {
    if (!this._node) return
    this._node.port.postMessage('clear')
    this._node.port.close()
    this._node.disconnect()
    this._node = undefined
    await this._handle.release()
  }

  /**
   * Play model audio and flush queued audio when the user barges in.
   *
   * @param event - Output event from the agent
   */
  async write(event: BidiOutputEvent): Promise<void> {
    if (!this._node) return

    if (event.type === 'bidiAudioDelta') {
      if (event.format !== 'pcm' || event.channels !== 1) {
        throw new Error(`BrowserAudioIO plays mono PCM, received ${event.format} with ${event.channels} channels`)
      }
      if (this._resampler?.fromRate !== event.sampleRate) {
        this._resampler = new PcmResampler(event.sampleRate, this._contextRate)
      }
      const samples = pcm16ToFloat(this._resampler.process(event.audio))
      if (samples.length > 0) this._node.port.postMessage(samples, [samples.buffer])
    } else if (event.type === 'bidiBargeIn') {
      this._node.port.postMessage('clear')
    }
  }
}

/**
 * Microphone and speaker I/O for bidi agents running in a browser.
 *
 * The microphone uses the browser's built-in echo cancellation, noise suppression, and gain control by
 * default, so the agent does not hear its own replies through the speakers. Audio is converted between
 * the device rate and the model's rates in both directions, and queued playback is flushed when the user
 * interrupts the model.
 *
 * Call `agent.run()` (or `start()`) from a user gesture, such as a click handler, so the browser allows
 * microphone access and audio playback.
 *
 * Transcripts, text, and tool calls are not rendered; add a callback output to show them.
 *
 * @example
 * ```typescript
 * import { BidiAgent, OpenAIRealtimeModel } from '@strands-agents/sdk/bidi'
 * import { BrowserAudioIO } from '@strands-agents/sdk/bidi/io/browser-audio'
 *
 * const audio = new BrowserAudioIO()
 * button.onclick = () =>
 *   agent.run({
 *     inputs: [audio.input()],
 *     outputs: [audio.output(), (event) => event.type === 'bidiTranscriptBlock' && show(event.transcript)],
 *   })
 * ```
 */
export class BrowserAudioIO {
  private readonly _config: BrowserAudioIOConfig
  private readonly _handle: AudioContextHandle

  /**
   * Initialize browser audio I/O.
   *
   * @param config - Optional microphone constraints, audio context, and capture chunk length
   */
  constructor(config: BrowserAudioIOConfig = {}) {
    this._config = config
    this._handle = new AudioContextHandle(config.audioContext)
  }

  /**
   * Return the microphone input stream.
   *
   * @returns Input stream that captures microphone audio at the model's input rate
   */
  input(): BidiInputStream {
    return new BrowserAudioInputStream(this._handle, this._config)
  }

  /**
   * Return the speaker output stream.
   *
   * @returns Output stream that plays model audio
   */
  output(): BidiOutputStream {
    return new BrowserAudioOutputStream(this._handle)
  }
}
