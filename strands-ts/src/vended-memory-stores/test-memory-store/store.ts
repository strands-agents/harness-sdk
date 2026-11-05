import { v7 as uuidv7 } from 'uuid'

import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { LocalFileStorage } from '../../storage/local-file-storage.js'
import type { MemoryEntry, MemoryStore, MemoryStoreConfig, SearchOptions } from '../../memory/types.js'
import type { ExtractionConfig } from '../../memory/extraction/types.js'
import type { JSONValue } from '../../types/json.js'
import type { Storage } from '../../storage/storage.js'
import { tokenize, tokenOverlapScore } from '../../storage/search/keyword.js'

/**
 * Metadata key holding the token-overlap relevance score on a search result.
 */
const DEFAULT_MAX_SEARCH_RESULTS = 10
const RELEVANCE_SCORE_KEY = '_relevanceScore'

/**
 * A stored memory, as it is persisted on disk.
 */
interface TestMemoryRecord {
  id: string
  content: string
  metadata?: Record<string, JSONValue>
  createdAt: string
}

/**
 * Configuration for {@link TestMemoryStore}.
 *
 * The store persists to disk by default so the memory records persist across restarts. Set
 * {@link persist} to `false` for an ephemeral, single session store (useful for e.g. testing).
 */
export interface TestMemoryStoreConfig extends MemoryStoreConfig {
  /**
   * Whether to persist entries to disk so they survive across sessions.
   * - `true` (default): writes are flushed to {@link path} (or the default location).
   * - `false`: entries live only in memory and are lost when the process exits.
   *
   * @defaultValue true
   */
  persist?: boolean
  /**
   * Full path to the JSON file backing this store. Defaults to
   * `~/.strands/memory/<sanitized-store-name>.json`. Ignored when {@link persist} is `false`.
   */
  path?: string
}

/** Result returned by {@link TestMemoryStore.add}. */
export interface TestMemoryAddResult {
  /** The id of the stored record. */
  id: string
}

/**
 * Sanitizes a store name into a safe single-path-segment filename.
 * Guards the default-path branch against a name that would escape the memory directory.
 * Ensures cross-SDK consistent sanitization.
 */
function sanitizeName(name: string): string {
  return name
    .replace(/\.\./g, '_')
    .replace(/[/\\]/g, '_')
    .replace(/[^\w\-.]/g, '_')
}

/**
 * A zero-infrastructure store {@link MemoryStore} that keeps entries in memory and by default
 * persists them to a local JSON file. Use for prototyping and testing.
 *
 * Recall is lexical: results are ranked by how many query tokens overlap an entry's content, with
 * the most recent entry winning ties. This is keyword matching, not the semantic search a managed
 * vector store (e.g. {@link BedrockKnowledgeBaseStore}) provides.
 *
 * Each {@link add} rewrites the whole file, so this fits modest volumes, not fit for high volume
 * production workloads. Use a managed store like {@link BedrockKnowledgeBaseStore} for that.
 *
 * Persistence is backed by the unified `Storage` interface internally: `persist: true` (the default)
 * uses a `LocalFileStorage`, `persist: false` an ephemeral `InMemoryStorage`. Unlike other
 * subsystems (SessionManager, ContextOffloader), this store does not accept an external `Storage`
 * or resolve from the agent-level `storage` — it manages its own backend via `persist` and `path`.
 *
 * The on-disk format is shared with the Python SDK's `TestMemoryStore`: records use the same
 * camelCase keys (`id`, `content`, `metadata`, `createdAt`) and the same timestamp shape, so a
 * backing file written by either SDK can be read by the other.
 *
 * @example
 * ```typescript
 * import { TestMemoryStore } from '@strands-agents/sdk/vended-memory-stores/test-memory-store'
 *
 * // Persists to ~/.strands/memory/notes.json by default.
 * const store = new TestMemoryStore({ name: 'notes' })
 *
 * const { id } = await store.add('User prefers dark mode')
 * const results = await store.search('what theme does the user like?')
 * ```
 */
export class TestMemoryStore implements MemoryStore {
  readonly name: string
  readonly description?: string
  readonly maxSearchResults?: number
  readonly writable: boolean
  readonly extraction?: boolean | ExtractionConfig

  private readonly _persist: boolean
  /** Explicit `path` override from config, if any; the default path is resolved lazily in {@link _resolve}. */
  private readonly _explicitPath: string | undefined
  /**
   * The resolved `(storage, key)` pair, memoized on first use. Resolution is lazy because the
   * default-path branch needs `node:os`/`node:path`, and deferring those dynamic imports keeps the
   * module safe to bundle for the browser and construction free of filesystem I/O.
   */
  private _resolved: { storage: Storage; key: string } | undefined
  /** Serializes writes so concurrent `add`s never interleave the read-modify-write cycle. */
  private _writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: TestMemoryStoreConfig) {
    const { name, description, maxSearchResults, writable, extraction, persist, path } = options

    if (!name.trim()) {
      throw new Error('TestMemoryStore: name must not be empty.')
    }
    this.name = name
    if (description !== undefined) this.description = description
    if (maxSearchResults !== undefined) {
      if (maxSearchResults < 1) {
        throw new Error('TestMemoryStore: maxSearchResults must be at least 1.')
      }
      this.maxSearchResults = maxSearchResults
    }
    // A local store is writable by default.
    this.writable = writable ?? true
    if (extraction !== undefined) this.extraction = extraction

    if (path !== undefined && !path.trim()) {
      throw new Error('TestMemoryStore: path must not be empty.')
    }
    this._persist = persist ?? true
    this._explicitPath = path
  }

  /**
   * Searches stored entries for those whose content overlaps the query, ranked by token overlap with
   * the most recent entry winning ties.
   *
   * @param query - The search query text
   * @param options - Optional search configuration
   * @returns Matching memory entries ordered by relevance. Each entry's `metadata` includes a
   *   `_relevanceScore` key (the token-overlap count). An empty or token-less query returns
   *   no results.
   * @throws An `Error` if `options.maxSearchResults` is less than 1, or if the backing blob is
   *   malformed (invalid JSON, not an array, or a record missing required string fields).
   * @throws {@link StorageError} if the backend read fails.
   */
  async search(query: string, options?: SearchOptions): Promise<MemoryEntry[]> {
    if (options?.maxSearchResults !== undefined && options.maxSearchResults < 1) {
      throw new Error('TestMemoryStore: maxSearchResults must be at least 1.')
    }
    const limit = options?.maxSearchResults || this.maxSearchResults || DEFAULT_MAX_SEARCH_RESULTS

    const queryTokens = tokenize(query)
    if (queryTokens.size === 0) return []

    const records = await this._read()

    const scored: Array<{ record: TestMemoryRecord; score: number }> = []
    for (const record of records) {
      const score = tokenOverlapScore(queryTokens, record.content)
      if (score > 0) scored.push({ record, score })
    }

    scored.sort(
      (left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt)
    )

    return scored.slice(0, limit).map(({ record, score }) => ({
      content: record.content,
      metadata: { ...record.metadata, [RELEVANCE_SCORE_KEY]: score },
    }))
  }

  /**
   * Adds `content` (with optional `metadata`) to the store. Identical content is deduplicated: a
   * repeat write returns the existing record's id without storing a second copy, so the at-least-once
   * retries that extraction may perform never accumulate duplicates.
   *
   * @param content - The text content to store
   * @param metadata - Optional metadata to attach to the entry. The key `_relevanceScore` is
   *   reserved: {@link search} populates it on results, so a value stored under it here is
   *   overwritten in search output.
   * @returns The id of the stored (or already-present) record
   * @throws An `Error` if the store is not writable, if `content` is empty or whitespace, or if
   *   the existing backing blob is malformed (invalid JSON, not an array, or a record missing
   *   required string fields).
   * @throws {@link StorageError} if the backend read or write fails.
   */
  async add(content: string, metadata?: Record<string, JSONValue>): Promise<TestMemoryAddResult> {
    if (!this.writable) {
      throw new Error('TestMemoryStore: store is not writable. Set writable: true in config to enable add().')
    }
    if (!content.trim()) {
      throw new Error('TestMemoryStore: content must not be empty.')
    }

    // Serialize the whole read-modify-write cycle behind any in-flight write so concurrent `add`s on
    // this instance don't each read the same snapshot and clobber one another. Reading inside the
    // chained callback guarantees add #N sees add #N-1's write. Serialization is per instance; adds
    // from separate instances/processes against a shared file remain last-write-wins.
    const run = this._writeChain.then(async () => {
      const records = await this._read()

      const normalizedContent = content.trim()
      const existing = records.find((record) => record.content.trim() === normalizedContent)
      if (existing) return { id: existing.id }

      const record: TestMemoryRecord = { id: uuidv7(), content, createdAt: new Date().toISOString() }
      if (metadata !== undefined) record.metadata = metadata

      await this._write([...records, record])
      return { id: record.id }
    })
    // Keep the chain alive even if this write rejects, so a failed write doesn't wedge later ones.
    this._writeChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /**
   * Resolves (and memoizes) the `(storage, key)` pair whose on-disk location matches the
   * pre-`Storage` behavior exactly: `persist: false` → an in-memory backend; an explicit `path` →
   * the file at `path` (backend rooted at its parent); the default → `~/.strands/memory/<name>.json`.
   * The `node:os`/`node:path` imports are dynamic so the module stays safe to bundle for the browser.
   */
  private async _resolve(): Promise<{ storage: Storage; key: string }> {
    if (this._resolved !== undefined) return this._resolved
    if (!this._persist) {
      this._resolved = { storage: new InMemoryStorage(), key: `${sanitizeName(this.name)}.json` }
    } else if (this._explicitPath !== undefined) {
      const path = await import('node:path')
      this._resolved = {
        storage: new LocalFileStorage(path.dirname(this._explicitPath)),
        key: path.basename(this._explicitPath),
      }
    } else {
      const os = await import('node:os')
      const path = await import('node:path')
      this._resolved = {
        storage: new LocalFileStorage(path.join(os.homedir(), '.strands', 'memory')),
        key: `${sanitizeName(this.name)}.json`,
      }
    }
    return this._resolved
  }

  /**
   * Reads and parses the backing file from storage; a missing key (or empty store) starts empty.
   * Reads fresh on every call — there is no in-memory cache, so a search always reflects the
   * latest write.
   *
   * @throws An `Error` if the stored file is not valid JSON, is not an array, or holds a record
   *   missing the required string fields. A backend I/O failure surfaces as its own `StorageError`.
   */
  private async _read(): Promise<TestMemoryRecord[]> {
    const { storage, key } = await this._resolve()
    const bytes = await storage.read(key)
    if (bytes === null) return []

    const rawContent = new TextDecoder().decode(bytes)
    let parsedBlob: unknown
    try {
      parsedBlob = JSON.parse(rawContent)
    } catch (error: unknown) {
      throw new Error(`TestMemoryStore: invalid JSON in ${key}`, { cause: error })
    }
    if (!Array.isArray(parsedBlob)) {
      throw new Error(`TestMemoryStore: invalid backing file ${key}: expected a JSON array of records`)
    }
    for (const record of parsedBlob) {
      if (
        record === null ||
        typeof record !== 'object' ||
        typeof record.id !== 'string' ||
        typeof record.content !== 'string' ||
        typeof record.createdAt !== 'string'
      ) {
        throw new Error(
          `TestMemoryStore: invalid backing file ${key}: ` +
            "each record must have string 'id', 'content', and 'createdAt' fields"
        )
      }
      // A present, non-null metadata must be a plain object. `null` is accepted and treated as
      // absent, matching the Python store (which maps JSON null to None and skips the check).
      if (
        record.metadata !== undefined &&
        record.metadata !== null &&
        (typeof record.metadata !== 'object' || Array.isArray(record.metadata))
      ) {
        throw new Error(
          `TestMemoryStore: invalid backing file ${key}: ` +
            "a record's 'metadata', when present, must be a JSON object"
        )
      }
    }
    return parsedBlob as TestMemoryRecord[]
  }

  /**
   * Persists `records` as a single JSON file through the storage backend. Callers serialize
   * invocations via {@link _writeChain}; atomicity is the backend's responsibility. A backend I/O
   * failure surfaces as its own `StorageError`, naming the key.
   */
  private async _write(records: TestMemoryRecord[]): Promise<void> {
    const { storage, key } = await this._resolve()
    const bytes = new TextEncoder().encode(JSON.stringify(records, null, 2))
    await storage.write(key, bytes)
  }
}
