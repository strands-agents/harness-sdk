import type { StorageSearchResult } from '../storage.js'
import type { S3Storage } from '../s3-storage.js'
import type { Embedder, SearchStrategy } from './types.js'

import { StorageError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { bedrockEmbedder } from '../embeddings/bedrock.js'

/** Configuration for {@link S3VectorSearchStrategy}. Every field is optional. */
export interface S3VectorSearchStrategyConfig {
  /**
   * Function that produces embedding vectors from text. Defaults to {@link bedrockEmbedder}
   * (Titan Text Embeddings V2) in the resolved region.
   */
  embedder?: Embedder
  /**
   * Name of an existing S3 Vectors bucket. Not created automatically.
   * Defaults to the storage bucket name suffixed with `-vectors`.
   */
  vectorBucketName?: string
  /**
   * Name of an existing vector index in that bucket. Not created automatically, and
   * its dimension must match the embedder. Defaults to `'default'`.
   */
  indexName?: string
  /**
   * Maximum number of results to return. Defaults to 10. The limit applies before
   * results are filtered to this storage's prefix (and to a `namespace()` view's prefix),
   * so a search over a narrow prefix of a shared index can return fewer results.
   */
  maxResults?: number
  /**
   * AWS region for the S3 Vectors client and the default embedder. Defaults to the
   * `region` the storage was configured with; when the storage was built from an
   * `s3Client` instead, the SDK's standard resolution chain applies. Cannot be combined
   * with `s3VectorsClient`.
   */
  region?: string
  /** Pre-configured S3 Vectors client. Cannot be combined with `region`. */
  s3VectorsClient?: import('@aws-sdk/client-s3vectors').S3VectorsClient
}

/**
 * Vector search for {@link S3Storage}, backed by Amazon S3 Vectors.
 *
 * A derived index over the bucket's content, not a separate store: `S3Storage` calls
 * {@link index} on every write (one embedder call plus a `PutVectors`), {@link remove}
 * on every delete, and {@link search} on search. The S3 Vectors SDK is loaded lazily on
 * first use and declared as an optional peer dependency.
 *
 * This strategy only works with `S3Storage`; passing it to another backend is a compile
 * error. Each storage backend pairs with its own native vector index (S3 Vectors for S3,
 * vector indexes for DynamoDB, pgvector for Postgres), and only the {@link Embedder} is
 * shared across backends.
 *
 * With no config it uses the vector bucket `<bucket>-vectors`, the index `default`,
 * Bedrock Titan Text Embeddings V2, and the storage's region. Vectors are keyed by the
 * full object key including the storage prefix, so storages that share a bucket under
 * different prefixes can share one index without overwriting each other's vectors.
 * A strategy instance resolves its clients on first use, so attach each instance to a
 * single storage.
 *
 * Only UTF-8 text is indexed. Empty values and values that are not valid UTF-8 are
 * stored but not indexed.
 *
 * The vector bucket and index must already exist; this strategy does not create
 * them. The index dimension must match the embedder (1024 for the default
 * Titan Text Embeddings V2 model). For example:
 *
 * ```bash
 * aws s3vectors create-vector-bucket --vector-bucket-name my-bucket-vectors
 * aws s3vectors create-index --vector-bucket-name my-bucket-vectors --index-name default \
 *   --data-type float32 --dimension 1024 --distance-metric cosine
 * ```
 *
 * @example
 * ```typescript
 * import { S3Storage } from '@strands-agents/sdk/storage'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * // Defaults: my-bucket-vectors / default / Titan v2
 * const storage = new S3Storage('my-bucket', { searchStrategy: new S3VectorSearchStrategy() })
 *
 * // Overrides
 * const custom = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({
 *     vectorBucketName: 'shared-vectors',
 *     indexName: 'agent-a',
 *     embedder: myEmbedder,
 *   }),
 * })
 * ```
 */
export class S3VectorSearchStrategy implements SearchStrategy<S3Storage> {
  private readonly _config: S3VectorSearchStrategyConfig
  private _client: import('@aws-sdk/client-s3vectors').S3VectorsClient | undefined
  private _embedder: Embedder | undefined

  /**
   * @param config - Optional embedder, vector bucket and index, and client settings
   * @throws {@link StorageError} if both `region` and `s3VectorsClient` are provided
   */
  constructor(config: S3VectorSearchStrategyConfig = {}) {
    if (config.s3VectorsClient && config.region) {
      throw new StorageError(
        'Cannot specify both s3VectorsClient and region. Configure the region on the S3VectorsClient instead.'
      )
    }
    this._config = config
    this._client = config.s3VectorsClient
    this._embedder = config.embedder
  }

  /**
   * Embeds and stores a vector for the given key.
   *
   * @param storage - The storage the content was written to
   * @param key - The storage key to associate the vector with
   * @param data - The raw bytes to embed
   */
  async index(storage: S3Storage, key: string, data: Uint8Array): Promise<void> {
    const text = decodeText(data)
    if (!text) {
      logger.warn(`key=<${key}> | value is empty or not valid utf-8 text | skipping vector index`)
      return
    }
    const vector = await this._getEmbedder(storage)(text)
    const client = await this._getClient(storage)
    const { PutVectorsCommand } = await import('@aws-sdk/client-s3vectors')
    await client.send(
      new PutVectorsCommand({
        ...this._target(storage),
        vectors: [{ key: storage.prefix + key, data: { float32: vector } }],
      })
    )
  }

  /**
   * Deletes the vector associated with the given key. A no-op if none exists.
   * Called by {@link S3Storage} on `delete()`.
   *
   * @param storage - The storage the content was deleted from
   * @param key - The storage key whose vector should be removed
   */
  async remove(storage: S3Storage, key: string): Promise<void> {
    const client = await this._getClient(storage)
    const { DeleteVectorsCommand } = await import('@aws-sdk/client-s3vectors')
    await client.send(new DeleteVectorsCommand({ ...this._target(storage), keys: [storage.prefix + key] }))
  }

  /**
   * Queries the S3 Vectors index for keys similar to the query.
   *
   * @param storage - The storage to search over
   * @param query - Natural-language search query
   * @returns Matched keys under the storage's prefix with similarity scores, ranked best-first
   */
  async search(storage: S3Storage, query: string): Promise<StorageSearchResult[]> {
    const queryVector = await this._getEmbedder(storage)(query)
    const client = await this._getClient(storage)
    const { QueryVectorsCommand } = await import('@aws-sdk/client-s3vectors')
    const response = await client.send(
      new QueryVectorsCommand({
        ...this._target(storage),
        queryVector: { float32: queryVector },
        topK: this._config.maxResults ?? 10,
        returnDistance: true,
      })
    )
    const prefix = storage.prefix
    const results: StorageSearchResult[] = []
    for (const vector of response.vectors ?? []) {
      if (vector.key == null || !vector.key.startsWith(prefix)) continue
      results.push({
        key: vector.key.slice(prefix.length),
        score: vector.distance != null ? 1 / (1 + vector.distance) : 0,
      })
    }
    return results
  }

  private _target(storage: S3Storage): { vectorBucketName: string; indexName: string } {
    return {
      vectorBucketName: this._config.vectorBucketName ?? `${storage.bucket}-vectors`,
      indexName: this._config.indexName ?? 'default',
    }
  }

  private _region(storage: S3Storage): string | undefined {
    return this._config.region ?? storage.region
  }

  private _getEmbedder(storage: S3Storage): Embedder {
    if (!this._embedder) {
      const region = this._region(storage)
      this._embedder = bedrockEmbedder(region ? { region } : undefined)
    }
    return this._embedder
  }

  private async _getClient(storage: S3Storage): Promise<import('@aws-sdk/client-s3vectors').S3VectorsClient> {
    if (this._client) return this._client
    const { S3VectorsClient } = await import('@aws-sdk/client-s3vectors')
    const region = this._region(storage)
    this._client = new S3VectorsClient(region ? { region } : {})
    return this._client
  }
}

/** Decodes `data` as UTF-8, returning `undefined` for empty or non-UTF-8 input. */
function decodeText(data: Uint8Array): string | undefined {
  if (data.length === 0) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    return undefined
  }
}
