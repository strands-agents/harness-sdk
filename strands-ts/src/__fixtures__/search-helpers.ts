import type { ToolSearchStrategy } from '../context-manager/strategies/hide/tool-search.js'

/**
 * A tool search strategy that returns fixed names best-first, ignoring the query and candidates.
 *
 * @param names - Tool names to return, in rank order
 * @returns A ToolSearchStrategy
 */
export function createStaticToolSearch(names: string[]): ToolSearchStrategy {
  return { search: async () => names.map((name, index) => ({ name, score: names.length - index })) }
}
