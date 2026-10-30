/**
 * The contract `Hide` uses to rank tool specs, and the shapes it exchanges with a strategy.
 *
 * Tool specs are a per-call projection of the registry, never stored, so this is a separate
 * contract from the storage package's `SearchStrategy`, which ranks keys held by a `Storage`.
 * The result shape mirrors `StorageSearchResult` with `name` in place of `key`.
 *
 * @internal
 */

import type { ToolSpec } from '../../../../tools/types.js'

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
 * Options for a {@link ToolSearchStrategy} search.
 *
 * @internal
 */
export interface ToolSearchOptions {
  /** How many results the caller will use. When omitted, every ranked match is returned. */
  limit?: number
}

/**
 * Ranks tool specs by relevance to a query. Implementations may be lexical, an LLM judge, or an
 * adapter over a persistent index; `Hide` keeps the first results that name a candidate, up to
 * the `limit` it passes.
 *
 * @internal
 */
export interface ToolSearchStrategy {
  /**
   * Ranks `candidates` against `query`.
   *
   * @param query - `Hide`'s projection of the conversation; today the latest user text. Strategies
   *   that need more context get it through a richer projection, not a wider signature.
   * @param candidates - The specs eligible for selection, in catalog order
   * @param options - Search options; `Hide` always passes `limit`
   * @returns Matches ranked best-first, at most `options.limit` when given
   */
  search(query: string, candidates: readonly ToolSpec[], options?: ToolSearchOptions): Promise<ToolSearchResult[]>
}
