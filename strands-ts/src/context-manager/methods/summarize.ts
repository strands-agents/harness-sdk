/**
 * What a summary request reads: messages and tool results rendered as content blocks a user turn accepts.
 *
 * The summarize strategy renders the content it summarizes through these, and the retrieval tool renders the
 * messages it hands back the same way, so stored media reaches the model as media rather than as JSON.
 */

import {
  GuardContentBlock,
  JsonBlock,
  Message,
  SummaryBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types/messages.js'
import { AudioBlock, DocumentBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import { CitationsBlock } from '../../types/citations.js'
import type { ContentBlock, ToolResultContent } from '../../types/messages.js'

/**
 * Converts a block to what the summarizer accepts in a user turn: text, images, and documents pass
 * through, other content is rendered as text or a placeholder, and the rest is left out.
 */
function toSummarizerBlocks(block: ContentBlock | ToolResultContent): ContentBlock[] {
  if (block instanceof TextBlock || block instanceof ImageBlock || block instanceof DocumentBlock) return [block]
  if (block instanceof JsonBlock) return [new TextBlock(JSON.stringify(block.json, null, 2))]
  if (block instanceof CitationsBlock) return block.content.map((content) => new TextBlock(content.text))
  if (block instanceof GuardContentBlock) {
    return [new TextBlock(block.text ? block.text.text : '[image omitted]')]
  }
  if (block instanceof SummaryBlock) return [new TextBlock(block.text)]
  if (block instanceof VideoBlock) return [new TextBlock('[video omitted]')]
  if (block instanceof AudioBlock) return [new TextBlock('[audio omitted]')]
  return []
}

/**
 * Converts ToolResultContent[] to ContentBlock[] the summarizer accepts.
 */
export function toolResultToContentBlocks(content: ToolResultContent[]): ContentBlock[] {
  return content.flatMap(toSummarizerBlocks)
}

/**
 * The label the summarizer reads before a tool result's content, such as `[tool result: bash (error)]`.
 *
 * @internal
 */
export function formatToolResultLabel(block: ToolResultBlock, name: string | undefined): string {
  const status = block.status === 'error' ? ' (error)' : ''
  return name ? `[tool result: ${name}${status}]` : `[tool result${status}]`
}

/**
 * Converts a message's content to ContentBlocks for the summarizer, rendering tool calls and tool result
 * labels as text.
 */
function messageToContentBlocks(message: Message, toolNames: Map<string, string>): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (const block of message.content) {
    if (block instanceof ToolResultBlock) {
      blocks.push(
        new TextBlock(formatToolResultLabel(block, toolNames.get(block.toolUseId))),
        ...toolResultToContentBlocks(block.content)
      )
    } else if (block instanceof ToolUseBlock) {
      blocks.push(new TextBlock(`[tool call: ${block.name}] ${JSON.stringify(block.input)}`))
    } else {
      blocks.push(...toSummarizerBlocks(block))
    }
  }
  return blocks
}

/**
 * Flattens a range of messages into a single ContentBlock array for multimodal summarization.
 * Inserts role markers and separators so the summarizer understands message boundaries.
 * Reasoning blocks are left out: they are assistant-only content, and their signatures are bound to the
 * conversation that produced them. Messages with nothing left get no role marker.
 */
export function flattenMessagesToContent(messages: Message[]): ContentBlock[] {
  const toolNames = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof ToolUseBlock) toolNames.set(block.toolUseId, block.name)
    }
  }
  const blocks: ContentBlock[] = []
  for (const message of messages) {
    const content = messageToContentBlocks(message, toolNames)
    if (content.length === 0) continue
    blocks.push(new TextBlock(`\n---\n[${message.role}]`), ...content)
  }
  return blocks
}
