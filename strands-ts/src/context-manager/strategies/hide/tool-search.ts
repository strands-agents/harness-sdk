/**
 * Tool search — ranks in-memory tool specs by relevance to a query.
 *
 * Tool specs are a per-call projection of the registry, never stored, so this is a separate
 * contract from the storage package's `SearchStrategy`, which ranks keys held by a `Storage`.
 * The result shape mirrors `StorageSearchResult` with `name` in place of `key`.
 *
 * @internal
 */

import { STOP_WORDS, tokenize } from '../../../storage/search/keyword.js'
import type { ToolSpec } from '../../../tools/types.js'

/**
 * A ranked match from a {@link ToolSearchStrategy}.
 *
 * @internal
 */
export interface ToolSearchResult {
  /** Name of the matched tool spec. */
  name: string
  /** Relevance score; higher is more relevant. */
  score: number
}

/**
 * Ranks tool specs by relevance to a query. Implementations may be lexical, an LLM judge, or an
 * adapter over a persistent index; `Hide` keeps the first `limit` results that name a candidate.
 *
 * @internal
 */
export interface ToolSearchStrategy {
  /**
   * Ranks `candidates` against `query`.
   *
   * @param query - The latest user text
   * @param candidates - The specs eligible for selection, in catalog order
   * @param limit - How many results the caller will use
   * @returns Matches ranked best-first, at most `limit`
   */
  search(query: string, candidates: readonly ToolSpec[], limit: number): Promise<ToolSearchResult[]>
}

/**
 * Keyword tool search over the query's content terms. A term that appears in the tool name counts
 * as one point; a term that appears only in the description or input properties counts as a
 * fraction of a point, so a name hit always ranks above any number of description hits and
 * description hits break ties among equal name hits. Remaining ties keep candidate order.
 *
 * Names are split on `_ - . : /` and camelCase so `get_weather` matches "weather"; plurals are
 * normalized so "refunds" matches `refund_invoice`. No external dependencies.
 *
 * @internal
 */
export const KeywordToolSearch: ToolSearchStrategy = {
  async search(query: string, candidates: readonly ToolSpec[], limit: number): Promise<ToolSearchResult[]> {
    // Raw terms meet descriptions, which are not split ("DynamoDB"); split terms meet names.
    const queryTerms = contentTerms(`${query} ${splitIdentifier(query)}`)
    if (queryTerms.size === 0) return []
    const bodyWeight = 1 / (queryTerms.size + 1)

    const scored: ToolSearchResult[] = []
    for (const spec of candidates) {
      const nameHits = overlap(queryTerms, splitIdentifier(spec.name))
      const bodyHits = overlap(queryTerms, bodyText(spec))
      const score = nameHits + bodyHits * bodyWeight
      if (score > 0) scored.push({ name: spec.name, score })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.slice(0, limit)
  },
}

/**
 * The content terms of a text: lowercased tokens that are not stop words or single characters,
 * with plurals normalized.
 *
 * @param text - Raw text
 * @returns Content terms
 * @internal
 */
export function contentTerms(text: string): Set<string> {
  const terms = new Set<string>()
  for (const token of tokenize(text)) {
    if (token.length > 1 && !STOP_WORDS.has(token)) terms.add(singular(token))
  }
  return terms
}

/** Count of `text`'s distinct content terms that appear in `queryTerms`. */
function overlap(queryTerms: ReadonlySet<string>, text: string): number {
  let hits = 0
  for (const term of contentTerms(text)) {
    if (queryTerms.has(term)) hits++
  }
  return hits
}

/**
 * Plural normalization: `refunds` → `refund`, `invoices` → `invoice`, `searches` → `search`,
 * `processes` → `process`, `queries` → `query`. Only the plural suffix is touched; `-ing`/`-ed` are left alone because
 * stripping them without restoring a dropped `e` (`pricing` vs `price`) creates more misses than
 * it fixes. Full stemming belongs to a richer search strategy.
 */
function singular(token: string): string {
  if (token.length <= 3 || !token.endsWith('s') || token.endsWith('ss')) return token
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (/(?:ch|sh|ss|x|z)es$/.test(token)) return token.slice(0, -2)
  return token.slice(0, -1)
}

/**
 * Breaks identifiers into words: `get_weather`, `get-weather`, `getWeather`, `parseHTTPBody`,
 * `mcp::get.weather`. Descriptions are left whole, since splitting prose turns "GitHub" into
 * "git hub" and a lowercase "github" in the query would then miss it.
 */
function splitIdentifier(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.:/]+/g, ' ')
}

/** Description plus input-property names and descriptions. */
function bodyText(spec: ToolSpec): string {
  const properties = spec.inputSchema?.properties
  if (!properties || typeof properties !== 'object') return spec.description
  const propertyText = Object.entries(properties)
    .map(([key, value]) => {
      const description = value && typeof value === 'object' && 'description' in value ? String(value.description) : ''
      return `${splitIdentifier(key)} ${description}`
    })
    .join(' ')
  return `${spec.description} ${propertyText}`
}
