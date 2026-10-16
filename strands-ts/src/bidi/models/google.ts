/**
 * Google Gemini Live model provider using the Gemini Live API and official Google GenAI SDK.
 *
 * Implements the BidiModel interface for Google's Gemini Live API using the official Google GenAI
 * SDK for simplified and robust WebSocket communication.
 */

import { GoogleGenAI } from '@google/genai'

import { ModelError, ModelThrottledError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { decodeBase64, encodeBase64 } from '../../types/media.js'
import { stopAll } from '../async/stop-all.js'
import {
  BidiAudioDeltaEvent,
  BidiAudioStartEvent,
  BidiAudioStopEvent,
  BidiBargeInEvent,
  BidiConnectionStartEvent,
  BidiReasoningDeltaEvent,
  BidiReasoningStartEvent,
  BidiReasoningStopEvent,
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

import type {
  Content,
  FunctionResponse,
  GoogleGenAIOptions,
  LiveConnectConfig,
  LiveServerContent,
  LiveServerMessage,
  ModalityTokenCount,
  Part,
  Session,
  UsageMetadata,
} from '@google/genai'
import type { ToolSpec } from '../../tools/types.js'
import type { JSONValue } from '../../types/json.js'
import type { Message } from '../../types/messages.js'
import type { ToolUseBlock } from '../../types/messages.js'
import type { BidiContentDelta, BidiMessage } from '../types/content.js'
import type { BidiOutputEvent, TokenDetails } from '../types/events.js'
import type { AudioConfig, BidiModelConfig, GoogleGeminiLiveAudioConfig } from './configs.js'
import type { AudioCapable, BidiModelStartOptions, Restartable } from './model.js'

/** Gemini caps a single connection at ~10 min; restart before that and resume the same session. */
const DEFAULT_RESTART_AFTER_MS = 540_000

/** Output audio sample rate fixed by the Gemini Live API. */
const OUTPUT_SAMPLE_RATE = 24000

/** Upper bound on waiting for the websocket close callback during `stop()`. */
const CLOSE_TIMEOUT_MS = 1000

/**
 * Configuration for the Google Gemini Live model.
 */
export interface GoogleGeminiLiveModelConfig extends BidiModelConfig {
  /** Gemini Live model identifier. */
  modelId: string
}

/**
 * Options for constructing a {@link GoogleGeminiLiveModel}.
 */
export interface GoogleGeminiLiveModelOptions extends GoogleGeminiLiveModelConfig {
  /** Gemini API key (falls back to the `GEMINI_API_KEY` environment variable). */
  apiKey?: string

  /** Pre-configured Google GenAI client instance, used instead of creating a new one. */
  client?: GoogleGenAI

  /** Additional Google GenAI client configuration. Only used if `client` is not provided. */
  clientConfig?: Omit<GoogleGenAIOptions, 'apiKey'>

  /** Audio configuration. */
  audio?: GoogleGeminiLiveAudioConfig

  /** Prebuilt output voice name. Omit to use the provider's default. */
  voice?: string
}

/**
 * Provider options accepted by {@link GoogleGeminiLiveModel.start} and `restart`.
 */
export interface GoogleGeminiLiveStartOptions extends BidiModelStartOptions {
  /** Resumption handle of a prior Gemini session to resume instead of starting fresh. */
  liveSessionHandle?: string
}

/** State preserved across connection restarts. */
interface TurnSnapshot {
  toolNames: Map<string, string>
}

/**
 * Track turns and outstanding tools for one connection.
 *
 * Each reader binds to its connection's state so it cannot alter a replacement connection.
 */
class TurnState {
  responseId?: string | undefined
  outputTranscriptId?: string | undefined
  outputTextStop?: BidiTextStopEvent | BidiReasoningStopEvent | undefined
  audioContentId?: string | undefined
  interrupted = false
  inputId?: string | undefined
  inputIds = new Set<string>()
  responseInputIds: string[] = []
  lastActivityInputId?: string | undefined
  toolNames = new Map<string, string>()

  /** Capture state that survives a connection restart. */
  takeSnapshot(): TurnSnapshot {
    return { toolNames: new Map(this.toolNames) }
  }

  /** Restore state preserved across a connection restart. */
  loadSnapshot(snapshot: TurnSnapshot): void {
    this.toolNames = new Map(snapshot.toolNames)
  }

  /** Close the current text or reasoning block. */
  stopText(): BidiOutputEvent[] {
    if (this.outputTextStop === undefined) {
      return []
    }
    const event = this.outputTextStop
    this.outputTextStop = undefined
    return [event]
  }

  /** Open a user transcript when speech or its first text arrives. */
  startInputTranscript(): BidiTranscriptStartEvent {
    this.inputId = globalThis.crypto.randomUUID()
    this.inputIds.add(this.inputId)
    return new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: this.inputId })
  }

  /** Close one user transcript without disturbing a newer utterance. */
  stopInputTranscript(inputId: string): BidiTranscriptStopEvent {
    this.inputIds.delete(inputId)
    if (this.inputId === inputId) {
      this.inputId = undefined
    }
    return new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: inputId })
  }
}

/**
 * Buffers server messages delivered by the SDK's `onmessage` callback for a single connection.
 *
 * The TypeScript Gemini SDK is callback-based where Python exposes an async iterator, so the
 * reader consumes messages through this queue instead of iterating the session.
 */
class MessageQueue {
  private _messages: LiveServerMessage[] = []
  private _error?: unknown
  private _closed = false
  private _aborted = false
  private _notify?: (() => void) | undefined
  private _resolveClosed: () => void = () => {}

  /** Resolves once the connection has closed or failed. */
  readonly closed: Promise<void> = new Promise<void>((resolve) => {
    this._resolveClosed = resolve
  })

  /** Buffer one server message and wake a waiting reader. */
  push(message: LiveServerMessage): void {
    this._messages.push(message)
    this._wake()
  }

  /** Fail the stream with a transport error after buffered messages drain. */
  fail(error: unknown): void {
    this._error = error
    this._closed = true
    this._resolveClosed()
    this._wake()
  }

  /** End the stream after buffered messages drain. */
  close(): void {
    this._closed = true
    this._resolveClosed()
    this._wake()
  }

  /** Abandon the stream immediately, settling a reader parked on an empty queue. */
  abort(): void {
    this._aborted = true
    this._wake()
  }

  /** Yield buffered messages until the connection closes, errors, or the reader abandons it. */
  async *drain(): AsyncGenerator<LiveServerMessage> {
    try {
      for (;;) {
        while (this._messages.length > 0) {
          yield this._messages.shift() as LiveServerMessage
        }
        if (this._error !== undefined) {
          throw this._error
        }
        if (this._closed || this._aborted) {
          return
        }
        await new Promise<void>((resolve) => {
          this._notify = resolve
        })
      }
    } finally {
      this._notify = undefined
    }
  }

  private _wake(): void {
    const notify = this._notify
    this._notify = undefined
    notify?.()
  }
}

/**
 * Google Gemini Live implementation using the official Google GenAI SDK.
 *
 * Combines model configuration and connection state in a single class. Provides a clean interface
 * to the Gemini Live API using the official SDK, eliminating custom WebSocket handling and
 * providing robust error handling.
 *
 * Exported from `@strands-agents/sdk/bidi/models/google`, not the `@strands-agents/sdk/bidi`
 * barrel, because it requires the optional `@google/genai` peer dependency.
 *
 * @example
 * ```typescript
 * import { GoogleGeminiLiveModel } from '@strands-agents/sdk/bidi/models/google'
 *
 * const model = new GoogleGeminiLiveModel({ modelId: 'gemini-live-2.5-flash-preview' })
 *
 * await model.start({ systemPrompt: 'You are a helpful assistant.' })
 * for await (const event of model.receive()) {
 *   console.log(event.type)
 * }
 * ```
 */
export class GoogleGeminiLiveModel extends BidiModel<GoogleGeminiLiveModelConfig> implements Restartable, AudioCapable {
  private _config: GoogleGeminiLiveModelConfig
  private _client: GoogleGenAI
  private _audioConfig: AudioConfig
  private _voice?: string | undefined
  private _liveSession?: Session | undefined
  private _liveSessionHandle?: string | undefined
  private _connectionId?: string | undefined
  private _messages?: MessageQueue | undefined
  private _turnState = new TurnState()

  /**
   * Creates a new Google Gemini Live model.
   *
   * @param options - Model configuration, audio settings, and client options
   * @throws {@link Error} If `modelId` is not a non-empty string, the input sample rate is not
   *   positive, or no API key is available
   */
  constructor(options: GoogleGeminiLiveModelOptions) {
    super()
    const { apiKey, client, clientConfig, audio, voice, ...modelConfig } = options

    GoogleGeminiLiveModel._validateModelConfig(modelConfig)
    this._config = {
      ...modelConfig,
      params: { ...(modelConfig.params ?? {}) },
      // Gemini caps a single connection at ~10 min; restart before that, resuming the same
      // session via its handle. The GoAway message remains the reactive backstop.
      connection: { restartAfterMs: DEFAULT_RESTART_AFTER_MS, ...(modelConfig.connection ?? {}) },
    }
    this._audioConfig = GoogleGeminiLiveModel._resolveAudioConfig(audio)
    if (voice !== undefined) {
      this._voice = voice
    }

    if (client) {
      this._client = client
    } else {
      const resolvedApiKey = apiKey || globalThis?.process?.env?.GEMINI_API_KEY

      if (!resolvedApiKey) {
        throw new Error(
          "Gemini API key is required. Provide it via the 'apiKey' option or set the GEMINI_API_KEY environment variable."
        )
      }

      this._client = new GoogleGenAI({ apiKey: resolvedApiKey, ...clientConfig })
    }
  }

  /**
   * Update the model configuration with the provided arguments.
   *
   * @param modelConfig - Configuration overrides
   * @throws {@link Error} If the resulting `modelId` is not a non-empty string
   */
  override updateConfig(modelConfig: Partial<GoogleGeminiLiveModelConfig>): void {
    const merged = { ...this._config, ...modelConfig }
    GoogleGeminiLiveModel._validateModelConfig(merged)
    this._config = merged
  }

  /**
   * Return the model configuration by reference.
   *
   * @returns The model configuration
   */
  override getConfig(): GoogleGeminiLiveModelConfig {
    return this._config
  }

  /**
   * Get the resolved audio configuration.
   *
   * @returns The input and output audio stream formats
   */
  getAudioConfig(): AudioConfig {
    return this._audioConfig
  }

  /**
   * Establish a bidirectional connection with the Gemini Live API.
   *
   * @param options - System prompt, tools, history, and provider options
   * @throws {@link Error} If the model is already started
   */
  override async start(options: GoogleGeminiLiveStartOptions = {}): Promise<void> {
    if (this._connectionId) {
      throw new Error('model already started | call stop before starting again')
    }

    const { systemPrompt, tools, messages, liveSessionHandle } = options

    // A fresh start (no handle) drops any handle from a prior session; otherwise the next
    // proactive restart would resume that conversation into this one. Resume paths pass the
    // handle explicitly and keep it.
    if (liveSessionHandle === undefined) {
      this._liveSessionHandle = undefined
    }

    this._connectionId = globalThis.crypto.randomUUID()
    this._turnState = new TurnState()

    // Build live config — only enable initial-history mode when text content exists
    // (tool-only history is dropped by _sendMessageHistory and would leave the server stuck
    // waiting for a turnComplete that never arrives)
    const hasMessages =
      messages !== undefined &&
      messages.some((message) => message.content.some((block) => block.type === 'textBlock')) &&
      liveSessionHandle === undefined
    const liveConfig = this._buildLiveConfig(systemPrompt, tools, hasMessages, liveSessionHandle)

    const queue = new MessageQueue()
    this._messages = queue
    this._liveSession = await this._client.live.connect({
      model: this._config.modelId,
      config: liveConfig,
      callbacks: {
        onmessage: (message: LiveServerMessage) => queue.push(message),
        onerror: (event: ErrorEvent) => queue.fail(GoogleGeminiLiveModel._mapError(event)),
        onclose: () => queue.close(),
      },
    })

    // Gemini itself restores message history when resuming from a session
    if (messages && messages.length > 0 && liveSessionHandle === undefined) {
      this._sendMessageHistory(messages)
    }
  }

  /**
   * Receive Gemini Live API events and convert them to the provider-agnostic format.
   *
   * @returns Async iterable of standardized bidirectional output events
   * @throws {@link Error} If the model has not been started
   */
  override async *receive(): AsyncGenerator<BidiOutputEvent> {
    if (!this._connectionId) {
      throw new Error('model not started | call start before receiving')
    }

    yield new BidiConnectionStartEvent({
      type: 'bidiConnectionStart',
      connectionId: this._connectionId,
      model: this._config.modelId,
    })

    // Bind the message queue and turn state to this reader so that after a restart swaps the
    // session, a still-draining reader keeps its own closing stream and turn state rather than
    // mutating the connection that replaced it.
    const queue = this._messages
    if (!queue) {
      throw new Error('model not started | call start before receiving')
    }
    const turnState = this._turnState

    // Pull messages through an explicit iterator so the queue can be aborted before the
    // generator is unwound; a reader parked inside `drain()` would otherwise never settle.
    const messages = queue.drain()
    try {
      for (;;) {
        const next = await messages.next()
        if (next.done === true) {
          return
        }
        for (const event of this._convertGeminiLiveEvent(next.value, turnState)) {
          yield event
        }
      }
    } finally {
      queue.abort()
      await messages.return(undefined)
    }
  }

  /**
   * Send a complete message or an individual audio delta to the Gemini Live API.
   *
   * @param content - A complete message or an individual audio delta
   * @throws {@link Error} If the model has not been started, the session is closed, or the content is
   *   unsupported
   */
  override async send(content: BidiMessage | BidiContentDelta): Promise<void> {
    if (!this._connectionId) {
      throw new Error('model not started | call start before sending')
    }

    if (content instanceof AudioDelta) {
      this._sendAudioContent(content)
    } else if ('content' in content) {
      this._sendMessage(content)
    } else {
      throw new Error(`contentType=<${String((content as { type?: string }).type)}> | content not supported`)
    }
  }

  /** Close the Gemini Live API connection. */
  override async stop(): Promise<void> {
    const stopSession = async (): Promise<void> => {
      const session = this._liveSession
      const queue = this._messages
      // Clear first so a second stop() during restart does not close an already-closed session.
      this._liveSession = undefined
      this._messages = undefined
      if (!session) {
        return
      }

      try {
        session.close()
        // Python awaits the session's __aexit__ and therefore the socket teardown. Wait for the
        // close callback so a restart cannot connect while the old socket is still closing,
        // bounded so a socket that never closes cannot hang stop().
        if (queue) {
          await Promise.race([
            queue.closed,
            new Promise<void>((resolve) => {
              setTimeout(resolve, CLOSE_TIMEOUT_MS)
            }),
          ])
        }
      } finally {
        queue?.close()
      }
    }

    const stopConnection = async (): Promise<void> => {
      this._connectionId = undefined
      this._turnState.toolNames.clear()
    }

    await stopAll(stopSession, stopConnection)
  }

  /**
   * Restart by closing the connection and resuming the same session via its handle.
   *
   * Resumes the Gemini session using the last resumption handle so server-side context carries
   * across the swap without replaying history. The handle is supplied by the reactive (GoAway)
   * path via `options` or read from the tracked handle on the proactive path. When no handle is
   * available yet, falls back to a fresh connection with history replay.
   *
   * @param options - Configuration for the new connection; `liveSessionHandle` resumes the session
   */
  async restart(options: GoogleGeminiLiveStartOptions = {}): Promise<void> {
    const { liveSessionHandle, messages, ...rest } = options
    const handle = liveSessionHandle || this._liveSessionHandle
    logger.debug(`session_handle=<${String(handle)}> | gemini restart starting`)
    const snapshot = this._turnState.takeSnapshot()
    await this.stop()

    if (handle === undefined || !(await this._tryResume({ ...rest, liveSessionHandle: handle }))) {
      // No handle, or the server refused it: start fresh and replay history so the conversation
      // continues rather than going silent.
      await this.start(messages === undefined ? rest : { ...rest, messages })
    }
    this._turnState.loadSnapshot(snapshot)
    logger.debug(`connection_id=<${String(this._connectionId)}> | gemini restart complete`)
  }

  /**
   * Attempt to resume the session via its handle and report whether it succeeded.
   *
   * On refusal the handle is dropped (it would fail every retry) and the half-started connection
   * torn down, leaving the model ready for a fresh start.
   */
  private async _tryResume(options: GoogleGeminiLiveStartOptions): Promise<boolean> {
    try {
      await this.start(options)
      return true
    } catch (error) {
      logger.warn(`error=<${String(error)}> | gemini resume failed | falling back to fresh session`)
      this._liveSessionHandle = undefined
      await this._teardownAfterFailedResume()
      return false
    }
  }

  /**
   * Tear down the half-started connection so the caller can start fresh.
   *
   * Best-effort: a failing close on the half-entered session must not mask the resume failure or
   * block the fresh-start fallback (stop() still clears the connection id).
   */
  private async _teardownAfterFailedResume(): Promise<void> {
    try {
      await this.stop()
    } catch (stopError) {
      logger.debug(`error=<${String(stopError)}> | teardown after failed resume`)
    }
  }

  /**
   * Send conversation history to the Gemini Live API.
   *
   * Collects text content from messages into a list of turns and sends them in a single
   * sendClientContent call with turnComplete so history seeding ends and realtime mode begins.
   */
  private _sendMessageHistory(messages: Message[]): void {
    const turns: Content[] = []
    for (const message of messages) {
      const parts: Part[] = []
      for (const block of message.content) {
        if (block.type === 'textBlock') {
          parts.push({ text: block.text })
        }
      }

      if (parts.length > 0) {
        turns.push({ role: message.role === 'assistant' ? 'model' : message.role, parts })
      }
    }

    if (turns.length > 0) {
      this._requireLiveSession().sendClientContent({ turns, turnComplete: true })
    }
  }

  /**
   * Return the live session, failing loudly when it has already been torn down.
   *
   * @throws {@link ModelError} If the session is closed
   */
  private _requireLiveSession(): Session {
    if (!this._liveSession) {
      throw new ModelError('model session closed | call start before sending')
    }

    return this._liveSession
  }

  /** Send one user turn or tool results. */
  private _sendMessage(message: BidiMessage): void {
    const parts: Part[] = []
    const functionResponses: FunctionResponse[] = []
    for (const block of message.content) {
      if (block.type === 'textBlock') {
        parts.push({ text: block.text })
      } else if (block.type === 'imageBlock') {
        if (!('bytes' in block.source)) {
          throw new Error('image source must contain bytes for Gemini Live')
        }
        parts.push({
          inlineData: { data: encodeBase64(block.source.bytes), mimeType: `image/${block.format}` },
        })
      } else if (block.type === 'toolResultBlock') {
        functionResponses.push(this._formatToolResult(block))
      } else {
        throw new Error(
          `contentType=<${String((block as { type?: string }).type)}> | content not supported by Gemini Live`
        )
      }
    }

    if (functionResponses.length > 0) {
      this._requireLiveSession().sendToolResponse({ functionResponses })
      for (const response of functionResponses) {
        this._turnState.toolNames.delete(response.id as string)
      }
    }
    if (parts.length > 0) {
      this._requireLiveSession().sendClientContent({ turns: [{ role: 'user', parts }], turnComplete: true })
    }
  }

  /**
   * Send audio content using the Gemini Live API.
   *
   * Gemini Live expects continuous audio streaming via sendRealtimeInput. This automatically
   * triggers VAD and allows users to barge in during ongoing responses.
   */
  private _sendAudioContent(audioInput: AudioDelta): void {
    if (!('bytes' in audioInput.source)) {
      throw new Error('audio source must contain bytes for Gemini Live')
    }

    this._requireLiveSession().sendRealtimeInput({
      audio: {
        data: encodeBase64(audioInput.source.bytes),
        mimeType: `audio/pcm;rate=${this._audioConfig.input.sampleRate}`,
      },
    })
  }

  /** Convert one result for a Gemini tool-response message. */
  private _formatToolResult(toolResult: ToolResultBlockLike): FunctionResponse {
    const toolUseId = toolResult.toolUseId
    const content = toolResult.content

    const serialized = content.map((block) => {
      if (block.type === 'textBlock') {
        return { text: block.text }
      }
      if (block.type === 'jsonBlock') {
        return { json: block.json }
      }
      throw new Error(
        `toolUseId=<${toolUseId}>, contentType=<${block.type}> | Content type not supported by Gemini Live API`
      )
    })

    // Optimize for a single content item — unwrap the array
    const response =
      serialized.length === 1
        ? (serialized[0] as Record<string, unknown>)
        : ({ result: serialized } as Record<string, unknown>)

    const name = this._turnState.toolNames.get(toolUseId)
    if (name === undefined) {
      throw new ModelError(`toolUseId=<${toolUseId}> | unknown tool use id`)
    }

    return { id: toolUseId, name, response }
  }

  /**
   * Convert Gemini Live API events to the provider-agnostic format.
   *
   * Handles input transcription (user speech), output transcription (model audio), model turn
   * text, and usage metadata. `usageMetadata` sits outside the message-type union, so it can
   * accompany any other field and is collected independently of the content events.
   *
   * @throws {@link ConnectionTimeoutError} If Gemini responds with a go-away message
   */
  private _convertGeminiLiveEvent(message: LiveServerMessage, turnState: TurnState): BidiOutputEvent[] {
    if (message.goAway) {
      throw new ConnectionTimeoutError(JSON.stringify(message.goAway), {
        liveSessionHandle: this._liveSessionHandle,
      })
    }

    const events: BidiOutputEvent[] = []

    if (message.sessionResumptionUpdate) {
      const resumptionUpdate = message.sessionResumptionUpdate
      if (resumptionUpdate.resumable && resumptionUpdate.newHandle) {
        this._liveSessionHandle = resumptionUpdate.newHandle
        logger.debug(`session_handle=<${this._liveSessionHandle}> | updating gemini session handle`)
      }
    }

    const audioData = message.data

    const activity = message.voiceActivity
    if (activity && activity.voiceActivityType === 'ACTIVITY_START') {
      if (turnState.inputId === undefined || turnState.inputId === turnState.lastActivityInputId) {
        events.push(turnState.startInputTranscript())
      }
      turnState.lastActivityInputId = turnState.inputId
    }

    if (message.serverContent) {
      events.push(...this._convertServerContent(message.serverContent, turnState))
    }

    if (audioData) {
      if (turnState.audioContentId === undefined) {
        turnState.audioContentId = globalThis.crypto.randomUUID()
        events.push(new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId: turnState.audioContentId }))
      }
      events.push(
        new BidiAudioDeltaEvent({
          type: 'bidiAudioDelta',
          audio: decodeBase64(audioData),
          contentId: turnState.audioContentId,
          ...this._audioConfig.output,
        })
      )
    }

    if (message.toolCall?.functionCalls) {
      const toolUses = message.toolCall.functionCalls.map((call) => ({
        type: 'toolUseBlock' as const,
        toolUseId: call.id as string,
        name: call.name as string,
        input: (call.args ?? {}) as JSONValue,
      }))
      for (const toolUse of toolUses) {
        turnState.toolNames.set(toolUse.toolUseId, toolUse.name)
      }
      events.push(new BidiToolUseBlocksEvent({ type: 'bidiToolUseBlocks', toolUses: toolUses as ToolUseBlock[] }))
    }

    if (message.usageMetadata) {
      events.push(GoogleGeminiLiveModel._convertUsageMetadata(message.usageMetadata))
    }

    return GoogleGeminiLiveModel._wrapTurnEvents(message, events, turnState)
  }

  /** Bracket assistant output from its first content through `turnComplete`. */
  private static _wrapTurnEvents(
    message: LiveServerMessage,
    events: BidiOutputEvent[],
    turnState: TurnState
  ): BidiOutputEvent[] {
    const serverContent = message.serverContent
    const bargeIn = Boolean(serverContent?.interrupted)
    const turnComplete = Boolean(serverContent?.turnComplete)
    const generationComplete = Boolean(serverContent?.generationComplete)
    const producedModelOutput = events.some(
      (event) =>
        event instanceof BidiAudioDeltaEvent ||
        event instanceof BidiTextDeltaEvent ||
        event instanceof BidiReasoningDeltaEvent ||
        event instanceof BidiToolUseBlocksEvent ||
        (event instanceof BidiTranscriptDeltaEvent && event.role === 'assistant')
    )

    // Start user transcripts before assistant output in the same native message.
    const isUserTranscriptStart = (event: BidiOutputEvent): boolean =>
      event instanceof BidiTranscriptStartEvent && event.role === 'user'
    const wrapped: BidiOutputEvent[] = events.filter(isUserTranscriptStart)
    if (producedModelOutput && turnState.responseId === undefined) {
      turnState.responseId = globalThis.crypto.randomUUID()
      turnState.responseInputIds = turnState.inputId === undefined ? [] : [turnState.inputId]
      wrapped.push(new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: turnState.responseId }))
    }

    wrapped.push(...events.filter((event) => !isUserTranscriptStart(event)))

    if (bargeIn && turnState.responseId !== undefined) {
      turnState.interrupted = true
    }
    if (turnState.audioContentId !== undefined && (bargeIn || turnComplete || generationComplete)) {
      wrapped.push(new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId: turnState.audioContentId }))
      turnState.audioContentId = undefined
    }
    if (turnComplete) {
      wrapped.push(...GoogleGeminiLiveModel._completeResponse(turnState))
    }
    return wrapped
  }

  /** Close the turn's content and response, preserving any newer user activity. */
  private static _completeResponse(turnState: TurnState): BidiOutputEvent[] {
    const events: BidiOutputEvent[] = []
    let inputIdsToComplete = turnState.responseInputIds
    if (turnState.responseId === undefined) {
      inputIdsToComplete = turnState.inputId === undefined ? [] : [turnState.inputId]
    }
    for (const inputId of inputIdsToComplete) {
      if (turnState.inputIds.has(inputId)) {
        events.push(turnState.stopInputTranscript(inputId))
      }
    }
    if (turnState.responseId === undefined) {
      return events
    }

    events.push(...turnState.stopText())
    if (turnState.outputTranscriptId !== undefined) {
      events.push(
        new BidiTranscriptStopEvent({
          type: 'bidiTranscriptStop',
          role: 'assistant',
          contentId: turnState.outputTranscriptId,
        })
      )
    }
    events.push(new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: turnState.responseId }))
    turnState.responseId = undefined
    turnState.responseInputIds = []
    turnState.outputTranscriptId = undefined
    turnState.interrupted = false
    return events
  }

  /** Convert the server content of a Gemini Live message. */
  private _convertServerContent(serverContent: LiveServerContent, turnState: TurnState): BidiOutputEvent[] {
    const events: BidiOutputEvent[] = []

    if (serverContent.interrupted) {
      events.push(new BidiBargeInEvent())
    }

    const inputTranscript = serverContent.inputTranscription
    if (inputTranscript?.text) {
      const text = inputTranscript.text
      let inputId = turnState.inputId
      if (inputId === undefined) {
        const startEvent = turnState.startInputTranscript()
        events.push(startEvent)
        inputId = startEvent.contentId
        // Without a native activity boundary, finalize late text with the current turn.
        if (turnState.responseId !== undefined && !turnState.interrupted && !serverContent.interrupted) {
          turnState.responseInputIds.push(inputId)
        }
      }
      logger.debug(`text_length=<${text.length}> | gemini input transcription detected`)
      events.push(
        new BidiTranscriptDeltaEvent({ type: 'bidiTranscriptDelta', delta: text, role: 'user', contentId: inputId })
      )
    }

    if (inputTranscript?.finished === true && turnState.inputId !== undefined) {
      events.push(turnState.stopInputTranscript(turnState.inputId))
    }

    const outputTranscript = serverContent.outputTranscription
    if (outputTranscript?.text) {
      const text = outputTranscript.text
      logger.debug(`text_length=<${text.length}> | gemini output transcription detected`)
      if (turnState.outputTranscriptId === undefined) {
        turnState.outputTranscriptId = globalThis.crypto.randomUUID()
        events.push(
          new BidiTranscriptStartEvent({
            type: 'bidiTranscriptStart',
            role: 'assistant',
            contentId: turnState.outputTranscriptId,
          })
        )
      }
      events.push(
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: text,
          role: 'assistant',
          contentId: turnState.outputTranscriptId,
        })
      )
    }

    if (serverContent.modelTurn) {
      for (const part of serverContent.modelTurn.parts ?? []) {
        if (!part.text) {
          continue
        }
        const isReasoning = part.thought === true
        const matchesCurrent = isReasoning
          ? turnState.outputTextStop instanceof BidiReasoningStopEvent
          : turnState.outputTextStop instanceof BidiTextStopEvent
        if (!matchesCurrent) {
          events.push(...turnState.stopText())
          const contentId = globalThis.crypto.randomUUID()
          turnState.outputTextStop = isReasoning
            ? new BidiReasoningStopEvent({ type: 'bidiReasoningStop', contentId })
            : new BidiTextStopEvent({ type: 'bidiTextStop', contentId })
          events.push(
            isReasoning
              ? new BidiReasoningStartEvent({ type: 'bidiReasoningStart', contentId })
              : new BidiTextStartEvent({ type: 'bidiTextStart', contentId })
          )
        }
        const contentId = (turnState.outputTextStop as BidiTextStopEvent | BidiReasoningStopEvent).contentId
        events.push(
          isReasoning
            ? new BidiReasoningDeltaEvent({ type: 'bidiReasoningDelta', delta: part.text, contentId })
            : new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: part.text, contentId })
        )
      }
    }

    return events
  }

  /** Convert Gemini usage metadata into a usage event. */
  private static _convertUsageMetadata(usage: UsageMetadata): BidiUsageEvent {
    const inputDetails = GoogleGeminiLiveModel._modalityTokenCounts(usage.promptTokensDetails ?? [])
    const outputDetails = GoogleGeminiLiveModel._modalityTokenCounts(usage.responseTokensDetails ?? [])
    if (usage.cachedContentTokenCount !== undefined) {
      inputDetails.cacheRead = usage.cachedContentTokenCount
    }
    if (usage.thoughtsTokenCount !== undefined) {
      outputDetails.reasoning = usage.thoughtsTokenCount
    }

    return new BidiUsageEvent({
      type: 'bidiUsage',
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.responseTokenCount ?? 0,
      totalTokens: usage.totalTokenCount ?? 0,
      ...(Object.keys(inputDetails).length > 0 ? { inputTokenDetails: inputDetails } : {}),
      ...(Object.keys(outputDetails).length > 0 ? { outputTokenDetails: outputDetails } : {}),
    })
  }

  private static _modalityTokenCounts(details: ModalityTokenCount[]): TokenDetails {
    const names: Record<string, keyof TokenDetails> = {
      TEXT: 'text',
      AUDIO: 'audio',
      IMAGE: 'image',
      VIDEO: 'video',
    }
    const counts: TokenDetails = {}
    for (const detail of details) {
      const name = detail.modality === undefined ? undefined : names[detail.modality]
      if (name !== undefined && detail.tokenCount !== undefined) {
        counts[name] = detail.tokenCount
      }
    }
    return counts
  }

  /**
   * Build the live connect config for the official SDK.
   *
   * Model params recursively override defaults and directly supplied options.
   */
  private _buildLiveConfig(
    systemPrompt: string | undefined,
    tools: ToolSpec[] | undefined,
    hasMessages: boolean,
    liveSessionHandle: string | undefined
  ): LiveConnectConfig {
    const configDict: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      outputAudioTranscription: {},
      inputAudioTranscription: {},
      // Sliding-window context compression removes the ~15-min audio-only session cap, so a
      // session resumed across proactive restarts can continue indefinitely rather than dying
      // at the cap.
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: { handle: liveSessionHandle },
    }

    // Enables sendClientContent for initial history seeding before realtime mode.
    // Not supported on Vertex AI.
    if (hasMessages && (this._client as { vertexai?: boolean }).vertexai !== true) {
      configDict.historyConfig = { initialHistoryInClientContent: true }
    }

    if (systemPrompt) {
      configDict.systemInstruction = systemPrompt
    }

    if (tools && tools.length > 0) {
      configDict.tools = [
        {
          functionDeclarations: tools.map((toolSpec) => ({
            description: toolSpec.description,
            name: toolSpec.name,
            parameters: toolSpec.inputSchema,
          })),
        },
      ]
    }

    if (this._voice !== undefined) {
      configDict.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: this._voice } } }
    }

    return mergeConfig(configDict, this._config.params ?? {}) as LiveConnectConfig
  }

  /** Resolve and validate input and output audio settings. */
  private static _resolveAudioConfig(config: GoogleGeminiLiveAudioConfig | undefined): AudioConfig {
    const sampleRate = config?.input?.sampleRate ?? 16000
    if (sampleRate <= 0) {
      throw new Error(`Unsupported sample rate: ${sampleRate}. Expected a positive value.`)
    }

    return {
      input: { sampleRate, channels: 1, format: 'pcm' },
      output: { sampleRate: OUTPUT_SAMPLE_RATE, channels: 1, format: 'pcm' },
    }
  }

  /** Validate shared bidirectional model configuration. */
  private static _validateModelConfig(config: Partial<GoogleGeminiLiveModelConfig>): void {
    if (typeof config.modelId !== 'string' || !config.modelId) {
      throw new Error('modelId must be a non-empty string')
    }
  }

  /** Map a transport error so vendor errors never escape the provider. */
  private static _mapError(event: ErrorEvent): Error {
    const message = event.message || String(event.error ?? 'gemini live connection error')
    if (/RESOURCE_EXHAUSTED|\b429\b/i.test(message)) {
      return new ModelThrottledError(message, { cause: event.error ?? event })
    }
    return new ModelError(message, { cause: event.error ?? event })
  }
}

/** Minimal structural view of a tool result block, avoiding a runtime import cycle. */
interface ToolResultBlockLike {
  toolUseId: string
  content: { type: string; text?: string; json?: unknown }[]
}
