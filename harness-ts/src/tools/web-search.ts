/**
 * web_search: search the web and return the top results as numbered sources.
 *
 * The opt-in fallback for models without native web search (`builtinTools: { web_search: 'exa' }`):
 * on OpenAI, Gemini and Mantle GPT models the name is a model flag and this tool is not built (see
 * `agent.ts`). It is backed by Exa's hosted MCP server, a third party that receives the
 * queries; the keyless free tier covers getting started and `EXA_API_KEY` lifts the rate limit in
 * place. The tool/backend split keeps the model-facing contract fixed while the search provider
 * behind it can change.
 */

import { McpClient, tool, type Tool } from '@strands-agents/sdk'
import { z } from 'zod'

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const EXA_TOOL = 'web_search_exa'
const TIMEOUT_MS = 30_000
const MAX_RESULTS = 10
const SNIPPET_CHARS = 500

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export type SearchBackend = (query: string, maxResults: number) => Promise<SearchResult[]>

/** A backend failure with a message the model can act on. */
export class WebSearchError extends Error {}

/**
 * Split Exa's `---`-separated `Title:/URL:/.../Highlights:` blocks into results. Only a block that
 * opens with a `Title:` line directly followed by a `URL:` line counts, so those words inside a
 * page's highlighted text do not start a source (a highlight would also have to carry Exa's `---`
 * separator to do that).
 */
function parseExa(text: string): SearchResult[] {
  const results: SearchResult[] = []
  for (const block of text.split(/^---\s*$/m)) {
    const head = /^\s*Title: (.*)\r?\nURL: (\S+)/.exec(block)
    if (!head) {
      continue
    }
    const highlights = block.includes('Highlights:')
      ? block.slice(block.indexOf('Highlights:') + 'Highlights:'.length)
      : ''
    const snippet = highlights.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS)
    results.push({ title: head[1]!.trim(), url: head[2]!, snippet })
  }
  return results
}

interface ExaResult {
  content?: { type: string; text?: string }[]
  isError?: boolean
}

/** One `web_search_exa` call over the SDK's MCP client; the session lives only for this call. */
async function exaCall(query: string, maxResults: number, apiKey: string | undefined): Promise<SearchResult[]> {
  const client = new McpClient({
    url: EXA_MCP_URL,
    toolFilters: { allowed: [EXA_TOOL] },
    ...(apiKey ? { headers: { 'x-api-key': apiKey } } : {}),
  })
  let result: ExaResult
  try {
    const tools = await client.listTools().catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      throw new WebSearchError(`could not reach Exa's MCP server at ${EXA_MCP_URL} (${reason})`)
    })
    const exa = tools.find((t) => t.name === EXA_TOOL)
    if (!exa) {
      throw new WebSearchError(`Exa's MCP server does not offer ${EXA_TOOL}`)
    }
    result = (await client.callTool(
      exa,
      { query, numResults: maxResults },
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    )) as ExaResult
  } finally {
    // a teardown error must not discard a result already in hand
    await client.disconnect().catch(() => undefined)
  }
  const text = (result.content ?? [])
    .filter((c) => c !== null && typeof c === 'object' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
  if (result.isError) {
    throw new WebSearchError(text || 'Exa reported an error')
  }
  return parseExa(text)
}

/** Search backend over Exa's hosted MCP server; `apiKey` defaults to `EXA_API_KEY` (read per call). */
export function exaBackend(apiKey?: string): SearchBackend {
  return async (query, maxResults) => {
    const key = apiKey ?? process.env.EXA_API_KEY
    try {
      return await exaCall(query, maxResults, key)
    } catch (err) {
      if (key) {
        throw err
      }
      // The SDK client hides the HTTP status, so a keyless 429 is not distinguishable here.
      const reason = err instanceof Error ? err.message : String(err)
      throw new WebSearchError(`${reason} (Exa's keyless tier is rate limited; set EXA_API_KEY to lift it.)`)
    }
  }
}

/** Build a `web_search` tool over Exa's hosted search (`EXA_API_KEY` lifts the keyless rate limit). */
export function makeExaWebSearch(): Tool {
  return searchTool(exaBackend())
}

/** The `web_search` tool served by Exa (`EXA_API_KEY` is read per call). */
export const exaWebSearch = makeExaWebSearch()

/** Build a `web_search` tool that formats `backend`'s results as a numbered `Sources:` list. */
export function searchTool(backend: SearchBackend): Tool {
  return tool({
    name: 'web_search',
    description: 'Search the web and return the top results as numbered sources with a short excerpt each.',
    inputSchema: z.object({
      query: z.string().describe('What to search for. A descriptive sentence works better than bare keywords.'),
      max_results: z.number().int().optional().describe('How many results to return, 1-10.'),
    }),
    callback: async (input) => {
      let results: SearchResult[]
      try {
        results = await backend(input.query, Math.max(1, Math.min(input.max_results ?? 5, MAX_RESULTS)))
      } catch (err) {
        const reason = err instanceof Error ? err.message || err.name : String(err)
        return `web_search failed: ${reason}`
      }
      if (results.length === 0) {
        return 'No results.'
      }
      const oneLine = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ')
      const lines = ['Sources:']
      results.forEach((result, index) => {
        lines.push(`${index + 1}. ${oneLine(result.title)} — ${result.url}`)
        if (result.snippet) {
          lines.push(`   ${oneLine(result.snippet)}`)
        }
      })
      return lines.join('\n')
    },
  })
}
