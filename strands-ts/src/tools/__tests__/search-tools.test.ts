import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSearchTools, isSearchTools, KeywordToolSearcher, toolListing } from '../search-tools.js'
import { tool } from '../tool-factory.js'
import type { ToolSpec } from '../types.js'
import type { Tool } from '../tool.js'
import type { LocalAgent } from '../../types/agent.js'

const spec = (name: string, description: string): ToolSpec => ({ name, description, inputSchema: { type: 'object' } })

describe('toolListing', () => {
  const tools = Array.from({ length: 10 }, (_, index) => spec(`tool_${index}`, `Run tool_${index}.`))

  it.each([
    [
      'each name with its first sentence while they fit',
      5_500,
      tools.map((t) => `- ${t.name}: Run ${t.name}.`).join('\n'),
    ],
    ['names alone when only they fit', 2_000, tools.map((t) => t.name).join(', ')],
    ['the names that fit and a count of the rest otherwise', 1_000, 'tool_0, and 9 more; search to find them'],
    ['only a count when no name fits', 100, '10 tools; search to find them'],
  ])('lists %s, in 1%% of the context window', (_name, contextWindow, expected) => {
    expect(toolListing(tools, contextWindow)).toBe(expected)
  })

  it('lists the first sentence of each description, cut at 120 characters, and a name without one alone', () => {
    const listed = [
      spec('reader', 'Reads a file. Use it for text files.'),
      spec('long', `${'x'.repeat(130)} and more.`),
      spec('bare', ''),
    ]

    expect(toolListing(listed, 200_000)).toBe(`- reader: Reads a file.\n- long: ${'x'.repeat(119)}…\n- bare`)
  })
})

describe('KeywordToolSearcher', () => {
  it('returns the best keyword matches, an exact name first, at most the limit', async () => {
    const make = (name: string, description: string): Tool =>
      tool({ name, description, inputSchema: z.object({ city: z.string() }), callback: () => 'ok' })
    const tools = [
      make('get_weather', 'Get the current weather for a city.'),
      make('get_forecast', 'Get the weather forecast for the next days.'),
      make('create_ticket', 'Create a support ticket.'),
      make('weather', 'Look up weather station data.'),
    ]
    const request = {
      query: 'weather',
      tools,
      limit: 2,
      agent: {} as LocalAgent,
      cancelSignal: new AbortController().signal,
    }

    expect(await new KeywordToolSearcher().search(request)).toEqual(['weather', 'get_weather'])
  })
})

describe('isSearchTools', () => {
  it("tells the SDK's search_tools from a user's tool with its name", () => {
    const own = tool({ name: 'search_tools', description: 'Mine.', inputSchema: z.object({}), callback: () => 'ok' })

    expect(isSearchTools(createSearchTools(() => []))).toBe(true)
    expect(isSearchTools(own)).toBe(false)
    expect(isSearchTools(undefined)).toBe(false)
  })
})
