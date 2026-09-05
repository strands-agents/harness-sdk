/**
 * Embedder implementations for vector search strategies.
 *
 * Each embedder wraps a specific embedding provider (Amazon Bedrock, etc.)
 * and returns an {@link Embedder} function compatible with any
 * {@link SearchStrategy} that requires embeddings.
 *
 * @packageDocumentation
 */

export { bedrockEmbedder } from './bedrock.js'
export type { BedrockEmbedderConfig } from './bedrock.js'
export type { Embedder } from '../search/types.js'
