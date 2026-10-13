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
   * Whether the strategy reads or writes the host filesystem directly instead of going through
   * the storage (e.g. an index file next to the storage directory). A sandboxed
   * {@link LocalFileStorage} rejects such strategies, because their view of the data would
   * not match the sandbox's. Omit or set `false` for strategies that only use the storage's
   * own methods.
   */
  readonly requiresHostFs?: boolean

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

/**
 * A {@link SearchStrategy} that only uses the storage's own methods, so it works when the storage
 * is bound to a sandbox. A sandboxed {@link LocalFileStorage} only accepts strategies of this type.
 *
 * Strategies that leave `requiresHostFs` out (or set it to `false`) already satisfy this type.
 * Declare `readonly requiresHostFs = true` on a strategy that touches the host filesystem so the
 * type checker rejects it alongside a sandbox.
 */
export interface SandboxSafeSearchStrategy<S extends Storage = Storage, SearchQuery = string> extends SearchStrategy<
  S,
  SearchQuery
> {
  readonly requiresHostFs?: false
}
