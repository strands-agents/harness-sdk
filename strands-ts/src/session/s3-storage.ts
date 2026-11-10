import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import type { SnapshotStorage, SnapshotLocation } from './storage.js'
import type { Snapshot, SnapshotManifest } from './types.js'
import { SessionError } from '../errors.js'
import { validateIdentifier, validateScope, validateUuidV7 } from './validation.js'

const MANIFEST = 'manifest.json'
const SNAPSHOT_LATEST = 'snapshot_latest.json'
const IMMUTABLE_HISTORY = 'immutable_history/'
const SCHEMA_VERSION = '1.0'
const SNAPSHOT_REGEX = /snapshot_([\w-]+)\.json$/
const S3_PAGE_SIZE = 1000

/**
 * Configuration options for S3Storage
 */
export type S3StorageConfig = {
  /** S3 bucket name */
  bucket: string
  /** Optional key prefix for all objects */
  prefix?: string
  /** AWS region (default: us-east-1). Cannot be used with s3Client */
  region?: string
  /** Pre-configured S3 client. Cannot be used with region */
  s3Client?: S3Client
}

/**
 * S3-based implementation of SnapshotStorage.
 * Persists session snapshots as JSON objects in an S3 bucket.
 *
 * @deprecated Pass a unified `Storage` (e.g. `S3Storage` from `@strands-agents/sdk/storage`)
 * to `SessionManagerConfig.storage` instead. The session manager wraps it internally.
 *
 * Object key layout:
 * ```
 * [<prefix>/]<sessionId>/scopes/<scope>/<scopeId>/snapshots/
 *   snapshot_latest.json
 *   immutable_history/
 *     snapshot_<uuid7>.json
 * ```
 */
export class S3Storage implements SnapshotStorage {
  /** S3 client instance */
  private readonly _s3: S3Client
  /** S3 bucket name */
  private readonly _bucket: string
  /** Key prefix for all objects */
  private readonly _prefix: string
  /**
   * Creates new S3Storage instance
   * @param config - Configuration options
   */
  constructor(config: S3StorageConfig) {
    if (config.s3Client && config.region) {
      throw new SessionError('Cannot specify both s3Client and region. Configure region in the S3Client instead.')
    }

    this._bucket = config.bucket
    this._prefix = config.prefix ?? ''
    this._s3 = config.s3Client ?? new S3Client({ region: config.region ?? 'us-east-1' })
  }

  /**
   * Resolves the full S3 object key for a given scope location and path.
   * Validates sessionId and scopeId before constructing the key.
   */
  private _getKey(location: SnapshotLocation, path: string): string {
    validateIdentifier(location.sessionId)
    validateScope(location.scope)
    validateIdentifier(location.scopeId)
    const base = this._prefix ? `${this._prefix}/` : ''
    return `${base}${location.sessionId}/scopes/${location.scope}/${location.scopeId}/snapshots/${path}`
  }

  /**
   * Resolves the S3 key prefix for an entire session (`[<prefix>/]<sessionId>/`).
   * Used by deleteSession to list and remove all objects under the session.
   */
  private _getSessionPrefix(sessionId: string): string {
    validateIdentifier(sessionId)
    const base = this._prefix ? `${this._prefix}/` : ''
    return `${base}${sessionId}/`
  }

  /**
   * Persists a snapshot to S3.
   * If `isLatest` is true, writes to `snapshot_latest.json` (overwriting any previous).
   * Otherwise, writes to `immutable_history/snapshot_<snapshotId>.json`.
   */
  async saveSnapshot(params: {
    location: SnapshotLocation
    snapshotId: string
    isLatest: boolean
    snapshot: Snapshot
  }): Promise<void> {
    if (!params.isLatest) {
      await this._writeJSON(this._getHistorySnapshotKey(params.location, params.snapshotId), params.snapshot)
    } else {
      await this._writeJSON(this._getLatestSnapshotKey(params.location), params.snapshot)
    }
  }

  /**
   * Loads a snapshot from S3.
   * If `snapshotId` is omitted, loads `snapshot_latest.json`.
   * Returns null if the object does not exist.
   */
  async loadSnapshot(params: { location: SnapshotLocation; snapshotId?: string }): Promise<Snapshot | null> {
    const key =
      params.snapshotId === undefined
        ? this._getLatestSnapshotKey(params.location)
        : this._getHistorySnapshotKey(params.location, params.snapshotId)
    return this._readJSON<Snapshot>(key)
  }

  /**
   * Lists immutable snapshot IDs for a scope, sorted chronologically.
   * Since IDs are UUID v7, lexicographic sort equals chronological order.
   * Pushes `startAfter` and `limit` down to S3 via `StartAfter` and `MaxKeys`
   * to avoid fetching unnecessary objects.
   * Returns an empty array if no snapshots exist yet.
   */
  async listSnapshotIds(params: {
    location: SnapshotLocation
    limit?: number
    startAfter?: string
  }): Promise<string[]> {
    if (params.limit !== undefined && params.limit <= 0) return []
    if (params.startAfter) validateUuidV7(params.startAfter)

    const prefix = this._getKey(params.location, IMMUTABLE_HISTORY)
    // S3 StartAfter is a full object key; construct it from the UUID cursor.
    // Exclusive: objects after this key are returned, matching our pagination contract.
    const startAfterKey = params.startAfter
      ? this._getHistorySnapshotKey(params.location, params.startAfter)
      : undefined
    try {
      const ids: string[] = []
      let continuationToken: string | undefined
      do {
        const response = await this._s3.send(
          new ListObjectsV2Command({
            Bucket: this._bucket,
            Prefix: prefix,
            StartAfter: continuationToken ? undefined : startAfterKey,
            MaxKeys: params.limit !== undefined ? Math.min(S3_PAGE_SIZE, params.limit - ids.length) : S3_PAGE_SIZE,
            ContinuationToken: continuationToken,
          })
        )
        const page = (response.Contents ?? [])
          .map((obj) => obj.Key?.match(SNAPSHOT_REGEX)?.[1])
          .filter((id): id is string => id !== undefined)
        ids.push(...page)
        if (response.IsTruncated) {
          if (!response.NextContinuationToken) {
            throw new SessionError('S3 returned truncated response without continuation token')
          }
          continuationToken = response.NextContinuationToken
        } else {
          continuationToken = undefined
        }
      } while (continuationToken && (params.limit === undefined || ids.length < params.limit))
      return params.limit !== undefined ? ids.slice(0, params.limit) : ids
    } catch (error: unknown) {
      if (error instanceof SessionError) throw error
      if (this._isNotFoundError(error)) return []
      throw new SessionError(`Failed to list snapshots for session ${params.location.sessionId}`, { cause: error })
    }
  }

  /**
   * Deletes all S3 objects belonging to a session by listing and batch-deleting
   * everything under `[<prefix>/]<sessionId>/`.
   * Handles buckets with more than 1000 objects via continuation token pagination.
   * No-ops if the session has no objects.
   */
  async deleteSession(params: { sessionId: string }): Promise<void> {
    const prefix = this._getSessionPrefix(params.sessionId)
    try {
      let continuationToken: string | undefined
      do {
        const response = await this._s3.send(
          new ListObjectsV2Command({ Bucket: this._bucket, Prefix: prefix, ContinuationToken: continuationToken })
        )
        const keys = (response.Contents ?? []).map((obj) => ({ Key: obj.Key! }))
        if (keys.length > 0) {
          await this._s3.send(new DeleteObjectsCommand({ Bucket: this._bucket, Delete: { Objects: keys } }))
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
    } catch (error: unknown) {
      throw new SessionError(`Failed to delete session ${params.sessionId}`, { cause: error })
    }
  }

  /**
   * Loads the snapshot manifest for a scope from S3.
   * Returns a default manifest with the current timestamp if none exists yet.
   */
  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    const key = this._getKey(params.location, MANIFEST)
    const manifest = await this._readJSON<SnapshotManifest>(key)

    return (
      manifest ?? {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      }
    )
  }

  /**
   * Persists the snapshot manifest for a scope to S3.
   */
  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    const key = this._getKey(params.location, MANIFEST)
    await this._writeJSON(key, params.manifest)
  }

  /**
   * Serializes data as JSON and writes it to S3 with `application/json` content type.
   */
  private async _writeJSON(key: string, data: unknown): Promise<void> {
    try {
      await this._s3.send(
        new PutObjectCommand({
          Bucket: this._bucket,
          Key: key,
          Body: JSON.stringify(data, null, 2),
          ContentType: 'application/json',
        })
      )
    } catch (error) {
      throw new SessionError(`Failed to write S3 object ${key}`, { cause: error })
    }
  }

  /**
   * Reads and parses a JSON object from S3. Returns null if the object does not exist.
   * Throws SessionError on parse failure or unexpected S3 errors.
   */
  private async _readJSON<T>(key: string): Promise<T | null> {
    try {
      const response = await this._s3.send(new GetObjectCommand({ Bucket: this._bucket, Key: key }))
      const body = await response.Body?.transformToString()
      if (!body) return null
      return JSON.parse(body)
    } catch (error: unknown) {
      if (this._isNotFoundError(error)) {
        return null
      }
      if (error instanceof SyntaxError) {
        throw new SessionError(`Invalid JSON in S3 object ${key}`, { cause: error })
      }
      throw new SessionError(`S3 error reading ${key}`, { cause: error })
    }
  }

  /** Returns true if the error represents a missing S3 object (`NoSuchKey`) or bucket (`NoSuchBucket`). */
  private _isNotFoundError(error: unknown): error is { name: string } {
    return (
      error !== null &&
      typeof error === 'object' &&
      'name' in error &&
      typeof (error as { name: unknown }).name === 'string' &&
      ((error as { name: string }).name === 'NoSuchKey' || (error as { name: string }).name === 'NoSuchBucket')
    )
  }

  /** Returns the S3 key for `snapshot_latest.json` within the given scope. */
  private _getLatestSnapshotKey(location: SnapshotLocation): string {
    return this._getKey(location, SNAPSHOT_LATEST)
  }

  /** Returns the S3 key for an immutable snapshot in `immutable_history/`. Validates the snapshotId before constructing the key. */
  private _getHistorySnapshotKey(location: SnapshotLocation, snapshotId: string): string {
    validateIdentifier(snapshotId)
    return this._getKey(location, `${IMMUTABLE_HISTORY}snapshot_${snapshotId}.json`)
  }
}
