/**
 * Pluggable search strategies for `Hide`.
 *
 * Each strategy ranks the candidate tool specs for a turn. `Hide` uses
 * {@link KeywordToolSearchStrategy} by default; a judge model or an embedding index plugs in
 * through the same contract.
 *
 * @internal
 */
export type { ToolSearchOptions, ToolSearchResult, ToolSearchStrategy } from './types.js'
export { KeywordToolSearchStrategy } from './keyword.js'
