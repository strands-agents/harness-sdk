import { z } from 'zod'
import { logger } from '../logging/logger.js'
import { warnOnce } from '../logging/warn-once.js'
import { ToolReferenceBlock } from '../types/messages.js'
import { LOAD_TOOLS_TOOL_NAME, loadableNames } from './load-tools.js'
import { McpTool } from './mcp-tool.js'
import { tool } from './tool-factory.js'
import type { InvocationContext } from '../agent/invocation-context.js'
import type { LocalAgent } from '../types/agent.js'
import type { Tool } from './tool.js'
import type { ToolSpec } from './types.js'

/**
 * Name of the tool a model calls to find deferred tools and load their input schemas.
 *
 * @internal
 */
export const SEARCH_TOOLS_TOOL_NAME = 'search_tools'

/** How many tools a query loads when the call sets no `limit`. */
const DEFAULT_LIMIT = 5

/** Length past which a tool's first sentence is cut in the listing. */
const SENTENCE_LIMIT = 120

/** Share of the context window a listing of the deferred tools may take, in characters at 4 per token. */
const LISTING_SHARE = 0.01

/** The search tools {@link createSearchTools} made, told apart from a user's tool of the same name by identity. */
const SEARCH_TOOLS = new WeakSet<Tool>()

/**
 * What a {@link ToolSearcher} gets for one search.
 *
 * @experimental
 */
export interface ToolSearchContext {
  /** What the model searched for. */
  readonly query: string
  /** The deferred tools the search may return, in tool order. */
  readonly tools: readonly Tool[]
  /** How many tools to return at most. */
  readonly limit: number
  /** The agent searching. */
  readonly agent: LocalAgent
  /** The search's cancellation signal. */
  readonly cancelSignal: AbortSignal
  /** The request the search runs in; pass it to a side model call so its usage adds to the request. */
  readonly invocationContext?: InvocationContext
}

/**
 * Picks the deferred tools that match the model's query for `search_tools`, such as with a keyword search or by asking
 * a model. The SDK loads the tools it picks: it drops any that isn't one of `context.tools` and keeps at most
 * `context.limit`, then sends each load the way the model's provider takes it.
 *
 * @experimental
 */
export interface ToolSearcher {
  /**
   * The tools that match the query, best first, picked from `context.tools`.
   *
   * @param context - The query and the tools to pick from
   * @returns The matching tools, none when no tool matches; or `undefined` to decline, so a
   *   {@link KeywordToolSearcher} searches instead
   */
  search(context: ToolSearchContext): Promise<readonly Tool[] | undefined>
}

/**
 * The searcher `search_tools` uses unless `Offload.defer` names another, and when that one declines: a keyword search.
 * A tool named exactly as the query comes first, then the rest by score, in tool order on a tie. A query word found in
 * a tool's name or MCP server scores twice what it scores in its description, weighted down by how many of the tools it
 * matches, so a word every tool has counts for little. There are no embeddings, so the same query and tools always give
 * the same result.
 *
 * @experimental
 */
export class KeywordToolSearcher implements ToolSearcher {
  /**
   * At most `context.limit` tools that match the query.
   *
   * @param context - The query and the tools to pick from
   * @returns The matching tools, best first
   */
  async search(context: ToolSearchContext): Promise<Tool[]> {
    return keywordSearch(context.query, context.tools, context.limit)
  }
}

/**
 * Whether a tool name is one of the SDK's loaders, `load_tools` or `search_tools`. The context manager reserves both.
 *
 * @param name - The tool name
 * @returns Whether a call to it loads deferred tools
 * @internal
 */
export function isLoaderName(name: string): boolean {
  return name === LOAD_TOOLS_TOOL_NAME || name === SEARCH_TOOLS_TOOL_NAME
}

/**
 * Whether a tool is the SDK's `search_tools`, rather than a user's tool with that name.
 *
 * @param tool - The tool to check
 * @returns Whether {@link createSearchTools} made the tool
 * @internal
 */
export function isSearchTools(tool: Tool | undefined): boolean {
  return tool !== undefined && SEARCH_TOOLS.has(tool)
}

/**
 * Creates the tool a model calls to load deferred tools, by name or by a search that loads the best matches. It returns
 * one {@link ToolReferenceBlock} per tool and nothing else, since the Claude API rejects a tool result that mixes tool
 * references with other content. A name that isn't a deferred tool fails the whole call, so the model can call again
 * with the right names.
 *
 * @param deferredTools - Returns the names of the agent's deferred tools, in tool order
 * @param searcher - Picks the tools that match a query
 * @returns The `search_tools` tool
 * @internal
 */
export function createSearchTools(
  deferredTools: (agent: LocalAgent) => readonly string[],
  searcher: ToolSearcher = new KeywordToolSearcher()
): Tool {
  const searchTools = tool({
    name: SEARCH_TOOLS_TOOL_NAME,
    description:
      'Load tools whose parameters are not shown yet, so you can call them: name them, or search their names and ' +
      'descriptions and load the best matches. Load every tool you need in one call.',
    inputSchema: z.object({
      query: z.string().optional().describe('Words to search the tools for.'),
      names: z.array(z.string()).optional().describe('Exact names of tools to load.'),
      limit: z.number().int().min(1).optional().describe(`Most tools a query loads; ${DEFAULT_LIMIT} by default.`),
    }),
    callback: async (input, context) => {
      const { agent, cancelSignal, invocationContext } = context!
      const deferred = deferredTools(agent)
      const names = loadableNames(agent, deferred, input.names ?? [])
      const query = input.query?.trim() ?? ''
      if (names.length === 0 && query === '') {
        throw new Error('Nothing loaded: name the tools to load, or search for them with a query.')
      }
      const tools = deferred
        .filter((name) => !names.includes(name))
        .flatMap((name) => agent.toolRegistry.get(name) ?? [])
      const limit = input.limit ?? DEFAULT_LIMIT
      const searchContext = {
        query,
        tools,
        limit,
        agent,
        cancelSignal,
        ...(invocationContext && { invocationContext }),
      }
      const found = query === '' ? [] : await searched(searcher, searchContext)
      if (names.length === 0 && found.length === 0) {
        throw new Error(`Nothing loaded: no tool matches "${query}". Search with other words, or name the tools.`)
      }
      return [...names, ...found].map((name) => new ToolReferenceBlock({ name }))
    },
  })
  SEARCH_TOOLS.add(searchTools)
  return searchTools
}

/**
 * The names of the tools a searcher picked that the search may return, each once, at most `limit` of them. A searcher
 * that declines leaves the search to the keywords.
 */
async function searched(searcher: ToolSearcher, context: ToolSearchContext): Promise<string[]> {
  const offered = new Set(context.tools)
  const picked = (await searcher.search(context)) ?? keywordSearch(context.query, context.tools, context.limit)
  const found = [...new Set(picked)].filter((candidate) => offered.has(candidate))
  if (found.length < picked.length) {
    warnOnce(
      logger,
      `searcher=<${searcher.constructor.name}> | searcher returned tools it was not given or repeated a tool | ` +
        'loading the others'
    )
  }
  return found.slice(0, context.limit).map((candidate) => candidate.name)
}

/**
 * A listing of the deferred tools for a model whose API hides them, in tool order: each name with the first sentence of
 * its description when they all fit the budget, names alone when only those fit, and otherwise the names that fit
 * followed by a count of the rest. The budget is 1% of the context window, so the same tools and model always give
 * the same listing.
 *
 * @param tools - The deferred tools
 * @param contextWindow - The model's context window, in tokens
 * @returns The listing, one line per tool or one line of names
 * @internal
 */
export function toolListing(tools: readonly ToolSpec[], contextWindow: number): string {
  const budget = Math.floor(contextWindow * LISTING_SHARE * 4)
  const described = tools.map((spec) => `- ${spec.name}${firstSentence(spec.description)}`).join('\n')
  if (described.length <= budget) return described
  const names = tools.map((spec) => spec.name)
  if (names.join(', ').length <= budget) return names.join(', ')
  const shown: string[] = []
  for (const name of names) {
    if (namesAndMore([...shown, name], names.length).length > budget) break
    shown.push(name)
  }
  return namesAndMore(shown, names.length)
}

/**
 * The listing a call's loader shows of the deferred tools, for a model whose API hides them. `load_tools` takes only
 * names, so it lists every deferred tool with its description; `search_tools` lists them as {@link toolListing} does.
 *
 * @param toolSpecs - The call's tool specs, its loader among them
 * @param deferred - The specs of the tools the call defers
 * @param contextWindow - The model's context window, in tokens
 * @returns The listing
 * @internal
 */
export function loaderListing(
  toolSpecs: readonly ToolSpec[],
  deferred: readonly ToolSpec[],
  contextWindow: number
): string {
  if (!toolSpecs.some((spec) => spec.name === LOAD_TOOLS_TOOL_NAME)) return toolListing(deferred, contextWindow)
  return deferred.map((spec) => `- ${spec.name}: ${spec.description}`).join('\n')
}

/**
 * A loader's description with a listing of the deferred tools after it, for a model whose API hides them.
 *
 * @param description - The tool's description
 * @param listing - The listing, from {@link toolListing}
 * @returns The description with the listing
 * @internal
 */
export function withToolListing(description: string, listing: string): string {
  return `${description}\n\nTools you can load:\n${listing}`
}

/** The words a search compares: a tool's name and its MCP server's name, and its description. */
interface SearchFields {
  readonly names: readonly string[]
  readonly description: readonly string[]
}

/** At most `limit` tools that match a query, best first, as {@link KeywordToolSearcher} describes. */
function keywordSearch(query: string, tools: readonly Tool[], limit: number): Tool[] {
  const fields = tools.map(searchFields)
  const scores = tools.map((candidate) => (candidate.name.toLowerCase() === query.toLowerCase() ? Infinity : 0))
  for (const word of new Set(words(query))) {
    const hits = fields.map(
      (field) => 2 * Number(hasWord(field.names, word)) + Number(hasWord(field.description, word))
    )
    const matching = hits.filter((hit) => hit > 0).length
    if (matching === 0) continue
    const weight = Math.log(1 + tools.length / matching)
    hits.forEach((hit, index) => (scores[index]! += hit * weight))
  }
  return tools
    .map((candidate, index) => ({ candidate, index, score: scores[index]! }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.candidate)
}

function searchFields(candidate: Tool): SearchFields {
  const server = candidate instanceof McpTool ? (candidate.mcpClient.serverVersion?.name ?? '') : ''
  return { names: words(`${candidate.name} ${server}`), description: words(candidate.description) }
}

/** The lowercase words of a text, with `snake_case`, `kebab-case` and `camelCase` names split into theirs. */
function words(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1)
}

/**
 * Whether the words hold this one, a plural `s` aside, or one it begins when it has at least 3 letters, so `ticket`
 * finds `tickets` and `weath` finds `weather`, but `forecast` doesn't find `for`.
 */
function hasWord(fieldWords: readonly string[], word: string): boolean {
  const stem = singular(word)
  return fieldWords.some(
    (fieldWord) => singular(fieldWord) === stem || (word.length >= 3 && fieldWord.startsWith(word))
  )
}

function singular(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word
}

/** Some of the names, and how many of the rest a search finds. */
function namesAndMore(shown: readonly string[], total: number): string {
  if (shown.length === 0) return `${total} tools; search to find them`
  return `${shown.join(', ')}, and ${total - shown.length} more; search to find them`
}

/** `: ` and the first sentence of a description, cut at {@link SENTENCE_LIMIT} characters; empty without one. */
function firstSentence(description: string | undefined): string {
  const text = (description ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
  return `: ${sentence.length <= SENTENCE_LIMIT ? sentence : `${sentence.slice(0, SENTENCE_LIMIT - 1)}…`}`
}
