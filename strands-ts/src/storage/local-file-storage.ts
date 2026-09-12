import type { Sandbox } from '../sandbox/base.js'
import type { Storage, StorageSearchResult } from './storage.js'
import type { SearchStrategy } from './search/types.js'

import { StorageError } from '../errors.js'
import { NAMESPACED, normalizeKey, normalizePrefix } from './storage.js'
import { KeywordSearchStrategy } from './search/keyword.js'

/** Configuration for {@link LocalFileStorage}. */
export interface LocalFileStorageConfig {
  /** Search strategy to use instead of the default keyword search. */
  searchStrategy?: SearchStrategy
}

/**
 * Returns true if the error represents a missing or non-directory path (ENOENT or ENOTDIR).
 *
 * @param error - The caught error to inspect
 * @returns Whether the error is a filesystem not-found error
 */
function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

/**
 * Local-filesystem {@link Storage} backend.
 *
 * Persists each key as a file under a base directory, mapping the key's `/` segments
 * onto directory segments. On the host filesystem, writes are atomic (write to a
 * scratch sibling, then rename) so a crash mid-write never leaves a partially written
 * file. When bound to a {@link Sandbox} via {@link forSandbox}, all I/O is routed
 * through that sandbox instead of the host's `node:fs` (atomicity depends on the
 * sandbox implementation).
 *
 * @example
 * ```typescript
 * import { LocalFileStorage } from '@strands-agents/sdk/storage'
 *
 * const storage = new LocalFileStorage('./.strands/')
 * await storage.write('sessions/abc/snapshot.json', bytes)
 * ```
 */
export class LocalFileStorage implements Storage {
  private readonly _baseDir: string
  private readonly _sandbox: Sandbox | undefined
  private readonly _searchStrategy: SearchStrategy

  /** The resolved root directory for this storage instance. */
  get baseDir(): string {
    return this._baseDir
  }

  /**
   * @param baseDir - Root directory under which keys are stored. Defaults to `./.strands/`.
   * @param sandbox - Optional sandbox to route I/O through. Usually set via {@link forSandbox}.
   * @param config - Optional configuration for search strategy.
   */
  constructor(baseDir: string = './.strands/', sandbox?: Sandbox, config?: LocalFileStorageConfig) {
    this._baseDir = baseDir.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1')
    this._sandbox = sandbox
    this._searchStrategy = config?.searchStrategy ?? KeywordSearchStrategy
  }

  /**
   * Returns a storage instance whose I/O is routed through `sandbox`.
   *
   * Instances already bound to a sandbox return themselves unchanged.
   *
   * @param sandbox - Sandbox to route the returned instance's I/O through
   * @returns A new `LocalFileStorage` with the same base directory, routed through `sandbox`
   */
  forSandbox(sandbox: Sandbox): LocalFileStorage {
    if (this._sandbox) return this
    return new LocalFileStorage(this._baseDir, sandbox, { searchStrategy: this._searchStrategy })
  }

  /**
   * Stores `data` under `key`, overwriting any existing value.
   *
   * @param key - Opaque string key identifying the value
   * @param data - Raw bytes to persist
   * @throws {@link StorageError} if the key is invalid or the write fails
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeKey(key)
    const path = this._pathFor(normalized)
    if (this._sandbox) {
      try {
        await this._sandbox.writeFile(path, data)
      } catch (error: unknown) {
        throw new StorageError(`Failed to write '${normalized}' to sandbox storage`, { cause: error })
      }
      await this._searchStrategy.index?.(this, normalized, data)
      return
    }
    let tmpPath: string | undefined
    try {
      const { mkdir, writeFile, rename } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(path), { recursive: true })
      const { randomUUID } = await import('node:crypto')
      tmpPath = `${path}.__strands_tmp_${randomUUID()}`
      await writeFile(tmpPath, data)
      await rename(tmpPath, path)
    } catch (error: unknown) {
      if (tmpPath) {
        const { rm } = await import('node:fs/promises')
        await rm(tmpPath, { force: true }).catch(() => {})
      }
      throw new StorageError(`Failed to write '${normalized}' to local storage`, { cause: error })
    }
    await this._searchStrategy.index?.(this, normalized, data)
  }

  /**
   * Retrieves the bytes previously stored under `key`.
   *
   * @param key - The key to read
   * @returns The stored bytes, or `null` if no value exists for `key`
   * @throws {@link StorageError} if the key is invalid or the read fails
   */
  async read(key: string): Promise<Uint8Array | null> {
    const normalized = normalizeKey(key)
    const path = this._pathFor(normalized)
    if (this._sandbox) {
      try {
        return await this._sandbox.readFile(path)
      } catch (error: unknown) {
        if (isNotFoundError(error)) return null
        throw new StorageError(`Failed to read '${normalized}' from sandbox storage`, { cause: error })
      }
    }
    try {
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(path)
      return new Uint8Array(content)
    } catch (error: unknown) {
      if (isNotFoundError(error)) return null
      throw new StorageError(`Failed to read '${normalized}' from local storage`, { cause: error })
    }
  }

  /**
   * Deletes the value stored under `key`. A no-op if the key does not exist.
   *
   * @param key - The key to delete
   * @throws {@link StorageError} if the key is invalid or the delete fails
   */
  async delete(key: string): Promise<void> {
    const normalized = normalizeKey(key)
    const path = this._pathFor(normalized)
    if (this._sandbox) {
      try {
        await this._sandbox.removeFile(path)
      } catch (error: unknown) {
        if (!isNotFoundError(error)) {
          throw new StorageError(`Failed to delete '${normalized}' from sandbox storage`, { cause: error })
        }
      }
      return
    }
    try {
      const { rm } = await import('node:fs/promises')
      await rm(path, { force: true })
    } catch (error: unknown) {
      throw new StorageError(`Failed to delete '${normalized}' from local storage`, { cause: error })
    }
  }

  /**
   * Lists the keys whose names begin with `prefix`, sorted lexicographically.
   *
   * @param prefix - Key prefix to match. An empty string matches all keys.
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the prefix is invalid or the listing fails
   */
  async list(prefix: string): Promise<string[]> {
    const normalized = normalizePrefix(prefix)
    const base = this._baseDir.replace(/\/$/, '')
    // Narrow the walk to the deepest directory the prefix fully specifies
    const lastSlash = normalized.lastIndexOf('/')
    const dirPortion = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
    const startDir = dirPortion ? `${base}/${dirPortion}` : base
    const keys = this._sandbox
      ? await this._listKeysSandbox(startDir, dirPortion)
      : await this._listKeysHost(startDir, dirPortion)
    return keys.filter((key) => key.startsWith(normalized)).sort()
  }

  private _pathFor(key: string): string {
    const base = this._baseDir.replace(/\/$/, '')
    return `${base}/${key}`
  }

  private async _listKeysHost(dir: string, keyPrefix: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')

    const walk = async (walkDir: string, walkPrefix: string): Promise<string[]> => {
      let entries
      try {
        entries = await readdir(walkDir, { withFileTypes: true })
      } catch (error: unknown) {
        if (isNotFoundError(error)) return []
        throw new StorageError(`Failed to list local storage under '${walkPrefix}'`, { cause: error })
      }
      const found: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.includes('.__strands_tmp')) continue
        const childKey = walkPrefix ? `${walkPrefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          found.push(...(await walk(`${walkDir}/${entry.name}`, childKey)))
        } else {
          found.push(childKey)
        }
      }
      return found
    }

    return walk(dir, keyPrefix)
  }

  private async _listKeysSandbox(dir: string, keyPrefix: string): Promise<string[]> {
    const sandbox = this._sandbox!

    const walk = async (walkDir: string, walkPrefix: string): Promise<string[]> => {
      let entries
      try {
        entries = await sandbox.listFiles(walkDir)
      } catch (error: unknown) {
        if (isNotFoundError(error)) return []
        throw new StorageError(`Failed to list sandbox storage under '${walkPrefix}'`, { cause: error })
      }
      const found: string[] = []
      for (const entry of entries) {
        if (!entry.isDir && entry.name.includes('.__strands_tmp')) continue
        const childKey = walkPrefix ? `${walkPrefix}/${entry.name}` : entry.name
        if (entry.isDir) {
          found.push(...(await walk(`${walkDir}/${entry.name}`, childKey)))
        } else {
          found.push(childKey)
        }
      }
      return found
    }

    return walk(dir, keyPrefix)
  }

  /**
   * Searches stored content by keyword token-overlap scoring.
   *
   * @param query - Natural-language search query
   * @returns All matches with relevance scores, ranked best-first
   */
  async search(query: string): Promise<StorageSearchResult[]> {
    return this._searchStrategy.search(this, query)
  }

  /**
   * Returns a namespaced `LocalFileStorage` rooted at the subdirectory.
   */
  namespace(prefix: string): LocalFileStorage {
    const normalized = normalizePrefix(prefix)
    const subDir = normalized ? `${this._baseDir.replace(/\/$/, '')}/${normalized}` : this._baseDir
    const scoped = new LocalFileStorage(subDir, this._sandbox, { searchStrategy: this._searchStrategy })
    Object.defineProperty(scoped, NAMESPACED, { value: true })
    return scoped
  }
}
