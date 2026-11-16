/**
 * Shared media formatting helpers for OpenAI adapters.
 *
 * @internal
 */

import type { DocumentBlock, ImageBlock } from '../../types/media.js'
import { encodeBase64 } from '../../types/media.js'
import { toMimeType } from '../../mime.js'
import { logger } from '../../logging/logger.js'

/**
 * Logs a warning for each key in `params` that is managed by the provider and
 * would be overwritten at request time. Fires at config time so callers notice
 * before sending a request.
 */
export function warnManagedParams(params: Record<string, unknown> | undefined, managed: ReadonlySet<string>): void {
  if (!params) return
  for (const key of Object.keys(params)) {
    if (managed.has(key)) {
      logger.warn(
        `params_key=<${key}> | '${key}' is managed by the provider and will be ignored in params — use the dedicated config property instead`
      )
    }
  }
}

/**
 * Builds a `data:<mime>;base64,<payload>` URL for an image block.
 * Returns `undefined` for unsupported source types.
 */
export function formatImageDataUrl(imageBlock: ImageBlock): string | undefined {
  if (imageBlock.source.type === 'imageSourceBytes') {
    const base64 = encodeBase64(imageBlock.source.bytes)
    const mimeType = toMimeType(imageBlock.format) || `image/${imageBlock.format}`
    return `data:${mimeType};base64,${base64}`
  }
  if (imageBlock.source.type === 'imageSourceUrl') {
    return imageBlock.source.url
  }
  return undefined
}

/**
 * Returns the document's name, appending its format as the extension when the name has no known one.
 * OpenAI-compatible endpoints such as Bedrock Mantle reject a `filename` that has no extension.
 * A name that already carries a known extension is kept as-is, even if it differs from `format`,
 * because the endpoint treats the file by that extension.
 */
export function formatDocumentFilename(docBlock: DocumentBlock): string {
  const dot = docBlock.name.lastIndexOf('.')
  if (dot !== -1 && toMimeType(docBlock.name.slice(dot + 1))) return docBlock.name
  return `${docBlock.name}.${docBlock.format}`
}
