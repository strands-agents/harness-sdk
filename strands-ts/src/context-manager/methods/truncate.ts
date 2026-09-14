/**
 * Truncate reduction method.
 *
 * Replaces content with a preview (head, tail, or head-tail).
 */

import { JsonBlock, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { ToolResultContent } from '../../types/messages.js'

export const TRUNCATED_PREFIX = '[Truncated:'

const DEFAULT_PREVIEW_TOKENS = 1000
const CHARS_PER_TOKEN = 4

/**
 * Configuration for the truncate method.
 *
 * @experimental
 */
export interface TruncateConfig {
  /** Number of tokens to keep as preview text. Defaults to 1,000. */
  previewTokens?: number

  /** Which portion of the text to keep as preview. Defaults to 'headTail'. */
  preview?: 'head' | 'tail' | 'headTail'
}

/**
 * Builds a preview of the given text (head, tail, or head-tail depending on config).
 *
 * @returns The preview string with truncation metadata header, or the original text if already within budget.
 */
export function buildPreview(fullText: string, blockCount: number, config?: TruncateConfig): string {
  const previewTokens =
    typeof config?.previewTokens === 'number' && Number.isFinite(config.previewTokens)
      ? Math.max(0, config.previewTokens)
      : DEFAULT_PREVIEW_TOKENS
  const previewChars = previewTokens * CHARS_PER_TOKEN
  const previewMode = config?.preview ?? 'headTail'
  const totalChars = fullText.length

  if (totalChars <= previewChars) {
    return fullText
  }

  const headShare = { head: 1, tail: 0, headTail: 0.6 }[previewMode]
  const headChars = Math.floor(previewChars * headShare)
  const tailChars = previewChars - headChars
  const head = fullText.slice(0, headChars)
  const tail = tailChars > 0 ? fullText.slice(-tailChars) : ''
  const elided = totalChars - headChars - tailChars
  const marker = `[... ${elided.toLocaleString()} chars elided ...]`
  const preview = [head, marker, tail].filter(Boolean).join('\n\n')

  const result =
    `${TRUNCATED_PREFIX} ${blockCount} ${blockCount === 1 ? 'block' : 'blocks'}, ~${Math.ceil(totalChars / CHARS_PER_TOKEN).toLocaleString()} tokens]\n\n` +
    preview

  if (result.length >= totalChars) {
    return fullText
  }

  return result
}

/**
 * Creates a replacement ToolResultBlock with textual content truncated.
 * Text and JSON blocks are serialized into a preview. Opaque blocks (images, video, documents)
 * are preserved untouched — their payloads cannot be meaningfully previewed as text.
 */
export function truncateToolResultBlock(block: ToolResultBlock, config?: TruncateConfig): ToolResultBlock {
  const textual: string[] = []
  const opaque: ToolResultContent[] = []

  for (const content of block.content) {
    if (content instanceof TextBlock) {
      textual.push(content.text)
    } else if (content instanceof JsonBlock) {
      textual.push(JSON.stringify(content.toJSON()))
    } else {
      opaque.push(content)
    }
  }

  if (textual.length === 0) {
    return block
  }

  const fullText = textual.join('\n')
  const preview = buildPreview(fullText, textual.length, config)

  if (preview === fullText) {
    return block
  }

  return new ToolResultBlock({
    toolUseId: block.toolUseId,
    status: block.status,
    content: [new TextBlock(preview), ...opaque],
  })
}

/**
 * Creates a replacement TextBlock containing the truncated preview.
 * Returns the original block unchanged if preview would not reduce size.
 */
export function truncateTextBlock(block: TextBlock, config?: TruncateConfig): TextBlock {
  const preview = buildPreview(block.text, 1, config)
  if (preview === block.text) {
    return block
  }
  return new TextBlock(preview)
}
