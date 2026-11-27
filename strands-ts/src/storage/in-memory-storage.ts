import type { SearchStrategy } from './search/types.js'
import type { Storage, StorageSearchResult } from './storage.js'

import { EPHEMERAL, NAMESPACED, normalizeKey, normalizePrefix } from './storage.js'
import { KeywordSearchStrategy } from './search/keyword.js'

/**
 * Configuration for {@link InMemoryStorage}.
 */
export interface InMemoryStorageConfig {
  /**
   * Search strategy. When set, `write()` indexes entries and `search()` delegates to the strategy
   * instead of the default keyword scan.
   */
  searchStrategy?: SearchStrategy<InMemoryStorage>
}

/**
 * Tells a search strategy passed positionally apart from an {@link InMemoryStorageConfig}.
 *
 * @param value - The constructor's argument
 * @returns True if `value` is a search strategy
 */
function isSearchStrategy(
  value: SearchStrategy<InMemoryStorage> | InMemoryStorageConfig | undefined
): value is SearchStrategy<InMemoryStorage> {
  return typeof (value as SearchStrategy<InMemoryStorage> | undefined)?.search === 'function'
}

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
  // Shared with every instance returned by namespace(); each instance only sees keys under its _prefix.
  private _store = new Map<string, Uint8Array>()
  private _prefix = ''
  private readonly _searchStrategy: SearchStrategy<InMemoryStorage> | undefined

  /**
   * @param config - Optional search strategy. See {@link InMemoryStorageConfig}.
   */
  constructor(config?: InMemoryStorageConfig)
  /**
   * @param searchStrategy - Optional search strategy. When set, `write()` indexes entries
   *   and `search()` delegates to the strategy instead of the default keyword scan.
   */
  constructor(searchStrategy?: SearchStrategy<InMemoryStorage>)
  constructor(strategyOrConfig?: SearchStrategy<InMemoryStorage> | InMemoryStorageConfig) {
    this._searchStrategy = isSearchStrategy(strategyOrConfig) ? strategyOrConfig : strategyOrConfig?.searchStrategy
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
    this._store.set(`${this._prefix}${normalized}`, data.slice())
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
    const value = this._store.get(`${this._prefix}${normalizeKey(key)}`)
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
    this._store.delete(`${this._prefix}${normalizeKey(key)}`)
  }

  /**
   * Lists the keys whose names begin with `prefix`, sorted lexicographically.
   *
   * @param prefix - Key prefix to match. An empty string matches all keys.
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the prefix contains `..` segments
   */
  async list(prefix: string): Promise<string[]> {
    const fullPrefix = `${this._prefix}${normalizePrefix(prefix)}`
    const keys: string[] = []
    for (const key of this._store.keys()) {
      if (key.startsWith(fullPrefix)) keys.push(key.slice(this._prefix.length))
    }
    return keys.sort()
  }

  /**
   * Returns an `InMemoryStorage` scoped to `prefix`, sharing this instance's entries and search
   * strategy. The original storage is not mutated.
   *
   * Unlike a generic prefixed view, the scoped instance's `search()` only sees entries under the
   * prefix and scores keys without it, so a query never matches every entry just because it
   * contains a word from the prefix.
   *
   * The shared search strategy receives the scoped instance and keys relative to the prefix.
   * A strategy that keeps its own index must not key it by those relative keys alone; see
   * {@link SearchStrategy.index}.
   *
   * @param prefix - Prefix to prepend to all keys
   * @returns An `InMemoryStorage` scoped to the prefix
   */
  namespace(prefix: string): InMemoryStorage {
    const normalized = normalizePrefix(prefix).replace(/\/$/, '')
    // Copy this instance rather than constructing a new one, so a subclass's overrides and
    // fields carry over to the scoped instance. The copy shares the store and search strategy.
    const scoped: InMemoryStorage = Object.assign(Object.create(Object.getPrototypeOf(this)), this)
    scoped._prefix = normalized ? `${this._prefix}${normalized}/` : this._prefix
    Object.defineProperty(scoped, NAMESPACED, { value: true })
    return scoped
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
   * Removes all stored entries visible to this instance (those under its namespace, or every
   * entry when not namespaced). Useful for resetting state between tests.
   */
  clear(): void {
    if (!this._prefix) {
      this._store.clear()
      return
    }
    for (const key of [...this._store.keys()]) {
      if (key.startsWith(this._prefix)) this._store.delete(key)
    }
  }
}
