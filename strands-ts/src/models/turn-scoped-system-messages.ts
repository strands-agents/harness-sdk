/**
 * Turn-scoped system messages: injected text sent as a system message the model reads only until a later user
 * message exists. Once cleared, the message stays in the request but renders nothing, so the history before every
 * later assistant turn is sent unchanged.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { Message } from '../types/messages.js'

/**
 * Beta that lets a mid-conversation system message carry `clear_at`.
 *
 * @internal
 */
export const TURN_SCOPED_SYSTEM_BETA = 'mid-conversation-system-clear-at-2026-08-21'

/**
 * A system message cleared at the next user message. The SDK types lack `clear_at`.
 *
 * @internal
 */
export interface TurnScopedSystemMessage extends Anthropic.MessageParam {
  role: 'system'
  content: Anthropic.TextBlockParam[]
  clear_at: 'next_user_message'
}

/**
 * The message's injected text as a turn-scoped system message. Never carries `cache_control`: a cleared message is
 * not part of any cache key.
 *
 * @param message - A message of the conversation
 * @returns The system message, or `undefined` when the message has no injected text
 * @internal
 */
export function turnScopedSystemMessage(message: Message): TurnScopedSystemMessage | undefined {
  const content = message.content.flatMap((block): Anthropic.TextBlockParam[] =>
    block.type === 'injectedBlock' && block.injected.text ? [{ type: 'text', text: block.injected.text }] : []
  )
  if (content.length === 0) return undefined
  return { role: 'system', content, clear_at: 'next_user_message' }
}

/**
 * Whether a request carries a turn-scoped system message, so it needs {@link TURN_SCOPED_SYSTEM_BETA}.
 *
 * @param messages - The messages of the request
 * @returns `true` when any message carries `clear_at`
 * @internal
 */
export function hasTurnScopedSystemMessage(messages: Anthropic.MessageParam[]): boolean {
  return messages.some((message) => 'clear_at' in message)
}
