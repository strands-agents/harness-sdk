import type { Storage, StorageSearchResult } from '../storage.js'

/** A function that produces an embedding vector from text. Provider-agnostic. */
export type Embedder = (text: string) => Promise<number[]>

/**
 * A pluggable search strategy for storage backends.
 *
 * Strategies encapsulate a single approach to searching stored content —
 * keyword/lexical scan, vector similarity, full-text index, etc.
 * Storage backends delegate their `search()` to a strategy, and consumers
 * (memory stores, context offloaders) can override the default.
 *
 * The `S` type parameter constrains which storage backends the strategy works with.
 * Defaults to `Storage` (any backend). Strategies that depend on backend-specific
 * features (e.g. {@link QmdSearchStrategy} needs `baseDir`) can narrow this to
 * require a specific implementation.
 *
 * The `SearchQuery` type parameter controls what the strategy accepts. It defaults
 * to `string` (a natural-language query). Strategies that support richer queries
 * (e.g. a pre-computed embedding vector with metadata filters) can widen this type.
 */
export interface SearchStrategy<S extends Storage = Storage, SearchQuery = string> {
  /**
   * Searches content in `storage` matching `query`.
   *
   * @param storage - The storage to search over
   * @param query - A string query or strategy-specific query object
   * @returns Matched keys with relevance scores, ranked best-first
   */
  search(storage: S, query: SearchQuery): Promise<StorageSearchResult[]>

  /**
   * Indexes content for future searches. Called by storage on every `write()`.
   *
   * Optional — strategies that maintain an external index (vector stores, full-text
   * engines) implement this to keep the index in sync with storage writes. Strategies
   * that scan storage on demand (e.g. keyword search) omit it.
   *
   * @param storage - The storage the content was written to
   * @param key - The normalized key the content was written under
   * @param data - The raw bytes that were written
   */
  index?(storage: S, key: string, data: Uint8Array): Promise<void>
}
