/**
 * Keeps lone UTF-16 surrogates out of model requests. Some providers reject a whole request over a single one,
 * whatever produced it: a length-based cut anywhere in the SDK, or a tool that returned malformed text.
 */

import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { Message, ReasoningBlock } from '../types/messages.js'
import type { StreamOptions } from './model.js'

// With the `u` flag a valid pair is a single code point, so only unpaired surrogates match.
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu
const REPLACEMENT_CHARACTER = '\uFFFD'

/**
 * Replaces lone surrogates in a model request with U+FFFD, without modifying the conversation history.
 *
 * Content is walked generically, so new content block types are covered without being registered here.
 *
 * @param messages - The messages about to be sent
 * @param options - The stream options about to be sent
 * @returns The request to send, with well-formed messages and options returned as they are rather than copied
 * @internal
 */
export function wellFormedRequest(
  messages: Message[],
  options?: StreamOptions
): [Message[], StreamOptions | undefined] {
  const sentMessages = mapChanged(messages, wellFormedMessage)
  const sentOptions = wellFormedOptions(options)
  if (sentMessages !== messages || sentOptions !== options) {
    warnOnce(logger, 'replaced lone surrogates in model request')
  }
  return [sentMessages, sentOptions]
}

function mapChanged<T>(values: T[], transform: (value: T) => T): T[] {
  const result = values.map((value) => transform(value))
  return result.every((item, index) => Object.is(item, values[index])) ? values : result
}

function wellFormedMessage(message: Message): Message {
  const content = wellFormed(message.content)
  return content === message.content ? message : new Message({ ...message, content })
}

function wellFormedOptions(options: StreamOptions | undefined): StreamOptions | undefined {
  if (options === undefined) return undefined
  const systemPrompt = wellFormed(options.systemPrompt)
  const toolSpecs = wellFormed(options.toolSpecs)
  if (systemPrompt === options.systemPrompt && toolSpecs === options.toolSpecs) return options
  return {
    ...options,
    ...(systemPrompt !== undefined && { systemPrompt }),
    ...(toolSpecs !== undefined && { toolSpecs }),
  }
}

function wellFormed<T>(value: T): T {
  if (typeof value === 'string') return value.replace(LONE_SURROGATE, REPLACEMENT_CHARACTER) as T
  if (Array.isArray(value)) return mapChanged(value, wellFormed) as T
  return isOpaque(value) ? value : (wellFormedObject(value as object) as T)
}

/** Any edit invalidates signed reasoning, and errors are never sent but can hold cyclic references. */
function isOpaque(value: unknown): boolean {
  return (
    typeof value !== 'object' ||
    value === null ||
    ArrayBuffer.isView(value) ||
    value instanceof Error ||
    (value instanceof ReasoningBlock && value.signature !== undefined)
  )
}

function wellFormedObject<T extends object>(value: T): T {
  const entries = Object.entries(value) as [string, unknown][]
  const result = entries.map(([key, item]) => [wellFormed(key), wellFormed(item)] as const)
  const unchanged = result.every(([key, item], index) => {
    const [originalKey, originalItem] = entries[index]!
    return key === originalKey && Object.is(item, originalItem)
  })
  if (unchanged) return value
  // Descriptors rather than assignment, so that an own `__proto__` key stays data.
  return Object.create(Object.getPrototypeOf(value), Object.getOwnPropertyDescriptors(Object.fromEntries(result))) as T
}
