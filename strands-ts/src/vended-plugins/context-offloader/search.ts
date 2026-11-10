/**
 * Search and formatting utilities for offloaded content.
 *
 * Provides grep-like pattern matching and line-range random access over stored
 * text content, with output capped to a character budget.
 */

/** Cuts output at the last newline before {@link maxChars} and appends a truncation message. */
function truncate(output: string, maxChars: number, message: string): string {
  if (output.length <= maxChars) return output

  const cut = output.lastIndexOf('\n', maxChars)
  const sliceEnd = cut > 0 ? cut : maxChars

  return output.slice(0, sliceEnd) + `\n\n[${message}]`
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
  const truncatedBody = truncate(body, maxChars, 'output truncated, narrow your search')
  return `${header}\n\n${truncatedBody}`
}

/** Formats a contiguous range of lines with truncation. */
function searchByLineRange(lines: string[], start: number, end: number, totalLines: number, maxChars: number): string {
  const indices = Array.from({ length: end - start + 1 }, (_, i) => start + i)
  const header = `[Lines ${start + 1}-${end + 1} of ${totalLines}]`
  const body = formatLines(lines, indices, new Set())
  const truncatedBody = truncate(body, maxChars, 'output truncated, narrow your range')
  return `${header}\n\n${truncatedBody}`
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
 * Search offloaded text content by pattern or line range.
 *
 * @param text - The full text content to search
 * @param input - Search parameters (pattern, line_range, context_lines)
 * @param maxChars - Maximum output size in characters; results are truncated beyond this
 * @returns Formatted search results with line numbers, or an error/empty message
 */
export function searchContent(
  text: string,
  input: {
    pattern?: string | undefined
    line_range?: { start: number; end: number } | undefined
    context_lines: number
  },
  maxChars: number
): string {
  const lines = text.split('\n')
  const totalLines = lines.length

  if (totalLines === 0 || (totalLines === 1 && lines[0] === '')) {
    return 'Content is empty (0 lines).'
  }

  let scopeStart = 0
  let scopeEnd = totalLines - 1
  if (input.line_range) {
    if (input.line_range.start > input.line_range.end) {
      return `Error: line_range.start (${input.line_range.start}) must be <= line_range.end (${input.line_range.end}).`
    }
    if (input.line_range.start > totalLines) {
      return `Error: line_range.start (${input.line_range.start}) is beyond content length (${totalLines} lines).`
    }
    scopeStart = input.line_range.start - 1
    scopeEnd = Math.min(input.line_range.end - 1, totalLines - 1)
  }

  if (input.pattern) {
    const scopeLabel = input.line_range ? ` in lines ${input.line_range.start}-${scopeEnd + 1}` : ''
    return searchByPattern(lines, input.pattern, scopeStart, scopeEnd, input.context_lines, maxChars, scopeLabel)
  }

  return searchByLineRange(lines, scopeStart, scopeEnd, totalLines, maxChars)
}
