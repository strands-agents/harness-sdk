/**
 * Amazon Bedrock embedder for vector search strategies.
 *
 * @packageDocumentation
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'

import { Embedder } from './embedder.js'

import { StorageError } from '../../errors.js'

const DEFAULT_EMBEDDER_MODEL_ID = 'amazon.titan-embed-text-v2:0'

/** Configuration for {@link BedrockEmbedder}. */
export interface BedrockEmbedderConfig {
  /**
   * Bedrock model ID or ARN of an Amazon Titan Text Embeddings model. Defaults to
   * `'amazon.titan-embed-text-v2:0'`. Other model families use a different request and
   * response shape and are not supported yet; extend {@link Embedder} for those.
   */
  modelId?: 'amazon.titan-embed-text-v2:0' | 'amazon.titan-embed-text-v1' | (string & {})
  /** AWS region override for the Bedrock Runtime client. */
  region?: string
  /** Pre-configured Bedrock Runtime client. Cannot be combined with `region`. */
  bedrockClient?: BedrockRuntimeClient
}

/**
 * An {@link Embedder} backed by Amazon Titan Text Embeddings on Amazon Bedrock.
 *
 * Sends `{ inputText }` via `InvokeModel` and returns the `embedding` field of the response.
 *
 * @example
 * ```typescript
 * import { BedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const storage = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({
 *     vectorBucketName: 'my-vectors',
 *     indexName: 'notes',
 *     embedder: new BedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0', region: 'us-west-2' }),
 *   }),
 * })
 * ```
 */
export class BedrockEmbedder extends Embedder {
  private readonly _modelId: string
  private readonly _client: BedrockRuntimeClient

  /**
   * @param config - Optional model, region, or pre-configured client
   * @throws {@link StorageError} if both `region` and `bedrockClient` are provided
   */
  constructor(config: BedrockEmbedderConfig = {}) {
    super()
    if (config.bedrockClient && config.region) {
      throw new StorageError(
        'Cannot specify both bedrockClient and region. Configure the region on the BedrockRuntimeClient instead.'
      )
    }
    this._modelId = config.modelId ?? DEFAULT_EMBEDDER_MODEL_ID
    this._client = config.bedrockClient ?? new BedrockRuntimeClient(config.region ? { region: config.region } : {})
  }

  /**
   * Embeds `text` with the configured Titan model.
   *
   * @param text - The text to embed
   * @returns The embedding vector
   * @throws {@link StorageError} if the model response has no `embedding` array
   */
  async embed(text: string): Promise<number[]> {
    const response = await this._client.send(
      new InvokeModelCommand({
        modelId: this._modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      })
    )
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown }
    if (!Array.isArray(parsed.embedding)) {
      throw new StorageError(`Model '${this._modelId}' did not return a Titan-shaped { embedding: number[] } response`)
    }
    return parsed.embedding as number[]
  }
}
