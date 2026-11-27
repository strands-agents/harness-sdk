import { logger } from '../../logging/logger.js'
import type { Storage, StorageSearchOptions, StorageSearchResult } from '../storage.js'
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

/** The query tokens of `query`: lowercased, with stop words dropped so they cannot match on their own. */
export function queryTokensOf(query: string): Set<string> {
  return new Set([...tokenize(query)].filter((token) => !STOP_WORDS.has(token)))
}

/** Strip a key's file extension so it is not scored as a word (e.g. `md` on every `.md` entry). */
function stripExtension(key: string): string {
  return key.replace(/(?<=[^/])\.[^./]*$/, '')
}

/**
 * Sections reported for one entry at most, bounding a result for an entry where a common query term
 * matches thousands of lines. A consumer needing more of such an entry wants a narrower query.
 */
const SECTIONS_PER_RESULT = 50

/** Configuration for {@link KeywordSearchStrategy}. */
export interface KeywordSearchConfig {
  /**
   * Report which parts of each entry matched, as `byteRanges`, with this many lines of context
   * either side of each match. Omit to report whole entries.
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
 * result instead report the matching sections of its entry as `byteRanges`, which is what a
 * consumer wanting the relevant parts of a large entry needs — the static {@link search} is the
 * whole-entry default every shipped backend falls back to.
 *
 * @example
 * ```typescript
 * import { KeywordSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * const results = await KeywordSearchStrategy.search(storage, 'dark mode toggle')
 *
 * // Report the matching sections of each entry rather than the whole entry
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
   * @param options - Narrows the scan to a key prefix and a result count
   * @returns All matches with relevance scores, ranked best-first
   */
  static async search(storage: Storage, query: string, options?: StorageSearchOptions): Promise<StorageSearchResult[]> {
    return scan(storage, query, undefined, options)
  }

  /**
   * Scores entries by token overlap, reporting the matching sections when configured to.
   *
   * @param storage - Storage to scan
   * @param query - Natural-language search query
   * @param options - Narrows the scan to a key prefix and a result count
   * @returns All matches with relevance scores, ranked best-first
   */
  async search(storage: Storage, query: string, options?: StorageSearchOptions): Promise<StorageSearchResult[]> {
    return scan(storage, query, this._sectionContextLines, options)
  }
}

/**
 * Scans the entries under `options.prefix`, scoring the key (less its extension) with the content.
 *
 * `sectionContextLines` decides the granularity of a result: whole entry when undefined, otherwise
 * the matching sections reported as `byteRanges`.
 */
async function scan(
  storage: Storage,
  query: string,
  sectionContextLines: number | undefined,
  options: StorageSearchOptions | undefined
): Promise<StorageSearchResult[]> {
  const queryTokens = queryTokensOf(query)
  if (queryTokens.size === 0) return []

  const allKeys = await storage.list(options?.prefix ?? '')
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
  return options?.limit === undefined ? scored : scored.slice(0, options.limit)
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

  const ranges =
    sectionContextLines === undefined
      ? []
      : sectionByteRanges(content, (text) => tokenOverlapScore(queryTokens, text), sectionContextLines)
  // Returns the bytes already read so callers (e.g. FileMemoryStore) need not re-read each hit.
  return ranges.length > 0 ? { key, score, data: bytes, byteRanges: ranges } : { key, score, data: bytes }
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

/**
 * A matching section of an entry's text: 0-indexed inclusive line bounds and its relevance score.
 *
 * @internal
 */
export interface MatchingSection {
  start: number
  end: number
  score: number
}

/**
 * Scores how relevant a piece of text is to a query the scorer already holds. Must return 0 when
 * the text does not match, since that is what rules a line out as the centre of a section.
 *
 * @internal
 */
export type TextScorer = (text: string) => number

/**
 * The sections of `lines` that `score` matches, best-first: each matching line with `contextLines`
 * of context on either side.
 *
 * Sections are centred on the match rather than cut on a fixed grid, so a match sits in the middle
 * of its section instead of wherever a boundary happened to fall. Adjacent matches therefore
 * produce overlapping sections, and a consumer rendering several should show the union of the lines
 * they cover rather than concatenate them.
 *
 * @param lines - The text to search, split into lines
 * @param score - Scores a candidate section; 0 means no match
 * @param contextLines - Lines of context to keep on either side of a matching line
 * @returns The matching sections, best-first
 *
 * @internal
 */
export function matchingSections(lines: string[], score: TextScorer, contextLines: number): MatchingSection[] {
  const candidates: Array<MatchingSection & { match: number }> = []
  for (const [line, text] of lines.entries()) {
    if (score(text) === 0) continue
    const start = Math.max(0, line - contextLines)
    const end = Math.min(lines.length - 1, line + contextLines)
    // Scored over the whole section, not the matching line: a passage whose query terms are spread
    // across neighbouring lines outranks one line repeating a single term.
    candidates.push({ start, end, score: score(lines.slice(start, end + 1).join('\n')), match: line })
  }
  candidates.sort((left, right) => right.score - left.score)

  const sections: MatchingSection[] = []
  for (const candidate of candidates) {
    // Kept unless a better section already shows the matching line itself, so one passage is
    // reported once. Overlapping is not on its own enough to drop a candidate: two matches up to
    // `contextLines` apart have overlapping sections, and the better one need not reach the other's
    // match, which would then be left out of the results altogether.
    if (sections.some((section) => candidate.match >= section.start && candidate.match <= section.end)) continue
    sections.push({ start: candidate.start, end: candidate.end, score: candidate.score })
  }
  return sections
}

/**
 * The byte offsets of `content`'s matching sections, best-first, ready to return as a result's
 * `byteRanges`. At most {@link SECTIONS_PER_RESULT} of them.
 *
 * @param content - The entry's decoded text
 * @param score - Scores a candidate section; 0 means no match
 * @param contextLines - Lines of context to keep on either side of a matching line
 * @returns The byte offsets, each `end` exclusive, empty when nothing in the content matched
 *
 * @internal
 */
export function sectionByteRanges(
  content: string,
  score: TextScorer,
  contextLines: number
): Array<{ start: number; end: number }> {
  const lines = content.split('\n')
  const sections = matchingSections(lines, score, contextLines).slice(0, SECTIONS_PER_RESULT)

  const encoder = new TextEncoder()
  // Each line carries the `\n` that followed it; the last line of the content has none, so the end
  // offset drops the separator counted for it.
  const lineBytes = lines.map((line) => encoder.encode(line).length + 1)
  const offsets = [0]
  for (const bytes of lineBytes) offsets.push(offsets[offsets.length - 1]! + bytes)

  return sections.map((section) => ({ start: offsets[section.start]!, end: offsets[section.end + 1]! - 1 }))
}
