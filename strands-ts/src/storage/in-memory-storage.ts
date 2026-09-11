import type { SearchStrategy } from './search/types.js'
import type { Storage, StorageSearchResult } from './storage.js'

import { EPHEMERAL, namespace, normalizeKey, normalizePrefix } from './storage.js'
import { KeywordSearchStrategy } from './search/keyword.js'

/**
 * In-memory {@link Storage} backend backed by a `Map`.
 *
 * Useful for testing and for serverless environments where disk access is unavailable.
 * Content does not survive process restarts — for persistence use {@link LocalFileStorage}
 * or {@link S3Storage}.
 *
 * This is a plain unbounded store with no eviction. Consumers that need eviction
 * (e.g. the ContextOffloader plugin) manage it themselves.
 *
 * Like the other shipped backends, keys are normalized via {@link normalizeKey}:
 * slash runs are collapsed, leading/trailing slashes are stripped, and `..`
 * segments are rejected.
 *
 * @example
 * ```typescript
 * const storage = new InMemoryStorage()
 * await storage.write('memory/notes.json', new TextEncoder().encode('[]'))
 * const bytes = await storage.read('memory/notes.json')
 * ```
 */
export class InMemoryStorage implements Storage {
  readonly [EPHEMERAL] = true as const
  private readonly _store = new Map<string, Uint8Array>()
  private readonly _searchStrategy: SearchStrategy<InMemoryStorage> | undefined

  /**
   * @param searchStrategy - Optional search strategy. When set, `write()` indexes entries
   *   and `search()` delegates to the strategy instead of the default keyword scan.
   */
  constructor(searchStrategy?: SearchStrategy<InMemoryStorage>) {
    this._searchStrategy = searchStrategy
  }

  /**
   * Stores `data` under `key`, overwriting any existing value.
   * Bytes are copied on write to prevent aliasing with the caller's buffer.
   *
   * @param key - Opaque string key identifying the value
   * @param data - Raw bytes to persist
   * @throws {@link StorageError} if the key is empty or contains `..` segments
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeKey(key)
    this._store.set(normalized, data.slice())
    if (this._searchStrategy) {
      await this._searchStrategy.index?.(this, normalized, data)
    }
  }

  /**
   * Retrieves the bytes previously stored under `key`.
   * Returns a copy to prevent aliasing with the internal buffer.
   *
   * @param key - The key to read
   * @returns The stored bytes, or `null` if no value exists for `key`
   * @throws {@link StorageError} if the key is empty or contains `..` segments
   */
  async read(key: string): Promise<Uint8Array | null> {
    const value = this._store.get(normalizeKey(key))
    if (value === undefined) return null
    return value.slice()
  }

  /**
   * Deletes the value stored under `key`. A no-op if the key does not exist.
   *
   * @param key - The key to delete
   * @throws {@link StorageError} if the key is empty or contains `..` segments
   */
  async delete(key: string): Promise<void> {
    this._store.delete(normalizeKey(key))
  }

  /**
   * Lists the keys whose names begin with `prefix`, sorted lexicographically.
   *
   * @param prefix - Key prefix to match. An empty string matches all keys.
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the prefix contains `..` segments
   */
  async list(prefix: string): Promise<string[]> {
    const normalized = normalizePrefix(prefix)
    const keys: string[] = []
    for (const key of this._store.keys()) {
      if (key.startsWith(normalized)) keys.push(key)
    }
    return keys.sort()
  }

  /** Returns a prefixed view of this storage without mutating the original. */
  namespace(prefix: string): Storage {
    return namespace(this, prefix)
  }

  /**
   * Searches stored content by keyword token-overlap scoring.
   *
   * @param query - Natural-language search query
   * @returns All matches with relevance scores, ranked best-first
   */
  async search(query: string): Promise<StorageSearchResult[]> {
    if (this._searchStrategy) {
      return this._searchStrategy.search(this, query)
    }
    return KeywordSearchStrategy.search(this, query)
  }

  /**
   * Removes all stored entries. Useful for resetting state between tests.
   */
  clear(): void {
    this._store.clear()
  }
}
