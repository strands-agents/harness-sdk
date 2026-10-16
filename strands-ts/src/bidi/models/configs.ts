/**
 * Configuration types and helpers for bidirectional model providers.
 */

import type { BaseModelConfig } from '../../models/model.js'
import type { AudioChannel, BidiAudioFormat } from '../types/events.js'

/**
 * Resolved format of an audio stream.
 */
export interface AudioStreamConfig {
  /** Sample rate in Hz. */
  sampleRate: number

  /** Number of audio channels. */
  channels: AudioChannel

  /** Audio encoding. */
  format: BidiAudioFormat
}

/**
 * Resolved input and output formats consumed by audio I/O.
 *
 * Pass provider-specific audio options to the model constructor and use `getAudioConfig()` to
 * obtain the resulting stream formats.
 */
export interface AudioConfig {
  /** Audio format configured for model input. */
  input: AudioStreamConfig

  /** Audio format produced by the model. */
  output: AudioStreamConfig
}

/**
 * Nova Sonic stream options. Audio uses mono PCM.
 */
export interface BedrockNovaSonicAudioStreamConfig {
  /** Sample rate in Hz. */
  sampleRate: 8000 | 16000 | 24000
}

/**
 * Nova Sonic input and output audio options.
 *
 * Omitted streams use a sample rate of 16000 Hz.
 */
export interface BedrockNovaSonicAudioConfig {
  /** Input stream options. */
  input?: BedrockNovaSonicAudioStreamConfig

  /** Output stream options. */
  output?: BedrockNovaSonicAudioStreamConfig
}

/**
 * Gemini Live input stream options. Audio uses mono PCM.
 */
export interface GoogleGeminiLiveAudioStreamConfig {
  /** Input sample rate in Hz. */
  sampleRate: number
}

/**
 * Gemini Live audio options. Output is mono PCM at 24000 Hz.
 *
 * Omitting the input stream uses a sample rate of 16000 Hz.
 */
export interface GoogleGeminiLiveAudioConfig {
  /** Input stream options. */
  input?: GoogleGeminiLiveAudioStreamConfig
}

/**
 * Declared restart timing for a bidirectional model.
 *
 * Providers declare this so the agent loop can restart the connection proactively, before the
 * provider terminates the connection on its own limit. A provider that declares nothing (empty
 * config) keeps reactive-only behavior: no proactive timer, restart only after the provider
 * reports a timeout.
 *
 * All fields are optional. The proactive timer arms only when `restartAfterMs` is positive and
 * automatic restarts are enabled.
 */
export interface ConnectionConfig {
  /**
   * Milliseconds after a connection is established at which to proactively restart. Set it at
   * least ~10s below the provider's own connection limit: the restart may wait briefly for the
   * current turn to finish (aligning the swap to a turn boundary), and that wait plus the swap
   * must complete before the provider's limit.
   */
  restartAfterMs?: number

  /** Whether the loop restarts the connection automatically (default true). */
  autoRestart?: boolean
}

/**
 * Configuration shared by bidirectional model providers.
 */
export interface BidiModelConfig extends BaseModelConfig {
  /** Provider-specific options passed to the model request or session. */
  params?: Record<string, unknown>

  /** Restart timing overrides. */
  connection?: ConnectionConfig
}

/**
 * Recursively merge configs without modifying either input.
 *
 * Object values merge; every other value (including arrays) replaces.
 *
 * @internal
 * @param config - Base configuration
 * @param overrides - Values that take precedence over the base
 * @returns A new merged configuration
 */
export function mergeConfig(
  config: Record<string, unknown>,
  overrides: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = globalThis.structuredClone(config)

  for (const [key, value] of Object.entries(overrides)) {
    if (isPlainObject(value)) {
      const existing = merged[key]
      merged[key] = mergeConfig(isPlainObject(existing) ? existing : {}, value)
    } else {
      merged[key] = globalThis.structuredClone(value)
    }
  }

  return merged
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
