import type { Storage, StorageSearchResult } from '../storage.js'

/**
 * A pluggable search strategy for storage backends.
 *
 * Strategies encapsulate a single approach to searching stored content —
 * keyword/lexical scan, vector similarity, full-text index, etc.
 * Storage backends delegate their `search()` to a strategy, and consumers
 * (memory stores, context offloaders) can override the default.
 *
 * The `SearchQuery` type parameter controls what the strategy accepts. It defaults
 * to `string` (a natural-language query). Strategies that support richer queries
 * (e.g. a pre-computed embedding vector with metadata filters) can widen this type.
 */
export interface SearchStrategy<S extends Storage = Storage, SearchQuery = string> {
  /**
   * Indexes a single entry for future searches.
   *
   * Called on each write so strategies that maintain an index (FTS5, vector,
   * etc.) can update incrementally. Strategies that search on the fly
   * (keyword) or manage their own indexing (QMD) can omit this.
   *
   * @param storage - The storage backend the entry belongs to
   * @param key - The storage key being written
   * @param data - The raw bytes being stored
   */
  index?: (storage: S, key: string, data: Uint8Array) => Promise<void>

  /**
   * Searches content in `storage` matching `query`.
   *
   * @param storage - The storage to search over
   * @param query - A string query or strategy-specific query object
   * @returns Matched keys with relevance scores, ranked best-first
   */
  search(storage: S, query: SearchQuery): Promise<StorageSearchResult[]>
}
