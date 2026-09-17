import type { SearchStrategy } from './search/types.js'
import type { Storage, StorageSearchResult } from './storage.js'

import { StorageError } from '../errors.js'
import { namespace, normalizeKey, normalizePrefix } from './storage.js'
import { KeywordSearchStrategy } from './search/keyword.js'

/** Configuration for {@link S3Storage}. */
export interface S3StorageConfig {
  /** Optional key prefix prepended to every key (a leading namespace within the bucket). */
  prefix?: string
  /** AWS region override. When omitted, the SDK's standard resolution chain applies. Cannot be combined with `s3Client`. */
  region?: string
  /** Pre-configured S3 client. Cannot be combined with `region`. */
  s3Client?: import('@aws-sdk/client-s3').S3Client
  /** Optional search strategy. When set, `write()` indexes entries and `search()` delegates to the strategy. */
  searchStrategy?: SearchStrategy<S3Storage>
}

const S3_PAGE_SIZE = 1000

/**
 * Amazon S3 {@link Storage} backend.
 *
 * Stores each key as an S3 object under an optional prefix. The AWS SDK is loaded
 * lazily on first use and declared as an optional peer dependency, so consumers that
 * never construct an `S3Storage` are not required to install `@aws-sdk/client-s3`.
 *
 * @example
 * ```typescript
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const storage = new S3Storage('my-bucket', { prefix: 'agents/' })
 * await storage.write('sessions/abc/snapshot.json', bytes)
 * ```
 */
export class S3Storage implements Storage {
  private readonly _bucket: string
  private readonly _prefix: string
  private readonly _region: string | undefined
  private readonly _searchStrategy: SearchStrategy<S3Storage> | undefined
  private _client: import('@aws-sdk/client-s3').S3Client | undefined

  /**
   * @param bucket - Target S3 bucket name
   * @param config - Optional prefix, region, or pre-configured client
   * @throws {@link StorageError} if both `region` and `s3Client` are provided
   */
  constructor(bucket: string, config?: S3StorageConfig) {
    if (config?.s3Client && config.region) {
      throw new StorageError('Cannot specify both s3Client and region. Configure the region on the S3Client instead.')
    }
    this._bucket = bucket
    this._prefix = config?.prefix ? config.prefix.split('/').filter(Boolean).join('/') + '/' : ''
    this._region = config?.region
    this._searchStrategy = config?.searchStrategy
    this._client = config?.s3Client
  }

  /**
   * Stores `data` under `key`, overwriting any existing value.
   *
   * @param key - Opaque string key identifying the value
   * @param data - Raw bytes to persist
   * @throws {@link StorageError} if the key is invalid or the upload fails
   */
  async write(key: string, data: Uint8Array): Promise<void> {
    const normalized = normalizeKey(key)
    const client = await this._getClient()
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    try {
      await client.send(new PutObjectCommand({ Bucket: this._bucket, Key: this._objectKey(normalized), Body: data }))
    } catch (error: unknown) {
      throw new StorageError(`Failed to write '${normalized}' to S3 bucket '${this._bucket}'`, { cause: error })
    }
    if (this._searchStrategy) {
      await this._searchStrategy.index?.(this, normalized, data)
    }
  }

  /**
   * Retrieves the bytes previously stored under `key`.
   *
   * @param key - The key to read
   * @returns The stored bytes, or `null` if no value exists for `key`
   * @throws {@link StorageError} if the key is invalid or the download fails
   */
  async read(key: string): Promise<Uint8Array | null> {
    const normalized = normalizeKey(key)
    const client = await this._getClient()
    const { GetObjectCommand } = await import('@aws-sdk/client-s3')
    try {
      const response = await client.send(
        new GetObjectCommand({ Bucket: this._bucket, Key: this._objectKey(normalized) })
      )
      const body = await response.Body?.transformToByteArray()
      return body ? new Uint8Array(body) : null
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) {
        return null
      }
      throw new StorageError(`Failed to read '${normalized}' from S3 bucket '${this._bucket}'`, { cause: error })
    }
  }

  /**
   * Deletes the value stored under `key`. A no-op if the key does not exist.
   *
   * @param key - The key to delete
   * @throws {@link StorageError} if the key is invalid or the delete request fails
   */
  async delete(key: string): Promise<void> {
    const normalized = normalizeKey(key)
    const client = await this._getClient()
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this._bucket, Key: this._objectKey(normalized) }))
    } catch (error: unknown) {
      throw new StorageError(`Failed to delete '${normalized}' from S3 bucket '${this._bucket}'`, { cause: error })
    }
  }

  /**
   * Lists the keys whose names begin with `prefix`, sorted lexicographically.
   *
   * @param prefix - Key prefix to match. An empty string matches all keys.
   * @returns The matching keys, sorted ascending
   * @throws {@link StorageError} if the prefix is invalid or the list request fails
   */
  async list(prefix: string): Promise<string[]> {
    const normalized = normalizePrefix(prefix)
    const client = await this._getClient()
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
    const listPrefix = `${this._prefix}${normalized}`
    const keys: string[] = []
    let continuationToken: string | undefined
    try {
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: this._bucket,
            Prefix: listPrefix,
            MaxKeys: S3_PAGE_SIZE,
            ContinuationToken: continuationToken,
          })
        )
        for (const object of response.Contents ?? []) {
          if (object.Key === undefined) continue
          keys.push(this._prefix ? object.Key.slice(this._prefix.length) : object.Key)
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
    } catch (error: unknown) {
      throw new StorageError(`Failed to list S3 bucket '${this._bucket}' under '${normalized}'`, { cause: error })
    }
    return keys.sort()
  }

  /**
   * Searches stored content by keyword token-overlap scoring.
   *
   * @param query - Natural-language search query
   * @returns All matches with relevance scores, ranked best-first
   */
  async search(query: string): Promise<StorageSearchResult[]> {
    if (this._searchStrategy) {
      return this._searchStrategy.search(this, query)
    }
    return KeywordSearchStrategy.search(this, query)
  }

  private async _getClient(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (this._client) return this._client
    const { S3Client } = await import('@aws-sdk/client-s3')
    this._client = new S3Client(this._region ? { region: this._region } : {})
    return this._client
  }

  /** Returns a prefixed view of this storage without mutating the original. */
  namespace(prefix: string): Storage {
    return namespace(this, prefix)
  }

  private _objectKey(key: string): string {
    return `${this._prefix}${key}`
  }
}
