/**
 * Conversion utilities between Strands SDK content blocks and A2A protocol parts.
 *
 * Supports text, audio, images, videos, documents, and structured data.
 */

import type { Part, FileWithBytes, FileWithUri } from '@a2a-js/sdk'
import type { ContentBlock } from '../types/messages.js'
import { TextBlock } from '../types/messages.js'
import type { ImageFormat, DocumentFormat, VideoFormat, AudioFormat } from '../mime.js'
import { toMimeType, toMediaFormat, toAudioMimeType, toAudioMediaFormat } from '../mime.js'
import { AudioBlock, ImageBlock, VideoBlock, DocumentBlock, decodeBase64, encodeBase64 } from '../types/media.js'
import { logger } from '../logging/logger.js'

/**
 * Converts A2A protocol parts to Strands SDK content blocks.
 *
 * Handles text, file (audio/image/video/document), and structured data parts,
 * @param parts - Array of A2A protocol parts
 * @returns Array of Strands content blocks
 */
export function partsToContentBlocks(parts: Part[]): ContentBlock[] {
  const blocks: ContentBlock[] = []

  for (const part of parts) {
    try {
      switch (part.kind) {
        case 'text':
          blocks.push(new TextBlock(part.text))
          break
        case 'file':
          blocks.push(_convertFilePart(part.file))
          break
        case 'data':
          blocks.push(new TextBlock(`[Structured Data]\n${JSON.stringify(part.data, null, 2)}`))
          break
      }
    } catch {
      logger.warn(`part_kind=<${part.kind}> | failed to convert A2A part to content block`)
    }
  }

  return blocks
}

/**
 * Converts Strands SDK content blocks to A2A protocol parts.
 *
 * Supports text, audio, image, video, and document blocks. Media blocks
 * with byte sources are encoded as base64 file parts; URL-based sources
 * become URI file parts. Unsupported block types are silently skipped.
 *
 * @param blocks - Array of Strands content blocks
 * @returns Array of A2A parts
 */
export function contentBlocksToParts(blocks: ContentBlock[]): Part[] {
  const parts: Part[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'textBlock':
        parts.push({ kind: 'text', text: block.text })
        break
      case 'imageBlock':
      case 'videoBlock': {
        const filePart = _mediaBlockToFilePart(block)
        if (filePart) parts.push(filePart)
        break
      }
      case 'audioBlock': {
        const filePart = _audioBlockToFilePart(block)
        if (filePart) parts.push(filePart)
        break
      }
      case 'documentBlock': {
        const filePart = _documentBlockToFilePart(block)
        if (filePart) parts.push(filePart)
        break
      }
    }
  }

  return parts
}

/**
 * Converts an A2A FilePart to the appropriate Strands content block.
 *
 * @param file - The file object from a FilePart (either bytes or URI based)
 * @returns ContentBlock for the file
 */
function _convertFilePart(file: FileWithBytes | FileWithUri): ContentBlock {
  if ('bytes' in file) {
    const decoded = decodeBase64(file.bytes)
    const fileType = _getFileType(file.mimeType)
    const format = _getFormat(file.mimeType, fileType)

    if (fileType === 'image') {
      return new ImageBlock({ format: format as ImageFormat, source: { bytes: decoded } })
    }

    if (fileType === 'video') {
      return new VideoBlock({ format: format as VideoFormat, source: { bytes: decoded } })
    }

    if (fileType === 'audio') {
      return new AudioBlock({ format: format as AudioFormat, source: { bytes: decoded } })
    }

    // Document or unknown — treat as document
    return new DocumentBlock({
      name: file.name ?? 'document',
      format: format as DocumentFormat,
      source: { bytes: decoded },
    })
  }

  const name = file.name ?? 'file'
  return new TextBlock(`[File: ${name} (${file.uri})]`)
}

/**
 * Classifies a MIME type into a file category.
 *
 * @param mimeType - The MIME type string
 * @returns The file type category
 */
function _getFileType(mimeType: string | undefined): 'audio' | 'image' | 'video' | 'document' | 'unknown' {
  if (!mimeType) {
    return 'unknown'
  }

  const lower = _normalizeMimeType(mimeType)
  if (lower.startsWith('audio/')) {
    // AudioBlock only accepts known formats; unrecognized audio falls back to a document.
    if (toAudioMediaFormat(lower)) return 'audio'
    logger.warn(`mime_type=<${mimeType}> | unsupported audio MIME type, treating as document`)
    return 'unknown'
  }
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('video/')) return 'video'
  if (lower.startsWith('text/') || lower.startsWith('application/')) return 'document'
  return 'unknown'
}

/**
 * Resolves a MIME type to a Strands media format using the reverse MIME_TYPES lookup.
 * Falls back to the MIME subtype for unrecognized types.
 *
 * @param mimeType - The MIME type string
 * @param fileType - The classified file type
 * @returns The format string
 */
function _getFormat(mimeType: string | undefined, fileType: string): string {
  if (!mimeType) {
    return fileType === 'image' ? 'png' : fileType === 'video' ? 'mp4' : 'txt'
  }

  const lower = _normalizeMimeType(mimeType)

  // Use the reverse lookup (handles complex types like application/vnd.ms-excel → xls)
  const known = fileType === 'audio' ? toAudioMediaFormat(lower) : toMediaFormat(lower)
  if (known) {
    return known
  }

  // Fallback: extract subtype from MIME (e.g., image/tiff → tiff)
  if (lower.includes('/')) {
    return lower.split('/').pop()!
  }

  return 'txt'
}

/**
 * Strips MIME parameters (e.g. `; charset=utf-8`) and lowercases the type.
 *
 * @param mimeType - The raw MIME type string
 * @returns The bare, lowercased MIME type
 */
function _normalizeMimeType(mimeType: string): string {
  return mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/**
 * Converts an AudioBlock with a byte source to an A2A FilePart.
 *
 * @param block - The audio block
 * @returns A2A FilePart, or undefined if the source type is unsupported
 */
function _audioBlockToFilePart(block: AudioBlock): Part | undefined {
  if (block.source.type !== 'audioSourceBytes') {
    logger.warn(`source_type=<${block.source.type}> | unsupported audio source, skipping A2A conversion`)
    return undefined
  }

  return {
    kind: 'file',
    file: { bytes: encodeBase64(block.source.bytes), mimeType: toAudioMimeType(block.format) },
  }
}

/**
 * Converts an ImageBlock or VideoBlock to an A2A FilePart.
 *
 * @param block - The image or video block
 * @returns A2A FilePart, or undefined if the source type is unsupported
 */
function _mediaBlockToFilePart(block: ImageBlock | VideoBlock): Part | undefined {
  const mimeType = toMimeType(block.format)!

  if (block.source.type === 'imageSourceBytes' || block.source.type === 'videoSourceBytes') {
    return { kind: 'file', file: { bytes: encodeBase64(block.source.bytes), mimeType } }
  }

  if (block.source.type === 'imageSourceUrl') {
    return { kind: 'file', file: { uri: block.source.url, mimeType } }
  }

  return undefined
}

/**
 * Converts a DocumentBlock to an A2A FilePart.
 *
 * @param block - The document block
 * @returns A2A FilePart, or undefined if the source type is unsupported
 */
function _documentBlockToFilePart(block: DocumentBlock): Part | undefined {
  const mimeType = toMimeType(block.format)!

  if (block.source.type === 'documentSourceBytes') {
    return { kind: 'file', file: { bytes: encodeBase64(block.source.bytes), mimeType, name: block.name } }
  }

  if (block.source.type === 'documentSourceText') {
    return { kind: 'text', text: block.source.text }
  }

  return undefined
}
