/**
 * Durable conversation checkpoints for the Responses API.
 *
 * @internal
 */
import type { ResponseInputItem } from 'openai/resources/responses/responses'
import { Message } from '../../types/messages.js'
import type { CacheConfig } from '../model.js'

type CacheablePart = { type: string; prompt_cache_breakpoint?: { mode: 'explicit' } }

/** Input content types that accept `prompt_cache_breakpoint` (gpt-5.6+). */
const CACHEABLE_INPUT_TYPES = new Set(['input_text', 'input_image', 'input_file'])
type FormatMessages = (messages: Message[]) => ResponseInputItem[]

/**
 * Responses models with content-level cache checkpoints. Unknown model aliases retain their
 * provider's implicit caching behavior rather than receiving potentially unsupported fields.
 *
 * @internal
 */
export function supportsResponsesCheckpoints(modelId: string): boolean {
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(modelId)
  if (!version) return false
  const major = Number(version[1])
  return major > 5 || (major === 5 && Number(version[2] ?? 0) >= 6)
}

/** Whether to place durable message checkpoints for this request. @internal */
export function cacheResponsesMessages(modelId: string, cacheConfig: CacheConfig | undefined): boolean {
  return (
    cacheConfig !== undefined &&
    (cacheConfig.strategy === undefined || cacheConfig.strategy === 'auto') &&
    cacheConfig.messagesTTL !== false &&
    supportsResponsesCheckpoints(modelId)
  )
}

/**
 * Format stable history before per-call injected content, retaining recent checkpoint locations
 * for the next request's cache lookup. Markers live only in the wire request, not agent history.
 *
 * @internal
 */
export function formatCacheableResponsesMessages(
  messages: Message[],
  dynamicTrailingBlocks: number,
  format: FormatMessages
): { input: ResponseInputItem[]; hasCheckpoints: boolean } {
  const input: ResponseInputItem[] = []
  const checkpoints: CacheablePart[] = []
  for (const [index, message] of messages.entries()) {
    const dynamicCount = index === messages.length - 1 && message.role === 'user' ? dynamicTrailingBlocks : 0
    const boundary = Math.max(0, message.content.length - dynamicCount)
    const stable = new Message({ role: message.role, content: message.content.slice(0, boundary) })
    const items = format([stable])
    normalizeToolOutputs(items)
    if (message.role === 'user') {
      const checkpoint = lastCacheablePart(items)
      if (checkpoint) checkpoints.push(checkpoint)
    }
    input.push(...items)
    if (dynamicCount > 0) {
      const dynamic = format([new Message({ role: 'user', content: message.content.slice(boundary) })])
      normalizeToolOutputs(dynamic)
      if (items.length > 0) appendDynamicContent(input, dynamic)
      else input.push(...dynamic)
    }
  }
  // Retain earlier lookup boundaries, not just the latest write location. The provider bounds
  // lookup and writes separately: sending more markers does not create a write at every marker.
  for (const checkpoint of checkpoints) checkpoint.prompt_cache_breakpoint = { mode: 'explicit' }
  return { input, hasCheckpoints: checkpoints.length > 0 }
}

/** Use the same tool-output representation on both current and replayed turns. */
function normalizeToolOutputs(items: ResponseInputItem[]): void {
  for (const item of items) {
    // An empty result stays a string: an empty text block would be a meaningless checkpoint.
    if (item.type === 'function_call_output' && typeof item.output === 'string' && item.output !== '') {
      item.output = [{ type: 'input_text', text: item.output }]
    }
  }
}

/** Find the final input content block (text, image, or file) in a formatted durable message. */
function lastCacheablePart(items: ResponseInputItem[]): CacheablePart | undefined {
  for (const item of [...items].reverse()) {
    const content = item.type === 'function_call_output' ? item.output : 'content' in item ? item.content : undefined
    if (!Array.isArray(content)) continue
    for (const block of [...content].reverse()) {
      if (CACHEABLE_INPUT_TYPES.has(block.type)) return block as CacheablePart
    }
  }
  return undefined
}

/** Keep normal user text together, but place injected text after completed tool outputs on the wire. */
function appendDynamicContent(input: ResponseInputItem[], dynamic: ResponseInputItem[]): void {
  const last = input.at(-1)
  const injected = dynamic[0]
  if (
    last &&
    'role' in last &&
    last.role === 'user' &&
    Array.isArray(last.content) &&
    injected &&
    'role' in injected &&
    injected.role === 'user' &&
    'content' in injected &&
    Array.isArray(injected.content)
  ) {
    last.content.push(...injected.content)
    input.push(...dynamic.slice(1))
    return
  }
  input.push(...dynamic)
}
