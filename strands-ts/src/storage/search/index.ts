/**
 * Pluggable search strategies for storage backends.
 *
 * Each strategy encapsulates a single approach to searching stored content.
 * Storage backends use {@link KeywordSearchStrategy} by default; consumers
 * (memory stores, context offloaders) can override with a different strategy.
 *
 * @packageDocumentation
 */

export type { SearchStrategy, Embedder } from './types.js'
export type { StorageSearchResult } from '../storage.js'
export { KeywordSearchStrategy } from './keyword.js'
export { S3VectorSearchStrategy } from './s3-vector.js'
export type { S3VectorSearchStrategyConfig } from './s3-vector.js'
