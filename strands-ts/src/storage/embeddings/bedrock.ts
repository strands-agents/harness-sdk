/**
 * Amazon Bedrock embedder for vector search strategies.
 *
 * @packageDocumentation
 */

import type { Embedder } from '../search/types.js'

import { StorageError } from '../../errors.js'

/** Configuration for {@link bedrockEmbedder}. */
export interface BedrockEmbedderConfig {
  /**
   * Bedrock model ID of an Amazon Titan Text Embeddings model. Defaults to
   * `'amazon.titan-embed-text-v2:0'`. Other model families use a different request and
   * response shape and are not supported; pass your own {@link Embedder} for those.
   */
  modelId?: 'amazon.titan-embed-text-v2:0' | (string & {})
  /** AWS region override for the Bedrock Runtime client. */
  region?: string
  /** Pre-configured Bedrock Runtime client. Cannot be combined with `region`. */
  bedrockClient?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient
}

/**
 * Creates an {@link Embedder} backed by Amazon Titan Text Embeddings on Amazon Bedrock.
 *
 * Sends `{ inputText }` via `InvokeModel` and returns the `embedding` field of the
 * response. The Bedrock Runtime client is created on first call. Titan limits input to
 * 50,000 characters; longer text is rejected by Bedrock.
 *
 * @example
 * ```typescript
 * import { bedrockEmbedder } from '@strands-agents/sdk/storage/embeddings/bedrock'
 * import { S3VectorSearchStrategy } from '@strands-agents/sdk/storage/search'
 * import { S3Storage } from '@strands-agents/sdk/storage'
 *
 * const storage = new S3Storage('my-bucket', {
 *   searchStrategy: new S3VectorSearchStrategy({
 *     embedder: bedrockEmbedder({ modelId: 'amazon.titan-embed-text-v2:0', region: 'us-west-2' }),
 *   }),
 * })
 * ```
 *
 * @param config - Optional configuration for model, region, or a pre-configured client
 * @returns An {@link Embedder} function that produces embedding vectors from text
 * @throws {@link StorageError} if both `region` and `bedrockClient` are provided. The returned
 *   embedder throws `StorageError` if the model response has no `embedding` array.
 */
export function bedrockEmbedder(config?: BedrockEmbedderConfig): Embedder {
  if (config?.bedrockClient && config.region) {
    throw new StorageError(
      'Cannot specify both bedrockClient and region. Configure the region on the BedrockRuntimeClient instead.'
    )
  }
  const modelId = config?.modelId ?? 'amazon.titan-embed-text-v2:0'
  let client: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient | undefined = config?.bedrockClient

  return async (text: string): Promise<number[]> => {
    if (!client) {
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime')
      client = new BedrockRuntimeClient(config?.region ? { region: config.region } : {})
    }
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime')
    const response = await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      })
    )
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { embedding?: unknown }
    if (!Array.isArray(parsed.embedding)) {
      throw new StorageError(`Model '${modelId}' did not return a Titan-shaped { embedding: number[] } response`)
    }
    return parsed.embedding as number[]
  }
}
