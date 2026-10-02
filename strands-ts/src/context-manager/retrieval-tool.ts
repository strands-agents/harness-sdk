/**
 * Retrieval tool for accessing stashed (L1) content.
 *
 * Registered automatically when the ContextManager has storage configured.
 *
 * @internal
 */

import { z } from 'zod'
import { tool } from '../tools/tool-factory.js'
import { isSearchableContent, searchContent } from '../vended-plugins/context-offloader/search.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../types/media.js'
import type { JSONValue } from '../types/json.js'
import type { Tool } from '../tools/tool.js'
import { Message, ToolUseBlock } from '../types/messages.js'
import type { Stash } from './stash.js'

export const RETRIEVAL_TOOL_NAME = 'retrieve_context'

const DEFAULT_MAX_RESULT_TOKENS = 10_000
const CHARS_PER_TOKEN = 4

const retrievalInputSchema = z.object({
  reference: z.string().describe('The reference key from the offload placeholder.'),
  pattern: z.string().optional().describe('Regex or keyword to grep for. Returns matching lines with context.'),
  line_range: z
    .object({
      start: z.number().int().min(1).describe('First line to return (1-indexed).'),
      end: z.number().int().min(1).describe('Last line to return (1-indexed).'),
    })
    .optional()
    .describe('Return only this span of lines.'),
  context_lines: z.number().int().min(0).optional().describe('Lines of context around each match (default: 5).'),
})

/**
 * Creates the retrieval tool for the given stash.
 *
 * @param stash - The stash instance to retrieve from
 * @param maxResultTokens - Maximum tokens in the retrieval result
 * @returns A Tool that can retrieve stashed content
 *
 * @internal
 */
export function createRetrievalTool(stash: Stash, maxResultTokens?: number): Tool {
  const maxChars = (maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

  return tool({
    name: RETRIEVAL_TOOL_NAME,
    description:
      'Retrieve content that was offloaded from context.\n\n' +
      'When content is offloaded (truncated, dropped, or summarized), the original is ' +
      'persisted and a reference key is left in its place. Use this tool with that ' +
      'reference to access the original content.\n\n' +
      'Options:\n' +
      '  - pattern: regex/keyword to find matching lines with context\n' +
      '  - line_range: { start, end } to read a specific span\n' +
      '  - Without pattern/line_range: returns the full original content\n\n' +
      'Examples:\n' +
      '  { reference: "1_toolu_abc_0", pattern: "error" }\n' +
      '  { reference: "1_toolu_abc_0", line_range: { start: 10, end: 25 } }\n' +
      '  { reference: "1_toolu_abc_0" }',
    inputSchema: retrievalInputSchema,
    callback: async (input) => {
      const result = await stash.retrieve(input.reference)
      if (!result) {
        return `Error: reference not found: ${input.reference}`
      }

      if (!input.pattern && !input.line_range) {
        if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
          const media = restoreMedia(result.data as Record<string, unknown>)
          if (media) return media as unknown as JSONValue
        }
        const serialized = JSON.stringify(result.data)
        if (serialized.length <= maxChars) return result.data as JSONValue
        return `${serialized.slice(0, maxChars)}\n\n[truncated]`
      }

      const text = extractText(result.data)
      if (!text || !isSearchableContent('text/plain')) {
        return `Error: cannot search non-text content. Omit pattern/line_range to retrieve full content.`
      }

      const contextLines = input.context_lines ?? 5

      return searchContent(
        text,
        { pattern: input.pattern, line_range: input.line_range, context_lines: contextLines },
        maxChars
      )
    },
  })
}

/**
 * Tracks toolUseIds from retrieval tool invocations so their results
 * can be excluded from stashing (prevents retrieval loops).
 *
 * @internal
 */
export function trackRetrievalToolUseIds(message: Message, skipSet: Set<string>): void {
  if (message.role !== 'assistant') return
  for (const block of message.content) {
    if (block instanceof ToolUseBlock && block.name === RETRIEVAL_TOOL_NAME) {
      skipSet.add(block.toolUseId)
    }
  }
}

function restoreMedia(data: Record<string, unknown>): ImageBlock | DocumentBlock | VideoBlock | null {
  if ('image' in data) return ImageBlock.fromJSON(data as Parameters<typeof ImageBlock.fromJSON>[0])
  if ('document' in data) return DocumentBlock.fromJSON(data as Parameters<typeof DocumentBlock.fromJSON>[0])
  if ('video' in data) return VideoBlock.fromJSON(data as Parameters<typeof VideoBlock.fromJSON>[0])
  return null
}

function extractText(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    if ('text' in data && typeof (data as Record<string, unknown>).text === 'string') {
      return (data as Record<string, unknown>).text as string
    }
    if ('json' in data) {
      return JSON.stringify((data as Record<string, unknown>).json, null, 2)
    }
  }
  return null
}
