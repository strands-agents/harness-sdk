/**
 * Conversion utilities between Strands SDK content blocks and A2A protocol parts.
 *
 * Supports text, images, videos, documents, and structured data.
 */

import type { Part, FileWithBytes, FileWithUri } from '@a2a-js/sdk'
import { A2AError } from '@a2a-js/sdk/server'
import type { ContentBlock } from '../types/messages.js'
import { TextBlock } from '../types/messages.js'
import type { ImageFormat, DocumentFormat, VideoFormat } from '../mime.js'
import { toMimeType, toMediaFormat } from '../mime.js'
import { ImageBlock, VideoBlock, DocumentBlock, decodeBase64, encodeBase64 } from '../types/media.js'
import { InterruptResponseContent } from '../types/interrupt.js'
import type { JSONValue } from '../types/json.js'
import { logger } from '../logging/logger.js'

/**
 * Key identifying a data part that carries a Strands interrupt response. The A2A payload mirrors
 * the `InterruptResponseContent` type verbatim, so the wire contract and the SDK type cannot drift.
 */
export const INTERRUPT_RESPONSE_KEY = 'interruptResponse'

/**
 * Key under which an `input-required` status message advertises the interrupts awaiting an answer.
 * Each entry carries the `interruptId` that the matching interrupt response must echo back.
 */
export const INTERRUPTS_KEY = 'interrupts'

/**
 * Extracts Strands interrupt responses from inbound A2A message parts.
 *
 * A client resumes a task parked in `input-required` by sending a data part shaped like the
 * `InterruptResponseContent` type:
 *
 * ```json
 * { "kind": "data", "data": { "interruptResponse": { "interruptId": "<id>", "response": <any> } } }
 * ```
 *
 * Recognition is deliberately narrow: only the explicit shape above is treated as a resume, so an
 * ordinary data part still reaches the generic content-block path unchanged.
 *
 * @param parts - Array of A2A protocol parts from the inbound message
 * @returns The interrupt responses carried by `parts`, or undefined when none are present and the
 *   caller should fall back to generic content-block conversion
 * @throws A2AError when an interrupt response is malformed, carries a null response, repeats an
 *   interrupt id, or is accompanied by unrelated content in the same message
 */
export function extractInterruptResponses(parts: Part[]): InterruptResponseContent[] | undefined {
  const responses: InterruptResponseContent[] = []
  const seenIds = new Set<string>()
  let unrelatedParts = 0

  for (const part of parts) {
    if (part.kind !== 'data' || !(INTERRUPT_RESPONSE_KEY in part.data)) {
      unrelatedParts += 1
      continue
    }

    const payload = part.data[INTERRUPT_RESPONSE_KEY]
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw A2AError.invalidParams(`'${INTERRUPT_RESPONSE_KEY}' must be an object with 'interruptId' and 'response'`)
    }

    const { interruptId, response } = payload as { interruptId?: unknown; response?: unknown }
    if (typeof interruptId !== 'string' || interruptId.length === 0) {
      throw A2AError.invalidParams("Interrupt response is missing a non-empty 'interruptId'")
    }

    // An interrupt whose response is null reads as "not yet answered", so a null answer would leave
    // the interrupt unsatisfied and re-raise it: the client would see an identical input-required
    // and no error. Falsy answers such as false are fine.
    if (response === undefined || response === null) {
      throw A2AError.invalidParams(`Interrupt response for '${interruptId}' must provide a non-null 'response'`)
    }

    // Two answers for one interrupt are ambiguous; reject rather than silently choosing one.
    if (seenIds.has(interruptId)) {
      throw A2AError.invalidParams(`Duplicate interrupt response for '${interruptId}'`)
    }

    seenIds.add(interruptId)
    responses.push(new InterruptResponseContent({ interruptId, response: response as JSONValue }))
  }

  if (responses.length === 0) {
    return undefined
  }

  // The agent resumes from interrupt responses alone, so delivering both would mean dropping the
  // conversational content — exactly the silent behaviour the resume path must avoid.
  if (unrelatedParts > 0) {
    throw A2AError.invalidParams('A message carrying interrupt responses must not contain other content parts')
  }

  return responses
}

/**
 * Converts A2A protocol parts to Strands SDK content blocks.
 *
 * Handles text, file (image/video/document), and structured data parts,
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
 * Supports text, image, video, and document blocks. Image and video blocks
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
function _getFileType(mimeType: string | undefined): 'image' | 'video' | 'document' | 'unknown' {
  if (!mimeType) {
    return 'unknown'
  }

  const lower = mimeType.toLowerCase()
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

  const lower = mimeType.toLowerCase()

  // Use the reverse lookup (handles complex types like application/vnd.ms-excel → xls)
  const known = toMediaFormat(lower)
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
