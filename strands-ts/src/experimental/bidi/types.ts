import type { TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { ImageBlock } from '../../types/media.js'
import type { ToolUse } from '../../tools/types.js'
import type { ToolUseInputDelta } from '../../models/streaming.js'

/** Resolved format of a live audio stream. */
export interface AudioStreamConfig {
  /** Sample rate in Hz. */
  sampleRate: number
  /** Number of audio channels. */
  channels: 1 | 2
  /** Audio encoding. */
  format: 'pcm' | 'wav' | 'opus' | 'mp3'
}

/** Resolved input and output formats consumed by audio I/O. */
export interface AudioConfig {
  /** Audio format accepted by the model. */
  input: AudioStreamConfig
  /** Audio format produced by the model. */
  output: AudioStreamConfig
}

/** An audio delta appends samples without explicitly ending the user's turn. */
export interface AudioDelta {
  /** Discriminator for incremental audio input. */
  type: 'audioDelta'
  /** Audio encoding; the rate and channels come from the model's AudioConfig. */
  format: AudioStreamConfig['format']
  /** Audio samples to append to the live input stream. */
  source: { bytes: Uint8Array }
}

/** Content sent through a persistent model connection. */
export type BidiModelInput = TextBlock | ImageBlock | AudioDelta | ToolResultBlock

/** A persistent connection is ready to send and receive. */
export interface BidiConnectionStartEvent {
  /** Event discriminator. */
  type: 'bidiConnectionStart'
  /** Provider-assigned connection identifier. */
  connectionId: string
  /** Provider model identifier. */
  model: string
}

/** A persistent connection ended. */
export interface BidiConnectionStopEvent {
  /** Event discriminator. */
  type: 'bidiConnectionStop'
  /** Identifier of the connection that ended. */
  connectionId: string
  /** Reason for closing the connection. */
  reason: 'clientDisconnect' | 'timeout' | 'error' | 'complete' | 'userRequest'
}

/** Beginning of a model response. */
export interface BidiResponseStartEvent {
  /** Event discriminator. */
  type: 'bidiResponseStart'
  /** Identifier shared with the corresponding response stop. */
  responseId: string
}

/** Response output ended; user transcription may still be pending. */
export interface BidiResponseStopEvent {
  /** Event discriminator. */
  type: 'bidiResponseStop'
  /** Identifier of the response that ended. */
  responseId: string
}

/** Beginning of an assistant audio stream. */
export interface BidiAudioStartEvent {
  /** Event discriminator. */
  type: 'bidiAudioStart'
}

/** Incremental assistant audio, encoded as base64 for transport. */
export interface BidiAudioDeltaEvent extends AudioStreamConfig {
  /** Event discriminator. */
  type: 'bidiAudioDelta'
  /** Base64-encoded audio samples. */
  audio: string
}

/** Audio generation ended; playback may still be in progress. */
export interface BidiAudioStopEvent {
  /** Event discriminator. */
  type: 'bidiAudioStop'
}

/** Beginning of a user or assistant transcript. */
export interface BidiTranscriptStartEvent {
  /** Event discriminator. */
  type: 'bidiTranscriptStart'
  /** Who is speaking. */
  role: 'user' | 'assistant'
  /** Identifier shared by all events for this transcript. */
  contentId: string
}

/** Incremental user or assistant transcript. */
export interface BidiTranscriptDeltaEvent extends Omit<BidiTranscriptStartEvent, 'type'> {
  /** Event discriminator. */
  type: 'bidiTranscriptDelta'
  /** Incremental transcript text. */
  delta: string
}

/** Final text of a user or assistant transcript. */
export interface BidiTranscriptStopEvent extends Omit<BidiTranscriptStartEvent, 'type'> {
  /** Event discriminator. */
  type: 'bidiTranscriptStop'
  /** Complete transcript text. */
  transcript: string
}

/** Playback must stop while the persistent session continues. */
export interface BidiBargeInEvent {
  /** Event discriminator. */
  type: 'bidiBargeIn'
  /** Reason output should stop. */
  reason: 'userSpeech' | 'error'
}

/** A complete tool request, ready for execution by the caller. */
export interface ToolUseStreamEvent {
  /** Event discriminator. */
  type: 'toolUseStream'
  /** Input delta; providers may emit the complete JSON input in one event. */
  delta: ToolUseInputDelta
  /** Complete provider tool request, including the provider-assigned call ID. */
  currentToolUse: ToolUse
}

/** Token counts for a completed provider response. */
export interface BidiUsageEvent {
  /** Event discriminator. */
  type: 'bidiUsage'
  /** Input token count. */
  inputTokens: number
  /** Output token count. */
  outputTokens: number
  /** Total token count. */
  totalTokens: number
}

/** Provider-independent events from a persistent model connection. */
export type BidiOutputEvent =
  | BidiConnectionStartEvent
  | BidiConnectionStopEvent
  | BidiResponseStartEvent
  | BidiResponseStopEvent
  | BidiAudioStartEvent
  | BidiAudioDeltaEvent
  | BidiAudioStopEvent
  | BidiTranscriptStartEvent
  | BidiTranscriptDeltaEvent
  | BidiTranscriptStopEvent
  | BidiBargeInEvent
  | ToolUseStreamEvent
  | BidiUsageEvent
