/**
 * Media input types for bidirectional streaming.
 */

import {
  decodeBase64,
  encodeBase64,
  type AudioFormat,
  type AudioSource,
  type AudioSourceData,
} from '../../types/media.js'
import { S3Location } from '../../types/media.js'

import type { JSONSerializable, MaybeSerializedInput, Serialized } from '../../types/json.js'

/**
 * Data for an audio delta.
 */
export interface AudioDeltaData {
  /** Audio format. */
  format: AudioFormat

  /** Source containing the audio samples. */
  source: AudioSourceData
}

/**
 * Audio samples to append to the live input stream.
 *
 * Sending a delta does not explicitly end the user's turn.
 */
export class AudioDelta implements AudioDeltaData, JSONSerializable<{ audioDelta: Serialized<AudioDeltaData> }> {
  /** Discriminator for audio deltas. */
  readonly type = 'audioDelta' as const

  /** Audio format. */
  readonly format: AudioFormat

  /** Source containing the audio samples. */
  readonly source: AudioSource

  constructor(data: AudioDeltaData) {
    this.format = data.format
    this.source = this._convertSource(data.source)
  }

  private _convertSource(source: AudioSourceData): AudioSource {
    if ('bytes' in source) {
      return { type: 'audioSourceBytes', bytes: source.bytes }
    }
    if ('location' in source) {
      return { type: 'audioSourceS3Location', location: new S3Location(source.location) }
    }
    throw new Error('Invalid audio source')
  }

  /**
   * Serializes the AudioDelta to a JSON-compatible object.
   * Called automatically by JSON.stringify().
   * Uint8Array bytes are encoded as a base64 string.
   *
   * @returns Wrapped audio delta data
   */
  toJSON(): { audioDelta: Serialized<AudioDeltaData> } {
    const source: Serialized<AudioSourceData> =
      this.source.type === 'audioSourceBytes'
        ? { bytes: encodeBase64(this.source.bytes) }
        : { location: this.source.location.toJSON() }

    return { audioDelta: { format: this.format, source } }
  }

  /**
   * Creates an AudioDelta instance from its wrapped data format.
   * Base64-encoded bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped AudioDeltaData to deserialize
   * @returns AudioDelta instance
   */
  static fromJSON(data: { audioDelta: MaybeSerializedInput<AudioDeltaData> }): AudioDelta {
    const audioDelta = data.audioDelta
    const source: AudioSourceData =
      'bytes' in audioDelta.source
        ? {
            bytes:
              typeof audioDelta.source.bytes === 'string'
                ? decodeBase64(audioDelta.source.bytes)
                : audioDelta.source.bytes,
          }
        : { location: audioDelta.source.location }

    return new AudioDelta({ format: audioDelta.format, source })
  }
}
