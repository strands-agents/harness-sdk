import { z } from 'zod'
import { ToolReferenceBlock } from '../types/messages.js'
import { McpTool } from './mcp-tool.js'
import { tool } from './tool-factory.js'
import type { LocalAgent } from '../types/agent.js'
import type { Tool } from './tool.js'
import type { ToolSpec } from './types.js'

/** Name of the tool a model calls to find deferred tools and load their input schemas. */
export const SEARCH_TOOLS_TOOL_NAME = 'search_tools'

/** How many tools a query loads when the call sets no `limit`. */
const DEFAULT_LIMIT = 5

/** Length past which a tool's first sentence is cut in the listing. */
const SENTENCE_LIMIT = 120

/** The tools {@link createSearchTools} made, told apart from a user's tool of the same name by identity. */
const SEARCHERS = new WeakSet<Tool>()

/**
 * Whether a tool is the SDK's `search_tools`, rather than a user's tool with that name.
 *
 * @param tool - The tool to check
 * @returns Whether {@link createSearchTools} made the tool
 * @internal
 */
export function isSearchTools(tool: Tool | undefined): boolean {
  return tool !== undefined && SEARCHERS.has(tool)
}

/**
 * Creates the tool a model calls to load deferred tools, by name or by a keyword search that loads the best matches. It
 * returns one {@link ToolReferenceBlock} per tool and nothing else, since the Claude API rejects a tool result that
 * mixes tool references with other content. A name that isn't a deferred tool fails the whole call, so the model can
 * call again with the right names.
 *
 * @param deferredTools - Returns the names of the agent's deferred tools, in tool order
 * @returns The `search_tools` tool
 * @internal
 */
export function createSearchTools(deferredTools: (agent: LocalAgent) => readonly string[]): Tool {
  const searcher = tool({
    name: SEARCH_TOOLS_TOOL_NAME,
    description:
      'Load tools whose parameters are not shown yet, so you can call them: name them, or search their names and ' +
      'descriptions and load the best matches. Load every tool you need in one call.',
    inputSchema: z.object({
      query: z.string().optional().describe('Words to search the tools for.'),
      names: z.array(z.string()).optional().describe('Exact names of tools to load.'),
      limit: z.number().int().min(1).optional().describe(`Most tools a query loads; ${DEFAULT_LIMIT} by default.`),
    }),
    callback: (input, context) => {
      const agent = context!.agent
      const deferred = deferredTools(agent)
      const names = namedTools(agent, deferred, input.names ?? [])
      const query = input.query?.trim() ?? ''
      if (names.length === 0 && query === '') {
        throw new Error('Nothing loaded: name the tools to load, or search for them with a query.')
      }
      const candidates = deferred
        .filter((name) => !names.includes(name))
        .flatMap((name) => agent.toolRegistry.get(name) ?? [])
      const found = query === '' ? [] : search(query, candidates, input.limit ?? DEFAULT_LIMIT)
      if (names.length === 0 && found.length === 0) {
        throw new Error(`Nothing loaded: no tool matches "${query}". Search with other words, or name the tools.`)
      }
      return [...names, ...found].map((name) => new ToolReferenceBlock({ name }))
    },
  })
  SEARCHERS.add(searcher)
  return searcher
}

/**
 * The search tool's spec with the tools it loads listed in its description, in tool order: each name with the first
 * sentence of its description when they all fit the budget, names alone when only those fit, and otherwise the names
 * that fit followed by a count of the rest. The listing depends only on these tools and the budget, so the same tools
 * give the same description on every call.
 *
 * @param spec - The search tool's spec
 * @param tools - The tools it loads
 * @param budget - The characters the listing may take
 * @returns A new spec with the listing
 * @internal
 */
export function withToolListing(spec: ToolSpec, tools: readonly ToolSpec[], budget: number): ToolSpec {
  return { ...spec, description: `${spec.description}\n\nTools you can load:\n${toolListing(tools, budget)}` }
}

/** The named tools, deduplicated in order. */
function namedTools(agent: LocalAgent, deferred: readonly string[], requested: readonly string[]): string[] {
  const names = [...new Set(requested)]
  const missing = names.filter((name) => !agent.toolRegistry.get(name))
  const shown = names.filter((name) => !deferred.includes(name) && agent.toolRegistry.get(name))
  // One bad name loads none: a result that mixes references with text loses Claude's native references.
  if (missing.length > 0 || shown.length > 0) throw new Error(nothingLoaded(missing, shown))
  return names
}

/** Why a load loaded nothing, naming each tool it couldn't load and what to do instead. */
function nothingLoaded(missing: readonly string[], shown: readonly string[]): string {
  const reasons: string[] = []
  if (shown.length > 0) {
    reasons.push(namesWith(shown, 'is shown in full, so call it directly', 'are shown in full, so call them directly'))
  }
  if (missing.length > 0) reasons.push(namesWith(missing, 'is not a tool', 'are not tools'))
  return `Nothing loaded: ${reasons.join('; ')}. Load only tools whose parameters are not shown.`
}

/** The names, followed by the phrase that agrees with how many there are. */
function namesWith(names: readonly string[], one: string, many: string): string {
  return `${names.join(', ')} ${names.length === 1 ? one : many}`
}

/** The words a search compares: a tool's name and its MCP server's name, and its description. */
interface SearchFields {
  readonly names: readonly string[]
  readonly description: readonly string[]
}

/**
 * The names of at most `limit` tools that match a query: a tool named exactly as the query first, then the rest by
 * score, in tool order on a tie. A query word found in a tool's name or MCP server scores twice what it scores in its
 * description, weighted down by how many of the tools it matches, so a word every tool has counts for little. There
 * are no embeddings, so the same query and tools always give the same result.
 */
function search(query: string, tools: readonly Tool[], limit: number): string[] {
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
    .map((candidate, index) => ({ name: candidate.name, index, score: scores[index]! }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.name)
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

/** The listing of these tools in at most `budget` characters, as {@link withToolListing} describes. */
function toolListing(tools: readonly ToolSpec[], budget: number): string {
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
