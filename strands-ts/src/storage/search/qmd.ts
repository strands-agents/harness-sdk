import type { Storage, StorageSearchResult } from '../storage.js'
import type { SearchStrategy } from './types.js'

import { STOP_WORDS, tokenize } from './keyword.js'

const COLLECTION_NAME = 'storage'
const COLLECTION_PREFIX = `${COLLECTION_NAME}/`

/** Configuration for {@link QmdSearchStrategy}. */
export interface QmdSearchStrategyConfig {
  /** Path to the SQLite database file for the QMD index. Defaults to `.<dir>-qmd.sqlite` alongside the storage directory. */
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
 * instance to know where files live on disk. Throws if passed a storage backend
 * without a `baseDir` property.
 *
 * Requires `@tobilu/qmd` as a peer dependency.
 *
 * @example
 * ```typescript
 * import { QmdSearchStrategy } from '@strands-agents/sdk/storage/search/qmd'
 * import { LocalFileStorage } from '@strands-agents/sdk/storage'
 *
 * const storage = new LocalFileStorage('./memory/')
 * const store = new FileMemoryStore({
 *   storage,
 *   search: new QmdSearchStrategy(),
 * })
 *
 * const results = await store.search('authentication flow')
 * ```
 */
export class QmdSearchStrategy implements SearchStrategy {
  private _store: QmdStore | undefined
  private _storagePath: string | undefined
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
  async search(storage: Storage, query: string): Promise<StorageSearchResult[]> {
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
  async update(storage: Storage): Promise<void> {
    const store = await this._ensureStore(storage)
    await store.update()
  }

  /**
   * Closes the QMD store and releases resources (SQLite connection).
   */
  async close(): Promise<void> {
    if (this._store) {
      await this._store.close()
      this._store = undefined
      this._storagePath = undefined
    }
  }

  private async _ensureStore(storage: Storage): Promise<QmdStore> {
    const storagePath = this._resolveStoragePath(storage)
    if (this._store && this._storagePath === storagePath) return this._store
    if (this._store) await this.close()

    let createStore: QmdCreateStore
    try {
      ;({ createStore } = await (import('@tobilu/qmd' as string) as Promise<{ createStore: QmdCreateStore }>))
    } catch {
      throw new Error('QmdSearchStrategy requires @tobilu/qmd — install it with: npm install @tobilu/qmd')
    }
    const { resolve, dirname, basename } = await import('node:path')
    const { mkdir } = await import('node:fs/promises')
    const resolvedPath = resolve(storagePath)
    await mkdir(resolvedPath, { recursive: true })
    const dbPath = this._config.dbPath ?? resolve(dirname(resolvedPath), `.${basename(resolvedPath)}-qmd.sqlite`)

    this._store = await createStore({
      dbPath,
      config: {
        collections: {
          [COLLECTION_NAME]: { path: resolvedPath, pattern: '**/*' },
        },
      },
    })
    this._storagePath = storagePath
    return this._store
  }

  private _resolveStoragePath(storage: Storage): string {
    const baseDir = (storage as Storage & { baseDir?: string }).baseDir
    if (typeof baseDir === 'string') return baseDir
    throw new Error('QmdSearchStrategy requires a storage backend with a baseDir property (e.g. LocalFileStorage)')
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
