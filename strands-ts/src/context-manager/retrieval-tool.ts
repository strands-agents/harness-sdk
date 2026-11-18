/**
 * Retrieval tool for accessing archived (L1) content.
 *
 * Registered automatically when the ContextManager has storage configured.
 *
 * @internal
 */

import { z } from 'zod'
import { tool } from '../tools/tool-factory.js'
import { searchContent } from '../vended-plugins/context-offloader/search.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../types/media.js'
import { CitationsBlock } from '../types/citations.js'
import {
  contentBlockFromData,
  JsonBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  toolResultContentFromData,
} from '../types/messages.js'
import type {
  ContentBlock,
  ContentBlockData,
  MessageData,
  ToolResultContent,
  ToolResultContentData,
} from '../types/messages.js'
import type { JSONValue } from '../types/json.js'
import type { Tool } from '../tools/tool.js'
import type { Archive } from './archive.js'
import { flattenMessagesToContent } from './content-rendering.js'
import { isOffloaded } from './placeholder.js'

/** What an archive entry holds: one stored block, or the messages removed together. */
type ArchiveEntry = ToolResultContent | ContentBlock | Message[]

export const RETRIEVAL_TOOL_NAME = 'retrieve_context'

const DEFAULT_MAX_RESULT_TOKENS = 10_000
const CHARS_PER_TOKEN = 4

/**
 * Default budget for a `query`, which is what sizes its result: the search strategy decides the order
 * of the sections and this decides how many of them fit. Lower than the whole-result ceiling because
 * accuracy over the retrieval corpora stops improving here, and the header tells the model when
 * raising `max_tokens` would show it more.
 */
const DEFAULT_QUERY_TOKENS = 2_400

const retrievalInputSchema = z.object({
  reference: z.string().describe('The <id> from the "[ref: <id>]" at the end of the offload placeholder.'),
  query: z
    .string()
    .optional()
    .describe('Question to answer from the content. Returns the sections most relevant to it, ranked.'),
  pattern: z.string().optional().describe('Regex or keyword to grep for. Returns matching lines with context.'),
  line_range: z
    .object({
      start: z.number().int().min(1).describe('First line to return (1-indexed).'),
      end: z.number().int().min(1).describe('Last line to return (1-indexed).'),
    })
    .optional()
    .describe('Return only this span of lines.'),
  context_lines: z.number().int().min(0).optional().describe('Lines of context around each match (default: 5).'),
  max_tokens: z
    .number()
    .int()
    .min(100)
    .optional()
    .describe('Cap on the result size. Raise it when the result says sections were withheld.'),
})

/**
 * Creates the retrieval tool for the given archive.
 *
 * @param archive - The archive instance to retrieve from
 * @param maxResultTokens - Maximum tokens in the retrieval result
 * @returns A Tool that can retrieve archived content
 *
 * @internal
 */
export function createRetrievalTool(archive: Archive, maxResultTokens?: number): Tool {
  const maxChars = (maxResultTokens ?? DEFAULT_MAX_RESULT_TOKENS) * CHARS_PER_TOKEN

  return tool({
    name: RETRIEVAL_TOOL_NAME,
    description:
      'Retrieve content that was offloaded from context.\n\n' +
      'When content is offloaded (truncated, dropped, or summarized), the original is ' +
      'persisted and the placeholder left in its place ends in "[ref: <id>]". Pass that ' +
      '<id> as the reference to access the original content.\n\n' +
      'Options:\n' +
      '  - query: a question, to get the sections that answer it. Prefer this when you do not ' +
      'already know a string that appears in the content.\n' +
      '  - pattern: regex/keyword to find matching lines with context\n' +
      '  - line_range: { start, end } to read a specific span\n' +
      '  - Without query/pattern/line_range: returns the full original content\n\n' +
      'Examples:\n' +
      '  { reference: "toolu_abc", query: "why did the checkout requests fail" }\n' +
      '  { reference: "toolu_abc", pattern: "error" }\n' +
      '  { reference: "toolu_abc", line_range: { start: 10, end: 25 } }\n' +
      '  { reference: "toolu_abc" }',
    inputSchema: retrievalInputSchema,
    callback: (input) => retrieve(archive, input, maxChars),
  })
}

/** Resolves the reference, then returns the slice of it the input asked for, within `maxChars`. */
async function retrieve(
  archive: Archive,
  input: z.infer<typeof retrievalInputSchema>,
  maxChars: number
): Promise<JSONValue> {
  const reference = input.reference.trim()
  // Actionable rather than terminal: the content is there, the search arguments are what cannot apply.
  if (input.query && input.pattern) {
    throw new Error('pass either query or pattern, not both. Use query for a question, pattern for a literal string.')
  }

  const entries = await resolveReference(archive, reference)
  // Thrown, not returned: the tool factory gives a returned string success status, and a model that
  // reads "Error" under success retries and then invents the content. A missing reference is terminal
  // only once the id was passed as the placeholder lists it; content offloaded again never comes back.
  if (entries.length === 0) {
    throw new Error(
      `reference not found: ${reference}. Pass only the <id> from the placeholder's "[ref: <id>]". ` +
        'If that is what you passed, the content is unavailable — do not retry.'
    )
  }
  if (entries.some(isOffloaded)) {
    throw new Error(`original content for reference ${reference} is no longer available — do not retry.`)
  }

  const fallback = input.query ? Math.min(DEFAULT_QUERY_TOKENS * CHARS_PER_TOKEN, maxChars) : maxChars
  const budget = input.max_tokens ? Math.min(input.max_tokens * CHARS_PER_TOKEN, maxChars) : fallback
  if (!input.query && !input.pattern && !input.line_range) return fullContent(entries, budget)
  return searchEntries(archive, reference, entries, input, budget)
}

/**
 * The stored content itself. Tool result items, and removed messages rendered as role markers and their
 * content, are returned as blocks, so media reaches the model as media and only their text is cut to
 * `maxChars`; anything else is returned in its JSON form.
 */
function fullContent(entries: ArchiveEntry[], maxChars: number): JSONValue {
  const blocks = entries.flatMap((entry) => (Array.isArray(entry) ? flattenMessagesToContent(entry) : [entry]))
  if (blocks.every(isToolResultContent)) {
    const clipped = clipText(blocks, maxChars)
    return (clipped.length === 1 ? clipped[0]! : clipped) as unknown as JSONValue
  }
  const data = entries.length === 1 ? entryToData(entries[0]!) : entries.map(entryToData)
  const serialized = JSON.stringify(data)
  return serialized.length <= maxChars ? data : `${serialized.slice(0, maxChars)}\n\n[truncated]`
}

function isToolResultContent(entry: ArchiveEntry): entry is ToolResultContent {
  return (
    entry instanceof TextBlock ||
    entry instanceof JsonBlock ||
    entry instanceof ImageBlock ||
    entry instanceof VideoBlock ||
    entry instanceof DocumentBlock
  )
}

/**
 * Cuts the items' text to `maxChars` in total, in order: the item that exhausts the budget is cut and
 * marked, later textual items are left out, and media passes through untouched.
 */
function clipText(blocks: ToolResultContent[], maxChars: number): ToolResultContent[] {
  let budget = maxChars
  const kept: ToolResultContent[] = []
  for (const block of blocks) {
    const text = blockText(block)
    if (text === null) {
      kept.push(block)
    } else if (text.length <= budget) {
      budget -= text.length
      kept.push(block)
    } else if (budget > 0) {
      kept.push(new TextBlock(`${text.slice(0, budget)}\n\n[truncated]`))
      budget = 0
    }
  }
  return kept
}

/** The lines of the entries' text that answer `query`, match `pattern`, or fall in `line_range`. */
function searchEntries(
  archive: Archive,
  reference: string,
  entries: ArchiveEntry[],
  input: z.infer<typeof retrievalInputSchema>,
  maxChars: number
): ReturnType<typeof searchContent> {
  const text = joinText(entries.map(entryText))
  // Actionable rather than terminal: the content is there, the search arguments are what cannot apply.
  if (!text) throw new Error('cannot search non-text content. Omit query/pattern/line_range to retrieve full content.')
  return searchContent(
    text,
    {
      query: input.query,
      pattern: input.pattern,
      line_range: input.line_range,
      context_lines: input.context_lines ?? 5,
      // Ranks on the configured storage, so the strategy set on it does the ranking. Returns null on
      // a backend without search(), and searchContent then ranks in an ephemeral store instead.
      rank_windows: (lines, query, scopeStart, scopeEnd) =>
        archive.rankWindows(reference, lines, query, scopeStart, scopeEnd),
    },
    maxChars
  )
}

/**
 * Resolves a reference to its stored entries. An id (a tool result's `toolUseId`, or
 * `removed-<trackingId>`) resolves to every entry keyed under it, in index order; otherwise the
 * reference is an exact key and resolves to that entry. Ids take precedence because a placeholder
 * references a tool result by id, and an id may itself end like a key (`tool_1`).
 */
async function resolveReference(archive: Archive, reference: string): Promise<ArchiveEntry[]> {
  const keys = await archive.keysOf(reference)
  if (keys.length > 0) return entriesFrom(await Promise.all(keys.map((key) => archive.retrieve(key))))

  const exact = await archive.retrieve(reference)
  return exact ? entriesFrom([exact]) : []
}

function entriesFrom(results: ReadonlyArray<{ data: unknown } | null>): ArchiveEntry[] {
  return results.flatMap((result) => {
    const entry = result && archiveEntryFromData(result.data)
    return entry ? [entry] : []
  })
}

/** Deserializes an archive entry with the same readers that load it from a session. */
function archiveEntryFromData(data: unknown): ArchiveEntry | null {
  if (Array.isArray(data)) return data.map((message) => Message.fromMessageData(message as MessageData))
  if (data === null || typeof data !== 'object') return null
  try {
    return toolResultContentFromData(data as ToolResultContentData)
  } catch {
    try {
      return contentBlockFromData(data as ContentBlockData)
    } catch {
      return null
    }
  }
}

function entryToData(entry: ArchiveEntry): JSONValue {
  const data = Array.isArray(entry) ? entry.map((message) => message.toJSON()) : entry.toJSON()
  return data as unknown as JSONValue
}

/** The searchable text of an entry: its text, JSON, and tool-result text, in order. */
function entryText(entry: ArchiveEntry): string | null {
  if (Array.isArray(entry)) return joinText(entry.flatMap((message) => message.content.map(blockText)))
  return blockText(entry)
}

function blockText(block: ContentBlock | ToolResultContent): string | null {
  if (block instanceof TextBlock) return block.text
  if (block instanceof JsonBlock) return JSON.stringify(block.json, null, 2)
  if (block instanceof ToolResultBlock) return joinText(block.content.map(blockText))
  if (block instanceof CitationsBlock) return joinText(block.content.map((cited) => cited.text ?? null))
  return null
}

function joinText(parts: ReadonlyArray<string | null>): string | null {
  const present = parts.filter((part): part is string => part !== null)
  return present.length > 0 ? present.join('\n') : null
}
