/**
 * Media and document content types for multimodal AI interactions.
 *
 * This module provides types for handling audio, images, videos, and documents
 * with support for multiple sources (bytes, S3, URLs, files).
 */

import type { Serialized, MaybeSerializedInput, JSONSerializable } from './json.js'
import { omitUndefined } from './json.js'
import { TextBlock, type TextBlockData } from './messages.js'

export type { AudioFormat, ImageFormat, VideoFormat, DocumentFormat, MediaFormat } from '../mime.js'
import type { AudioFormat, ImageFormat, VideoFormat, DocumentFormat } from '../mime.js'

/**
 * Cross-platform base64 encoding function that works in both browser and Node.js environments.
 */
export function encodeBase64(input: string | Uint8Array): string {
  // Handle Uint8Array (Image/PDF bytes)
  if (input instanceof Uint8Array) {
    // Node.js: Fast and zero copy
    if (typeof globalThis.Buffer === 'function') {
      return globalThis.Buffer.from(input).toString('base64')
    }

    // Browser: Safe conversion which doesn't cause a stack overflow like when using the spread operator.
    // We convert bytes to binary string in chunks to satisfy btoa()
    const CHUNK_SIZE = 0x8000 // 32k chunks
    let binary = ''
    for (let i = 0; i < input.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode.apply(
        null,
        input.subarray(i, Math.min(i + CHUNK_SIZE, input.length)) as unknown as number[]
      )
    }

    return globalThis.btoa(binary)
  }

  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(input)
  }

  return globalThis.Buffer.from(input, 'binary').toString('base64')
}

/**
 * Cross-platform base64 decoding function that works in both browser and Node.js environments.
 *
 * @param input - Base64 encoded string to decode
 * @returns Decoded bytes as Uint8Array
 */
export function decodeBase64(input: string): Uint8Array {
  // Node.js: Fast path using Buffer
  if (typeof globalThis.Buffer === 'function') {
    return new Uint8Array(globalThis.Buffer.from(input, 'base64'))
  }

  // Browser: Use atob to decode base64 to binary string, then convert to bytes
  const binary = globalThis.atob(input)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Base interface for a document/media source location.
 */
export interface LocationData {
  /**
   * Location type discriminator.
   */
  type: string
}

/**
 * Data for an S3 location.
 */
export interface S3LocationData extends LocationData {
  /**
   * Location type — always "s3".
   */
  type: 's3'

  /**
   * S3 URI in format: s3://bucket-name/key-name
   */
  uri: string

  /**
   * AWS account ID of the S3 bucket owner (12-digit).
   * Required if the bucket belongs to another AWS account.
   */
  bucketOwner?: string
}

/**
 * S3 location for media and document sources.
 */
export class S3Location implements S3LocationData, JSONSerializable<S3LocationData> {
  readonly type = 's3' as const
  readonly uri: string
  readonly bucketOwner?: string

  constructor(data: Omit<S3LocationData, 'type'> & { type?: 's3' }) {
    this.uri = data.uri
    if (data.bucketOwner !== undefined) {
      this.bucketOwner = data.bucketOwner
    }
  }

  /**
   * Serializes the S3Location to a JSON-compatible S3LocationData object.
   * Called automatically by JSON.stringify().
   */
  toJSON(): S3LocationData {
    return omitUndefined({
      type: this.type,
      uri: this.uri,
      bucketOwner: this.bucketOwner,
    }) as S3LocationData
  }

  /**
   * Creates an S3Location instance from S3LocationData.
   *
   * @param data - S3LocationData to deserialize
   * @returns S3Location instance
   */
  static fromJSON(data: S3LocationData): S3Location {
    return new S3Location(data)
  }
}

/**
 * Source for an audio block (Data version).
 */
export type AudioSourceData = { bytes: Uint8Array } | { location: S3LocationData }

/**
 * Source for an audio block (Class version).
 */
export type AudioSource =
  { type: 'audioSourceBytes'; bytes: Uint8Array } | { type: 'audioSourceS3Location'; location: S3Location }

/**
 * Data for an audio block.
 */
export interface AudioBlockData {
  /** Audio format. */
  format: AudioFormat

  /** Audio source. */
  source: AudioSourceData
}

/**
 * Audio content block.
 */
export class AudioBlock implements AudioBlockData, JSONSerializable<{ audio: Serialized<AudioBlockData> }> {
  /** Discriminator for audio content. */
  readonly type = 'audioBlock' as const

  /** Audio format. */
  readonly format: AudioFormat

  /** Audio source. */
  readonly source: AudioSource

  constructor(data: AudioBlockData) {
    this.format = data.format
    this.source = this._convertSource(data.source)
  }

  private _convertSource(source: AudioSourceData): AudioSource {
    if ('bytes' in source) {
      return {
        type: 'audioSourceBytes',
        bytes: source.bytes,
      }
    }
    if ('location' in source) {
      return {
        type: 'audioSourceS3Location',
        location: new S3Location(source.location),
      }
    }
    throw new Error('Invalid audio source')
  }

  /**
   * Serializes the AudioBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array bytes are encoded as a base64 string.
   *
   * @returns Wrapped audio block data
   */
  toJSON(): { audio: Serialized<AudioBlockData> } {
    const source: Serialized<AudioSourceData> =
      this.source.type === 'audioSourceBytes'
        ? { bytes: encodeBase64(this.source.bytes) }
        : { location: this.source.location.toJSON() }

    return {
      audio: {
        format: this.format,
        source,
      },
    }
  }

  /**
   * Creates an AudioBlock instance from its wrapped data format.
   * Base64-encoded bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped AudioBlockData to deserialize
   * @returns AudioBlock instance
   */
  static fromJSON(data: { audio: MaybeSerializedInput<AudioBlockData> }): AudioBlock {
    const audio = data.audio
    const source: AudioSourceData =
      'bytes' in audio.source
        ? {
            bytes: typeof audio.source.bytes === 'string' ? decodeBase64(audio.source.bytes) : audio.source.bytes,
          }
        : { location: audio.source.location }

    return new AudioBlock({
      format: audio.format,
      source,
    })
  }
}

/**
 * Source for an image (Data version).
 * Supports multiple formats for different providers.
 */
export type ImageSourceData =
  | { bytes: Uint8Array } // raw binary data
  | { location: S3LocationData } // remote location reference
  | { url: string } // https://

/**
 * Source for an image (Class version).
 */
export type ImageSource =
  | { type: 'imageSourceBytes'; bytes: Uint8Array }
  | { type: 'imageSourceS3Location'; location: S3Location }
  | { type: 'imageSourceUrl'; url: string }

/**
 * Data for an image block.
 */
export interface ImageBlockData {
  /**
   * Image format.
   */
  format: ImageFormat

  /**
   * Image source.
   */
  source: ImageSourceData
}

/**
 * Image content block.
 */
export class ImageBlock implements ImageBlockData, JSONSerializable<{ image: Serialized<ImageBlockData> }> {
  /**
   * Discriminator for image content.
   */
  readonly type = 'imageBlock' as const

  /**
   * Image format.
   */
  readonly format: ImageFormat

  /**
   * Image source.
   */
  readonly source: ImageSource

  constructor(data: ImageBlockData) {
    this.format = data.format
    this.source = this._convertSource(data.source)
  }

  private _convertSource(source: ImageSourceData): ImageSource {
    if ('bytes' in source) {
      return {
        type: 'imageSourceBytes',
        bytes: source.bytes,
      }
    }
    if ('url' in source) {
      return {
        type: 'imageSourceUrl',
        url: source.url,
      }
    }
    if ('location' in source) {
      return {
        type: 'imageSourceS3Location',
        location: new S3Location(source.location),
      }
    }
    throw new Error('Invalid image source')
  }

  /**
   * Serializes the ImageBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array bytes are encoded as base64 string.
   */
  toJSON(): { image: Serialized<ImageBlockData> } {
    let source: Serialized<ImageSourceData>
    if (this.source.type === 'imageSourceBytes') {
      source = { bytes: encodeBase64(this.source.bytes) }
    } else if (this.source.type === 'imageSourceUrl') {
      source = { url: this.source.url }
    } else {
      source = { location: this.source.location.toJSON() }
    }
    return {
      image: {
        format: this.format,
        source,
      },
    }
  }

  /**
   * Creates an ImageBlock instance from its wrapped data format.
   * Base64-encoded bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped ImageBlockData to deserialize (accepts both string and Uint8Array for bytes)
   * @returns ImageBlock instance
   */
  static fromJSON(data: { image: MaybeSerializedInput<ImageBlockData> }): ImageBlock {
    const image = data.image
    let source: ImageSourceData
    if ('bytes' in image.source) {
      const bytes = image.source.bytes
      source = { bytes: typeof bytes === 'string' ? decodeBase64(bytes) : bytes }
    } else if ('url' in image.source) {
      source = { url: image.source.url }
    } else {
      source = { location: image.source.location }
    }
    return new ImageBlock({
      format: image.format,
      source,
    })
  }
}

/**
 * Source for a video (Data version).
 */
export type VideoSourceData = { bytes: Uint8Array } | { location: S3LocationData } // remote location reference

/**
 * Source for a video (Class version).
 */
export type VideoSource =
  { type: 'videoSourceBytes'; bytes: Uint8Array } | { type: 'videoSourceS3Location'; location: S3Location }

/**
 * Data for a video block.
 */
export interface VideoBlockData {
  /**
   * Video format.
   */
  format: VideoFormat

  /**
   * Video source.
   */
  source: VideoSourceData
}

/**
 * Video content block.
 */
export class VideoBlock implements VideoBlockData, JSONSerializable<{ video: Serialized<VideoBlockData> }> {
  /**
   * Discriminator for video content.
   */
  readonly type = 'videoBlock' as const

  /**
   * Video format.
   */
  readonly format: VideoFormat

  /**
   * Video source.
   */
  readonly source: VideoSource

  constructor(data: VideoBlockData) {
    this.format = data.format
    this.source = this._convertSource(data.source)
  }

  private _convertSource(source: VideoSourceData): VideoSource {
    if ('bytes' in source) {
      return {
        type: 'videoSourceBytes',
        bytes: source.bytes,
      }
    }
    if ('location' in source) {
      return { type: 'videoSourceS3Location', location: new S3Location(source.location) }
    }
    throw new Error('Invalid video source')
  }

  /**
   * Serializes the VideoBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array bytes are encoded as base64 string.
   */
  toJSON(): { video: Serialized<VideoBlockData> } {
    let source: Serialized<VideoSourceData>
    if (this.source.type === 'videoSourceBytes') {
      source = { bytes: encodeBase64(this.source.bytes) }
    } else {
      source = { location: this.source.location.toJSON() }
    }
    return {
      video: {
        format: this.format,
        source,
      },
    }
  }

  /**
   * Creates a VideoBlock instance from its wrapped data format.
   * Base64-encoded bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped VideoBlockData to deserialize (accepts both string and Uint8Array for bytes)
   * @returns VideoBlock instance
   */
  static fromJSON(data: { video: MaybeSerializedInput<VideoBlockData> }): VideoBlock {
    const video = data.video
    let source: VideoSourceData
    if ('bytes' in video.source) {
      const bytes = video.source.bytes
      source = { bytes: typeof bytes === 'string' ? decodeBase64(bytes) : bytes }
    } else {
      source = { location: video.source.location }
    }
    return new VideoBlock({
      format: video.format,
      source,
    })
  }
}

/**
 * Content blocks that can be nested inside a document.
 * Documents can contain text blocks for structured content.
 */
export type DocumentContentBlockData = TextBlockData
export type DocumentContentBlock = TextBlock

/**
 * Source for a document (Data version).
 * Supports multiple formats including structured content.
 */
export type DocumentSourceData =
  | { bytes: Uint8Array } // raw binary data
  | { text: string } // plain text
  | { content: DocumentContentBlockData[] } // structured content
  | { location: S3LocationData } // remote location reference

/**
 * Source for a document (Class version).
 */
export type DocumentSource =
  | { type: 'documentSourceBytes'; bytes: Uint8Array }
  | { type: 'documentSourceText'; text: string }
  | { type: 'documentSourceContentBlock'; content: DocumentContentBlock[] }
  | { type: 'documentSourceS3Location'; location: S3Location }

/**
 * Data for a document block.
 */
export interface DocumentBlockData {
  /**
   * Document name.
   */
  name: string

  /**
   * Document format.
   */
  format: DocumentFormat

  /**
   * Document source.
   */
  source: DocumentSourceData

  /**
   * Citation configuration.
   */
  citations?: { enabled: boolean }

  /**
   * Context information for the document.
   */
  context?: string
}

/**
 * Document content block.
 */
export class DocumentBlock implements DocumentBlockData, JSONSerializable<{ document: Serialized<DocumentBlockData> }> {
  /**
   * Discriminator for document content.
   */
  readonly type = 'documentBlock' as const

  /**
   * Document name.
   */
  readonly name: string

  /**
   * Document format.
   */
  readonly format: DocumentFormat

  /**
   * Document source.
   */
  readonly source: DocumentSource

  /**
   * Citation configuration.
   */
  readonly citations?: { enabled: boolean }

  /**
   * Context information for the document.
   */
  readonly context?: string

  constructor(data: DocumentBlockData) {
    this.name = data.name
    this.format = data.format
    this.source = this._convertSource(data.source)
    if (data.citations !== undefined) {
      this.citations = data.citations
    }
    if (data.context !== undefined) {
      this.context = data.context
    }
  }

  private _convertSource(source: DocumentSourceData): DocumentSource {
    if ('bytes' in source) {
      return {
        type: 'documentSourceBytes',
        bytes: source.bytes,
      }
    }
    if ('text' in source) {
      return {
        type: 'documentSourceText',
        text: source.text,
      }
    }
    if ('content' in source) {
      return {
        type: 'documentSourceContentBlock',
        content: source.content.map((block) => new TextBlock(block.text)),
      }
    }
    if ('location' in source) {
      return {
        type: 'documentSourceS3Location',
        location: new S3Location(source.location),
      }
    }
    throw new Error('Invalid document source')
  }

  /**
   * Serializes the DocumentBlock to a JSON-compatible ContentBlockData object.
   * Called automatically by JSON.stringify().
   * Uint8Array bytes are encoded as base64 string.
   */
  toJSON(): { document: Serialized<DocumentBlockData> } {
    let source: Serialized<DocumentSourceData>
    if (this.source.type === 'documentSourceBytes') {
      source = { bytes: encodeBase64(this.source.bytes) }
    } else if (this.source.type === 'documentSourceText') {
      source = { text: this.source.text }
    } else if (this.source.type === 'documentSourceContentBlock') {
      source = { content: this.source.content.map((block) => block.toJSON()) }
    } else {
      source = { location: this.source.location.toJSON() }
    }
    return {
      document: omitUndefined({
        name: this.name,
        format: this.format,
        source,
        citations: this.citations,
        context: this.context,
      }),
    }
  }

  /**
   * Creates a DocumentBlock instance from its wrapped data format.
   * Base64-encoded bytes are decoded back to Uint8Array.
   *
   * @param data - Wrapped DocumentBlockData to deserialize (accepts both string and Uint8Array for bytes)
   * @returns DocumentBlock instance
   */
  static fromJSON(data: { document: MaybeSerializedInput<DocumentBlockData> }): DocumentBlock {
    const doc = data.document
    let source: DocumentSourceData
    if ('bytes' in doc.source) {
      const bytes = doc.source.bytes
      source = { bytes: typeof bytes === 'string' ? decodeBase64(bytes) : bytes }
    } else if ('text' in doc.source) {
      source = { text: doc.source.text }
    } else if ('content' in doc.source) {
      source = { content: doc.source.content }
    } else {
      source = { location: doc.source.location }
    }
    const result: DocumentBlockData = {
      name: doc.name,
      format: doc.format,
      source,
    }
    if (doc.citations !== undefined) {
      result.citations = doc.citations
    }
    if (doc.context !== undefined) {
      result.context = doc.context
    }
    return new DocumentBlock(result)
  }
}
