/**
 * Adapter that implements {@link SnapshotStorage} on top of the unified {@link Storage} interface.
 *
 * Allows the session manager to accept a unified Storage instance in addition to
 * a legacy SnapshotStorage, bridging the two interfaces without breaking changes.
 */

import type { Storage } from '../storage/storage.js'
import type { SnapshotStorage, SnapshotLocation } from './storage.js'
import type { Snapshot, SnapshotManifest } from './types.js'

import { SessionError } from '../errors.js'
import { validateIdentifier, validateUuidV7 } from './validation.js'

const SCHEMA_VERSION = '1.0'
const SNAPSHOT_REGEX = /snapshot_([\w-]+)\.json$/

/**
 * Adapts a unified {@link Storage} instance into the {@link SnapshotStorage} interface
 * expected by the session manager.
 *
 * Keys are written directly into the provided storage:
 * `<sessionId>/scopes/<scope>/<scopeId>/snapshots/...`
 *
 * Callers control namespacing by passing a scoped storage — e.g.
 * `storage.namespace('session')` produces keys like
 * `session/<sessionId>/scopes/...`.
 *
 * @internal
 * @param storage - The unified Storage backend to delegate to
 */
export class SnapshotStorageAdapter implements SnapshotStorage {
  private readonly _storage: Storage

  constructor(storage: Storage) {
    this._storage = storage
  }

  /**
   * Persists a snapshot to storage.
   *
   * @param params - Snapshot location, ID, latest flag, and snapshot data
   */
  async saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void> {
    const key = params.isLatest
      ? this._latestKey(params.location)
      : this._historyKey(params.location, params.snapshotId)
    await this._writeJSON(key, params.snapshot)
  }

  /**
   * Loads a snapshot from storage.
   *
   * @param params - Snapshot location and optional snapshot ID
   * @returns The snapshot, or null if not found
   */
  async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
    const key =
      params.snapshotId === undefined
        ? this._latestKey(params.location)
        : this._historyKey(params.location, params.snapshotId)
    return this._readJSON<Snapshot>(key)
  }

  /**
   * Lists immutable snapshot IDs for a scope, sorted chronologically.
   *
   * @param params - Location, optional limit and cursor
   * @returns Array of snapshot IDs
   */
  async listSnapshotIds(params: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }): Promise<string[]> {
    if (params.limit !== undefined && params.limit <= 0) return []
    if (params.startAfter) validateUuidV7(params.startAfter)

    const prefix = this._historyPrefix(params.location)
    const keys = await this._storage.list(prefix)

    let ids = keys
      .map((key) => key.match(SNAPSHOT_REGEX)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort()

    if (params.startAfter) {
      ids = ids.filter((id) => id > params.startAfter!)
    }
    if (params.limit !== undefined) {
      ids = ids.slice(0, params.limit)
    }
    return ids
  }

  /**
   * Deletes all snapshots and data belonging to the session ID.
   *
   * @param params - Session ID to delete
   */
  async deleteSession(params: { sessionId: string }): Promise<void> {
    validateIdentifier(params.sessionId)
    const prefix = `${params.sessionId}/`
    const keys = await this._storage.list(prefix)
    const BATCH_SIZE = 100
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      await Promise.all(keys.slice(i, i + BATCH_SIZE).map((key) => this._storage.delete(key)))
    }
  }

  /**
   * Loads the snapshot manifest for a scope.
   *
   * @param params - Snapshot location
   * @returns The manifest, or a default if none exists
   */
  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    const key = this._manifestKey(params.location)
    const manifest = await this._readJSON<SnapshotManifest>(key)
    return (
      manifest ?? {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      }
    )
  }

  /**
   * Persists the snapshot manifest for a scope.
   *
   * @param params - Location and manifest data
   */
  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    const key = this._manifestKey(params.location)
    await this._writeJSON(key, params.manifest)
  }

  private _scopePrefix(location: SnapshotLocation): string {
    validateIdentifier(location.sessionId)
    validateIdentifier(location.scopeId)
    return `${location.sessionId}/scopes/${location.scope}/${location.scopeId}/snapshots`
  }

  private _latestKey(location: SnapshotLocation): string {
    return `${this._scopePrefix(location)}/snapshot_latest.json`
  }

  private _historyKey(location: SnapshotLocation, snapshotId: string): string {
    validateIdentifier(snapshotId)
    return `${this._scopePrefix(location)}/immutable_history/snapshot_${snapshotId}.json`
  }

  private _historyPrefix(location: SnapshotLocation): string {
    return `${this._scopePrefix(location)}/immutable_history/`
  }

  private _manifestKey(location: SnapshotLocation): string {
    return `${this._scopePrefix(location)}/manifest.json`
  }

  private async _writeJSON(key: string, data: unknown): Promise<void> {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(data))
      await this._storage.write(key, bytes)
    } catch (error: unknown) {
      throw new SessionError(`Failed to write '${key}' to storage`, { cause: error })
    }
  }

  private async _readJSON<T>(key: string): Promise<T | null> {
    try {
      const bytes = await this._storage.read(key)
      if (bytes === null) return null
      const text = new TextDecoder().decode(bytes)
      return JSON.parse(text) as T
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        throw new SessionError(`Corrupted JSON at '${key}'`, { cause: error })
      }
      throw new SessionError(`Failed to read '${key}' from storage`, { cause: error })
    }
  }
}
