/**
 * Finding the part of an entry that matched, for a strategy that reports sections rather than
 * whole entries.
 *
 * Independent of how relevance is scored: the caller passes a scorer, so a token-overlap scan and a
 * BM25 index can both use this to turn a hit into the span of it worth reading. Entry ranking and
 * section selection are separate scorers by necessity — an external index ranks documents but
 * cannot score an arbitrary substring of one, so it ranks with BM25 and selects sections with a
 * local pass, which is how full-text engines produce highlights.
 *
 * A strategy that chunks at index time (a vector store) gets spans from its own chunks and does not
 * need this.
 */

/** Lines of context reported on either side of a matching line. */
const CONTEXT_LINES = 5

/** A matching section of an entry's text: 0-indexed inclusive line bounds and its relevance score. */
export interface MatchingSection {
  start: number
  end: number
  score: number
}

/**
 * Scores how relevant a piece of text is to a query the scorer already holds. Must return 0 when
 * the text does not match, since that is what rules a line out as the centre of a section.
 */
export type TextScorer = (text: string) => number

/**
 * The sections of `lines` that `score` matches, best-first: each matching line with `contextLines`
 * of context on either side.
 *
 * Sections are centred on the match rather than cut on a fixed grid, so a match sits in the middle
 * of its section instead of wherever a boundary happened to fall. Where several overlap — adjacent
 * matching lines produce near-identical sections — only the best-scoring is kept, so one passage is
 * not reported as several.
 *
 * @param lines - The text to search, split into lines
 * @param score - Scores a candidate section; 0 means no match
 * @param contextLines - Lines of context to keep on either side of a matching line
 * @returns The matching sections, best-first
 */
export function matchingSections(
  lines: string[],
  score: TextScorer,
  contextLines: number = CONTEXT_LINES
): MatchingSection[] {
  const candidates: MatchingSection[] = []
  for (const [line, text] of lines.entries()) {
    if (score(text) === 0) continue
    const start = Math.max(0, line - contextLines)
    const end = Math.min(lines.length - 1, line + contextLines)
    // Scored over the whole section, not the matching line: a passage whose query terms are spread
    // across neighbouring lines outranks one line repeating a single term.
    candidates.push({ start, end, score: score(lines.slice(start, end + 1).join('\n')) })
  }
  candidates.sort((left, right) => right.score - left.score)

  const sections: MatchingSection[] = []
  for (const candidate of candidates) {
    if (sections.some((section) => candidate.start <= section.end && candidate.end >= section.start)) continue
    sections.push(candidate)
  }
  return sections
}

/**
 * The byte offsets of `content`'s best-matching section, ready to return as a result's `byteRange`.
 *
 * @param content - The entry's decoded text
 * @param score - Scores a candidate section; 0 means no match
 * @param contextLines - Lines of context to keep on either side of a matching line
 * @returns The byte offsets, `end` exclusive, or `undefined` when nothing in the content matched
 */
export function bestSectionRange(
  content: string,
  score: TextScorer,
  contextLines: number = CONTEXT_LINES
): { start: number; end: number } | undefined {
  const lines = content.split('\n')
  const best = matchingSections(lines, score, contextLines)[0]
  if (!best) return undefined

  const encoder = new TextEncoder()
  // Each line carries the `\n` that followed it; the last line of the content has none, so the end
  // offset drops the separator counted for it.
  const byteLength = (from: number, to: number): number =>
    lines.slice(from, to).reduce((total, line) => total + encoder.encode(line).length + 1, 0)
  const start = byteLength(0, best.start)
  return { start, end: start + byteLength(best.start, best.end + 1) - 1 }
}
