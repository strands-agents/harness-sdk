import type { Storage, StorageSearchResult } from '../storage.js'
import type { Embedder, SearchStrategy } from './types.js'

/** Configuration for {@link S3VectorSearchStrategy}. */
export interface S3VectorSearchStrategyConfig {
  /** Function that produces embedding vectors from text. */
  embedder: Embedder
  /** S3 Vectors bucket name. */
  vectorBucketName: string
  /** Vector index name within the bucket. */
  indexName: string
  /** Maximum number of results to return. Defaults to 10. */
  maxResults?: number
  /** AWS region override for the S3 Vectors client. */
  region?: string
  /** Pre-configured S3 Vectors client. Cannot be combined with `region`. */
  s3VectorsClient?: import('@aws-sdk/client-s3vectors').S3VectorsClient
}

/**
 * Vector search strategy backed by Amazon S3 Vectors.
 *
 * Embeds content on write via {@link index} and queries the vector index on
 * {@link search}. The S3 Vectors SDK is loaded lazily on first use and declared
 * as an optional peer dependency.
 *
 * Works with any {@link Storage} backend — S3 Vector keys are plain strings that
 * reference storage keys, not S3 object keys.
 *
 * @example
 * ```typescript
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const search = new S3VectorSearchStrategy({
 *   embedder: async (text) => bedrockEmbed(text),
 *   vectorBucketName: 'my-vectors',
 *   indexName: 'memory-index',
 * })
 * const storage = new S3Storage('my-bucket', { searchStrategy: search })
 * ```
 */
export class S3VectorSearchStrategy implements SearchStrategy {
  private readonly _config: S3VectorSearchStrategyConfig
  private _client: import('@aws-sdk/client-s3vectors').S3VectorsClient | undefined

  constructor(config: S3VectorSearchStrategyConfig) {
    this._config = config
    this._client = config.s3VectorsClient
  }

  /**
   * Embeds and stores a vector for the given key.
   *
   * @param _storage - The storage the content was written to (unused — vectors are stored in S3 Vectors)
   * @param key - The storage key to associate the vector with
   * @param data - The raw bytes to embed
   */
  async index(_storage: Storage, key: string, data: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(data)
    const vector = await this._config.embedder(text)
    const client = await this._getClient()
    const { PutVectorsCommand } = await import('@aws-sdk/client-s3vectors')
    await client.send(
      new PutVectorsCommand({
        vectorBucketName: this._config.vectorBucketName,
        indexName: this._config.indexName,
        vectors: [{ key, data: { float32: vector } }],
      })
    )
  }

  /**
   * Queries the S3 Vectors index for keys similar to the query.
   *
   * @param _storage - The storage to search over (unused — search is done via S3 Vectors)
   * @param query - Natural-language search query
   * @returns Matched keys with similarity scores, ranked best-first
   */
  async search(_storage: Storage, query: string): Promise<StorageSearchResult[]> {
    const queryVector = await this._config.embedder(query)
    const topK = this._config.maxResults ?? 10
    const client = await this._getClient()
    const { QueryVectorsCommand } = await import('@aws-sdk/client-s3vectors')
    const response = await client.send(
      new QueryVectorsCommand({
        vectorBucketName: this._config.vectorBucketName,
        indexName: this._config.indexName,
        queryVector: { float32: queryVector },
        topK,
        returnDistance: true,
      })
    )
    return (response.vectors ?? []).map((vector) => ({
      key: vector.key!,
      score: vector.distance != null ? 1 / (1 + vector.distance) : 0,
    }))
  }

  private async _getClient(): Promise<import('@aws-sdk/client-s3vectors').S3VectorsClient> {
    if (this._client) return this._client
    const { S3VectorsClient } = await import('@aws-sdk/client-s3vectors')
    this._client = new S3VectorsClient(this._config.region ? { region: this._config.region } : {})
    return this._client
  }
}
