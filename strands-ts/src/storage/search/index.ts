/**
 * Pluggable search strategies for storage backends.
 *
 * Each strategy encapsulates a single approach to searching stored content.
 * Storage backends use {@link KeywordSearchStrategy} by default; consumers
 * (memory stores, context offloaders) can override with a different strategy.
 *
 * @packageDocumentation
 */

export type { SearchStrategy } from './types.js'
export type { StorageSearchResult } from '../storage.js'
export { KeywordSearchStrategy } from './keyword.js'
