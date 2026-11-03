/**
 * Anthropic on-demand compaction: the beta, and how a compaction block is stored and sent back.
 *
 * A compaction block is stored as a {@link TextBlock} whose `text` is the block's `content` and whose
 * `providerData.data` holds every other field the API returned, unchanged. Sending it back restores the block
 * exactly as returned.
 *
 * @internal
 */

import type Anthropic from '@anthropic-ai/sdk'
import { TextBlock } from '../types/messages.js'
import type { ContentBlock, Message } from '../types/messages.js'

/**
 * Beta that enables on-demand compaction and compaction blocks in later requests.
 *
 * @internal
 */
export const COMPACTION_BETA = 'compact-2026-09-04'

/**
 * `providerData.provider` of a block only Anthropic can read.
 *
 * @internal
 */
export const ANTHROPIC_PROVIDER = 'anthropic'

/**
 * Formats a block that holds Anthropic provider data as the block the API returned.
 *
 * @internal
 * @param block - A text block
 * @returns The returned block with its `content` restored from `text`, or undefined for any other text block
 */
export function formatNativeBlock(block: TextBlock): Anthropic.ContentBlockParam | undefined {
  if (block.providerData?.provider !== ANTHROPIC_PROVIDER) return undefined
  return { ...(block.providerData.data as object), content: block.text } as unknown as Anthropic.ContentBlockParam
}

/**
 * Whether any message carries a block only Anthropic can read, so the request needs {@link COMPACTION_BETA}.
 *
 * @internal
 * @param messages - The messages of a request
 * @returns True when a block with Anthropic provider data is present
 */
export function carriesNativeBlock(messages: Message[]): boolean {
  return messages.some((message) => message.content.some(isNativeBlock))
}

function isNativeBlock(block: ContentBlock): boolean {
  return block instanceof TextBlock && block.providerData?.provider === ANTHROPIC_PROVIDER
}

/**
 * Stores a returned compaction block: `content` as the text, every other field as opaque provider data.
 *
 * @internal
 * @param block - A `compaction` block from a response
 * @returns The stored block, or undefined when the block holds no summary
 */
export function storeCompactionBlock(block: Record<string, unknown>): TextBlock | undefined {
  const { content, ...data } = block
  if (typeof content !== 'string' || content.length === 0) return undefined
  return new TextBlock(content, { providerData: { provider: ANTHROPIC_PROVIDER, data } })
}
