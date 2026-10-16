/**
 * Output event types for bidirectional streaming.
 *
 * Defines the provider-agnostic events produced by bidirectional models and `BidiAgent`:
 * connection lifecycle (start, restart, warning, stop), response start and stop, audio, text,
 * reasoning, and transcript streams (start, delta, stop, and the completed block), barge-in,
 * token usage, and tool-use groups.
 *
 * This module follows the same pattern as `models/streaming.ts`: "Data" interfaces define the
 * structure for objects and corresponding classes implement those interfaces with type
 * discrimination. {@link BidiOutputEvent} is the union of the data interfaces, so a provider may
 * yield either a class instance or a plain object.
 */

import { logger } from '../../logging/logger.js'
import { encodeBase64 } from '../../types/media.js'

import type { Serialized } from '../../types/json.js'
import type { Role, ToolUseBlock } from '../../types/messages.js'
import type { ConnectionTimeoutError } from '../models/model.js'

/**
 * Number of audio channels.
 *
 * - Mono: 1
 * - Stereo: 2
 */
export type AudioChannel = 1 | 2

/**
 * Audio encoding format of model audio output and the resolved audio stream config.
 *
 * Distinct from `AudioFormat` in `types/media.ts`, the wider set of formats that types
 * the `format` field on audio input.
 */
export type BidiAudioFormat = 'pcm' | 'wav' | 'opus' | 'mp3'

const validRoles: ReadonlySet<string> = new Set<Role>(['user', 'assistant'])

/**
 * Normalize a role value to a supported {@link Role}.
 *
 * Provider outputs and transcript events may carry role values in arbitrary casing or outside
 * the supported set. This trims surrounding whitespace, coerces the value to lowercase, and
 * falls back to `defaultRole` when it is not one of the supported roles, so that messages
 * persisted to the conversation always carry a valid role.
 *
 * The default is the lowest-trust role (`'user'`): unknown or spoofed role values are never
 * attributed to the assistant. Legitimate assistant output passes an explicit
 * `role: 'assistant'`, which the allowlist accepts verbatim.
 *
 * @internal
 * @param role - The incoming role value (any type)
 * @param defaultRole - Role to use when the value is missing or unsupported
 * @returns A role guaranteed to be one of the supported {@link Role} values
 */
export function normalizeRole(role: unknown, defaultRole: Role = 'user'): Role {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : undefined
  if (normalized === undefined || !validRoles.has(normalized)) {
    logger.debug(`role=<${String(role)}>, default=<${defaultRole}> | coercing unsupported transcript role`)
    return defaultRole
  }
  return normalized as Role
}

/**
 * Union type representing all output events produced by a bidirectional model or agent.
 * This is a discriminated union where each event has a unique type field.
 */
export type BidiOutputEvent =
  | BidiConnectionStartEventData
  | BidiConnectionRestartEventData
  | BidiConnectionWarningEventData
  | BidiResponseStartEventData
  | BidiAudioStartEventData
  | BidiAudioDeltaEventData
  | BidiAudioStopEventData
  | BidiTextStartEventData
  | BidiTextDeltaEventData
  | BidiTextStopEventData
  | BidiTextBlockEventData
  | BidiReasoningStartEventData
  | BidiReasoningDeltaEventData
  | BidiReasoningStopEventData
  | BidiReasoningBlockEventData
  | BidiTranscriptStartEventData
  | BidiTranscriptDeltaEventData
  | BidiTranscriptStopEventData
  | BidiTranscriptBlockEventData
  | BidiBargeInEventData
  | BidiResponseStopEventData
  | BidiUsageEventData
  | BidiToolUseBlocksEventData
  | BidiConnectionStopEventData

/** Set of all BidiOutputEvent type discriminators. */
const bidiOutputEventTypes: ReadonlySet<string> = new Set<BidiOutputEvent['type']>([
  'bidiConnectionStart',
  'bidiConnectionRestart',
  'bidiConnectionWarning',
  'bidiResponseStart',
  'bidiAudioStart',
  'bidiAudioDelta',
  'bidiAudioStop',
  'bidiTextStart',
  'bidiTextDelta',
  'bidiTextStop',
  'bidiTextBlock',
  'bidiReasoningStart',
  'bidiReasoningDelta',
  'bidiReasoningStop',
  'bidiReasoningBlock',
  'bidiTranscriptStart',
  'bidiTranscriptDelta',
  'bidiTranscriptStop',
  'bidiTranscriptBlock',
  'bidiBargeIn',
  'bidiResponseStop',
  'bidiUsage',
  'bidiToolUseBlocks',
  'bidiConnectionStop',
])

/**
 * Type guard to check if an event with a type discriminator is a BidiOutputEvent.
 *
 * @param event - The event to check
 * @returns true if the event is a BidiOutputEvent
 */
export function isBidiOutputEvent(event: { type: string }): event is BidiOutputEvent {
  return bidiOutputEventTypes.has(event.type)
}

/**
 * Data for a connection start event.
 */
export interface BidiConnectionStartEventData {
  /** Discriminator for connection start events. */
  type: 'bidiConnectionStart'

  /** Unique identifier for this streaming connection. */
  connectionId: string

  /** Model identifier (e.g., 'gpt-realtime-2.1', 'gemini-3.8-live'). */
  model: string
}

/**
 * Streaming connection established and ready for interaction.
 */
export class BidiConnectionStartEvent implements BidiConnectionStartEventData {
  /** Discriminator for connection start events. */
  readonly type = 'bidiConnectionStart' as const

  /** Unique identifier for this streaming connection. */
  readonly connectionId: string

  /** Model identifier (e.g., 'gpt-realtime-2.1', 'gemini-3.8-live'). */
  readonly model: string

  constructor(data: BidiConnectionStartEventData) {
    this.connectionId = data.connectionId
    this.model = data.model
  }
}

/**
 * Data for a connection restart event.
 */
export interface BidiConnectionRestartEventData {
  /** Discriminator for connection restart events. */
  type: 'bidiConnectionRestart'

  /** What triggered the restart ('timeout' reactively, 'scheduled' proactively). */
  reason: 'timeout' | 'scheduled'

  /** The model's timeout error on the reactive path; absent when scheduled. */
  timeoutError?: ConnectionTimeoutError

  /** True if the restart cut off an in-progress response or an unanswered user turn. */
  turnInterrupted?: boolean
}

/**
 * Agent is restarting the model connection.
 *
 * Emitted on both restart paths: reactively after the model reports a timeout, and
 * proactively when the restart timer fires ahead of the provider's limit. Recovery depends on
 * the provider's replay or resumption support; the application may need to re-prompt or notify
 * the user.
 */
export class BidiConnectionRestartEvent implements BidiConnectionRestartEventData {
  /** Discriminator for connection restart events. */
  readonly type = 'bidiConnectionRestart' as const

  /** What triggered the restart ('timeout' reactively, 'scheduled' proactively). */
  readonly reason: 'timeout' | 'scheduled'

  /** The model's timeout error on the reactive path; absent when scheduled. */
  readonly timeoutError?: ConnectionTimeoutError

  /** True if the restart cut off an in-progress response or an unanswered user turn. */
  readonly turnInterrupted: boolean

  constructor(data: BidiConnectionRestartEventData) {
    this.reason = data.reason
    this.turnInterrupted = data.turnInterrupted ?? false
    if (data.timeoutError !== undefined) {
      this.timeoutError = data.timeoutError
    }
  }
}

/**
 * Data for a connection warning event.
 */
export interface BidiConnectionWarningEventData {
  /** Discriminator for connection warning events. */
  type: 'bidiConnectionWarning'

  /** Approximate milliseconds until the scheduled restart. */
  timeLeftMs: number
}

/**
 * Agent is approaching a proactive restart.
 *
 * Emitted by the proactive restart timer before a restart; informational only.
 */
export class BidiConnectionWarningEvent implements BidiConnectionWarningEventData {
  /** Discriminator for connection warning events. */
  readonly type = 'bidiConnectionWarning' as const

  /** Approximate milliseconds until the scheduled restart. */
  readonly timeLeftMs: number

  constructor(data: BidiConnectionWarningEventData) {
    this.timeLeftMs = data.timeLeftMs
  }
}

/**
 * Data for a response start event.
 */
export interface BidiResponseStartEventData {
  /** Discriminator for response start events. */
  type: 'bidiResponseStart'

  /** Unique identifier for this response. */
  responseId: string
}

/**
 * Start of a model response.
 */
export class BidiResponseStartEvent implements BidiResponseStartEventData {
  /** Discriminator for response start events. */
  readonly type = 'bidiResponseStart' as const

  /** Unique identifier for this response. */
  readonly responseId: string

  constructor(data: BidiResponseStartEventData) {
    this.responseId = data.responseId
  }
}

/**
 * Data for an audio start event.
 */
export interface BidiAudioStartEventData {
  /** Discriminator for audio start events. */
  type: 'bidiAudioStart'

  /** Identifier shared by this audio stream's events. */
  contentId: string
}

/**
 * Beginning of an assistant audio stream, identified by `contentId`.
 */
export class BidiAudioStartEvent implements BidiAudioStartEventData {
  /** Discriminator for audio start events. */
  readonly type = 'bidiAudioStart' as const

  /** Identifier shared by this audio stream's events. */
  readonly contentId: string

  constructor(data: BidiAudioStartEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for an audio delta event.
 */
export interface BidiAudioDeltaEventData {
  /** Discriminator for audio delta events. */
  type: 'bidiAudioDelta'

  /** Raw audio chunk. */
  audio: Uint8Array

  /** Audio encoding format. */
  format: BidiAudioFormat

  /** Number of audio samples per second in Hz. */
  sampleRate: number

  /** Number of audio channels (1=mono, 2=stereo). */
  channels: AudioChannel

  /** Identifier shared by this audio stream's events. */
  contentId: string
}

/**
 * Incremental audio output from the model.
 */
export class BidiAudioDeltaEvent implements BidiAudioDeltaEventData {
  /** Discriminator for audio delta events. */
  readonly type = 'bidiAudioDelta' as const

  /** Raw audio chunk. */
  readonly audio: Uint8Array

  /** Audio encoding format. */
  readonly format: BidiAudioFormat

  /** Number of audio samples per second in Hz. */
  readonly sampleRate: number

  /** Number of audio channels (1=mono, 2=stereo). */
  readonly channels: AudioChannel

  /** Identifier shared by this audio stream's events. */
  readonly contentId: string

  constructor(data: BidiAudioDeltaEventData) {
    this.audio = data.audio
    this.format = data.format
    this.sampleRate = data.sampleRate
    this.channels = data.channels
    this.contentId = data.contentId
  }

  /**
   * Serializes the event, base64-encoding the audio chunk.
   * Called automatically by JSON.stringify().
   *
   * @returns Serialized audio delta event data
   */
  toJSON(): Serialized<BidiAudioDeltaEventData> {
    return {
      type: this.type,
      audio: encodeBase64(this.audio),
      format: this.format,
      sampleRate: this.sampleRate,
      channels: this.channels,
      contentId: this.contentId,
    }
  }
}

/**
 * Data for an audio stop event.
 */
export interface BidiAudioStopEventData {
  /** Discriminator for audio stop events. */
  type: 'bidiAudioStop'

  /** Identifier shared by this audio stream's events. */
  contentId: string
}

/**
 * End of an assistant audio stream, which may still be playing.
 */
export class BidiAudioStopEvent implements BidiAudioStopEventData {
  /** Discriminator for audio stop events. */
  readonly type = 'bidiAudioStop' as const

  /** Identifier shared by this audio stream's events. */
  readonly contentId: string

  constructor(data: BidiAudioStopEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for a text start event.
 */
export interface BidiTextStartEventData {
  /** Discriminator for text start events. */
  type: 'bidiTextStart'

  /** Identifier shared by this text stream's events. */
  contentId: string
}

/**
 * Beginning of assistant text output, identified by `contentId`.
 */
export class BidiTextStartEvent implements BidiTextStartEventData {
  /** Discriminator for text start events. */
  readonly type = 'bidiTextStart' as const

  /** Identifier shared by this text stream's events. */
  readonly contentId: string

  constructor(data: BidiTextStartEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for a text delta event.
 */
export interface BidiTextDeltaEventData {
  /** Discriminator for text delta events. */
  type: 'bidiTextDelta'

  /** The incremental text. */
  delta: string

  /** Identifier shared by this text stream's events. */
  contentId: string
}

/**
 * Incremental assistant text output, separate from speech transcripts.
 */
export class BidiTextDeltaEvent implements BidiTextDeltaEventData {
  /** Discriminator for text delta events. */
  readonly type = 'bidiTextDelta' as const

  /** The incremental text. */
  readonly delta: string

  /** Identifier shared by this text stream's events. */
  readonly contentId: string

  constructor(data: BidiTextDeltaEventData) {
    this.delta = data.delta
    this.contentId = data.contentId
  }
}

/**
 * Data for a text stop event.
 */
export interface BidiTextStopEventData {
  /** Discriminator for text stop events. */
  type: 'bidiTextStop'

  /** Identifier shared by this text stream's events. */
  contentId: string
}

/**
 * End of an assistant text stream, before its completed block is emitted.
 */
export class BidiTextStopEvent implements BidiTextStopEventData {
  /** Discriminator for text stop events. */
  readonly type = 'bidiTextStop' as const

  /** Identifier shared by this text stream's events. */
  readonly contentId: string

  constructor(data: BidiTextStopEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for a text block event.
 */
export interface BidiTextBlockEventData {
  /** Discriminator for text block events. */
  type: 'bidiTextBlock'

  /** The complete assistant text. */
  text: string

  /** Identifier shared by this text stream's events. */
  contentId: string
}

/**
 * Complete assistant text, emitted after its stop event by the agent.
 */
export class BidiTextBlockEvent implements BidiTextBlockEventData {
  /** Discriminator for text block events. */
  readonly type = 'bidiTextBlock' as const

  /** The complete assistant text. */
  readonly text: string

  /** Identifier shared by this text stream's events. */
  readonly contentId: string

  constructor(data: BidiTextBlockEventData) {
    this.text = data.text
    this.contentId = data.contentId
  }
}

/**
 * Data for a reasoning start event.
 */
export interface BidiReasoningStartEventData {
  /** Discriminator for reasoning start events. */
  type: 'bidiReasoningStart'

  /** Identifier shared by this reasoning stream's events. */
  contentId: string
}

/**
 * Beginning of model-provided reasoning text, identified by `contentId`.
 */
export class BidiReasoningStartEvent implements BidiReasoningStartEventData {
  /** Discriminator for reasoning start events. */
  readonly type = 'bidiReasoningStart' as const

  /** Identifier shared by this reasoning stream's events. */
  readonly contentId: string

  constructor(data: BidiReasoningStartEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for a reasoning delta event.
 */
export interface BidiReasoningDeltaEventData {
  /** Discriminator for reasoning delta events. */
  type: 'bidiReasoningDelta'

  /** The incremental reasoning text. */
  delta: string

  /** Identifier shared by this reasoning stream's events. */
  contentId: string
}

/**
 * Incremental reasoning text or thought summary exposed by the model.
 */
export class BidiReasoningDeltaEvent implements BidiReasoningDeltaEventData {
  /** Discriminator for reasoning delta events. */
  readonly type = 'bidiReasoningDelta' as const

  /** The incremental reasoning text. */
  readonly delta: string

  /** Identifier shared by this reasoning stream's events. */
  readonly contentId: string

  constructor(data: BidiReasoningDeltaEventData) {
    this.delta = data.delta
    this.contentId = data.contentId
  }
}

/**
 * Data for a reasoning stop event.
 */
export interface BidiReasoningStopEventData {
  /** Discriminator for reasoning stop events. */
  type: 'bidiReasoningStop'

  /** Identifier shared by this reasoning stream's events. */
  contentId: string
}

/**
 * End of a reasoning stream, before its completed block is emitted.
 */
export class BidiReasoningStopEvent implements BidiReasoningStopEventData {
  /** Discriminator for reasoning stop events. */
  readonly type = 'bidiReasoningStop' as const

  /** Identifier shared by this reasoning stream's events. */
  readonly contentId: string

  constructor(data: BidiReasoningStopEventData) {
    this.contentId = data.contentId
  }
}

/**
 * Data for a reasoning block event.
 */
export interface BidiReasoningBlockEventData {
  /** Discriminator for reasoning block events. */
  type: 'bidiReasoningBlock'

  /** The complete reasoning text. */
  text: string

  /** Identifier shared by this reasoning stream's events. */
  contentId: string
}

/**
 * Complete reasoning text, emitted after its stop event by the agent.
 */
export class BidiReasoningBlockEvent implements BidiReasoningBlockEventData {
  /** Discriminator for reasoning block events. */
  readonly type = 'bidiReasoningBlock' as const

  /** The complete reasoning text. */
  readonly text: string

  /** Identifier shared by this reasoning stream's events. */
  readonly contentId: string

  constructor(data: BidiReasoningBlockEventData) {
    this.text = data.text
    this.contentId = data.contentId
  }
}

/**
 * Data for a transcript start event.
 */
export interface BidiTranscriptStartEventData {
  /** Discriminator for transcript start events. */
  type: 'bidiTranscriptStart'

  /** Who is speaking ('user' or 'assistant'). */
  role: Role

  /** Identifier shared by this transcript's events. */
  contentId: string
}

/**
 * Beginning of a user or assistant transcript, before its text arrives.
 */
export class BidiTranscriptStartEvent implements BidiTranscriptStartEventData {
  /** Discriminator for transcript start events. */
  readonly type = 'bidiTranscriptStart' as const

  /** Who is speaking ('user' or 'assistant'). */
  readonly role: Role

  /** Identifier shared by this transcript's events. */
  readonly contentId: string

  constructor(data: BidiTranscriptStartEventData) {
    this.role = normalizeRole(data.role)
    this.contentId = data.contentId
  }
}

/**
 * Data for a transcript delta event.
 */
export interface BidiTranscriptDeltaEventData {
  /** Discriminator for transcript delta events. */
  type: 'bidiTranscriptDelta'

  /** The incremental transcript text. */
  delta: string

  /** Who is speaking ('user' or 'assistant'). */
  role: Role

  /** Identifier shared by this transcript's events. */
  contentId: string
}

/**
 * Incremental transcription of user or assistant speech.
 */
export class BidiTranscriptDeltaEvent implements BidiTranscriptDeltaEventData {
  /** Discriminator for transcript delta events. */
  readonly type = 'bidiTranscriptDelta' as const

  /** The incremental transcript text. */
  readonly delta: string

  /** Who is speaking ('user' or 'assistant'). */
  readonly role: Role

  /** Identifier shared by this transcript's events. */
  readonly contentId: string

  constructor(data: BidiTranscriptDeltaEventData) {
    this.delta = data.delta
    this.role = normalizeRole(data.role)
    this.contentId = data.contentId
  }
}

/**
 * Data for a transcript stop event.
 */
export interface BidiTranscriptStopEventData {
  /** Discriminator for transcript stop events. */
  type: 'bidiTranscriptStop'

  /** Who spoke ('user' or 'assistant'). */
  role: Role

  /** Identifier shared by this transcript's events. */
  contentId: string
}

/**
 * End of a transcript stream, before its completed block is emitted.
 */
export class BidiTranscriptStopEvent implements BidiTranscriptStopEventData {
  /** Discriminator for transcript stop events. */
  readonly type = 'bidiTranscriptStop' as const

  /** Who spoke ('user' or 'assistant'). */
  readonly role: Role

  /** Identifier shared by this transcript's events. */
  readonly contentId: string

  constructor(data: BidiTranscriptStopEventData) {
    this.role = normalizeRole(data.role)
    this.contentId = data.contentId
  }
}

/**
 * Data for a transcript block event.
 */
export interface BidiTranscriptBlockEventData {
  /** Discriminator for transcript block events. */
  type: 'bidiTranscriptBlock'

  /** The final transcript text. */
  transcript: string

  /** Who spoke ('user' or 'assistant'). */
  role: Role

  /** Identifier shared by this transcript's events. */
  contentId: string
}

/**
 * Complete transcript, emitted after its stop event by the agent.
 */
export class BidiTranscriptBlockEvent implements BidiTranscriptBlockEventData {
  /** Discriminator for transcript block events. */
  readonly type = 'bidiTranscriptBlock' as const

  /** The final transcript text. */
  readonly transcript: string

  /** Who spoke ('user' or 'assistant'). */
  readonly role: Role

  /** Identifier shared by this transcript's events. */
  readonly contentId: string

  constructor(data: BidiTranscriptBlockEventData) {
    this.transcript = data.transcript
    this.role = normalizeRole(data.role)
    this.contentId = data.contentId
  }
}

/**
 * Data for a barge-in event.
 */
export interface BidiBargeInEventData {
  /** Discriminator for barge-in events. */
  type: 'bidiBargeIn'
}

/**
 * Stop current response generation or playback while the session continues.
 */
export class BidiBargeInEvent implements BidiBargeInEventData {
  /** Discriminator for barge-in events. */
  readonly type = 'bidiBargeIn' as const
}

/**
 * Data for a response stop event.
 */
export interface BidiResponseStopEventData {
  /** Discriminator for response stop events. */
  type: 'bidiResponseStop'

  /** ID of the response that ended (matches {@link BidiResponseStartEvent}). */
  responseId: string
}

/**
 * Response output ended. User transcription may still be pending.
 */
export class BidiResponseStopEvent implements BidiResponseStopEventData {
  /** Discriminator for response stop events. */
  readonly type = 'bidiResponseStop' as const

  /** ID of the response that ended (matches {@link BidiResponseStartEvent}). */
  readonly responseId: string

  constructor(data: BidiResponseStopEventData) {
    this.responseId = data.responseId
  }
}

/**
 * Token counts by category for the input or output side of a usage event.
 *
 * All fields are optional. Categories may overlap or be incomplete, so their sum is not
 * necessarily the event's input or output token count.
 */
export interface TokenDetails {
  /** Text tokens. */
  text?: number

  /** Audio tokens. */
  audio?: number

  /** Image tokens. */
  image?: number

  /** Video tokens. */
  video?: number

  /** Input tokens read from cache. */
  cacheRead?: number

  /** Output reasoning or thought tokens reported by the provider. */
  reasoning?: number
}

/**
 * Data for a usage event.
 */
export interface BidiUsageEventData {
  /** Discriminator for usage events. */
  type: 'bidiUsage'

  /** Input tokens accounted for by this event. */
  inputTokens: number

  /** Output tokens accounted for by this event. */
  outputTokens: number

  /** Total tokens accounted for by this event. */
  totalTokens: number

  /** Input token counts by category for this event. */
  inputTokenDetails?: TokenDetails

  /** Output token counts by category for this event. */
  outputTokenDetails?: TokenDetails
}

/**
 * Additional model token usage with optional input and output breakdowns.
 *
 * Each event contributes new usage to the conversation's running totals. Its counts may cover
 * part of a response or a complete model generation. Providers may omit details or report
 * overlapping counts, so use the reported totals rather than summing the breakdowns.
 */
export class BidiUsageEvent implements BidiUsageEventData {
  /** Discriminator for usage events. */
  readonly type = 'bidiUsage' as const

  /** Input tokens accounted for by this event. */
  readonly inputTokens: number

  /** Output tokens accounted for by this event. */
  readonly outputTokens: number

  /** Total tokens accounted for by this event. */
  readonly totalTokens: number

  /** Input token counts by category for this event. */
  readonly inputTokenDetails?: TokenDetails

  /** Output token counts by category for this event. */
  readonly outputTokenDetails?: TokenDetails

  constructor(data: BidiUsageEventData) {
    this.inputTokens = data.inputTokens
    this.outputTokens = data.outputTokens
    this.totalTokens = data.totalTokens
    if (data.inputTokenDetails !== undefined) {
      this.inputTokenDetails = data.inputTokenDetails
    }
    if (data.outputTokenDetails !== undefined) {
      this.outputTokenDetails = data.outputTokenDetails
    }
  }
}

/**
 * Data for a tool-use group event.
 */
export interface BidiToolUseBlocksEventData {
  /** Discriminator for tool-use group events. */
  type: 'bidiToolUseBlocks'

  /** Tool calls to execute together. */
  toolUses: ToolUseBlock[]
}

/**
 * A complete group of tool calls requested by the model.
 */
export class BidiToolUseBlocksEvent implements BidiToolUseBlocksEventData {
  /** Discriminator for tool-use group events. */
  readonly type = 'bidiToolUseBlocks' as const

  /** Tool calls to execute together. */
  readonly toolUses: ToolUseBlock[]

  constructor(data: BidiToolUseBlocksEventData) {
    this.toolUses = data.toolUses
  }
}

/**
 * Data for a connection stop event.
 */
export interface BidiConnectionStopEventData {
  /** Discriminator for connection stop events. */
  type: 'bidiConnectionStop'

  /** Unique identifier for this streaming connection (matches {@link BidiConnectionStartEvent}). */
  connectionId: string

  /** Why the connection was closed. `'userRequest'` after `agent.cancel()` takes effect. */
  reason: 'userRequest'
}

/**
 * Streaming connection stop notification, which may precede resource cleanup.
 */
export class BidiConnectionStopEvent implements BidiConnectionStopEventData {
  /** Discriminator for connection stop events. */
  readonly type = 'bidiConnectionStop' as const

  /** Unique identifier for this streaming connection (matches {@link BidiConnectionStartEvent}). */
  readonly connectionId: string

  /** Why the connection was closed. `'userRequest'` after `agent.cancel()` takes effect. */
  readonly reason: 'userRequest'

  constructor(data: BidiConnectionStopEventData) {
    this.connectionId = data.connectionId
    this.reason = data.reason
  }
}
