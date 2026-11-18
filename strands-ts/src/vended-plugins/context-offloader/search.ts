/**
 * Search and formatting utilities for offloaded content.
 *
 * Provides relevance-ranked query search, grep-like pattern matching, and line-range
 * random access over stored text content, with output capped to a character budget.
 */

import { InMemoryStorage } from '../../storage/in-memory-storage.js'

/**
 * Formats a header and a body cut to the last newline that keeps the whole result within
 * {@link maxChars}, appending a truncation message when the body did not fit.
 */
function render(header: string, body: string, maxChars: number, message: string): string {
  const room = Math.max(0, maxChars - header.length - 2)
  if (body.length <= room) return `${header}\n\n${body}`

  // The message is appended after the cut, so it has to come out of the body's share of the budget.
  const limit = Math.max(0, room - message.length - 4)
  const cut = body.lastIndexOf('\n', limit)

  return `${header}\n\n${body.slice(0, cut > 0 ? cut : limit)}\n\n[${message}]`
}

/** Formats line indices with line numbers, `>` prefixes for matches, and `---` separators for gaps. */
function formatLines(lines: string[], indices: number[], matchedSet: Set<number>): string {
  if (indices.length === 0) return ''
  const padWidth = String(indices[indices.length - 1]! + 1).length
  const output: string[] = []
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i]!
    if (i > 0 && idx > indices[i - 1]! + 1) output.push('---')
    const lineNum = String(idx + 1).padStart(padWidth)
    const prefix = matchedSet.has(idx) ? '>' : ' '
    output.push(`${prefix} ${lineNum}| ${lines[idx]}`)
  }
  return output.join('\n')
}

/** The lines a set of windows covers, as the sorted indices and the set {@link formatLines} needs. */
function windowLines(windows: LineWindow[]): { indices: number[]; set: Set<number> } {
  const set = new Set<number>()
  for (const window of windows) {
    for (let line = window.start; line <= window.end; line++) set.add(line)
  }
  return { indices: [...set].sort((left, right) => left - right), set }
}

/**
 * Size and step of the line windows a query ranks. Windows overlap so an answer that straddles a
 * boundary stays whole in at least one of them.
 *
 * The size is the knee of a cost/quality curve: coarser windows rank the answer higher but each one
 * returned costs the caller more of the result budget, and past ~100 lines a single window exceeds
 * the whole budget.
 *
 * @internal
 */
export const WINDOW_LINES = 12
/** @internal */
export const WINDOW_STRIDE = 6

/**
 * A line window of the content. Bounds are 0-indexed and inclusive.
 *
 * @internal
 */
export interface LineWindow {
  start: number
  end: number
}

/**
 * Ranks the line windows of `lines` within `[scopeStart, scopeEnd]` against a query, best-first.
 *
 * Returning `null` means this ranker cannot serve the request, and the caller falls back to
 * {@link rankWindowsInMemory}.
 *
 * @internal
 */
export type WindowRanker = (
  lines: string[],
  query: string,
  scopeStart: number,
  scopeEnd: number
) => Promise<LineWindow[] | null>

/**
 * The windows of `[scopeStart, scopeEnd]`, as the keys a ranker indexes them under.
 *
 * Keys are the window bounds, so a ranker that stores them recovers the bounds from the key alone
 * and never has to keep a side table.
 *
 * @internal
 */
export function windowsOf(lines: string[], scopeStart: number, scopeEnd: number): Map<string, LineWindow> {
  const windows = new Map<string, LineWindow>()
  for (let start = scopeStart; start <= scopeEnd; start += WINDOW_STRIDE) {
    const end = Math.min(start + WINDOW_LINES - 1, scopeEnd)
    windows.set(formatWindowKey({ start, end }), { start, end })
    if (start + WINDOW_LINES > scopeEnd) break
  }
  return windows
}

/** @internal */
export function formatWindowKey(window: LineWindow): string {
  return `${window.start}-${window.end}`
}

/**
 * Parses a window key written by {@link formatWindowKey}.
 *
 * @returns The bounds, or `null` when the key was not written by this module
 * @internal
 */
export function parseWindowKey(key: string): LineWindow | null {
  const match = /^(\d+)-(\d+)$/.exec(key)
  if (!match) return null
  return { start: Number(match[1]), end: Number(match[2]) }
}

/**
 * Ranks the scope's overlapping line windows against a query and formats the best-ranked ones.
 *
 * Ranking is an ordinary storage search over the windows: a search strategy decides which are
 * relevant and in what order, and `maxChars` decides how many fit. Windows are taken in rank order,
 * so the budget drops the least relevant rather than whatever happens to come last in the content.
 */
async function searchByQuery(
  lines: string[],
  query: string,
  scopeStart: number,
  scopeEnd: number,
  maxChars: number,
  scopeLabel: string,
  rank: WindowRanker | undefined
): Promise<string> {
  const label = query.replace(/[\n\r/\]]/g, ' ').slice(0, 50)
  const ranked =
    (await rank?.(lines, query, scopeStart, scopeEnd)) ??
    (await rankWindowsInMemory(lines, query, scopeStart, scopeEnd))
  if (ranked.length === 0) return `No relevant content found for query '${label}'${scopeLabel}.`

  const header = (shown: number): string => {
    const withheld = ranked.length - shown
    const note = withheld > 0 ? `, ${withheld} withheld by max_tokens — raise max_tokens to see them` : ''
    return `[showing ${shown} of ${ranked.length} relevant section${ranked.length > 1 ? 's' : ''} for '${label}'${scopeLabel}${note}]`
  }

  // Reserved against the widest header the body could end up under, so the header never overruns maxChars.
  const room = maxChars - header(1).length - 2
  const taken: LineWindow[] = []
  for (const window of ranked) {
    const candidate = windowLines([...taken, window])
    if (formatLines(lines, candidate.indices, candidate.set).length > room) break
    taken.push(window)
  }

  // A single window wider than the whole budget is still returned, cut by render rather than dropped.
  const shown = windowLines(taken.length > 0 ? taken : [ranked[0]!])
  const body = formatLines(lines, shown.indices, shown.set)
  return render(header(Math.max(taken.length, 1)), body, maxChars, 'output truncated, raise max_tokens')
}

/**
 * Ranks the scope's line windows in an ephemeral store, discarded when the query returns.
 *
 * The fallback ranker: it needs nothing of the caller's storage, so it serves backends that do not
 * implement `search()` and references whose durable window index is not there yet. Costs no durable
 * writes, and reaches only {@link InMemoryStorage}'s built-in {@link KeywordSearchStrategy} — a
 * strategy configured on the caller's own storage cannot apply to a store it was not written for.
 *
 * @internal
 */
export async function rankWindowsInMemory(
  lines: string[],
  query: string,
  scopeStart: number,
  scopeEnd: number
): Promise<LineWindow[]> {
  const storage = new InMemoryStorage()
  const encoder = new TextEncoder()
  const windows = windowsOf(lines, scopeStart, scopeEnd)

  await Promise.all(
    [...windows].map(([key, window]) =>
      storage.write(key, encoder.encode(lines.slice(window.start, window.end + 1).join('\n')))
    )
  )

  const results = (await storage.search?.(query)) ?? []
  return results.flatMap((result) => {
    const window = windows.get(result.key)
    return window ? [window] : []
  })
}

const MAX_PATTERN_LENGTH = 200
// Best-effort heuristic; does not catch all catastrophic patterns (e.g. (.*a){12}$).
const NESTED_QUANTIFIER = /[+*]\s*\)\s*[+*]/

/** Finds lines matching a pattern, expands with context, and formats with truncation. */
function searchByPattern(
  lines: string[],
  pattern: string,
  scopeStart: number,
  scopeEnd: number,
  contextLines: number,
  maxChars: number,
  scopeLabel: string
): string {
  let regex: RegExp
  const truncated = pattern.length > MAX_PATTERN_LENGTH ? pattern.slice(0, MAX_PATTERN_LENGTH) : pattern
  try {
    if (NESTED_QUANTIFIER.test(truncated)) throw new Error('ReDoS')
    regex = new RegExp(truncated)
  } catch {
    regex = new RegExp(truncated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }

  const matchedSet = new Set<number>()
  for (let i = scopeStart; i <= scopeEnd; i++) {
    if (regex.test(lines[i]!)) matchedSet.add(i)
  }

  if (matchedSet.size === 0) {
    return `No matches found for pattern '${pattern}'${scopeLabel} (searched ${scopeEnd - scopeStart + 1} lines).`
  }

  const visible = new Set<number>()
  for (const idx of matchedSet) {
    for (let i = Math.max(scopeStart, idx - contextLines); i <= Math.min(scopeEnd, idx + contextLines); i++) {
      visible.add(i)
    }
  }

  const safePattern = pattern.replace(/[\n\r/\]]/g, ' ').slice(0, 50)
  const header = `[${matchedSet.size} match${matchedSet.size > 1 ? 'es' : ''} for /${safePattern}/${scopeLabel}]`
  const body = formatLines(
    lines,
    [...visible].sort((a, b) => a - b),
    matchedSet
  )
  return render(header, body, maxChars, 'output truncated, narrow your search')
}

/** Formats a contiguous range of lines with truncation. */
function searchByLineRange(lines: string[], start: number, end: number, totalLines: number, maxChars: number): string {
  const indices = Array.from({ length: end - start + 1 }, (_, i) => start + i)
  const header = `[Lines ${start + 1}-${end + 1} of ${totalLines}]`
  const body = formatLines(lines, indices, new Set())
  return render(header, body, maxChars, 'output truncated, narrow your range')
}

const TEXT_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
  'application/xhtml+xml',
])

/** Returns whether the given MIME content type can be searched as text. */
export function isSearchableContent(contentType: string): boolean {
  return contentType.startsWith('text/') || TEXT_APPLICATION_TYPES.has(contentType)
}

/**
 * Search offloaded text content by query, pattern, or line range.
 *
 * @param text - The full text content to search
 * @param input - Search parameters (query, pattern, line_range, context_lines), and optionally the
 *   `rank_windows` ranker a `query` should use in place of the in-memory fallback
 * @param maxChars - Maximum output size in characters; results are truncated beyond this
 * @returns Formatted search results with line numbers, or a message saying the content held no match
 * @throws If `line_range` is inverted or starts past the end of the content. Callers are tools, and the
 *   tool factory turns a throw into an error-status result; returning the message would report the
 *   failure as a success.
 */
export async function searchContent(
  text: string,
  input: {
    query?: string | undefined
    pattern?: string | undefined
    line_range?: { start: number; end: number } | undefined
    context_lines: number
    rank_windows?: WindowRanker | undefined
  },
  maxChars: number
): Promise<string> {
  const lines = text.split('\n')
  const totalLines = lines.length

  if (totalLines === 0 || (totalLines === 1 && lines[0] === '')) {
    return 'Content is empty (0 lines).'
  }

  let scopeStart = 0
  let scopeEnd = totalLines - 1
  if (input.line_range) {
    if (input.line_range.start > input.line_range.end) {
      throw new Error(
        `line_range.start (${input.line_range.start}) must be <= line_range.end (${input.line_range.end}).`
      )
    }
    if (input.line_range.start > totalLines) {
      throw new Error(`line_range.start (${input.line_range.start}) is beyond content length (${totalLines} lines).`)
    }
    scopeStart = input.line_range.start - 1
    scopeEnd = Math.min(input.line_range.end - 1, totalLines - 1)
  }

  const scopeLabel = input.line_range ? ` in lines ${input.line_range.start}-${scopeEnd + 1}` : ''
  if (input.query) {
    return searchByQuery(lines, input.query, scopeStart, scopeEnd, maxChars, scopeLabel, input.rank_windows)
  }
  if (input.pattern) {
    return searchByPattern(lines, input.pattern, scopeStart, scopeEnd, input.context_lines, maxChars, scopeLabel)
  }

  return searchByLineRange(lines, scopeStart, scopeEnd, totalLines, maxChars)
}
