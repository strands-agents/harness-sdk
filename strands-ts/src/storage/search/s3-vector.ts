import type { StorageSearchResult } from '../storage.js'
import type { S3Storage } from '../s3-storage.js'
import type { SearchStrategy } from './types.js'
import type { Embedder } from '../embeddings/embedder.js'

import { logger } from '../../logging/logger.js'

/** Configuration for {@link S3VectorSearchStrategy}. */
export interface S3VectorSearchStrategyConfig {
  /**
   * Name of an existing S3 Vectors bucket. Not created automatically. Do not share one index
   * across storages on different buckets: results are filtered by prefix only.
   */
  vectorBucketName: string
  /**
   * Name of an existing vector index in that bucket. Not created automatically, and its
   * dimension must match the embedder.
   */
  indexName: string
  /**
   * Produces the embedding vectors. Defaults to a `BedrockEmbedder` (Titan Text Embeddings V2)
   * in the storage's region, loaded on first use so this module does not import the Bedrock
   * provider.
   */
  embedder?: Embedder
  /**
   * Maximum number of results to return. Defaults to 10. The limit applies before
   * results are filtered to this storage's prefix (and to a `namespace()` view's prefix),
   * so a search over a narrow prefix of a shared index can return fewer results.
   */
  maxResults?: number
  /**
   * Pre-configured S3 Vectors client. Defaults to a client in the storage's `region`, or the
   * SDK's standard region resolution when the storage has none.
   */
  s3VectorsClient?: import('@aws-sdk/client-s3vectors').S3VectorsClient
}

/**
 * Vector search for {@link S3Storage}, backed by Amazon S3 Vectors.
 *
 * A derived index over the bucket: `S3Storage` calls {@link index} on every write (one
 * embedder call plus a `PutVectors`), {@link remove} on every delete, and {@link search}
 * on search. Only works with `S3Storage`; each storage backend pairs with its own native
 * vector index, and only the {@link Embedder} is shared.
 *
 * The vector bucket and index must already exist, with a dimension matching the embedder
 * (1024 for the default, Titan Text Embeddings V2). Clients default to the storage's region.
 * Vectors are keyed by the full object key, so storages sharing a bucket under different
 * prefixes can share one index. Empty and non-UTF-8 values are stored but not indexed, and
 * clear any earlier vector for that key. Attach each instance to a single storage.
 *
 * @example
 * ```typescript
 * import { S3Storage } from '@strands-agents/sdk/storage'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 *
 * const storage = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({ vectorBucketName: 'my-vectors', indexName: 'notes' }),
 * })
 * ```
 */
export class S3VectorSearchStrategy implements SearchStrategy<S3Storage> {
  private readonly _config: S3VectorSearchStrategyConfig
  private readonly _target: { vectorBucketName: string; indexName: string }
  private _client: import('@aws-sdk/client-s3vectors').S3VectorsClient | undefined
  private _embedder: Promise<Embedder> | undefined

  /**
   * @param config - Vector bucket and index, plus optional embedder and client settings
   */
  constructor(config: S3VectorSearchStrategyConfig) {
    this._config = config
    this._target = { vectorBucketName: config.vectorBucketName, indexName: config.indexName }
    this._client = config.s3VectorsClient
    if (config.embedder) this._embedder = Promise.resolve(config.embedder)
  }

  /**
   * Embeds and stores a vector for the given key.
   *
   * Empty or non-UTF-8 values are not embedded. Any vector from a previous write to the
   * same key is removed instead, so the index never matches content that is no longer stored.
   *
   * @param storage - The storage the content was written to
   * @param key - The storage key to associate the vector with
   * @param data - The raw bytes to embed
   */
  async index(storage: S3Storage, key: string, data: Uint8Array): Promise<void> {
    const text = decodeText(data)
    if (!text) {
      logger.debug(`key=<${key}> | value is empty or not valid utf-8 text | removing any existing vector`)
      await this.remove(storage, key)
      return
    }
    const embedder = await this._getEmbedder(storage)
    const vector = await embedder.embed(text)
    const { client, sdk } = await this._vectors(storage)
    await client.send(
      new sdk.PutVectorsCommand({
        ...this._target,
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
    const { client, sdk } = await this._vectors(storage)
    await client.send(new sdk.DeleteVectorsCommand({ ...this._target, keys: [storage.prefix + key] }))
  }

  /**
   * Queries the S3 Vectors index for keys similar to the query.
   *
   * @param storage - The storage to search over
   * @param query - Natural-language search query
   * @returns Matched keys under the storage's prefix with similarity scores, ranked best-first
   */
  async search(storage: S3Storage, query: string): Promise<StorageSearchResult[]> {
    const embedder = await this._getEmbedder(storage)
    const queryVector = await embedder.embed(query)
    const { client, sdk } = await this._vectors(storage)
    const response = await client.send(
      new sdk.QueryVectorsCommand({
        ...this._target,
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

  /** Resolves the configured embedder, or loads the default Bedrock embedder once on first use. */
  private _getEmbedder(storage: S3Storage): Promise<Embedder> {
    this._embedder ??= import('../embeddings/bedrock.js').then(({ BedrockEmbedder }) => {
      const region = storage.region
      return new BedrockEmbedder(region ? { region } : undefined)
    })
    return this._embedder
  }

  /**
   * Loads the S3 Vectors SDK (an optional dependency) and, unless one was configured, creates
   * the client on first use in the storage's region.
   */
  private async _vectors(storage: S3Storage): Promise<{
    client: import('@aws-sdk/client-s3vectors').S3VectorsClient
    sdk: typeof import('@aws-sdk/client-s3vectors')
  }> {
    const sdk = await import('@aws-sdk/client-s3vectors')
    this._client ??= new sdk.S3VectorsClient(storage.region ? { region: storage.region } : {})
    return { client: this._client, sdk }
  }
}

/** Decodes `data` as UTF-8, returning `undefined` for empty or non-UTF-8 input. */
function decodeText(data: Uint8Array): string | undefined {
  if (data.length === 0) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch (error: unknown) {
    logger.debug(`bytes=<${data.length}>, error=<${String(error)}> | failed to decode value as utf-8`)
    return undefined
  }
}
