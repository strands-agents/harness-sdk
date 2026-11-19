import { logger } from '../../logging/logger.js'
import type { Storage, StorageSearchResult } from '../storage.js'
import type { SearchStrategy } from './types.js'

/** Split text into a set of lowercased word tokens for keyword matching. */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
  )
}

/** Lexical relevance score: distinct query tokens that appear in the content. Returns 0 when there is no overlap. */
export function tokenOverlapScore(queryTokens: Set<string>, content: string): number {
  let score = 0
  for (const token of tokenize(content)) {
    if (queryTokens.has(token)) score++
  }
  return score
}

export const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'dare',
  'ought',
  'used',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'out',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'because',
  'about',
  'up',
  'its',
  'it',
  'he',
  'she',
  'they',
  'we',
  'you',
  'i',
  'me',
  'him',
  'her',
  'us',
  'them',
  'my',
  'your',
  'his',
  'our',
  'their',
  'this',
  'that',
  'these',
  'those',
  'what',
  'which',
  'who',
  'whom',
  'when',
  'where',
  'why',
  'how',
  'if',
  'while',
  'although',
  'though',
  'unless',
  'until',
  'since',
])

/** Entries read concurrently per batch during a keyword scan, to avoid throttling remote backends such as S3. */
const READ_BATCH_SIZE = 8

/** Lines of context reported on either side of a matching line. */
const CONTEXT_LINES = 5

/** A matching section of an entry's text: 0-indexed inclusive line bounds and its relevance score. */
export interface MatchingSection {
  start: number
  end: number
  score: number
}

/**
 * The sections of `lines` that the query tokens match, best-first: each matching line with
 * `contextLines` of context on either side.
 *
 * Sections are centred on the match rather than cut on a fixed grid, so a match sits in the middle
 * of its section instead of wherever a boundary happened to fall. Where several overlap — adjacent
 * matching lines produce near-identical sections — only the best-scoring is kept, so one passage is
 * not reported as several.
 *
 * @param queryTokens - Query tokens to match, already lowercased and stop-word filtered
 * @param lines - The text to search, split into lines
 * @param contextLines - Lines of context to keep on either side of a matching line
 * @returns The matching sections, best-first
 */
export function matchingSections(
  queryTokens: Set<string>,
  lines: string[],
  contextLines: number = CONTEXT_LINES
): MatchingSection[] {
  const candidates: MatchingSection[] = []
  for (const [line, text] of lines.entries()) {
    if (tokenOverlapScore(queryTokens, text) === 0) continue
    const start = Math.max(0, line - contextLines)
    const end = Math.min(lines.length - 1, line + contextLines)
    // Scored over the whole section, not the matching line: a passage whose query terms are spread
    // across neighbouring lines outranks one line repeating a single term.
    candidates.push({ start, end, score: tokenOverlapScore(queryTokens, lines.slice(start, end + 1).join('\n')) })
  }
  candidates.sort((left, right) => right.score - left.score)

  const sections: MatchingSection[] = []
  for (const candidate of candidates) {
    if (sections.some((section) => candidate.start <= section.end && candidate.end >= section.start)) continue
    sections.push(candidate)
  }
  return sections
}

/** The query tokens of `query`: lowercased, with stop words dropped so they cannot match on their own. */
export function queryTokensOf(query: string): Set<string> {
  return new Set([...tokenize(query)].filter((token) => !STOP_WORDS.has(token)))
}

/** The byte offsets the lines `[start, end]` occupy in `lines` joined by `\n`, `end` exclusive. */
function byteRangeOf(lines: string[], start: number, end: number): { start: number; end: number } {
  const encoder = new TextEncoder()
  const byteLength = (from: number, to: number): number =>
    lines.slice(from, to).reduce((total, line) => total + encoder.encode(line).length + 1, 0)
  const startByte = byteLength(0, start)
  return { start: startByte, end: startByte + byteLength(start, end + 1) - 1 }
}

/** Strip a key's file extension so it is not scored as a word (e.g. `md` on every `.md` entry). */
function stripExtension(key: string): string {
  return key.replace(/(?<=[^/])\.[^./]*$/, '')
}

/** Configuration for {@link KeywordSearchStrategy}. */
export interface KeywordSearchConfig {
  /**
   * Report which part of each entry matched, as `byteRange`, with this many lines of context either
   * side of the match. Omit to report whole entries.
   */
  sectionContextLines?: number
}

/**
 * Keyword search strategy using token-overlap scoring.
 *
 * Tokenizes the query and each stored entry (key without its file extension + content),
 * then scores by the number of distinct query tokens that appear. Stop words in the query
 * (`the`, `is`, `what`, ...) are ignored. Works on any storage backend with `list()` and
 * `read()` — no index or embedding model required. Entries are read in small concurrent
 * batches. Each result includes the bytes read during the scan, so callers do not need to
 * read hits again. Entries whose `read()` throws are skipped and logged at debug level.
 *
 * A result covers the whole entry by default. Construct it with `sectionContextLines` to have each
 * result instead report the best-matching section of its entry as `byteRange`, which is what a
 * consumer wanting the relevant part of a large entry needs — the static {@link search} is the
 * whole-entry default every shipped backend falls back to.
 *
 * @example
 * ```typescript
 * import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * const results = await KeywordSearchStrategy.search(storage, 'dark mode toggle')
 *
 * // Report the matching section of each entry rather than the whole entry
 * const storage = new LocalFileStorage('./docs/', {
 *   searchStrategy: new KeywordSearchStrategy({ sectionContextLines: 5 }),
 * })
 * ```
 */
export class KeywordSearchStrategy implements SearchStrategy {
  private readonly _sectionContextLines: number | undefined

  /**
   * @param config - Optional section reporting. See {@link KeywordSearchConfig}.
   */
  constructor(config?: KeywordSearchConfig) {
    this._sectionContextLines = config?.sectionContextLines
  }

  /**
   * Scores whole entries by token overlap. The default every shipped backend uses when no strategy
   * is configured.
   *
   * @param storage - Storage to scan
   * @param query - Natural-language search query
   * @returns All matches with relevance scores, ranked best-first
   */
  static async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
    return scan(storage, query, undefined)
  }

  /**
   * Scores entries by token overlap, reporting the matching section when configured to.
   *
   * @param storage - Storage to scan
   * @param query - Natural-language search query
   * @returns All matches with relevance scores, ranked best-first
   */
  async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
    return scan(storage, query, this._sectionContextLines)
  }
}

/**
 * Scans every entry, scoring the key (less its extension) together with the content.
 *
 * `sectionContextLines` decides the granularity of a result: whole entry when undefined, otherwise
 * the best-matching section reported as `byteRange`.
 */
async function scan(
  storage: Storage,
  query: string,
  sectionContextLines: number | undefined
): Promise<StorageSearchResult[]> {
  const queryTokens = queryTokensOf(query)
  if (queryTokens.size === 0) return []

  const allKeys = await storage.list('')
  const scored: StorageSearchResult[] = []
  for (let offset = 0; offset < allKeys.length; offset += READ_BATCH_SIZE) {
    const keys = allKeys.slice(offset, offset + READ_BATCH_SIZE)
    const batch = await Promise.all(keys.map((key) => readOrSkip(storage, key)))
    for (const [index, key] of keys.entries()) {
      const bytes = batch[index]
      if (!bytes) continue
      const result = scoreEntry(queryTokens, key, bytes, sectionContextLines)
      if (result) scored.push(result)
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored
}

/** The result for one entry, or `null` when no query token appears in its key or content. */
function scoreEntry(
  queryTokens: Set<string>,
  key: string,
  bytes: Uint8Array,
  sectionContextLines: number | undefined
): StorageSearchResult | null {
  const content = new TextDecoder().decode(bytes)
  const score = tokenOverlapScore(queryTokens, `${stripExtension(key)} ${content}`)
  if (score === 0) return null

  const range = sectionContextLines === undefined ? undefined : bestSection(queryTokens, content, sectionContextLines)
  // Returns the bytes already read so callers (e.g. FileMemoryStore) need not re-read each hit.
  return range ? { key, score, data: bytes, byteRange: range } : { key, score, data: bytes }
}

/**
 * The byte offsets of `content`'s best-matching section, or `undefined` when only the key matched
 * and the content holds nothing to point at.
 */
function bestSection(
  queryTokens: Set<string>,
  content: string,
  contextLines: number
): { start: number; end: number } | undefined {
  const lines = content.split('\n')
  const best = matchingSections(queryTokens, lines, contextLines)[0]
  return best ? byteRangeOf(lines, best.start, best.end) : undefined
}

/** Read `key`, returning `null` when the read throws so one unreadable entry (e.g. a permissions error) cannot fail a search. */
async function readOrSkip(storage: Storage, key: string): Promise<Uint8Array | null> {
  try {
    return await storage.read(key)
  } catch (error) {
    logger.debug(`key=<${key}>, error=<${error}> | skipped unreadable entry`)
    return null
  }
}
