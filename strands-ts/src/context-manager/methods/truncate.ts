/**
 * Truncate reduction method.
 *
 * Replaces content with a preview (head, tail, or head-tail).
 */

import { JsonBlock, TextBlock, ToolResultBlock } from '../../types/messages.js'
import type { ToolResultContent } from '../../types/messages.js'
import { splitLargeStrings } from '../split.js'

export const TRUNCATED_PREFIX = '[Truncated:'

export const DEFAULT_PREVIEW_TOKENS = 1000
export const CHARS_PER_TOKEN = 4
/**
 * Strings at least this long are stashed as their own raw-text entry; shorter ones fit in a default preview anyway.
 * The preview splits at the same constant so every field ref it shows exists in the stash.
 */
export const SPLIT_THRESHOLD_CHARS = DEFAULT_PREVIEW_TOKENS * CHARS_PER_TOKEN

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
function previewCharsFor(config?: TruncateConfig): number {
  const previewTokens =
    typeof config?.previewTokens === 'number' && Number.isFinite(config.previewTokens)
      ? Math.max(0, config.previewTokens)
      : DEFAULT_PREVIEW_TOKENS
  return previewTokens * CHARS_PER_TOKEN
}

export function buildPreview(fullText: string, blockCount: number, config?: TruncateConfig): string {
  const previewChars = previewCharsFor(config)
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
  const marker = `[... ${elided.toLocaleString('en-US')} chars elided ...]`
  const preview = [head, marker, tail].filter(Boolean).join('\n\n')

  const result =
    `${TRUNCATED_PREFIX} ${blockCount} ${blockCount === 1 ? 'block' : 'blocks'}, ~${Math.ceil(totalChars / CHARS_PER_TOKEN).toLocaleString('en-US')} tokens]\n\n` +
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
 * With `split`, large strings are previewed after the blocks, under the field refs the stash stores them at.
 */
export function truncateToolResultBlock(
  block: ToolResultBlock,
  config?: TruncateConfig,
  split = false
): ToolResultBlock {
  const textual: string[] = []
  const bodies: string[] = []
  const opaque: ToolResultContent[] = []

  for (let index = 0; index < block.content.length; index++) {
    let content = block.content[index]!
    let fields: Record<string, string> = {}
    if (split) {
      ;({ parent: content, fields } = splitLargeStrings(content, `${block.toolUseId}_${index}`, SPLIT_THRESHOLD_CHARS))
    }
    if (content instanceof TextBlock) {
      textual.push(content.text)
    } else if (content instanceof JsonBlock) {
      textual.push(JSON.stringify(content.toJSON()))
    } else {
      opaque.push(content)
    }
    bodies.push(...Object.entries(fields).map(([ref, text]) => `[${ref}]\n${text}`))
  }

  if (textual.length === 0) {
    return block
  }

  const fullText = [...textual, ...bodies].join('\n')
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
