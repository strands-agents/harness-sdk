/**
 * Relevance-ranked query search over a stashed entry's text.
 *
 * A query is answered by ranking the content's overlapping line windows and returning the
 * best-ranked ones that fit the budget. Ranking is an ordinary storage search — a `SearchStrategy`
 * decides which windows are relevant and in what order — so there is no scoring code here.
 *
 * @internal
 */

import { InMemoryStorage } from '../storage/in-memory-storage.js'

/**
 * Size and step of the line windows a query ranks. Windows overlap so an answer that straddles a
 * boundary stays whole in at least one of them.
 *
 * The size is the knee of a cost/quality curve: coarser windows rank the answer higher but each one
 * returned costs the caller more of the result budget, and past ~100 lines a single window exceeds
 * the whole budget.
 */
const WINDOW_LINES = 12
const WINDOW_STRIDE = 6

/** A line window of the content. Bounds are 0-indexed and inclusive. */
interface LineWindow {
  start: number
  end: number
}

/**
 * Answers `query` with the content's best-ranked line windows, within `maxChars`.
 *
 * `maxChars` decides how many windows fit, and they are taken in rank order, so the budget drops
 * the least relevant rather than whatever happens to come last in the content.
 *
 * @param text - The full text to search
 * @param query - Natural-language query
 * @param lineRange - Span to rank within, 1-indexed and inclusive; omit to rank the whole content
 * @param maxChars - Maximum output size in characters
 * @returns The ranked sections with line numbers, or a message saying nothing was relevant
 * @throws If `lineRange` is inverted or starts past the end of the content. Mirrors `searchContent`'s
 *   contract, which the pattern path still resolves for itself. The caller is a tool, and the tool
 *   factory turns a throw into an error-status result; returning the message would report the failure
 *   as a success.
 * @internal
 */
export async function searchByQuery(
  text: string,
  query: string,
  lineRange: { start: number; end: number } | undefined,
  maxChars: number
): Promise<string> {
  const lines = text.split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return 'Content is empty (0 lines).'

  const scope = resolveScope(lines.length, lineRange)
  const scopeLabel = lineRange ? ` in lines ${lineRange.start}-${scope.end + 1}` : ''
  const label = query.replace(/[\n\r/\]]/g, ' ').slice(0, 50)

  const ranked = await rankWindows(lines, query, scope.start, scope.end)
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
    if (formatWindows(lines, [...taken, window]).length > room) break
    taken.push(window)
  }

  // A single window wider than the whole budget is still returned, cut by render rather than dropped.
  const shown = taken.length > 0 ? taken : [ranked[0]!]
  return render(header(shown.length), formatWindows(lines, shown), maxChars, 'output truncated, raise max_tokens')
}

/**
 * Ranks the scope's line windows in an ephemeral store, discarded when the query returns.
 *
 * The store is scratch space rather than the caller's storage: ranking needs each candidate span to
 * be a separately addressable entry, and building that out of the caller's storage would mean
 * writing derived data into it to answer a read. The cost is that a search strategy configured on
 * the caller's storage does not apply here, since it was never written for this store.
 */
async function rankWindows(
  lines: string[],
  query: string,
  scopeStart: number,
  scopeEnd: number
): Promise<LineWindow[]> {
  const storage = new InMemoryStorage()
  const encoder = new TextEncoder()
  const windows = windowsOf(scopeStart, scopeEnd)

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

/** The windows of `[scopeStart, scopeEnd]`, keyed by their bounds. */
function windowsOf(scopeStart: number, scopeEnd: number): Map<string, LineWindow> {
  const windows = new Map<string, LineWindow>()
  for (let start = scopeStart; start <= scopeEnd; start += WINDOW_STRIDE) {
    const end = Math.min(start + WINDOW_LINES - 1, scopeEnd)
    windows.set(`${start}-${end}`, { start, end })
    if (start + WINDOW_LINES > scopeEnd) break
  }
  return windows
}

/** The 0-indexed inclusive bounds a query ranks within. */
function resolveScope(
  totalLines: number,
  lineRange: { start: number; end: number } | undefined
): { start: number; end: number } {
  if (!lineRange) return { start: 0, end: totalLines - 1 }
  if (lineRange.start > lineRange.end) {
    throw new Error(`line_range.start (${lineRange.start}) must be <= line_range.end (${lineRange.end}).`)
  }
  if (lineRange.start > totalLines) {
    throw new Error(`line_range.start (${lineRange.start}) is beyond content length (${totalLines} lines).`)
  }
  return { start: lineRange.start - 1, end: Math.min(lineRange.end - 1, totalLines - 1) }
}

/**
 * Formats the lines the windows cover with 1-indexed line numbers, `---` between non-contiguous
 * windows, and the same leading gutter the pattern path uses for an unmarked line.
 */
function formatWindows(lines: string[], windows: LineWindow[]): string {
  const covered = new Set<number>()
  for (const window of windows) {
    for (let line = window.start; line <= window.end; line++) covered.add(line)
  }
  const indices = [...covered].sort((left, right) => left - right)
  if (indices.length === 0) return ''

  const padWidth = String(indices[indices.length - 1]! + 1).length
  const output: string[] = []
  for (const [position, index] of indices.entries()) {
    if (position > 0 && index > indices[position - 1]! + 1) output.push('---')
    output.push(`  ${String(index + 1).padStart(padWidth)}| ${lines[index]}`)
  }
  return output.join('\n')
}

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
