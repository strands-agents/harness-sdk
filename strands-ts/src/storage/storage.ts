import { StorageError } from '../errors.js'

/**
 * Symbol present on namespaced storage views. Constructs use this to detect
 * whether the caller already scoped the storage, skipping the default prefix.
 *
 * @internal
 */
export const NAMESPACED: unique symbol = Symbol.for('strands.storage.namespaced')

/**
 * Symbol marking storage backends whose data does not survive process restarts.
 * Propagated through {@link "namespace"} so namespaced views of ephemeral storage
 * remain detectable.
 *
 * @internal
 */
export const EPHEMERAL: unique symbol = Symbol.for('strands.storage.ephemeral')

/**
 * Validates and normalizes a storage key for path-based backends: collapses
 * runs of `/`, strips leading and trailing `/`, and rejects empty keys and
 * any `..` segment.
 *
 * Used by the shipped path-based backends ({@link InMemoryStorage},
 * {@link LocalFileStorage}, {@link S3Storage}), not required by the
 * {@link Storage} interface itself.
 *
 * @param key - The raw key to normalize
 * @returns The normalized key
 * @throws {@link StorageError} if the key is empty or contains a `..` segment
 */
export function normalizeKey(key: string): string {
  if (key.includes('\\')) {
    throw new StorageError(`Invalid storage key '${key}': backslashes are not allowed`)
  }
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) {
    throw new StorageError('Storage key must not be empty')
  }
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage key '${key}': '..' path segments are not allowed`)
  }
  return segments.join('/')
}

/**
 * Normalizes a list prefix for path-based backends: collapses slash runs,
 * strips leading slashes. Unlike a key, an empty prefix is valid and matches
 * everything.
 *
 * Used by the shipped path-based backends alongside {@link normalizeKey}.
 *
 * @param prefix - The raw prefix to normalize
 * @returns The normalized prefix
 * @throws {@link StorageError} if the prefix contains a `..` segment
 */
export function normalizePrefix(prefix: string): string {
  if (prefix.includes('\\')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': backslashes are not allowed`)
  }
  const parts = prefix.split('/')
  const segments = parts.filter(Boolean)
  if (segments.includes('..')) {
    throw new StorageError(`Invalid storage prefix '${prefix}': '..' path segments are not allowed`)
  }
  const joined = segments.join('/')
  const normalized = parts[parts.length - 1] === '' && joined ? joined + '/' : joined
  return normalized
}

/** A single result from a {@link Storage.search} call. */
export interface StorageSearchResult {
  /** Storage key of the matched item. */
  key: string
  /**
   * Relevance score, normalized so that higher values indicate greater relevance.
   * Backends using distance-based scoring (e.g. vector distance) must invert to
   * similarity before returning results.
   */
  score: number
  /** Stored bytes, present only when the backend includes them. */
  data?: Uint8Array
}

/**
 * A backend for storing and retrieving raw bytes under string keys.
 *
 * The interface is deliberately minimal — four operations over opaque `Uint8Array`
 * values. Keys are opaque strings — implementations must round-trip the bytes
 * they are given unchanged. The shipped backends interpret `/` as a logical
 * separator (collapsing runs, rejecting `..`), but custom backends may apply
 * their own key scheme.
 *
 * The `ListQuery` type parameter controls what `list` accepts. It defaults to
 * `string` (a key prefix), which every backend supports. Implementations may
 * widen it to accept a richer query object (e.g. a DynamoDB partition/sort-key
 * filter) while still accepting a plain string for SDK-internal callers.
 *
 * The `SearchQuery` type parameter controls what `search` accepts. It defaults to
 * `string` (a natural-language query), which every backend interprets in its own way
 * (keyword scan, vector similarity, full-text index). Implementations may widen it to
 * accept a richer query object (e.g. a pre-computed embedding vector with filters).
 *
 * Implement this to add a custom backend; the SDK ships {@link InMemoryStorage},
 * {@link LocalFileStorage}, and {@link S3Storage}.
 */
export interface Storage<ListQuery = string, SearchQuery = string> {
  /**
   * Stores `data` under `key`, overwriting any existing value.
   *
   * @param key - Opaque string key identifying the value
   * @param data - Raw bytes to persist
   * @throws {@link StorageError} if the write fails
   */
  write(key: string, data: Uint8Array): Promise<void>

  /**
   * Retrieves the bytes previously stored under `key`.
   *
   * @param key - The key to read
   * @returns The stored bytes, or `null` if no value exists for `key`
   * @throws {@link StorageError} if the read fails for a reason other than a missing key
   */
  read(key: string): Promise<Uint8Array | null>

  /**
   * Deletes the value stored under `key`. A no-op if the key does not exist.
   *
   * @param key - The key to delete
   * @throws {@link StorageError} if the delete fails
   */
  delete(key: string): Promise<void>

  /**
   * Lists keys matching the given query.
   *
   * When `ListQuery` is `string` (the default), this is a prefix match — returns
   * full keys (not the suffix after the prefix), sorted lexicographically. An empty
   * string lists every key.
   *
   * Implementations may accept richer query objects (e.g. partition + sort-key filters)
   * while still supporting a plain string prefix for SDK-internal callers.
   *
   * @param query - A string prefix or backend-specific query object
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the listing fails
   */
  list(query: ListQuery): Promise<string[]>

  /**
   * Returns a view of this storage with all keys prefixed by `prefix`.
   * The original storage is not mutated.
   *
   * Optional — shipped backends implement this, custom backends may omit it.
   *
   * @param prefix - Prefix to prepend to all keys
   * @returns A Storage view scoped to the given prefix
   */
  namespace?(prefix: string): Storage

  /**
   * Searches stored content by query.
   *
   * When `SearchQuery` is `string` (the default), the query is a natural-language string
   * and how it is interpreted is backend-specific: keyword/lexical scan, full-text index,
   * or vector similarity (the backend embeds the query internally).
   *
   * Implementations may accept richer query objects (e.g. a pre-computed embedding vector
   * with metadata filters) while still accepting a plain string for SDK-internal callers.
   *
   * Optional — when absent, consumers fall back to client-side search.
   *
   * @param query - A string query or backend-specific query object
   * @returns Matched keys with relevance scores, ranked best-first
   */
  search?(query: SearchQuery): Promise<StorageSearchResult[]>
}

/**
 * Returns a {@link Storage} view with all keys prefixed by `prefix`.
 *
 * Composable — calling `namespace()` on the result nests prefixes.
 * Uses {@link normalizePrefix} to sanitize the prefix, so it assumes a
 * `/`-separated key scheme. Backends with a different key scheme should
 * implement their own namespacing.
 *
 * @internal
 * @param storage - The underlying storage to delegate to
 * @param prefix - Prefix to prepend to all keys (normalized as a `/`-separated path)
 * @returns A namespaced Storage view
 */
export function namespace(storage: Storage, prefix: string): Storage {
  const normalized = normalizePrefix(prefix)
  const p = normalized ? `${normalized}/` : ''
  const view: Storage & { [NAMESPACED]: true } = {
    write: (key, data) => storage.write(`${p}${key}`, data),
    read: (key) => storage.read(`${p}${key}`),
    delete: (key) => storage.delete(`${p}${key}`),
    list: (query) => storage.list(`${p}${query}`).then((keys) => keys.map((key) => key.slice(p.length))),
    namespace: (sub) => namespace(storage, `${p}${sub}`),
    [NAMESPACED]: true,
  }
  if (EPHEMERAL in storage) {
    ;(view as unknown as Record<symbol, boolean>)[EPHEMERAL] = true
  }
  if (storage.search) {
    view.search = (query: string): Promise<StorageSearchResult[]> =>
      storage.search!(query).then((results) =>
        results
          .filter((result) => result.key.startsWith(p))
          .map((result) => ({ ...result, key: result.key.slice(p.length) }))
      )
  }
  return view
}

/**
 * Returns a namespaced view of `storage` under `prefix`, unless the storage is already namespaced.
 *
 * Consolidates the common pattern: if already marked with {@link NAMESPACED}, return as-is;
 * otherwise delegate to the storage's own `namespace()` method or the standalone `namespace` helper.
 *
 * @param storage - The storage to scope
 * @param prefix - Prefix to apply
 * @returns A namespaced Storage view (or the original if already namespaced)
 */
export function resolveNamespace(storage: Storage, prefix: string): Storage {
  if (NAMESPACED in storage) return storage
  if (storage.namespace) return storage.namespace(prefix)
  return namespace(storage, prefix)
}
