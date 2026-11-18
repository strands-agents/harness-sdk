import type { LocalFileStorage } from '../local-file-storage.js'
import type { StorageSearchResult } from '../storage.js'
import type { SearchStrategy } from './types.js'

import { STOP_WORDS, tokenize } from './keyword.js'

const COLLECTION_NAME = 'storage'
const COLLECTION_PREFIX = `${COLLECTION_NAME}/`

/** Configuration for {@link QmdSearchStrategy}. */
export interface QmdSearchStrategyConfig {
  /**
   * Path to the SQLite database file for the QMD index. Defaults to `.<dir>-qmd.sqlite` alongside the storage
   * directory, which gives each directory its own index. An explicit `dbPath` holds one directory's index, so a
   * strategy with `dbPath` set throws if it is then used with a second directory (for example a second
   * `FileMemoryStore` on the same storage).
   */
  dbPath?: string
}

/**
 * BM25 full-text search strategy powered by QMD.
 *
 * Maintains a SQLite-backed inverted index over the storage contents and uses
 * BM25 scoring for relevance ranking. Accounts for term frequency, inverse
 * document frequency, and document length normalization.
 *
 * Works only with {@link LocalFileStorage} — reads `baseDir` from the storage
 * instance to know where files live on disk.
 *
 * Keeps one index per storage directory, so one instance can serve several
 * namespaced storages, such as multiple `FileMemoryStore`s on the same
 * `LocalFileStorage`, and {@link close} closes all of them.
 *
 * Requires `@tobilu/qmd` as a peer dependency.
 *
 * @example
 * ```typescript
 * import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
 * import { LocalFileStorage } from '@strands-agents/sdk/storage'
 * import { FileMemoryStore } from '@strands-agents/sdk/vended-memory-stores/file-memory-store'
 *
 * const strategy = new QmdSearchStrategy()
 * const storage = new LocalFileStorage('./.strands/', { searchStrategy: strategy })
 * const store = new FileMemoryStore({ name: 'agent-memory', storage })
 *
 * const results = await store.search('authentication flow')
 * await strategy.close()
 * ```
 */
export class QmdSearchStrategy implements SearchStrategy<LocalFileStorage> {
  /**
   * QMD scans `baseDir` and keeps its index on the host filesystem, so `LocalFileStorage` rejects it
   * alongside a sandbox (a type error, plus a runtime check) and `forSandbox()` drops it.
   */
  readonly requiresHostFs = true
  /**
   * One QMD index per resolved storage directory. Namespaced storages (e.g. one per `FileMemoryStore`) each get
   * their own entry, so they share this strategy without closing each other's index. The value is the pending
   * open, so concurrent first searches for a directory share a single `createStore` call.
   */
  private readonly _stores = new Map<string, Promise<QmdStore>>()
  private readonly _config: QmdSearchStrategyConfig

  constructor(config?: QmdSearchStrategyConfig) {
    this._config = config ?? {}
  }

  /**
   * Searches stored content using BM25 full-text search.
   *
   * Triggers a re-index of the backing filesystem before searching to ensure
   * results reflect the latest writes. For high-throughput workloads, prefer
   * calling {@link update} on a schedule rather than relying on per-search sync.
   *
   * @param storage - A LocalFileStorage instance (reads `baseDir` for the index path)
   * @param query - Natural-language search query
   * @returns Matched keys with BM25 relevance scores, ranked best-first
   * @throws Error if storage is not a filesystem storage or `@tobilu/qmd` is not installed
   */
  async search(storage: LocalFileStorage, query: string): Promise<StorageSearchResult[]> {
    const store = await this._ensureStore(storage)
    await store.update()
    const ftsQuery = buildQuery(query)
    if (!ftsQuery) return []
    const results = await store.searchLex(ftsQuery)
    return results.map((result) => ({
      key: result.displayPath.slice(COLLECTION_PREFIX.length),
      score: Math.abs(result.score) / (1 + Math.abs(result.score)),
    }))
  }

  /**
   * Re-indexes the backing storage directory without performing a search.
   *
   * @param storage - A LocalFileStorage instance
   */
  async update(storage: LocalFileStorage): Promise<void> {
    const store = await this._ensureStore(storage)
    await store.update()
  }

  /**
   * Closes every QMD index this strategy has opened and releases resources (SQLite connections).
   */
  async close(): Promise<void> {
    const pending = [...this._stores.values()]
    this._stores.clear()
    // An index whose open failed has nothing to close; its error was already surfaced to the caller that opened it.
    await Promise.allSettled(pending.map(async (store) => (await store).close()))
  }

  private async _ensureStore(storage: LocalFileStorage): Promise<QmdStore> {
    const { resolve } = await import('node:path')
    const resolvedPath = resolve(storage.baseDir)

    // No await between the lookup and the set below, so concurrent callers for one directory share one open.
    const existing = this._stores.get(resolvedPath)
    if (existing) return existing

    const { dbPath } = this._config
    if (dbPath !== undefined && this._stores.size > 0) {
      const [boundPath] = this._stores.keys()
      throw new Error(
        `QmdSearchStrategy dbPath '${dbPath}' already indexes '${boundPath}' and cannot also index '${resolvedPath}'. ` +
          'Omit dbPath to keep one index per directory (e.g. per FileMemoryStore), or use one strategy per storage.'
      )
    }

    const opening = this._openStore(resolvedPath)
    this._stores.set(resolvedPath, opening)
    // Drop a failed open so the next search retries instead of returning the same rejection forever.
    opening.catch(() => {
      if (this._stores.get(resolvedPath) === opening) this._stores.delete(resolvedPath)
    })
    return opening
  }

  private async _openStore(resolvedPath: string): Promise<QmdStore> {
    let createStore: QmdCreateStore
    try {
      ;({ createStore } = await (import('@tobilu/qmd' as string) as Promise<{ createStore: QmdCreateStore }>))
    } catch {
      throw new Error('QmdSearchStrategy requires @tobilu/qmd — install it with: npm install @tobilu/qmd')
    }
    const { resolve, dirname, basename } = await import('node:path')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(resolvedPath, { recursive: true })
    const dbPath = this._config.dbPath ?? resolve(dirname(resolvedPath), `.${basename(resolvedPath)}-qmd.sqlite`)

    return createStore({
      dbPath,
      config: {
        collections: {
          [COLLECTION_NAME]: { path: resolvedPath, pattern: '**/*' },
        },
      },
    })
  }
}

type QmdCreateStore = (config: {
  dbPath: string
  config: { collections: Record<string, { path: string; pattern: string }> }
}) => Promise<QmdStore>

interface QmdStore {
  update(): Promise<unknown>
  close(): Promise<void>
  searchLex(query: string): Promise<Array<{ displayPath: string; score: number }>>
}

function buildQuery(query: string): string | null {
  const terms = [...tokenize(query)].filter((term) => term.length > 1 && !STOP_WORDS.has(term))
  if (terms.length === 0) return null
  return terms.join(' ')
}

/** Cross-SDK alias for {@link QmdSearchStrategy}. */
export { QmdSearchStrategy as Bm25SearchStrategy }
/** Cross-SDK alias for {@link QmdSearchStrategyConfig}. */
export type { QmdSearchStrategyConfig as Bm25SearchStrategyConfig }
