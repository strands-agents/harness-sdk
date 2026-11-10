import type { SnapshotStorage, SnapshotLocation } from './storage.js'
import type { Snapshot, SnapshotManifest } from './types.js'

import { SessionError } from '../errors.js'
import { validateIdentifier, validateScope, validateUuidV7 } from './validation.js'

const MANIFEST = 'manifest.json'
const SNAPSHOT_LATEST = 'snapshot_latest.json'
const IMMUTABLE_HISTORY = 'immutable_history'
const SNAPSHOT_REGEX = /snapshot_([\w-]+)\.json$/
const SCHEMA_VERSION = '1.0'

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

  /**
   * @param baseDir - Absolute path to the root directory for storing session snapshots.
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
   * Atomically writes JSON to a file using a `.tmp` intermediary to prevent partial writes.
   * Creates parent directories if they do not exist.
   */
  private async _writeJSON(path: string, data: unknown): Promise<void> {
    try {
      const { promises: fs } = await import('fs')
      const { dirname } = await import('path')
      await fs.mkdir(dirname(path), { recursive: true })
      const tmpPath = `${path}.tmp`
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
      await fs.rename(tmpPath, path)
    } catch (error: unknown) {
      throw new SessionError(`Failed to write file ${path}`, { cause: error })
    }
  }

  /**
   * Reads and parses a JSON file. Returns null if the file does not exist.
   * Throws SessionError on parse failure or unexpected filesystem errors.
   */
  private async _readJSON<T>(path: string): Promise<T | null> {
    try {
      const { promises: fs } = await import('fs')
      const content = await fs.readFile(path, 'utf8')
      return JSON.parse(content)
    } catch (error: unknown) {
      if (this._isFileNotFoundError(error)) {
        return null
      }
      if (error instanceof SyntaxError) {
        throw new SessionError(`Invalid JSON in file ${path}`, { cause: error })
      }
      throw new SessionError(`File system error reading ${path}`, { cause: error })
    }
  }

  /** Returns true if the error represents a missing file or directory (ENOENT). */
  private _isFileNotFoundError(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
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
