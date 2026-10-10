import { Message, TextBlock } from '../../types/messages.js'
import type { Model } from '../../models/model.js'

export const DEFAULT_SUMMARIZATION_PROMPT = `You are a conversation summarizer. Provide a concise summary of the conversation \
history.

Format Requirements:
- You MUST create a structured and concise summary in bullet-point format.
- You MUST NOT respond conversationally.
- You MUST NOT address the user directly.
- You MUST NOT comment on tool availability.

Assumptions:
- You MUST NOT assume tool executions failed unless otherwise stated.

Task:
Your task is to create a structured summary document:
- It MUST contain bullet points with key topics and questions covered
- It MUST contain bullet points for all significant tools executed and their results
- It MUST contain bullet points for any code or technical information shared
- It MUST contain a section of key insights gained
- It MUST format the summary in the third person

Example format:

## Conversation Summary
* Topic 1: Key information
* Topic 2: Key information

## Tools Executed
* Tool X: Result Y`

/**
 * Adjust a split point forward to avoid breaking tool use/result pairs.
 *
 * Walks the split point forward until the message at that position is neither
 * an orphaned toolResult nor a toolUse without an immediately following toolResult.
 *
 * @throws If no valid split point can be found (walked past all messages)
 */
export function adjustSplitPointForToolPairs(messages: Message[], splitPoint: number): number {
  if (splitPoint >= messages.length) {
    return splitPoint
  }

  while (splitPoint < messages.length) {
    const message = messages[splitPoint]!

    const hasToolResult = message.content.some((block) => block.type === 'toolResultBlock')
    if (hasToolResult) {
      splitPoint++
      continue
    }

    const hasToolUse = message.content.some((block) => block.type === 'toolUseBlock')
    if (hasToolUse) {
      const nextMessage = messages[splitPoint + 1]
      const nextHasToolResult = nextMessage?.content.some((block) => block.type === 'toolResultBlock')
      if (!nextHasToolResult) {
        splitPoint++
        continue
      }
    }

    break
  }

  if (splitPoint >= messages.length) {
    throw new Error('Unable to find valid split point for summarization')
  }

  return splitPoint
}

/**
 * Find a valid trim point for truncation starting at `startIndex`.
 *
 * A valid trim point must:
 * 1. Be a user message (required by some models)
 * 2. Not be an orphaned toolResult
 * 3. Not be a toolUse unless its toolResult immediately follows
 *
 * @returns The valid trim index, or `messages.length` if none found
 */
export function findValidTrimPoint(messages: Message[], startIndex: number): number {
  let trimIndex = startIndex

  while (trimIndex < messages.length) {
    const message = messages[trimIndex]
    if (!message) break

    if (message.role !== 'user') {
      trimIndex++
      continue
    }

    const hasToolResult = message.content.some((block) => block.type === 'toolResultBlock')
    if (hasToolResult) {
      trimIndex++
      continue
    }

    const hasToolUse = message.content.some((block) => block.type === 'toolUseBlock')
    if (hasToolUse) {
      const nextMessage = messages[trimIndex + 1]
      const nextHasToolResult = nextMessage && nextMessage.content.some((block) => block.type === 'toolResultBlock')
      if (!nextHasToolResult) {
        trimIndex++
        continue
      }
    }

    break
  }

  return trimIndex
}

/**
 * Generate a summary of the provided messages by calling the model.
 *
 * @returns A user-role message containing the model-generated summary
 * @throws If the model fails to produce a response, or its reply carries no text
 */
export async function generateSummary(
  messagesToSummarize: Message[],
  model: Model,
  systemPrompt?: string
): Promise<Message> {
  const summarizationMessages = [
    ...messagesToSummarize,
    new Message({
      role: 'user',
      content: [new TextBlock('Please summarize this conversation.')],
    }),
  ]

  const stream = model.streamAggregated(summarizationMessages, {
    systemPrompt: systemPrompt ?? DEFAULT_SUMMARIZATION_PROMPT,
  })

  let result: Awaited<ReturnType<typeof stream.next>> | undefined
  for (;;) {
    result = await stream.next()
    if (result.done) break
  }

  if (!result?.done || !result.value) {
    throw new Error('Failed to generate summary: no response from model')
  }

  return asUserSummary(result.value.message)
}

/**
 * Re-role a model reply as the user-role summary message kept in history.
 *
 * Only the reply's text is kept: providers reject reasoning and tool-use blocks in user
 * messages (Bedrock: "User messages cannot contain reasoning content").
 *
 * @param message - The summarizer's reply
 * @returns A user-role message holding the reply's text blocks
 * @throws If the reply carries no text
 * @internal
 */
export function asUserSummary(message: Message): Message {
  const textBlocks: TextBlock[] = []
  for (const block of message.content) {
    if (block.type === 'textBlock') {
      textBlocks.push(new TextBlock(block.text))
    } else if (block.type === 'citationsBlock') {
      // A cited reply carries its text nested inside the citations block; URL citations may carry none.
      for (const cited of block.content) {
        if (cited.text) textBlocks.push(new TextBlock(cited.text))
      }
    }
  }
  if (textBlocks.length === 0) {
    throw new Error('Failed to generate summary: model response contained no text')
  }
  return new Message({ role: 'user', content: textBlocks })
}

export type MessageTypeFilter = 'tools' | 'messages' | 'all'

/**
 * Returns true if the message matches the given type filter.
 * - 'tools': message contains at least one toolUseBlock or toolResultBlock
 * - 'messages': message contains no toolUseBlock or toolResultBlock
 * - 'all': always matches
 */
export function matchesMessageType(message: Message, filter: MessageTypeFilter): boolean {
  if (filter === 'all') return true
  const hasTool = message.content.some((b) => b.type === 'toolUseBlock' || b.type === 'toolResultBlock')
  if (filter === 'tools') return hasTool
  if (filter === 'messages') return !hasTool
  return false
}
