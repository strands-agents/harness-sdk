import type { Scope, Snapshot, SnapshotManifest } from './types.js'

/**
 * Identifies the location of a snapshot within the storage hierarchy.
 */
export type SnapshotLocation = {
  /** Session identifier */
  sessionId: string
  /** Scope of the snapshot (agent or multi-agent) */
  scope: Scope
  /** Scope-specific identifier (agent id or multi-agent id) */
  scopeId: string
}

/**
 * SessionStorage configuration for pluggable storage backends.
 * Allows users to configure snapshot and transcript storage independently.
 *
 * @deprecated Prefer passing a unified `Storage` directly to `SessionManagerConfig.storage`.
 */
export type SessionStorage = {
  snapshot: SnapshotStorage
  // TODO: Fast-follow - Transcript support
}

/**
 * Interface for snapshot persistence.
 * Implementations provide storage backends (S3, filesystem, etc.).
 *
 * @deprecated Prefer passing a unified `Storage` to `SessionManagerConfig.storage` instead of implementing this directly.
 *
 * File layout convention:
 * ```
 * sessions/<session_id>/
 *   scopes/
 *     agent/<scope_id>/
 *       snapshots/
 *         snapshot_latest.json
 *         immutable_history/
 *           snapshot_<uuid>.json
 *           snapshot_<uuid>.json
 * ```
 */
export interface SnapshotStorage {
  /**
   * Persists a snapshot to storage.
   */
  saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void>

  /**
   * Loads a snapshot from storage.
   */
  loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null>

  /**
   * Lists all available immutable snapshot IDs for a session scope, sorted chronologically.
   * Snapshot IDs are UUID v7 strings vended by the SDK — callers should treat them as opaque
   * handles and never construct them manually.
   *
   * Typical pagination pattern:
   * ```typescript
   * const page1 = await storage.listSnapshotIds({ location })
   * const page2 = await storage.listSnapshotIds({ location, startAfter: page1.at(-1) })
   * ```
   *
   * `limit` caps the number of returned IDs. `startAfter` is an exclusive cursor (the last ID
   * from the previous page); it must be a UUID v7 obtained from a prior `listSnapshotIds` call.
   */
  listSnapshotIds(params: { location: SnapshotLocation; limit?: number; startAfter?: string }): Promise<string[]>

  /**
   * Deletes all snapshots and directories belonging to the session ID.
   */
  deleteSession(params: { sessionId: string }): Promise<void>

  /**
   * Loads the snapshot manifest.
   */
  loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest>

  /**
   * Saves the snapshot manifest.
   */
  saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void>
}
