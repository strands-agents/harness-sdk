/**
 * OpenAI Realtime API provider for Strands bidirectional streaming.
 *
 * Provides real-time audio and text communication through OpenAI's Realtime API
 * with WebSocket connections, voice activity detection, and function calling.
 */

import { ModelError, ModelThrottledError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { ImageBlock } from '../../types/media.js'
import { JsonBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import { decodeBase64, encodeBase64 } from '../../types/media.js'
import { stopAll } from '../async/stop-all.js'
import {
  BidiAudioDeltaEvent,
  BidiAudioStartEvent,
  BidiAudioStopEvent,
  BidiBargeInEvent,
  BidiConnectionStartEvent,
  BidiResponseStartEvent,
  BidiResponseStopEvent,
  BidiTextDeltaEvent,
  BidiTextStartEvent,
  BidiTextStopEvent,
  BidiToolUseBlocksEvent,
  BidiTranscriptDeltaEvent,
  BidiTranscriptStartEvent,
  BidiTranscriptStopEvent,
  BidiUsageEvent,
} from '../types/events.js'
import { AudioDelta } from '../types/media.js'
import { mergeConfig } from './configs.js'
import { BidiModel, ConnectionTimeoutError } from './model.js'

import type { JSONValue } from '../../types/json.js'
import type { Message, Role } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import type { BidiContentDelta, BidiMessage } from '../types/content.js'
import type { BidiOutputEvent, TokenDetails } from '../types/events.js'
import type { AudioCapable, BidiModelStartOptions, Restartable } from './model.js'
import type { AudioConfig, BidiModelConfig, ConnectionConfig } from './configs.js'

/**
 * Max timeout before closing connection.
 *
 * OpenAI documents a 60 minute limit on realtime sessions
 * ([docs](https://platform.openai.com/docs/guides/realtime-conversations#session-lifecycle-events)). However, OpenAI
 * does not emit any warnings when approaching the limit. As a workaround, we configure a max timeout client side to
 * gracefully handle the connection closure. We set the max to 50 minutes to provide enough buffer before hitting the
 * real limit.
 *
 * @internal
 */
export const OPENAI_MAX_TIMEOUT_MS = 3_000_000

/**
 * Proactive restart fires this many milliseconds below the reader's reactive timeout, leaving room
 * for the turn-boundary alignment wait so a mid-turn swap stays graceful instead of being preempted
 * by the reactive timeout firing at the same instant.
 *
 * @internal
 */
export const OPENAI_PROACTIVE_RESTART_MARGIN_MS = 300_000

const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime'
const DEFAULT_SAMPLE_RATE = 24000
const RECV_POLL_TIMEOUT_MS = 10_000
const SEND_BUFFER_HIGH_WATER_BYTES = 1_048_576
const SEND_DRAIN_POLL_MS = 5

const DEFAULT_SESSION_CONFIG: Record<string, unknown> = {
  type: 'realtime',
  instructions: 'You are a helpful assistant. Please speak in English and keep your responses clear and concise.',
  output_modalities: ['audio'],
  audio: {
    input: {
      format: { type: 'audio/pcm', rate: DEFAULT_SAMPLE_RATE },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    },
    output: { format: { type: 'audio/pcm', rate: DEFAULT_SAMPLE_RATE } },
  },
}

/**
 * Sent as a system message after a restart. Replay restores the conversation text but not the
 * live audio state, so the fresh session can drift language or re-introduce itself; this steers it
 * to continue seamlessly.
 *
 * @internal
 */
export const RESTART_INSTRUCTION =
  'The connection was re-established mid-conversation. Continue seamlessly from the prior ' +
  'context: do not greet or re-introduce yourself, and keep replying in the language already in use.'

/** Shape of a server or client event on the OpenAI Realtime wire. */
type RealtimeEvent = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Minimal WebSocket surface used by the provider.
 *
 * Satisfied by the global `WebSocket` and by test doubles.
 *
 * @internal
 */
export interface OpenAIRealtimeWebSocket {
  /** Current connection state, following the WebSocket readyState values. */
  readyState: number

  /** Bytes queued but not yet written to the network, when the implementation reports it. */
  bufferedAmount?: number

  /** Send a serialized client event. */
  send(data: string): void

  /** Close the connection. */
  close(): void

  /** Register a listener for `open`, `message`, `close`, or `error`. */
  addEventListener(type: string, listener: (event: any) => void): void // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Remove a previously registered listener. */
  removeEventListener?(type: string, listener: (event: any) => void): void // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Creates the WebSocket used for a connection.
 *
 * @param url - Realtime endpoint including the model query parameter
 * @param headers - Authorization and account headers for the handshake
 * @returns An unopened WebSocket
 *
 * @internal
 */
export type OpenAIRealtimeWebSocketFactory = (url: string, headers: Record<string, string>) => OpenAIRealtimeWebSocket

/**
 * Configuration for {@link OpenAIRealtimeModel}.
 */
export interface OpenAIRealtimeModelConfig extends BidiModelConfig {
  /**
   * Session overrides merged recursively over the defaults and the constructor options, using the
   * OpenAI Realtime `session.update` payload shape.
   */
  params?: Record<string, unknown>
}

/**
 * Options for constructing an {@link OpenAIRealtimeModel}.
 */
export interface OpenAIRealtimeModelOptions extends OpenAIRealtimeModelConfig {
  /** Input transcription model identifier. Pass `null` to disable user transcription. */
  transcriptionModelId: string | null

  /**
   * OpenAI API key. Defaults to `OPENAI_API_KEY` in Node.
   *
   * In browsers, prefer a short-lived client secret minted by your server (`POST /v1/realtime/client_secrets`)
   * so a long-lived key never reaches the page.
   */
  apiKey?: string

  /** OpenAI organization. Defaults to `OPENAI_ORGANIZATION`. */
  organization?: string

  /** OpenAI project. Defaults to `OPENAI_PROJECT`. */
  project?: string

  /**
   * Maximum connection duration in milliseconds. Unless `connection.restartAfterMs` is set, the
   * agent restarts the connection 5 minutes before this limit, so a value of 300,000 or less
   * disables the proactive restart.
   */
  timeoutMs?: number

  /** Output voice identifier. Defaults to `alloy`. */
  voice?: string

  /** WebSocket factory override, primarily for tests. */
  websocket?: OpenAIRealtimeWebSocketFactory
}

/** State preserved across connection restarts. */
interface SessionSnapshot {
  /** Outstanding tool call IDs carried across connection restarts. */
  pendingTools: Set<string>
}

/**
 * Connection-local transcript identities and response creation state.
 *
 * @internal
 */
export class SessionState {
  /** Open transcript IDs mapped to whether they have emitted deltas. */
  startedTranscripts = new Map<string, boolean>()

  /** Assistant content IDs mapped to the item and content index of their last part. */
  assistantParts = new Map<string, string>()

  /** Response IDs mapped to the content ID of their open audio stream. */
  audioContentIds = new Map<string | undefined, string>()

  /** Response IDs currently being generated. */
  activeResponses = new Set<string>()

  /** Outstanding tool call IDs carried across connection restarts. */
  pendingTools = new Set<string>()

  /** IDs of submitted inputs awaiting confirmation that they were added to the conversation. */
  pendingInputIds = new Set<string>()

  /** Whether user speech has started but its audio has not yet been committed. */
  inputAudioPending = false

  /** Whether an input still needs a response. */
  responsePending = false

  /** Whether a response has been requested but not yet created. */
  responseRequested = false

  /** Whether input transcription is configured for the connection. */
  transcriptionEnabled = true

  /** Serializes response creation decisions. */
  lock: Promise<void> = Promise.resolve()

  /**
   * Capture state that survives a connection restart.
   *
   * @returns The preserved state
   */
  takeSnapshot(): SessionSnapshot {
    return { pendingTools: new Set(this.pendingTools) }
  }

  /**
   * Restore state preserved across a connection restart.
   *
   * @param snapshot - State captured before the restart
   */
  loadSnapshot(snapshot: SessionSnapshot): void {
    this.pendingTools = new Set(snapshot.pendingTools)
  }

  /**
   * Open an audio stream before its first chunk.
   *
   * @param responseId - Response the audio belongs to
   * @returns A start event, or nothing when the stream is already open
   */
  startAudio(responseId: string | undefined): BidiOutputEvent[] {
    if (this.audioContentIds.has(responseId)) {
      return []
    }
    const contentId = globalThis.crypto.randomUUID()
    this.audioContentIds.set(responseId, contentId)
    return [new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId })]
  }

  /**
   * Close an open audio stream once.
   *
   * @param responseId - Response the audio belongs to
   * @returns A stop event, or nothing when no stream is open
   */
  stopAudio(responseId: string | undefined): BidiOutputEvent[] {
    const contentId = this.audioContentIds.get(responseId)
    if (contentId === undefined) {
      return []
    }
    this.audioContentIds.delete(responseId)
    return [new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId })]
  }

  /**
   * Open a transcript once, when speech or its first text arrives.
   *
   * @param role - Who is speaking
   * @param contentId - Identifier shared by the transcript's events
   * @returns A start event, or nothing when the transcript is already open
   */
  startTranscript(role: Role, contentId: string): BidiOutputEvent[] {
    if (this.startedTranscripts.has(contentId)) {
      return []
    }
    this.startedTranscripts.set(contentId, false)
    return [new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role, contentId })]
  }

  /**
   * Ensure the transcript starts before emitting its delta.
   *
   * @param event - The transcript delta to emit
   * @returns The delta, preceded by a start event when needed
   */
  transcriptEvents(event: BidiTranscriptDeltaEvent): BidiOutputEvent[] {
    const events = [...this.startTranscript(event.role, event.contentId), event]
    this.startedTranscripts.set(event.contentId, true)
    return events
  }

  /**
   * Close a transcript, emitting final-only text as a delta.
   *
   * @param transcript - The complete transcript text
   * @param role - Who is speaking
   * @param contentId - Identifier shared by the transcript's events
   * @returns The transcript's closing events
   */
  stopTranscript(transcript: string, role: Role, contentId: string): BidiOutputEvent[] {
    const events = this.startTranscript(role, contentId)
    const hasDeltas = this.startedTranscripts.get(contentId)
    this.startedTranscripts.delete(contentId)
    if (transcript && !hasDeltas) {
      events.push(new BidiTranscriptDeltaEvent({ type: 'bidiTranscriptDelta', delta: transcript, role, contentId }))
    }
    events.push(new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role, contentId }))
    return events
  }
}

/**
 * Pull-based reader over an event-based WebSocket.
 *
 * @internal
 */
class WebSocketReader {
  private readonly _messages: string[] = []
  private _closed = false
  private _closeCode: number | undefined
  private _closeReason: string | undefined
  private _error: unknown
  private _notify: (() => void) | undefined

  constructor(socket: OpenAIRealtimeWebSocket) {
    socket.addEventListener('message', (event: { data: unknown }) => {
      this._messages.push(typeof event.data === 'string' ? event.data : String(event.data))
      this._notify?.()
    })
    // Mid-session socket errors have no other observer, so the reader keeps the last one and
    // reports it as the cause of the close that follows.
    socket.addEventListener('error', (event: { message?: string; error?: unknown }) => {
      this._error = event.error ?? event
      this._notify?.()
    })
    socket.addEventListener('close', (event: { code?: number; reason?: string }) => {
      this._closed = true
      this._closeCode = event?.code
      this._closeReason = event?.reason
      this._notify?.()
    })
  }

  /**
   * Wait for the next message.
   *
   * @param timeoutMs - How long to wait before giving up
   * @returns The next message, or undefined when the wait times out
   * @throws {@link ModelError} If the connection closed or errored with no buffered messages
   */
  async recv(timeoutMs: number): Promise<string | undefined> {
    const message = this._messages.shift()
    if (message !== undefined) {
      return message
    }
    if (this._closed || this._error !== undefined) {
      throw this._closedError()
    }

    const received = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this._notify = undefined
        resolve(false)
      }, timeoutMs)
      this._notify = (): void => {
        clearTimeout(timer)
        this._notify = undefined
        resolve(true)
      }
    })
    if (!received) {
      return undefined
    }
    const next = this._messages.shift()
    if (next === undefined && (this._closed || this._error !== undefined)) {
      throw this._closedError()
    }
    return next
  }

  /** Build the close error, carrying the close code/reason and the last socket error as cause. */
  private _closedError(): ModelError {
    const details = `code=<${String(this._closeCode)}>, reason=<${this._closeReason ?? ''}>`
    const message = `${details} | openai realtime connection closed`
    return this._error !== undefined ? new ModelError(message, { cause: this._error }) : new ModelError(message)
  }
}

/** Name an unsupported content value for an error message, standing in for Python's `type(...)`. */
function describeContentType(content: unknown): string {
  if (content === null || typeof content !== 'object') {
    return typeof content
  }
  const type = (content as { type?: unknown }).type
  return typeof type === 'string' ? type : content.constructor.name
}

/** Render keys the way Python's `list(...)` repr does, so error text matches. */
function formatKeyList(keys: string[]): string {
  return `[${keys.map((key) => `'${key}'`).join(', ')}]`
}

/**
 * Open the realtime WebSocket with the runtime's native WebSocket.
 *
 * Node's global WebSocket accepts handshake headers. Browsers cannot set headers on a WebSocket, so
 * there the API key (or an ephemeral client secret) travels as a subprotocol, the same way the
 * official `openai` package authenticates in browsers.
 *
 * @internal
 */
export function defaultWebSocketFactory(url: string, headers: Record<string, string>): OpenAIRealtimeWebSocket {
  if (globalThis?.process?.versions?.node) {
    // The DOM type does not describe the Node-only options form.
    const options = { headers } as unknown as string[]
    return new WebSocket(url, options) as unknown as OpenAIRealtimeWebSocket
  }

  if (headers['OpenAI-Organization'] || headers['OpenAI-Project']) {
    logger.warn('organization and project cannot be sent from a browser websocket | ignoring')
  }
  const apiKey = (headers['Authorization'] ?? '').replace(/^Bearer /, '')
  return new WebSocket(url, ['realtime', `openai-insecure-api-key.${apiKey}`]) as unknown as OpenAIRealtimeWebSocket
}

/**
 * OpenAI Realtime API implementation for bidirectional streaming.
 *
 * Combines model configuration and connection state in a single class. Manages the WebSocket
 * connection to OpenAI's Realtime API with automatic VAD, function calling, and event conversion
 * to Strands format.
 *
 * @example
 * ```typescript
 * const model = new OpenAIRealtimeModel({
 *   modelId: 'gpt-realtime',
 *   transcriptionModelId: 'gpt-4o-transcribe',
 *   apiKey: 'sk-...',
 * })
 * await model.start({ systemPrompt: 'You are a helpful assistant' })
 * ```
 */
export class OpenAIRealtimeModel extends BidiModel<OpenAIRealtimeModelConfig> implements AudioCapable, Restartable {
  /** Resolved OpenAI API key. */
  readonly apiKey: string

  /** Resolved OpenAI organization. */
  readonly organization?: string

  /** Resolved OpenAI project. */
  readonly project?: string

  /** Maximum connection duration in milliseconds. */
  readonly timeoutMs: number

  private readonly _config: OpenAIRealtimeModelConfig
  private readonly _transcriptionModelId: string | null
  private readonly _voice: string
  private readonly _createWebSocket: OpenAIRealtimeWebSocketFactory
  private _audioConfig!: AudioConfig
  private _connectionId: string | undefined
  private _socket?: OpenAIRealtimeWebSocket
  private _reader?: WebSocketReader
  private _startTime = 0
  private _sessionState = new SessionState()

  /**
   * Initialize OpenAI Realtime bidirectional model.
   *
   * @param options - Model configuration and connection options
   * @throws {@link Error} If `modelId` is not a non-empty string, the API key is missing,
   *   `timeoutMs` exceeds the maximum, or the configured audio formats are unsupported
   */
  constructor(options: OpenAIRealtimeModelOptions) {
    super()

    const {
      transcriptionModelId,
      apiKey,
      organization,
      project,
      timeoutMs = OPENAI_MAX_TIMEOUT_MS,
      voice = 'alloy',
      websocket,
      ...modelConfig
    } = options

    if (typeof modelConfig.modelId !== 'string' || !modelConfig.modelId) {
      throw new Error('model_id must be a non-empty string')
    }
    this._config = { ...modelConfig, params: { ...(modelConfig.params ?? {}) } }

    const resolvedApiKey = apiKey ?? globalThis?.process?.env?.OPENAI_API_KEY
    if (!resolvedApiKey) {
      throw new Error('OpenAI API key is required. Provide via api_key or set OPENAI_API_KEY environment variable.')
    }
    this.apiKey = resolvedApiKey

    const resolvedOrganization = organization ?? globalThis?.process?.env?.OPENAI_ORGANIZATION
    if (resolvedOrganization) {
      this.organization = resolvedOrganization
    }
    const resolvedProject = project ?? globalThis?.process?.env?.OPENAI_PROJECT
    if (resolvedProject) {
      this.project = resolvedProject
    }

    this.timeoutMs = timeoutMs
    if (timeoutMs > OPENAI_MAX_TIMEOUT_MS) {
      throw new Error(
        `timeout_ms=<${timeoutMs}>, max_timeout_ms=<${OPENAI_MAX_TIMEOUT_MS}> | timeout exceeds max limit`
      )
    }

    // OpenAI emits no approaching-limit warning, so restart proactively a margin below the
    // reader's reactive timeout: the swap can then align to a turn boundary before the reactive
    // path fires. Deriving from timeoutMs keeps that headroom when a caller lowers it.
    this._config.connection = {
      restartAfterMs: timeoutMs - OPENAI_PROACTIVE_RESTART_MARGIN_MS,
      ...(this._config.connection ?? {}),
    } satisfies ConnectionConfig

    this._transcriptionModelId = transcriptionModelId
    this._voice = voice
    this._createWebSocket = websocket ?? defaultWebSocketFactory
    this._resolveAudioConfig(this._config.params)

    logger.debug(`model=<${this._config.modelId}> | openai realtime model initialized`)
  }

  /**
   * Update the model configuration with the provided arguments.
   *
   * @param modelConfig - Configuration overrides
   * @throws {@link Error} If the resulting `modelId` is not a non-empty string or the configured
   *   audio formats are unsupported
   */
  updateConfig(modelConfig: Partial<OpenAIRealtimeModelConfig>): void {
    const merged = { ...this._config, ...modelConfig }
    if (typeof merged.modelId !== 'string' || !merged.modelId) {
      throw new Error('model_id must be a non-empty string')
    }
    if (modelConfig.params !== undefined) {
      this._resolveAudioConfig(modelConfig.params)
    }
    Object.assign(this._config, modelConfig)
  }

  /**
   * Return the model configuration by reference.
   *
   * @returns The current configuration
   */
  getConfig(): OpenAIRealtimeModelConfig {
    return this._config
  }

  /**
   * Get the resolved audio configuration.
   *
   * @returns Input and output audio formats
   */
  getAudioConfig(): AudioConfig {
    return this._audioConfig
  }

  /**
   * Establish bidirectional connection to OpenAI Realtime API.
   *
   * @param options - System prompt, tools, and conversation history for the connection
   * @throws {@link Error} If the model has already been started, or turn detection, automatic
   *   responses, or interruption are disabled
   */
  async start(options: BidiModelStartOptions = {}): Promise<void> {
    if (this._connectionId) {
      throw new Error('model already started | call stop before starting again')
    }

    const { systemPrompt, tools, messages } = options
    const sessionConfig = this._buildSessionConfig(systemPrompt, tools)
    logger.debug('openai realtime connection starting')

    this._connectionId = globalThis.crypto.randomUUID()
    this._startTime = Date.now()

    this._sessionState = new SessionState()

    const url = `${OPENAI_REALTIME_URL}?model=${this._config.modelId}`

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` }
    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization
    }
    if (this.project) {
      headers['OpenAI-Project'] = this.project
    }

    this._socket = await this._connect(url, headers)
    this._reader = new WebSocketReader(this._socket)
    logger.debug(`connection_id=<${this._connectionId}> | websocket connected successfully`)

    const audio = sessionConfig['audio'] as { input: Record<string, unknown> }
    this._sessionState.transcriptionEnabled = audio.input['transcription'] != null
    await this._sendEvent({ type: 'session.update', session: sessionConfig })

    if (messages) {
      await this._addConversationHistory(messages)
    }
  }

  /**
   * Receive OpenAI events and convert to Strands event format.
   *
   * @returns Async iterable of standardized bidirectional output events
   * @throws {@link Error} If the model was not started
   * @throws {@link ConnectionTimeoutError} If the connection exceeded `timeoutMs`
   */
  async *receive(): AsyncGenerator<BidiOutputEvent> {
    if (!this._connectionId) {
      throw new Error('model not started | call start before receiving')
    }

    yield new BidiConnectionStartEvent({
      type: 'bidiConnectionStart',
      connectionId: this._connectionId,
      model: this._config.modelId as string,
    })

    // Bind this reader to the connection it started on. After a restart swaps the socket, a
    // still-draining superseded reader keeps reading its own (now-closed) socket rather than
    // stealing messages from the connection that replaced it.
    const reader = this._reader
    const startTime = this._startTime
    const state = this._sessionState

    for (;;) {
      const duration = Date.now() - startTime
      if (duration >= this.timeoutMs) {
        throw new ConnectionTimeoutError(`timeout_ms=<${this.timeoutMs}>`)
      }

      const message = await reader?.recv(RECV_POLL_TIMEOUT_MS)
      if (message === undefined) {
        continue
      }

      const openaiEvent = JSON.parse(message) as RealtimeEvent
      const eventType = openaiEvent['type'] as string | undefined
      if (eventType === 'input_audio_buffer.speech_started') {
        state.inputAudioPending = true
      } else if (eventType === 'input_audio_buffer.committed') {
        state.inputAudioPending = false
        // Let VAD create the response containing the committed utterance.
        state.responseRequested = true
      } else if (eventType === 'conversation.item.added') {
        state.pendingInputIds.delete(openaiEvent['item']['id'])
      } else if (eventType === 'response.created') {
        const responseId = openaiEvent['response']['id'] as string
        if (state.activeResponses.has(responseId)) {
          continue
        }
        state.activeResponses.add(responseId)
        state.responseRequested = false
        // A response includes acknowledged inputs; later inputs still need a continuation.
        state.responsePending = state.pendingInputIds.size > 0
      } else if (eventType === 'response.done') {
        const responseId = openaiEvent['response']['id'] as string
        if (!state.activeResponses.has(responseId)) {
          continue
        }
        state.activeResponses.delete(responseId)
      }

      if (eventType === 'error' && openaiEvent['error']?.['code'] === 'conversation_already_has_active_response') {
        state.responseRequested = false
        state.responsePending = true
        continue
      }

      for (const event of this._convertOpenAIEvent(openaiEvent, state) ?? []) {
        if (event instanceof BidiToolUseBlocksEvent) {
          for (const call of event.toolUses) {
            state.pendingTools.add(call.toolUseId)
          }
        }
        yield event
      }
      if (state === this._sessionState && eventType === 'response.done') {
        await this._flushResponseRequest(state)
      }
    }
  }

  /**
   * Send the given content to OpenAI, dispatching on the content type.
   *
   * @param content - A complete message or an individual audio delta
   * @throws {@link Error} If the model was not started or the content type is unsupported
   */
  async send(content: BidiMessage | BidiContentDelta): Promise<void> {
    if (!this._connectionId) {
      throw new Error('model not started | call start before sending')
    }

    if (content instanceof AudioDelta) {
      await this._sendAudioContent(content)
    } else if (typeof content === 'object' && content !== null && Array.isArray(content.content)) {
      await this._sendMessage(content)
    } else {
      throw new Error(`content_type=${describeContentType(content)} | content not supported`)
    }
  }

  /**
   * Close the session and clean up resources.
   *
   * @throws {@link Error} If closing the connection failed
   */
  async stop(): Promise<void> {
    logger.debug('openai realtime connection cleanup starting')

    const stopWebsocket = async (): Promise<void> => {
      this._socket?.close()
    }

    const stopConnection = async (): Promise<void> => {
      this._connectionId = undefined
    }

    await stopAll(stopWebsocket, stopConnection)

    logger.debug('openai realtime connection closed')
  }

  /**
   * Restart by closing the connection and starting a new one, replaying history.
   *
   * OpenAI's Realtime API exposes no server-side resume handle, so a restart re-establishes the
   * session and replays the accumulated conversation history to preserve context across the swap.
   *
   * @param options - System prompt, tools, and conversation history for the new connection
   */
  async restart(options: BidiModelStartOptions = {}): Promise<void> {
    logger.debug('openai realtime restart starting')
    const snapshot = this._sessionState.takeSnapshot()
    await this.stop()
    await this.start(options)
    this._sessionState.loadSnapshot(snapshot)
    // Re-anchor the fresh session so it continues the conversation rather than drifting. This is a
    // best-effort nudge: if the send fails, the connection is still healthy, so log and move on
    // rather than let a failed nudge tear down the session.
    try {
      await this._sendEvent({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: RESTART_INSTRUCTION }],
        },
      })
    } catch (error) {
      logger.warn(`error=<${String(error)}> | failed to send restart re-anchor message | continuing`)
    }
    logger.debug(`connection_id=<${this._connectionId}> | openai realtime restart complete`)
  }

  private async _connect(url: string, headers: Record<string, string>): Promise<OpenAIRealtimeWebSocket> {
    const socket = this._createWebSocket(url, headers)
    if (socket.readyState === 1) {
      return socket
    }

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup()
        resolve()
      }
      const onError = (event: { message?: string; error?: unknown }): void => {
        cleanup()
        const message = event.message ?? String(event.error ?? event)
        reject(
          /429|rate limit/i.test(message)
            ? new ModelThrottledError(`error=<${message}> | openai realtime connection throttled`, {
                cause: event.error ?? event,
              })
            : new ModelError(`error=<${message}> | openai realtime connection failed`, {
                cause: event.error ?? event,
              })
        )
      }
      // Drop the handshake listeners once settled so mid-session errors reach the reader instead
      // of rejecting an already-settled promise.
      const cleanup = (): void => {
        socket.removeEventListener?.('open', onOpen)
        socket.removeEventListener?.('error', onError)
      }

      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
    return socket
  }

  private _resolveAudioConfig(params: Record<string, unknown> | undefined): void {
    const audio = ((params ?? {})['audio'] ?? {}) as Record<string, Record<string, any>> // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const direction of ['input', 'output'] as const) {
      const stream = audio[direction] ?? {}
      const audioFormat = (stream['format'] ?? {}) as Record<string, unknown>

      const formatType = audioFormat['type'] ?? 'audio/pcm'
      if (formatType !== 'audio/pcm') {
        throw new Error(`Unsupported audio format: ${String(formatType)}. Expected audio/pcm.`)
      }

      const sampleRate = audioFormat['rate'] ?? DEFAULT_SAMPLE_RATE
      if (sampleRate !== DEFAULT_SAMPLE_RATE) {
        throw new Error(`Unsupported sample rate: ${String(sampleRate)}. Expected ${DEFAULT_SAMPLE_RATE}.`)
      }
    }

    this._audioConfig = {
      input: { sampleRate: DEFAULT_SAMPLE_RATE, channels: 1, format: 'pcm' },
      output: { sampleRate: DEFAULT_SAMPLE_RATE, channels: 1, format: 'pcm' },
    }
  }

  /**
   * Build session configuration for OpenAI Realtime API.
   *
   * Model params recursively override defaults and directly supplied options.
   */
  private _buildSessionConfig(
    systemPrompt: string | undefined,
    tools: ToolSpec[] | undefined
  ): Record<string, unknown> {
    let config = globalThis.structuredClone(DEFAULT_SESSION_CONFIG)

    if (systemPrompt) {
      config['instructions'] = systemPrompt
    }

    if (tools && tools.length > 0) {
      config['tools'] = this._convertToolsToOpenAIFormat(tools)
    }

    const audio = config['audio'] as { input: Record<string, unknown>; output: Record<string, unknown> }
    audio.input['transcription'] = this._transcriptionModelId !== null ? { model: this._transcriptionModelId } : null
    audio.output['voice'] = this._voice

    config = mergeConfig(config, this._config.params ?? {})
    const mergedAudio = config['audio'] as { input: Record<string, unknown> }
    const turnDetection = mergedAudio.input['turn_detection'] as Record<string, unknown> | null | undefined
    if (
      turnDetection == null ||
      turnDetection['create_response'] === false ||
      turnDetection['interrupt_response'] === false
    ) {
      throw new Error(
        'OpenAIRealtimeModel requires turn detection with create_response=True and interrupt_response=True.'
      )
    }
    return config
  }

  private _convertToolsToOpenAIFormat(tools: ToolSpec[]): Record<string, unknown>[] {
    return tools.map((tool) => {
      const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>
      const schema =
        'json' in inputSchema
          ? typeof inputSchema['json'] === 'string'
            ? JSON.parse(inputSchema['json'])
            : inputSchema['json']
          : inputSchema

      // OpenAI Realtime API expects flat structure, not nested under "function"
      return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: schema,
      }
    })
  }

  /**
   * Add conversation history to the session.
   *
   * OpenAI Realtime API has a 32-character limit on call_id, so UUIDs are truncated consistently
   * to ensure tool calls and their results match.
   */
  private async _addConversationHistory(messages: Message[]): Promise<void> {
    // Track tool call IDs to ensure consistency between calls and results
    const callIdMap = new Map<string, string>()

    // First pass: collect all tool call IDs
    for (const message of messages) {
      for (const block of message.content) {
        if (block instanceof ToolUseBlock) {
          callIdMap.set(block.toolUseId, block.toolUseId.slice(0, 32))
        }
      }
    }

    // Second pass: send messages
    for (const message of messages) {
      const role = message.role
      const openaiContent: Record<string, unknown>[] = []

      for (const block of message.content) {
        if (block instanceof TextBlock) {
          // User messages use "input_text", assistant messages use "output_text"
          openaiContent.push({ type: role === 'user' ? 'input_text' : 'output_text', text: block.text })
        } else if (block instanceof ToolUseBlock) {
          await this._sendEvent({
            type: 'conversation.item.create',
            item: {
              type: 'function_call',
              call_id: callIdMap.get(block.toolUseId),
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })
        } else if (block instanceof ToolResultBlock) {
          this._validateToolResultContent(block)
          const resultOutput = JSON.stringify(block.content)

          // Use mapped call_id if available, otherwise skip orphaned result
          const callId = callIdMap.get(block.toolUseId)
          if (callId === undefined) {
            continue
          }

          await this._sendEvent({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: callId, output: resultOutput },
          })
        }
      }

      // Only create message item if there's text content
      if (openaiContent.length > 0) {
        await this._sendEvent({
          type: 'conversation.item.create',
          item: { type: 'message', role, content: openaiContent },
        })
      }
    }

    logger.debug(`message_count=<${messages.length}> | conversation history added to openai session`)
  }

  private _convertOpenAIEvent(openaiEvent: RealtimeEvent, state: SessionState): BidiOutputEvent[] | undefined {
    const eventType = openaiEvent['type'] as string | undefined

    if (eventType === 'input_audio_buffer.speech_started') {
      const events: BidiOutputEvent[] = []
      if (state.transcriptionEnabled) {
        events.push(...state.startTranscript('user', openaiEvent['item_id']))
      }
      return events
    }

    let inputId: string | undefined
    if (eventType === 'input_audio_buffer.committed' && state.transcriptionEnabled) {
      inputId = openaiEvent['item_id']
    } else if (eventType === 'conversation.item.added' && openaiEvent['item']?.['role'] === 'user') {
      const item = openaiEvent['item']
      const isAudio = ((item['content'] ?? []) as Record<string, unknown>[]).some(
        (content) => content['type'] === 'input_audio'
      )
      if (state.transcriptionEnabled && isAudio) {
        inputId = item['id']
      }
    }
    if (inputId !== undefined) {
      const events = state.startTranscript('user', inputId)
      return events.length > 0 ? events : undefined
    }

    if (eventType === 'response.created') {
      const response = (openaiEvent['response'] ?? {}) as Record<string, unknown>
      const responseId = (response['id'] as string | undefined) ?? globalThis.crypto.randomUUID()
      return [new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId })]
    }

    if (eventType === 'response.content_part.added' && openaiEvent['part']?.['type'] === 'audio') {
      const events = state.startAudio(openaiEvent['response_id'])
      return events.length > 0 ? events : undefined
    }

    if (eventType === 'response.output_audio.delta') {
      const responseId = openaiEvent['response_id'] as string | undefined
      return [
        ...state.startAudio(responseId),
        new BidiAudioDeltaEvent({
          type: 'bidiAudioDelta',
          audio: decodeBase64(openaiEvent['delta']),
          contentId: this._sessionAudioContentId(state, responseId),
          ...this._audioConfig.output,
        }),
      ]
    }

    if (eventType === 'response.output_audio.done') {
      const events = state.stopAudio(openaiEvent['response_id'])
      return events.length > 0 ? events : undefined
    }

    if (eventType === 'response.output_text.delta' || eventType === 'response.output_audio_transcript.delta') {
      let text = (openaiEvent['delta'] ?? '') as string
      if (!text) {
        return undefined
      }
      const responseId = openaiEvent['response_id'] as string
      const isText = eventType === 'response.output_text.delta'
      const contentId = isText ? `${responseId}:text` : responseId
      const partId = `${openaiEvent['item_id']}:${openaiEvent['content_index']}`
      const previousPart = state.assistantParts.get(contentId)
      if (previousPart !== undefined && previousPart !== partId) {
        text = `\n\n${text}`
      }
      state.assistantParts.set(contentId, partId)
      if (isText) {
        const events: BidiOutputEvent[] = []
        if (previousPart === undefined) {
          events.push(new BidiTextStartEvent({ type: 'bidiTextStart', contentId }))
        }
        events.push(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: text, contentId }))
        return events
      }
      return state.transcriptEvents(
        new BidiTranscriptDeltaEvent({ type: 'bidiTranscriptDelta', delta: text, role: 'assistant', contentId })
      )
    }

    if (eventType === 'response.output_text.done' || eventType === 'response.output_audio_transcript.done') {
      // Response completion closes the assistant's text and transcript streams.
      return undefined
    }

    if (
      eventType === 'conversation.item.input_audio_transcription.delta' ||
      eventType === 'conversation.item.input_audio_transcription.segment'
    ) {
      let text: string
      let role: Role
      if (eventType === 'conversation.item.input_audio_transcription.segment') {
        const segment = (openaiEvent['segment'] ?? {}) as Record<string, unknown>
        text = (segment['text'] ?? '') as string
        role = (segment['role'] ?? 'user') as Role
      } else {
        text = (openaiEvent['delta'] ?? '') as string
        role = 'user'
      }
      if (!text) {
        return undefined
      }
      return state.transcriptEvents(
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: text,
          role,
          contentId: openaiEvent['item_id'],
        })
      )
    }

    if (eventType === 'conversation.item.input_audio_transcription.completed') {
      return state.stopTranscript(openaiEvent['transcript'], 'user', openaiEvent['item_id'])
    }

    if (eventType === 'conversation.item.input_audio_transcription.failed') {
      const errorInfo = (openaiEvent['error'] ?? {}) as Record<string, unknown>
      throw new ModelError((errorInfo['message'] as string | undefined) ?? 'Transcription failed.')
    }

    if (eventType === 'response.output_item.done') {
      const item = openaiEvent['item']
      if (item['type'] === 'function_call' && item['status'] === 'completed') {
        const toolUse = new ToolUseBlock({
          toolUseId: item['call_id'],
          name: item['name'],
          input: JSON.parse(item['arguments']) as JSONValue,
        })
        return [new BidiToolUseBlocksEvent({ type: 'bidiToolUseBlocks', toolUses: [toolUse] })]
      }
      return undefined
    }

    if (eventType === 'response.done') {
      return this._completeResponse(openaiEvent['response'], state)
    }

    if (eventType === 'conversation.item.retrieve' || eventType === 'conversation.item.added') {
      const item = (openaiEvent['item'] ?? {}) as Record<string, unknown>
      const action = eventType.includes('retrieve') ? 'retrieved' : 'added'
      logger.debug(`action=<${action}>, item_id=<${String(item['id'])}> | openai conversation item event`)
      return undefined
    }

    if (eventType === 'conversation.item.done') {
      logger.debug(`item_id=<${String((openaiEvent['item'] ?? {})['id'])}> | openai conversation item done`)
      return undefined
    }

    if (
      eventType === 'response.output_item.added' ||
      eventType === 'response.content_part.added' ||
      eventType === 'response.content_part.done'
    ) {
      const itemData = (openaiEvent['item'] ?? openaiEvent['part']) as Record<string, unknown> | undefined
      logger.debug(
        `event_type=<${eventType}>, item_id=<${itemData ? String(itemData['id']) : 'unknown'}> | openai output event`
      )

      return undefined
    }

    if (
      eventType === 'input_audio_buffer.committed' ||
      eventType === 'input_audio_buffer.cleared' ||
      eventType === 'session.created' ||
      eventType === 'session.updated' ||
      eventType === 'response.function_call_arguments.delta' ||
      eventType === 'response.function_call_arguments.done'
    ) {
      logger.debug(`event_type=<${eventType}> | openai event received`)
      return undefined
    }

    if (eventType === 'error') {
      const errorData = (openaiEvent['error'] ?? {}) as Record<string, unknown>
      const errorCode = errorData['code'] ?? ''

      // Suppress expected errors that don't affect session state: cancelling a response that is
      // not active leaves the session functional.
      if (errorCode === 'response_cancel_not_active') {
        logger.debug('openai response cancel attempted when no response active')
        return undefined
      }

      logger.error(`error=<${JSON.stringify(errorData)}> | openai realtime error`)
      return undefined
    }

    logger.debug(`event_type=<${String(eventType)}> | unhandled openai event type`)
    return undefined
  }

  private _sessionAudioContentId(state: SessionState, responseId: string | undefined): string {
    const contentId = state.audioContentIds.get(responseId)
    if (contentId === undefined) {
      throw new ModelError(`response_id=<${String(responseId)}> | no audio stream open for response`)
    }
    return contentId
  }

  /** Close audio, text, and transcripts before stopping the response. */
  private _completeResponse(response: RealtimeEvent, state: SessionState): BidiOutputEvent[] {
    const responseId = (response['id'] as string | undefined) ?? 'unknown'
    const output = (response['output'] ?? []) as Record<string, any>[] // eslint-disable-line @typescript-eslint/no-explicit-any
    const events: BidiOutputEvent[] = []
    if (response['status'] === 'cancelled' && (response['status_details'] ?? {})['reason'] === 'turn_detected') {
      events.push(new BidiBargeInEvent())
    }
    events.push(...state.stopAudio(response['id']))

    const assistantParts = (partType: string): Record<string, unknown>[] =>
      output
        .filter((item) => item['type'] === 'message' && item['role'] === 'assistant')
        .flatMap((item) => (item['content'] ?? []) as Record<string, unknown>[])
        .filter((part) => part['type'] === partType)

    const transcriptParts = assistantParts('output_audio').map((part) => (part['transcript'] ?? '') as string)
    if (transcriptParts.length > 0 || state.assistantParts.has(responseId)) {
      events.push(...state.stopTranscript(transcriptParts.join('\n\n'), 'assistant', responseId))
    }
    state.assistantParts.delete(responseId)

    const textParts = assistantParts('output_text').map((part) => (part['text'] ?? '') as string)
    const contentId = `${responseId}:text`
    if (textParts.length > 0 || state.assistantParts.has(contentId)) {
      if (!state.assistantParts.has(contentId)) {
        events.push(new BidiTextStartEvent({ type: 'bidiTextStart', contentId }))
        events.push(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: textParts.join('\n\n'), contentId }))
      }
      events.push(new BidiTextStopEvent({ type: 'bidiTextStop', contentId }))
    }
    state.assistantParts.delete(contentId)

    const usage = response['usage'] as Record<string, unknown> | undefined
    if (usage) {
      events.push(this._convertUsageMetadata(usage))
    }
    events.push(new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId }))
    return events
  }

  /** Convert response token counts and their input and output breakdowns. */
  private _convertUsageMetadata(usage: Record<string, unknown>): BidiUsageEvent {
    const inputDetails = convertTokenDetails((usage['input_token_details'] ?? {}) as Record<string, unknown>)
    const outputDetails = convertTokenDetails((usage['output_token_details'] ?? {}) as Record<string, unknown>)
    return new BidiUsageEvent({
      type: 'bidiUsage',
      inputTokens: (usage['input_tokens'] as number | undefined) ?? 0,
      outputTokens: (usage['output_tokens'] as number | undefined) ?? 0,
      totalTokens: (usage['total_tokens'] as number | undefined) ?? 0,
      ...(Object.keys(inputDetails).length > 0 ? { inputTokenDetails: inputDetails } : {}),
      ...(Object.keys(outputDetails).length > 0 ? { outputTokenDetails: outputDetails } : {}),
    })
  }

  /** Send one user message or tool results. */
  private async _sendMessage(message: BidiMessage): Promise<void> {
    const content: Record<string, unknown>[] = []
    for (const block of message.content) {
      if (block instanceof TextBlock) {
        content.push({ type: 'input_text', text: block.text })
      } else if (block instanceof ImageBlock) {
        const imageBytes = 'bytes' in block.source ? block.source.bytes : undefined
        if (imageBytes === undefined) {
          throw new Error('image source must contain bytes for OpenAI Realtime')
        }
        const image = encodeBase64(imageBytes)
        content.push({ type: 'input_image', image_url: `data:image/${block.format};base64,${image}` })
      } else if (block instanceof ToolResultBlock) {
        await this._sendToolResult(block)
      } else {
        throw new Error(`content_type=${describeContentType(block)} | content not supported by OpenAI Realtime`)
      }
    }

    if (content.length > 0) {
      await this._sendInputItem({ type: 'message', role: 'user', content })
    }
  }

  private async _sendAudioContent(audioInput: AudioDelta): Promise<void> {
    const audioBytes = 'bytes' in audioInput.source ? audioInput.source.bytes : undefined
    if (audioBytes === undefined) {
      throw new Error('audio source must contain bytes for OpenAI Realtime')
    }
    const audio = encodeBase64(audioBytes)
    await this._sendEvent({ type: 'input_audio_buffer.append', audio })
  }

  private async _sendToolResult(toolResult: ToolResultBlock): Promise<void> {
    const toolUseId = toolResult.toolUseId

    logger.debug(`tool_use_id=<${toolUseId}> | sending openai tool result`)

    this._validateToolResultContent(toolResult)

    // Preserve structure by JSON-dumping the entire content array
    const resultOutput = JSON.stringify(toolResult.content)

    await this._sendInputItem({ type: 'function_call_output', call_id: toolUseId, output: resultOutput })
  }

  private _validateToolResultContent(toolResult: ToolResultBlock): void {
    for (const block of toolResult.content) {
      if (!(block instanceof TextBlock) && !(block instanceof JsonBlock)) {
        const contentTypes = Object.keys(block.toJSON() as Record<string, unknown>)
        throw new Error(
          `tool_use_id=<${toolResult.toolUseId}>, content_types=<${formatKeyList(contentTypes)}> | ` +
            `Content type not supported by OpenAI Realtime API`
        )
      }
    }
  }

  /** Send an input and track whether the next response includes it. */
  private async _sendInputItem(item: Record<string, unknown>): Promise<void> {
    const state = this._sessionState
    const withId: Record<string, unknown> = { id: globalThis.crypto.randomUUID().replace(/-/g, ''), ...item }
    state.pendingInputIds.add(withId['id'] as string)
    state.responsePending = true
    await this._sendEvent({ type: 'conversation.item.create', item: withId })
    if (withId['type'] === 'function_call_output') {
      state.pendingTools.delete(withId['call_id'] as string)
    }
    await this._flushResponseRequest(state)
  }

  /**
   * Create a response if needed, deferring while audio, another response, or tool calls are
   * pending.
   */
  private async _flushResponseRequest(state: SessionState): Promise<void> {
    const previous = state.lock
    let release!: () => void
    state.lock = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      if (state.inputAudioPending) {
        return
      }
      if (
        !state.responsePending ||
        state.responseRequested ||
        state.activeResponses.size > 0 ||
        state.pendingTools.size > 0
      ) {
        return
      }
      state.responsePending = false
      state.responseRequested = true
      // WebSocket ordering includes all preceding inputs in this explicit request.
      state.pendingInputIds.clear()
      try {
        await this._sendEvent({ type: 'response.create' })
      } catch (error) {
        state.responseRequested = false
        state.responsePending = true
        throw error
      }
    } finally {
      release()
    }
  }

  private async _sendEvent(event: Record<string, unknown>): Promise<void> {
    const socket = this._socket
    if (!socket) {
      throw new ModelError('model not started | no websocket')
    }
    const message = JSON.stringify(event)
    socket.send(message)
    await this._drain(socket)
    logger.debug(`event_type=<${String(event['type'])}> | openai event sent`)
  }

  /**
   * Yield until the socket's write buffer drains below the threshold.
   *
   * Python's `await websocket.send(...)` yields to the websockets write-buffer drain, which paces
   * the `input_audio_buffer.append` hot path. The DOM-style `send` is fire-and-forget, so poll
   * `bufferedAmount` when the socket reports it; sockets that don't are sent without pacing.
   */
  private async _drain(socket: OpenAIRealtimeWebSocket): Promise<void> {
    if (socket.bufferedAmount === undefined) {
      return
    }
    while (socket.bufferedAmount > SEND_BUFFER_HIGH_WATER_BYTES && socket.readyState === 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, SEND_DRAIN_POLL_MS))
    }
  }
}

function convertTokenDetails(details: Record<string, unknown>): TokenDetails {
  const names: [string, keyof TokenDetails][] = [
    ['text_tokens', 'text'],
    ['audio_tokens', 'audio'],
    ['image_tokens', 'image'],
    ['video_tokens', 'video'],
    ['cached_tokens', 'cacheRead'],
    ['reasoning_tokens', 'reasoning'],
  ]
  const converted: TokenDetails = {}
  for (const [key, name] of names) {
    const value = details[key]
    if (value != null) {
      converted[name] = value as number
    }
  }
  return converted
}
