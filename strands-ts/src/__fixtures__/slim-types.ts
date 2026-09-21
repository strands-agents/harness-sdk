/**
 * Utility types for testing that strip methods from classes.
 * Allows tests to use plain objects without needing to construct class instances.
 */

import type { Message, ToolResultBlock, TextBlock, CachePointBlock, GuardContentBlock } from '../types/messages.js'
import type { MockMessageContentBlock } from '../testing/types.js'

/**
 * Strips the toJSON method from a type, allowing plain objects to be used in tests.
 * This is useful when you want to pass plain object literals where class instances are expected.
 *
 * @example
 * ```typescript
 * const messages: NoJSON<Message>[] = [
 *   { type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hello' }] }
 * ]
 * ```
 */
export type NoJSON<T> = Omit<T, 'toJSON'>

/**
 * Plain content block without toJSON method - preserves discriminated union.
 */
export type PlainContentBlock = MockMessageContentBlock

/**
 * Plain system content block without toJSON method.
 */
export type PlainSystemContentBlock = NoJSON<TextBlock> | NoJSON<CachePointBlock> | NoJSON<GuardContentBlock>

/**
 * Plain tool result block without toJSON method.
 */
export type PlainToolResultBlock = NoJSON<ToolResultBlock>

/**
 * Recursively strips toJSON from a type and its nested content.
 * Use this for Message which contains ContentBlock arrays.
 */
export type PlainMessage = NoJSON<Message> & { content: PlainContentBlock[] }

/**
 * Type assertion helper for using plain message objects where Message[] is expected.
 * Use this when calling model.stream() with plain objects in tests.
 *
 * @example
 * ```typescript
 * const messages = [
 *   { type: 'message', role: 'user', content: [{ type: 'textBlock', text: 'Hello' }] }
 * ] as PlainMessage[] as Message[]
 * ```
 */
export type { Message }
