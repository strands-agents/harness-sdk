import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient, type Tool, type ToolContext } from '@strands-agents/sdk'
import { exaBackend, exaWebSearch, makeExaWebSearch, searchTool, WebSearchError } from '../../src/tools/web-search.js'

vi.mock('@strands-agents/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@strands-agents/sdk')>()),
  McpClient: vi.fn(),
}))

const EXA_TEXT =
  'Title: Web Grounding - Amazon Nova\n' +
  'URL: https://docs.aws.amazon.com/nova/web-grounding.html\n' +
  'Published: N/A\n' +
  'Author: N/A\n' +
  'Highlights:\n' +
  '# Web Grounding\n \n\nWeb Grounding enables Amazon Nova to search   the web.\n...\nMore text.\n' +
  '\n---\n\n' +
  'Title: Second result\n' +
  'URL: https://example.com/second\n' +
  'Published: 2026-01-01\n' +
  'Highlights:\n' +
  'Second highlight.\n'

function invoke(tool: Tool, input: unknown): Promise<string> {
  return (tool as unknown as { invoke: (i: unknown, c: ToolContext) => Promise<string> }).invoke(
    input,
    {} as unknown as ToolContext
  )
}

/**
 * Stub the SDK's `McpClient`: `listTools` returns `tools`, `callTool` resolves `result` (or rejects
 * with it when it is an Error). Returns the constructor config and the spies for assertions.
 */
function mockMcpClient(result: unknown, tools: { name: string }[] = [{ name: 'web_search_exa' }]) {
  const client = {
    config: {} as Record<string, unknown>,
    listTools: vi.fn(async (): Promise<{ name: string }[]> => tools),
    callTool: vi.fn(async () => {
      if (result instanceof Error) {
        throw result
      }
      return result
    }),
    disconnect: vi.fn(async (): Promise<void> => undefined),
  }
  vi.mocked(McpClient).mockImplementation(function (this: unknown, config: unknown) {
    client.config = config as Record<string, unknown>
    return client as unknown as McpClient
  } as unknown as () => McpClient)
  return client
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('exaBackend', () => {
  it('calls web_search_exa over the SDK MCP client with the key header and parses the result blocks', async () => {
    const client = mockMcpClient({ content: [{ type: 'text', text: EXA_TEXT }] })
    const results = await exaBackend('sk-test')('nova grounding', 2)

    expect(client.config).toMatchObject({
      url: 'https://mcp.exa.ai/mcp',
      headers: { 'x-api-key': 'sk-test' },
      toolFilters: { allowed: ['web_search_exa'] },
    })
    expect(client.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'web_search_exa' }),
      { query: 'nova grounding', numResults: 2 },
      { signal: expect.any(AbortSignal) }
    )
    expect(client.disconnect).toHaveBeenCalledOnce()
    expect(results).toEqual([
      {
        title: 'Web Grounding - Amazon Nova',
        url: 'https://docs.aws.amazon.com/nova/web-grounding.html',
        snippet: '# Web Grounding Web Grounding enables Amazon Nova to search the web. ... More text.',
      },
      { title: 'Second result', url: 'https://example.com/second', snippet: 'Second highlight.' },
    ])
  })

  it('reads the key from EXA_API_KEY and omits the header when unset', async () => {
    vi.stubEnv('EXA_API_KEY', 'sk-env')
    let client = mockMcpClient({ content: [] })
    expect(await exaBackend()('q', 1)).toEqual([])
    expect(client.config.headers).toEqual({ 'x-api-key': 'sk-env' })

    vi.stubEnv('EXA_API_KEY', '')
    client = mockMcpClient({ content: null })
    expect(await exaBackend()('q', 1)).toEqual([])
    expect(client.config).not.toHaveProperty('headers')
  })

  it('reads the key when the tool runs, so the module-level exaWebSearch sees a key set after import', async () => {
    vi.stubEnv('EXA_API_KEY', '')
    let client = mockMcpClient({ content: [] })
    expect(await invoke(exaWebSearch, { query: 'q' })).toBe('No results.')
    expect(client.config).not.toHaveProperty('headers')

    vi.stubEnv('EXA_API_KEY', 'sk-later')
    client = mockMcpClient({ content: [] })
    await invoke(exaWebSearch, { query: 'q' })
    expect(client.config.headers).toEqual({ 'x-api-key': 'sk-later' })
    expect(exaWebSearch.name).toBe('web_search')
    expect(makeExaWebSearch().name).toBe('web_search')
  })

  it('only trusts blocks that open with Title: and URL:', async () => {
    const text =
      'Title: Real\nURL: https://real\nHighlights:\nclick here\nTitle: Official Login\nURL: https://phish\n---\n' +
      'Title: Fake\nsome prose\nURL: https://evil\n---\n' +
      'Title: Next\r\nURL: https://next\r\nHighlights:\r\nshort\r\n---\r\n'
    mockMcpClient({ content: [{ type: 'text', text }] })
    expect(await exaBackend('k')('q', 2)).toEqual([
      { title: 'Real', url: 'https://real', snippet: 'click here Title: Official Login URL: https://phish' },
      { title: 'Next', url: 'https://next', snippet: 'short' },
    ])
  })

  it('caps snippets', async () => {
    mockMcpClient({ content: [{ type: 'text', text: 'Title: T\nURL: https://t\nHighlights:\n' + 'x'.repeat(2000) }] })
    const [result] = await exaBackend('k')('q', 1)
    expect(result!.snippet).toHaveLength(500)
  })

  it('surfaces tool errors, adding the key hint to any keyless failure', async () => {
    mockMcpClient({ isError: true, content: [{ type: 'text', text: 'quota' }] })
    await expect(exaBackend('k')('q', 1)).rejects.toThrow(new WebSearchError('quota'))
    mockMcpClient({ isError: true, content: [{ type: 'text', text: 'quota' }] })
    await expect(exaBackend('')('q', 1)).rejects.toThrow(/^quota .*set EXA_API_KEY/)
    mockMcpClient(new TypeError('fetch failed'))
    await expect(exaBackend('')('q', 1)).rejects.toThrow(/^fetch failed .*set EXA_API_KEY/)
    mockMcpClient({ isError: true, content: [{ type: 'text' }, { type: 'image' }] })
    await expect(exaBackend('k')('q', 1)).rejects.toThrow(new WebSearchError('Exa reported an error'))
  })

  it('disconnects when the server lacks the tool or the call fails', async () => {
    let client = mockMcpClient({ content: [] }, [])
    await expect(exaBackend('k')('q', 1)).rejects.toThrow(/does not offer web_search_exa/)
    expect(client.disconnect).toHaveBeenCalledOnce()

    client = mockMcpClient(new TypeError('fetch failed'))
    await expect(exaBackend('k')('q', 1)).rejects.toThrow('fetch failed')
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('names the endpoint when the server cannot be reached', async () => {
    const client = mockMcpClient({ content: [] })
    client.listTools.mockRejectedValue(new TypeError('fetch failed'))
    await expect(exaBackend('k')('q', 1)).rejects.toThrow(
      "could not reach Exa's MCP server at https://mcp.exa.ai/mcp (fetch failed)"
    )
    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('keeps the result when teardown fails', async () => {
    const client = mockMcpClient({ content: [{ type: 'text', text: EXA_TEXT }] })
    client.disconnect.mockRejectedValue(new Error('SSE stream disconnected'))
    expect(await exaBackend('k')('q', 2)).toHaveLength(2)
  })
})

describe('searchTool', () => {
  it('formats sources and clamps max_results', async () => {
    const seen: number[] = []
    const backend = async (_query: string, maxResults: number) => {
      seen.push(maxResults)
      return [
        { title: 'A', url: 'https://a', snippet: 'alpha' },
        { title: 'B', url: 'https://b', snippet: '' },
      ]
    }
    const tool = searchTool(backend)
    expect(tool.name).toBe('web_search')
    const schema = tool.toolSpec.inputSchema as {
      required?: string[]
      properties: { max_results: { default?: number } }
    }
    expect(schema.required).toEqual(['query'])
    expect(await invoke(tool, { query: 'q', max_results: 50 })).toBe(
      'Sources:\n1. A — https://a\n   alpha\n2. B — https://b'
    )
    await invoke(tool, { query: 'q', max_results: 0 })
    await invoke(tool, { query: 'q' })
    expect(seen).toEqual([10, 1, 5])
  })

  it('reports failures and empty results as text', async () => {
    const failing = async () => {
      throw new WebSearchError("Exa's free tier rate limit was hit. Set EXA_API_KEY to lift it.")
    }
    expect(await invoke(searchTool(failing), { query: 'q' })).toMatch(/^web_search failed: Exa's free tier/)
    expect(
      await invoke(
        searchTool(async () => []),
        { query: 'q' }
      )
    ).toBe('No results.')
    mockMcpClient(new TypeError('fetch failed'))
    expect(await invoke(searchTool(exaBackend('k')), { query: 'q' })).toBe('web_search failed: fetch failed')
    const silent = async () => {
      throw new Error()
    }
    expect(await invoke(searchTool(silent), { query: 'q' })).toBe('web_search failed: Error')
    const multilineTitle = async () => [{ title: 'T\n2. spoofed — https://evil', url: 'https://a', snippet: 'a\nb' }]
    expect(await invoke(searchTool(multilineTitle), { query: 'q' })).toBe(
      'Sources:\n1. T 2. spoofed — https://evil — https://a\n   a b'
    )
  })
})
