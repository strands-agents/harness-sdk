import type { SnapshotStorage, SnapshotLocation } from './storage.js'
import type { Snapshot, SnapshotManifest } from './types.js'

import { SessionError } from '../errors.js'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { validateIdentifier, validateScope, validateUuidV7 } from './validation.js'

const MANIFEST = 'manifest.json'
const SNAPSHOT_LATEST = 'snapshot_latest.json'
const IMMUTABLE_HISTORY = 'immutable_history'
const SNAPSHOT_REGEX = /snapshot_([\w-]+)\.json$/
const SCHEMA_VERSION = '1.0'
// Windows may reject simultaneous replacements of the same destination.
const PENDING_RENAMES = new Map<string, Promise<void>>()

/**
 * File-based implementation of SnapshotStorage.
 * Persists session snapshots to the local filesystem under a configurable base directory.
 *
 * @deprecated Pass a unified `Storage` (e.g. `LocalFileStorage` from `@strands-agents/sdk/storage`)
 * to `SessionManagerConfig.storage` instead. The session manager wraps it internally.
 *
 * Directory layout:
 * ```
 * <baseDir>/<sessionId>/scopes/<scope>/<scopeId>/snapshots/
 *   snapshot_latest.json
 *   immutable_history/
 *     snapshot_<uuid7>.json
 * ```
 */
export class FileStorage implements SnapshotStorage {
  /** Absolute path to the root directory where all session data is stored. */
  private readonly _baseDir: string
  private _rootChecked = false

  /**
   * @param baseDir - Absolute path to the root directory for storing session snapshots. A missing
   *   directory is created accessible to the owner only. An existing one keeps its permissions, and
   *   on POSIX a warning is logged if it is accessible by group or others.
   */
  constructor(baseDir: string) {
    this._baseDir = baseDir
  }

  /**
   * Resolves the absolute file path for a given scope location and filename.
   * Validates sessionId, scope, and scopeId before constructing the path.
   */
  private async _getPath(location: SnapshotLocation, filename: string): Promise<string> {
    const { join } = await import('path')
    validateIdentifier(location.sessionId)
    validateScope(location.scope)
    validateIdentifier(location.scopeId)
    return join(this._baseDir, location.sessionId, 'scopes', location.scope, location.scopeId, 'snapshots', filename)
  }

  /**
   * Resolves the absolute path to the root directory for a session.
   * Used by deleteSession to remove all data under `<baseDir>/<sessionId>/`.
   */
  private async _getSessionDir(sessionId: string): Promise<string> {
    const { join } = await import('path')
    validateIdentifier(sessionId)
    return join(this._baseDir, sessionId)
  }

  /**
   * Persists a snapshot to disk.
   * If `isLatest` is true, writes to `snapshot_latest.json` (overwriting any previous).
   * Otherwise, writes to `immutable_history/snapshot_<snapshotId>.json`.
   */
  async saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void> {
    const path = params.isLatest
      ? await this._getLatestSnapshotPath(params.location)
      : await this._getHistorySnapshotPath(params.location, params.snapshotId)
    await this._writeJSON(path, params.snapshot)
  }

  /**
   * Loads a snapshot from disk.
   * If `snapshotId` is omitted, loads `snapshot_latest.json`.
   * Returns null if the file does not exist.
   */
  async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
    const path =
      params.snapshotId === undefined
        ? await this._getLatestSnapshotPath(params.location)
        : await this._getHistorySnapshotPath(params.location, params.snapshotId)
    return this._readJSON<Snapshot>(path)
  }

  /**
   * Lists immutable snapshot IDs for a scope, sorted chronologically.
   * Since IDs are UUID v7, lexicographic sort equals chronological order.
   * `startAfter` filters to IDs after the given UUID v7 (exclusive cursor).
   * `limit` caps the number of returned IDs.
   * Returns an empty array if no snapshots exist yet.
   */
  async listSnapshotIds(params: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }): Promise<string[]> {
    if (params.limit !== undefined && params.limit <= 0) return []
    if (params.startAfter) validateUuidV7(params.startAfter)
    const dirPath = await this._getPath(params.location, IMMUTABLE_HISTORY)
    try {
      const { promises: fs } = await import('fs')
      const files = await fs.readdir(dirPath)
      let ids = files
        .map((file) => file.match(SNAPSHOT_REGEX)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort()
      if (params.startAfter) {
        ids = ids.filter((id) => id > params.startAfter!)
      }
      if (params.limit !== undefined) {
        ids = ids.slice(0, params.limit)
      }
      return ids
    } catch (error: unknown) {
      if (this._isFileNotFoundError(error)) return []
      throw new SessionError(`Failed to list snapshots for session ${params.location.sessionId}`, { cause: error })
    }
  }

  /**
   * Deletes all data for a session by removing its root directory (`<baseDir>/<sessionId>/`) recursively.
   * No-ops if the session directory does not exist.
   */
  async deleteSession(params: { sessionId: string }): Promise<void> {
    const sessionDir = await this._getSessionDir(params.sessionId)
    try {
      const { promises: fs } = await import('fs')
      await fs.rm(sessionDir, { recursive: true, force: true })
    } catch (error: unknown) {
      throw new SessionError(`Failed to delete session ${params.sessionId}`, { cause: error })
    }
  }

  /**
   * Loads the snapshot manifest for a scope.
   * Returns a default manifest with the current timestamp if none exists yet.
   */
  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    const path = await this._getPath(params.location, MANIFEST)
    const manifest = await this._readJSON<SnapshotManifest>(path)

    return (
      manifest ?? {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      }
    )
  }

  /**
   * Persists the snapshot manifest for a scope to disk.
   */
  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    const path = await this._getPath(params.location, MANIFEST)
    await this._writeJSON(path, params.manifest)
  }

  /**
   * Atomically writes JSON to a file through a unique `.tmp` intermediary to prevent partial writes.
   * Creates parent directories if they do not exist. New directories and files are accessible
   * to the owner only, and a symbolic link at `path` is refused.
   * Overlapping saves to the same file write concurrently and are renamed one at a time in call
   * order, so the last save called wins. This holds within one process only.
   */
  private async _writeJSON(path: string, data: unknown): Promise<void> {
    let tmpPath: string | undefined
    try {
      const { promises: fs } = await import('fs')
      const { dirname, resolve } = await import('path')
      const { randomUUID } = await import('crypto')
      const uniquePath = `${path}.${randomUUID()}.tmp`
      tmpPath = uniquePath
      const target = resolve(path)
      // No I/O is awaited before this save takes its place in the queue, which keeps call order.
      const written = (async (): Promise<void> => {
        if (await this._isSymlink(path)) {
          throw new SessionError(`Refusing to write to symbolic link at ${path}`)
        }
        // Directories above the storage root keep the default mode. Windows rejects mkdir on a drive
        // root, and a real failure here also fails the mkdir below.
        await fs.mkdir(dirname(this._baseDir), { recursive: true }).catch(() => {})
        await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
        await this._warnIfRootIsOpen()
        await fs.writeFile(uniquePath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      })()
      const pendingRename = Promise.allSettled([PENDING_RENAMES.get(target), written])
        .then(() => written)
        .then(() => fs.rename(uniquePath, path))
      PENDING_RENAMES.set(target, pendingRename)
      try {
        await pendingRename
      } finally {
        if (PENDING_RENAMES.get(target) === pendingRename) PENDING_RENAMES.delete(target)
      }
    } catch (error: unknown) {
      if (error instanceof SessionError) throw error
      // On EEXIST the temp path was not created by this call, so it is not ours to remove.
      if (tmpPath && !this._hasErrorCode(error, 'EEXIST')) {
        const { promises: fs } = await import('fs')
        await fs.rm(tmpPath, { force: true }).catch(() => {})
      }
      throw new SessionError(`Failed to write file ${path}`, { cause: error })
    }
  }

  /**
   * Reads and parses a JSON file. Returns null if the file does not exist.
   * Throws SessionError on a symbolic link, parse failure, or unexpected filesystem errors.
   */
  private async _readJSON<T>(path: string): Promise<T | null> {
    if (await this._isSymlink(path)) {
      throw new SessionError(`Refusing to read symbolic link at ${path}`)
    }
    try {
      const { promises: fs, constants } = await import('fs')
      // O_NOFOLLOW (not on Windows) also refuses a link swapped in after the check above.
      const flag = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      const content = await fs.readFile(path, { encoding: 'utf8', flag })
      return JSON.parse(content)
    } catch (error: unknown) {
      if (this._isFileNotFoundError(error)) {
        return null
      }
      if (error instanceof SyntaxError) {
        throw new SessionError(`Invalid JSON in file ${path}`, { cause: error })
      }
      // ELOOP on Linux and macOS, EMLINK on FreeBSD.
      if (this._hasErrorCode(error, 'ELOOP') || this._hasErrorCode(error, 'EMLINK')) {
        throw new SessionError(`Refusing to read symbolic link at ${path}`, { cause: error })
      }
      throw new SessionError(`File system error reading ${path}`, { cause: error })
    }
  }

  /**
   * Warns once if the storage root is accessible by group or others; an existing root keeps its mode.
   * The check is advisory, so it never fails a save.
   */
  private async _warnIfRootIsOpen(): Promise<void> {
    // Windows does not report POSIX permission bits.
    if (this._rootChecked || process.platform === 'win32') return
    this._rootChecked = true
    try {
      const { promises: fs } = await import('fs')
      const { resolve } = await import('path')
      const root = resolve(this._baseDir)
      const mode = (await fs.stat(root)).mode & 0o777
      if (mode & 0o077) {
        warnOnce(
          logger,
          `path=<${root}>, mode=<${mode.toString(8)}> | session storage directory is accessible by group or others | restrict it with chmod 700`
        )
      }
    } catch {
      // Ignored: the write reports real filesystem errors.
    }
  }

  /** Returns true if `path` is a symbolic link. */
  private async _isSymlink(path: string): Promise<boolean> {
    try {
      const { promises: fs } = await import('fs')
      return (await fs.lstat(path)).isSymbolicLink()
    } catch {
      return false
    }
  }

  /** Returns true if the error represents a missing file or directory (ENOENT). */
  private _isFileNotFoundError(error: unknown): boolean {
    return this._hasErrorCode(error, 'ENOENT')
  }

  /** Returns true if the error carries the given Node.js error code. */
  private _hasErrorCode(error: unknown, code: string): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === code
  }

  /** Returns the file path for `snapshot_latest.json` within the given scope. */
  private async _getLatestSnapshotPath(location: SnapshotLocation): Promise<string> {
    return this._getPath(location, SNAPSHOT_LATEST)
  }

  /**
   * Returns the file path for an immutable snapshot in `immutable_history/`.
   * Validates the snapshotId and guards against path traversal outside `_baseDir`.
   */
  private async _getHistorySnapshotPath(location: SnapshotLocation, snapshotId: string): Promise<string> {
    validateIdentifier(snapshotId)
    const resolved = await this._getPath(location, `${IMMUTABLE_HISTORY}/snapshot_${snapshotId}.json`)
    if (!resolved.startsWith(this._baseDir)) {
      throw new SessionError(`Invalid snapshotId '${snapshotId}': resolves outside storage directory`)
    }
    return resolved
  }
}
