/**
 * Agentic context management: model-driven compression via injected tools.
 *
 * @experimental This module is experimental and may change in future versions.
 */

import { z } from 'zod'
import { Message, TextBlock } from '../../../types/messages.js'
import { tool } from '../../../tools/tool-factory.js'
import { pinMessage, unpinMessage, isPinned } from '../../../conversation-manager/compression/pin-message.js'
import {
  generateSummary,
  adjustSplitPointForToolPairs,
  findValidTrimPoint,
  matchesMessageType,
  type MessageTypeFilter,
} from '../../../conversation-manager/compression/context-compression.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { MiddlewareInputHandler } from '../../../middleware/types.js'
import { DEFAULT_CONTEXT_WINDOW_LIMIT } from '../../../models/defaults.js'

/** Default number of recent messages to preserve verbatim during summarization or truncation. */
const DEFAULT_KEEP_RECENT_MESSAGES = 10
/** Default fraction of oldest messages to fold into the summary. */
const DEFAULT_SUMMARY_RATIO = 0.3
/** Minimum allowed summary ratio (prevents near-zero compression). */
const MIN_SUMMARY_RATIO = 0.1
/** Maximum allowed summary ratio (prevents summarizing nearly everything). */
const MAX_SUMMARY_RATIO = 0.8
/** Minimum conversation length required before any compression operation can run. */
const MIN_MESSAGES_FOR_COMPRESSION = 2

const messageTypeSchema = z
  .enum(['tools', 'messages', 'all'])
  .optional()
  .describe(
    'Filter which messages to target. "tools" targets only tool use/result messages, ' +
      '"messages" targets only non-tool messages, "all" (default) targets everything.'
  )

/**
 * Identify eligible messages in [0, rangeEnd) and return the messages to keep (in original order).
 * The first user message is always preserved to maintain a valid conversation start
 * (Bedrock rejects conversations that don't begin with a user message).
 */
function collectPreserved(
  messages: Message[],
  rangeEnd: number,
  filter: MessageTypeFilter
): { eligible: Message[]; preserved: Message[] } {
  const eligible: Message[] = []
  const preserved: Message[] = []
  let foundFirstUser = false

  for (let i = 0; i < rangeEnd; i++) {
    const msg = messages[i]!
    const isFirstUser = !foundFirstUser && msg.role === 'user'
    if (isFirstUser) foundFirstUser = true

    if (isFirstUser || isPinned(messages, i) || !matchesMessageType(msg, filter)) {
      preserved.push(msg)
    } else {
      eligible.push(msg)
    }
  }

  return { eligible, preserved }
}

export const summarizeContextTool = tool({
  name: 'summarize_context',
  description:
    'Compress the oldest messages in your conversation into a concise summary to free up context space. ' +
    'The summary preserves key information while reducing token usage. ' +
    'Recent messages are kept verbatim. Pinned messages are never summarized away. ' +
    'Often most useful with messageType "messages" to preserve tool results verbatim while condensing discussion.',
  inputSchema: z.object({
    keepRecent: z
      .number()
      .int()
      .min(MIN_MESSAGES_FOR_COMPRESSION)
      .optional()
      .describe(`Minimum number of recent messages to preserve verbatim. Defaults to ${DEFAULT_KEEP_RECENT_MESSAGES}.`),
    summaryRatio: z
      .number()
      .min(MIN_SUMMARY_RATIO)
      .max(MAX_SUMMARY_RATIO)
      .optional()
      .describe(
        `Fraction of the oldest messages to fold into the summary (${MIN_SUMMARY_RATIO}–${MAX_SUMMARY_RATIO}). Defaults to ${DEFAULT_SUMMARY_RATIO}.`
      ),
    messageType: messageTypeSchema,
  }),
  callback: async ({ keepRecent, summaryRatio, messageType }, context) => {
    const agent = context!.agent
    const messages = agent.messages
    const originalMessageCount = messages.length
    const filter: MessageTypeFilter = messageType ?? 'all'
    const preserveRecent = keepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES
    const ratio = Math.max(MIN_SUMMARY_RATIO, Math.min(MAX_SUMMARY_RATIO, summaryRatio ?? DEFAULT_SUMMARY_RATIO))

    let splitPoint = Math.max(1, Math.floor(messages.length * ratio))
    splitPoint = Math.min(splitPoint, messages.length - preserveRecent)
    if (splitPoint <= 0) {
      return `No summarization performed: not enough eligible messages to compress (conversation has ${originalMessageCount} messages, preserving recent ${preserveRecent}).`
    }

    try {
      splitPoint = adjustSplitPointForToolPairs(messages, splitPoint)
    } catch {
      return `No summarization performed: no valid split boundary found from index ${splitPoint} onward (requires a message that isn't mid-tool-call). Try a smaller keepRecent, a larger summaryRatio, or use truncate_context with messageType="tools" instead.`
    }

    const { eligible, preserved } = collectPreserved(messages, splitPoint, filter)

    if (eligible.length === 0) {
      return `No summarization performed: no ${filter === 'all' ? 'eligible' : `"${filter}"`} messages found in range (conversation has ${originalMessageCount} messages).`
    }

    let summaryMessage
    try {
      summaryMessage = await generateSummary(eligible, agent.model)
    } catch (err) {
      return `Summarization failed: ${err instanceof Error ? err.message : 'unknown error'}`
    }

    messages.splice(0, splitPoint, ...preserved, summaryMessage)

    const removed = originalMessageCount - messages.length
    return `Summarized ${eligible.length} ${filter === 'all' ? '' : `"${filter}" `}message(s). Removed ${removed} message(s), ${messages.length} remaining.`
  },
})

export const truncateContextTool = tool({
  name: 'truncate_context',
  description:
    'Drop the oldest messages from your conversation history entirely to free up context space. ' +
    'Use this when older messages are no longer relevant and do not need to be preserved in any form. ' +
    'Pinned messages are always kept. Tool-call pairs are preserved together. ' +
    'Often most useful with messageType "tools" since tool results tend to be large and lose relevance quickly.',
  inputSchema: z.object({
    keepRecent: z
      .number()
      .int()
      .min(MIN_MESSAGES_FOR_COMPRESSION)
      .optional()
      .describe(
        `Number of most recent messages to keep. Everything older (and unpinned) is dropped. Defaults to ${DEFAULT_KEEP_RECENT_MESSAGES}.`
      ),
    messageType: messageTypeSchema,
  }),
  callback: ({ keepRecent, messageType }, context) => {
    const agent = context!.agent
    const messages = agent.messages
    const originalMessageCount = messages.length
    const filter: MessageTypeFilter = messageType ?? 'all'
    const windowSize = keepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES

    if (messages.length <= MIN_MESSAGES_FOR_COMPRESSION || messages.length <= windowSize) {
      return `No messages dropped: conversation only has ${originalMessageCount} messages.`
    }

    const startIndex = messages.length - windowSize
    const trimPoint = findValidTrimPoint(messages, startIndex)

    if (trimPoint >= messages.length) {
      return `No messages dropped: no valid trim boundary exists between index ${startIndex} and ${messages.length - 1} (requires a plain user text message). Try a larger keepRecent or use summarize_context instead.`
    }

    const { eligible, preserved } = collectPreserved(messages, trimPoint, filter)

    if (eligible.length === 0) {
      return `No messages dropped: no ${filter === 'all' ? 'eligible' : `"${filter}"`} messages found in range (conversation has ${originalMessageCount} messages).`
    }

    messages.splice(0, trimPoint, ...preserved)

    const dropped = originalMessageCount - messages.length
    return `Dropped ${dropped} ${filter === 'all' ? '' : `"${filter}" `}message(s). ${messages.length} remaining.`
  },
})

export function createTokenUsageMiddleware(): MiddlewareInputHandler<InvokeModelContext> {
  return async (context: InvokeModelContext): Promise<InvokeModelContext> => {
    const projectedInputTokens = context.projectedInputTokens
    if (projectedInputTokens === undefined) {
      return context
    }

    const contextWindowLimit = context.model.getConfig().contextWindowLimit ?? DEFAULT_CONTEXT_WINDOW_LIMIT
    const remaining = Math.max(0, contextWindowLimit - projectedInputTokens)
    const percentUsed = ((projectedInputTokens / contextWindowLimit) * 100).toFixed(1)

    const statusText =
      `\n\n<context-status>\n` +
      `<used>${projectedInputTokens.toLocaleString()} / ${contextWindowLimit.toLocaleString()} tokens (${percentUsed}%)</used>\n` +
      `<remaining>~${remaining.toLocaleString()} tokens</remaining>\n` +
      `</context-status>`

    const messages = [...context.messages]
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) {
      return context
    }

    messages[messages.length - 1] = new Message({
      role: lastMessage.role,
      content: [...lastMessage.content, new TextBlock(statusText)],
      ...(lastMessage.metadata && { metadata: lastMessage.metadata }),
    })

    // The live token count makes this block per-call, so a cache point must stay ahead of it. Only
    // counted for a user message: elsewhere it would move the cache point off an unrelated message.
    const appended = lastMessage.role === 'user' ? 1 : 0
    return { ...context, messages, dynamicTrailingBlocks: (context.dynamicTrailingBlocks ?? 0) + appended }
  }
}

export const pinContextTool = tool({
  name: 'pin_context',
  description:
    'Pin or unpin messages in the conversation history. ' +
    'Pinned messages are protected from eviction during context reduction (summarize or truncate). ' +
    'Best for critical context like user-established constraints or key facts that must survive compression. ' +
    'Pin sparingly — too many pinned messages limit what can be compressed. ' +
    'Select messages using relative references: pin the current exchange, the last N messages, or specific indices.',
  inputSchema: z.object({
    select: z
      .union([
        z
          .literal('last_turn')
          .describe('Select messages from the current turn (everything since the last user request).'),
        z.number().int().min(1).describe('Select the last N messages from the conversation.'),
        z.array(z.number().int().min(0)).min(1).describe('Select messages at specific zero-based indices.'),
      ])
      .describe(
        'Which messages to target. "last_turn" for the current exchange, a number for the last N messages, or an array of indices.'
      ),
    filter: z
      .enum(['user', 'assistant', 'tools'])
      .optional()
      .describe(
        'Narrow the selection to only messages matching this filter. ' +
          '"user" matches user text messages, "assistant" matches assistant text responses, ' +
          '"tools" matches tool call and tool result messages (pairs are always kept together).'
      ),
    action: z.enum(['pin', 'unpin']).default('pin').describe('Whether to pin or unpin the selected messages.'),
  }),
  callback: ({ select, filter, action }, context) => {
    const messages = context!.agent.messages

    if (messages.length === 0) {
      return 'No messages in the conversation.'
    }

    let candidateIndices: number[]

    if (select === 'last_turn') {
      candidateIndices = []
      let i = messages.length - 1
      // Walk back through the entire turn: assistant response, tool results/calls, and the initiating user message
      while (i >= 0) {
        candidateIndices.push(i)
        // Stop after we hit a user text message (the turn boundary)
        const msg = messages[i]!
        if (msg.role === 'user' && msg.content.some((b) => b.type === 'textBlock')) break
        i--
      }
    } else if (typeof select === 'number') {
      const count = Math.min(select, messages.length)
      candidateIndices = Array.from({ length: count }, (_, k) => messages.length - 1 - k)
    } else {
      candidateIndices = select.filter((i) => i < messages.length)
      if (candidateIndices.length === 0) {
        return `All indices out of range (conversation has ${messages.length} messages).`
      }
    }

    const targetIndices = filter
      ? candidateIndices.filter((i) => {
          const msg = messages[i]!
          if (filter === 'user') return msg.role === 'user' && msg.content.some((b) => b.type === 'textBlock')
          if (filter === 'assistant') return msg.role === 'assistant' && msg.content.some((b) => b.type === 'textBlock')
          if (filter === 'tools')
            return msg.content.some((b) => b.type === 'toolUseBlock' || b.type === 'toolResultBlock')
          return true
        })
      : candidateIndices

    if (targetIndices.length === 0) {
      return 'No matching messages found.'
    }

    for (const index of targetIndices) {
      if (action === 'pin') {
        pinMessage(messages, index)
      } else {
        unpinMessage(messages, index)
      }
    }

    const verb = action === 'pin' ? 'Pinned' : 'Unpinned'
    return `${verb} ${targetIndices.length} message(s).`
  },
})
