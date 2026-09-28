/**
 * Live check of the default `web_search` backend against Exa's hosted MCP server.
 *
 * The unit tests stub the transport, so a change on Exa's side (the MCP handshake, the text format
 * of `web_search_exa` results) would otherwise surface only as a silent `No results.` for every user
 * on a model without native search. Keyless; `EXA_API_KEY` is picked up when present.
 */

import { describe, expect, it } from 'vitest'

import { exaBackend, WebSearchError } from '../../src/tools/web-search.js'

describe('exa backend (live)', () => {
  it('returns parsed results', async (ctx) => {
    let results
    try {
      results = await exaBackend()('Strands Agents SDK documentation', 3)
    } catch (err) {
      if (err instanceof WebSearchError && err.message.includes('rate limit')) {
        ctx.skip()
      }
      throw err
    }
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) {
      expect(result.title).not.toBe('')
      expect(result.url).toMatch(/^http/)
    }
  })
})
