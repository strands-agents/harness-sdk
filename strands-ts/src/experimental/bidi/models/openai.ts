import OpenAI from 'openai'
import { OpenAIRealtimeWebSocket } from 'openai/realtime/websocket'
import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../../../errors.js'
import { classifyOpenAIError } from '../../../models/openai/errors.js'
import { BidiModel } from '../model.js'
import { EventQueue } from '../event-queue.js'
import { formatHistory, formatInput, formatToolCalls } from './openai-format.js'
import type { RealtimeClientEvent, RealtimeServerEvent, RealtimeResponse } from 'openai/resources/realtime/realtime'
import type { AudioCapable, BidiModelConfig, BidiStartOptions } from '../model.js'
import type { AudioConfig, BidiModelInput, BidiOutputEvent } from '../types.js'
import type { ClientOptions } from 'openai'

/** OpenAI Realtime session configuration. */
export interface OpenAIRealtimeModelConfig extends BidiModelConfig {
  /** Audio output voice. Defaults to marin. */
  voice?: string
  /** Transcription model for user audio. Defaults to whisper-1. */
  transcriptionModelId?: string
  /** Maximum time to establish and configure a connection. Defaults to 30000 ms. */
  startupTimeoutMs?: number
  /** Maximum queued output events. Defaults to 256. Overflow ends the session. */
  maxBufferedEvents?: number
  /** Maximum queued output or pending outbound bytes. Defaults to 1048576. */
  maxBufferedBytes?: number
}

/** Construction options for the optional OpenAI provider. */
export interface OpenAIRealtimeModelOptions extends OpenAIRealtimeModelConfig {
  /** Preconfigured OpenAI client, including authentication. */
  client?: OpenAI
  /** OpenAI client options, used when client is omitted. */
  clientConfig?: ClientOptions
}

interface Session {
  queue: EventQueue<BidiOutputEvent>
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
  connection: OpenAIRealtimeWebSocket | undefined
  error: Error | undefined
  connectionId: string
  ready: boolean
  closed: boolean
  receiving: boolean
  responseId: string | undefined
  responseRequested: boolean
  needsResponse: boolean
  speaking: boolean
  suppressAudio: boolean
  audioStarted: boolean
  transcripts: Set<string>
  pendingTools: Set<string>
}

/**
 * Experimental OpenAI Realtime connection for Node.js 22+ and browsers.
 *
 * Uses mono PCM16 at 24 kHz in both directions with server VAD. Tool requests are
 * emitted after a completed response; callers execute tools and return results.
 * This model does not provide an agent loop, audio devices, or automatic reconnect.
 *
 * @example
 * ```typescript
 * const model = new OpenAIRealtimeModel({ modelId: 'gpt-realtime' })
 * await model.start()
 * try {
 *   await model.send(new TextBlock('Hello'))
 *   for await (const event of model.receive()) console.log(event)
 * } finally {
 *   await model.stop()
 * }
 * ```
 */
export class OpenAIRealtimeModel extends BidiModel<OpenAIRealtimeModelConfig> implements AudioCapable {
  private _config: OpenAIRealtimeModelConfig
  private readonly _client: OpenAI
  private _session: Session | undefined

  constructor(options: OpenAIRealtimeModelOptions) {
    super()
    const { client, clientConfig, ...config } = options
    this._validate(config)
    this._config = { ...config }
    this._client = client ?? new OpenAI(clientConfig)
  }

  /** Updates configuration between connections. */
  override updateConfig(config: OpenAIRealtimeModelConfig): void {
    if (this._session && !this._session.closed)
      throw new Error('Stop the Realtime session before updating configuration')
    const merged = { ...this._config, ...config }
    this._validate(merged)
    this._config = merged
  }

  /** Returns a copy of the session configuration. */
  override getConfig(): OpenAIRealtimeModelConfig {
    return { ...this._config }
  }

  /** Returns the fixed PCM16 stream formats; resampling belongs to the caller. */
  getAudioConfig(): AudioConfig {
    return {
      input: { format: 'pcm', sampleRate: 24000, channels: 1 },
      output: { format: 'pcm', sampleRate: 24000, channels: 1 },
    }
  }

  /**
   * Opens and configures a persistent session, including optional history.
   * @throws ModelError - Connection setup fails, times out, or is cancelled.
   */
  override async start(options: BidiStartOptions = {}): Promise<void> {
    if (this._session && !this._session.closed) throw new Error('A Realtime session is already active')
    const history = formatHistory(options.messages ?? [])
    let resolve!: () => void
    let reject!: (error: Error) => void
    const ready = new Promise<void>((onReady, onError) => {
      resolve = onReady
      reject = onError
    })
    const session: Session = {
      queue: new EventQueue(this._config.maxBufferedEvents ?? 256, this._config.maxBufferedBytes ?? 1048576),
      resolve,
      reject,
      cleanup: () => {},
      connection: undefined,
      error: undefined,
      connectionId: '',
      ready: false,
      closed: false,
      receiving: false,
      responseId: undefined,
      responseRequested: false,
      needsResponse: false,
      speaking: false,
      suppressAudio: false,
      audioStarted: false,
      transcripts: new Set(),
      pendingTools: new Set(),
    }
    this._session = session
    const cancel = (): void =>
      this._fail(session, new ModelError('Realtime session cancelled', { cause: options.cancelSignal?.reason }))
    const timer = setTimeout(
      () => this._fail(session, new ModelError('Realtime startup timed out')),
      this._config.startupTimeoutMs ?? 30000
    )
    session.cleanup = (): void => {
      clearTimeout(timer)
      options.cancelSignal?.removeEventListener('abort', cancel)
    }
    options.cancelSignal?.addEventListener('abort', cancel, { once: true })
    if (options.cancelSignal?.aborted) cancel()
    if (!session.closed) {
      void OpenAIRealtimeWebSocket.create(this._client, { model: this._config.modelId })
        .then((connection) => this._attach(session, connection, options, history, () => clearTimeout(timer)))
        .catch((error: unknown) => this._fail(session, error))
    }
    await ready
  }

  private _attach(
    session: Session,
    connection: OpenAIRealtimeWebSocket,
    options: BidiStartOptions,
    history: RealtimeClientEvent[],
    onConfigured: () => void
  ): void {
    // Authentication may finish after the startup deadline or cancellation.
    connection.on('error', (error) => this._fail(session, error))
    if (session.closed) {
      connection.close()
      return
    }
    session.connection = connection
    connection.on('event', (event) => this._onEvent(session, event, history, onConfigured))
    const socket = connection.socket as WebSocket
    socket.addEventListener('close', () =>
      this._fail(session, new ModelError('Realtime connection closed unexpectedly'))
    )
    socket.addEventListener(
      'open',
      () => {
        if (session.closed) return
        try {
          this._configure(session, options)
        } catch (error) {
          this._fail(session, error)
        }
      },
      { once: true }
    )
  }

  private _onEvent(
    session: Session,
    event: RealtimeServerEvent,
    history: RealtimeClientEvent[],
    onConfigured: () => void
  ): void {
    if (session.closed) return
    try {
      if (event.type === 'session.updated' && !session.ready) {
        this._ready(session, history)
        onConfigured()
      } else this._handle(session, event)
    } catch (error) {
      this._fail(session, error)
    }
  }

  private _ready(session: Session, history: RealtimeClientEvent[]): void {
    if (!session.connectionId) throw new ModelError('Realtime configuration arrived before session creation')
    for (const item of history) this._write(session, item)
    session.ready = true
    this._emit(session, {
      type: 'bidiConnectionStart',
      connectionId: session.connectionId,
      model: this._config.modelId,
    })
    session.resolve()
  }

  /** Ends the local session promptly without waiting for a remote close acknowledgement. */
  override async stop(): Promise<void> {
    const session = this._session
    if (!session || session.closed) return
    session.queue.discard(() => true)
    try {
      session.queue.push({ type: 'bidiConnectionStop', connectionId: session.connectionId, reason: 'userRequest' })
    } finally {
      this._close(session)
    }
  }

  /**
   * Sends input or a result with its original provider call ID.
   * @throws ModelError - Transport fails or its output buffer exceeds the configured bound.
   */
  override async send(content: BidiModelInput): Promise<void> {
    const session = this._session
    if (!session?.ready || session.closed) throw new Error('Realtime session is not ready')
    if (content.type === 'toolResultBlock' && !session.pendingTools.has(content.toolUseId)) {
      throw new Error('Tool result must match a pending Realtime call ID')
    }
    const event = formatInput(content)
    try {
      this._write(session, event)
      if (content.type === 'audioDelta') return
      if (content.type === 'toolResultBlock') session.pendingTools.delete(content.toolUseId)
      session.needsResponse = true
      this._respond(session)
    } catch (error) {
      this._fail(session, error)
      throw session.error
    }
  }

  /** Returns a single-consumer stream; leaving the loop closes that session. */
  override async *receive(): AsyncGenerator<BidiOutputEvent> {
    const session = this._session
    if (!session) throw new Error('Start the Realtime session before receiving events')
    if (session.receiving) throw new Error('Realtime events support only one consumer')
    session.receiving = true
    try {
      yield* session.queue.receive()
    } finally {
      this._close(session)
    }
  }

  private _configure(session: Session, options: BidiStartOptions): void {
    this._write(session, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: this._config.modelId,
        output_modalities: ['audio'],
        ...(options.systemPrompt === undefined ? {} : { instructions: options.systemPrompt }),
        tools: (options.tools ?? []).map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: false },
        })),
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: this._config.transcriptionModelId ?? 'whisper-1' },
            turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this._config.voice ?? 'marin' },
        },
      },
    })
  }

  private _handle(session: Session, event: RealtimeServerEvent): void {
    switch (event.type) {
      case 'session.created':
        if (!('id' in event.session) || typeof event.session.id !== 'string')
          throw new ModelError('Realtime session is missing its ID')
        session.connectionId = event.session.id
        break
      case 'response.created':
        if (!event.response.id) throw new ModelError('Realtime response is missing its ID')
        session.responseId = event.response.id
        session.responseRequested = false
        session.suppressAudio = session.speaking
        session.audioStarted = false
        this._emit(session, { type: 'bidiResponseStart', responseId: event.response.id })
        if (session.speaking) this._write(session, { type: 'response.cancel', response_id: event.response.id })
        break
      case 'input_audio_buffer.speech_started':
        session.speaking = true
        session.suppressAudio = true
        session.queue.discard((queued) => ['bidiAudioStart', 'bidiAudioDelta', 'bidiAudioStop'].includes(queued.type))
        this._emit(session, { type: 'bidiBargeIn', reason: 'userSpeech' })
        break
      case 'input_audio_buffer.speech_stopped':
        session.speaking = false
        break
      case 'input_audio_buffer.committed':
        session.needsResponse = true
        this._respond(session)
        break
      case 'response.output_audio.delta':
        if (session.suppressAudio || event.response_id !== session.responseId) break
        if (!session.audioStarted) this._emit(session, { type: 'bidiAudioStart' })
        session.audioStarted = true
        this._emit(session, { type: 'bidiAudioDelta', audio: event.delta, ...this.getAudioConfig().output })
        break
      case 'response.output_audio.done':
        if (session.audioStarted && !session.suppressAudio && event.response_id === session.responseId) {
          this._emit(session, { type: 'bidiAudioStop' })
          session.audioStarted = false
        }
        break
      case 'conversation.item.input_audio_transcription.delta':
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        this._transcript(session, event, false)
        break
      case 'conversation.item.input_audio_transcription.completed':
      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
        this._transcript(session, event, true)
        break
      case 'conversation.item.input_audio_transcription.failed':
        throw new ModelError(event.error.message ?? 'Realtime transcription failed')
      case 'response.done':
        this._finishResponse(session, event.response)
        break
    }
  }

  private _transcript(session: Session, event: RealtimeServerEvent, done: boolean): void {
    if (!('item_id' in event) || !('content_index' in event)) return
    const role = event.type.startsWith('conversation.') ? 'user' : 'assistant'
    const contentId = `${event.item_id}:${event.content_index}`
    if (!session.transcripts.has(contentId)) {
      if (session.transcripts.size >= (this._config.maxBufferedEvents ?? 256)) {
        throw new ModelError('Too many unfinished Realtime transcripts')
      }
      session.transcripts.add(contentId)
      this._emit(session, { type: 'bidiTranscriptStart', contentId, role })
    }
    if (done) {
      const transcript = 'transcript' in event ? event.transcript : 'text' in event ? event.text : ''
      this._emit(session, { type: 'bidiTranscriptStop', contentId, role, transcript })
      session.transcripts.delete(contentId)
    } else if ('delta' in event)
      this._emit(session, { type: 'bidiTranscriptDelta', contentId, role, delta: event.delta })
  }

  private _finishResponse(session: Session, response: RealtimeResponse): void {
    if (!response.id || response.id !== session.responseId) return
    if (response.status !== 'completed' && response.status !== 'cancelled') {
      throw new ModelError(
        `Realtime response ${response.status}: ${response.status_details?.error?.code ?? response.status_details?.reason ?? 'unknown'}`
      )
    }
    const calls = formatToolCalls(response)
    // Register the entire batch before exposing any call to an eager consumer.
    for (const call of calls) {
      const callId = call.currentToolUse.toolUseId
      if (session.pendingTools.has(callId)) throw new ModelError('Duplicate Realtime tool call ID')
      session.pendingTools.add(callId)
    }
    for (const call of calls) this._emit(session, call)
    if (response.usage)
      this._emit(session, {
        type: 'bidiUsage',
        inputTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        totalTokens: response.usage.total_tokens ?? 0,
      })
    this._emit(session, { type: 'bidiResponseStop', responseId: response.id })
    session.responseId = undefined
    this._respond(session)
  }

  private _respond(session: Session): void {
    if (
      !session.needsResponse ||
      session.responseId ||
      session.responseRequested ||
      session.pendingTools.size ||
      session.speaking
    )
      return
    session.needsResponse = false
    session.responseRequested = true
    this._write(session, { type: 'response.create' })
  }

  private _write(session: Session, event: RealtimeClientEvent): void {
    if (session.closed || !session.connection) throw session.error ?? new ModelError('Realtime connection is closed')
    const socket = session.connection.socket as WebSocket
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
    if (socket.bufferedAmount + bytes > (this._config.maxBufferedBytes ?? 1048576)) {
      throw new ModelError('Realtime outbound buffer is full')
    }
    session.connection.send(event)
    if (session.error) throw session.error
  }

  private _emit(session: Session, event: BidiOutputEvent): void {
    session.queue.push(event)
  }

  private _fail(session: Session, cause: unknown): void {
    if (session.closed) return
    const error = normalizeError(cause)
    const kind = classifyOpenAIError(error)
    const ErrorClass =
      kind === 'throttling' ? ModelThrottledError : kind === 'contextOverflow' ? ContextWindowOverflowError : ModelError
    session.error = !kind && error instanceof ModelError ? error : new ErrorClass(error.message)
    if (session.error !== error) session.error.cause = cause
    this._close(session, session.error)
  }

  private _close(session: Session, error?: Error): void {
    if (session.closed) return
    session.closed = true
    session.cleanup()
    session.reject(error ?? new ModelError('Realtime session stopped before startup completed'))
    session.queue.close(error)
    session.connection?.close()
  }

  private _validate(config: OpenAIRealtimeModelConfig): void {
    if (!config.modelId.trim()) throw new Error('Realtime modelId must not be empty')
    for (const value of [config.startupTimeoutMs, config.maxBufferedEvents, config.maxBufferedBytes]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error('Realtime limits must be positive safe integers')
    }
    if ((config.startupTimeoutMs ?? 30000) > 2147483647) {
      throw new Error('Realtime startupTimeoutMs must fit a 32-bit timer')
    }
  }
}
