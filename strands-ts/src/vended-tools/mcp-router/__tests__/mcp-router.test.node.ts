import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { makeMcpRouter } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { McpClient } from '../../../mcp/index.js'
import { mcpServerLoader } from '../../../mcp/config.js'
import { resolveServerConfigs } from '../../../mcp/config.node.js'

function createContext(agent: object): ToolContext {
  return {
    toolUse: { name: 'mcp_router', toolUseId: 'test-id', input: {} },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
  } as unknown as ToolContext
}

/** Replace a real client's transport-backed SDK client so it serves the given tools without a network. */
function stubSdkClient(client: McpClient, toolNames: string[], callTool: ReturnType<typeof vi.fn>): void {
  const sdkClient = (client as unknown as { _client: Record<string, unknown> })._client
  sdkClient.listTools = vi.fn().mockResolvedValue({
    tools: toolNames.map((name) => ({ name, inputSchema: { type: 'object' } })),
  })
  sdkClient.callTool = callTool
  vi.spyOn(client, 'connect').mockResolvedValue(undefined)
  vi.spyOn(client, 'disconnect').mockResolvedValue(undefined)
}

describe('mcp_router tool with config-loaded servers', () => {
  beforeAll(() => {
    mcpServerLoader.set(resolveServerConfigs)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { label: 'rejected', toolFilters: { rejected: ['delete_everything'] } },
    { label: 'allowed', toolFilters: { allowed: ['list_items'] } },
  ])('enforces $label toolFilters from the server config on call_tool', async ({ toolFilters }) => {
    const sdkCallTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    const realLoadServers = McpClient.loadServers.bind(McpClient)
    vi.spyOn(McpClient, 'loadServers').mockImplementationOnce(async (...args) => {
      const clients = await realLoadServers(...args)
      for (const client of clients) {
        stubSdkClient(client, ['list_items', 'delete_everything'], sdkCallTool)
      }
      return clients
    })
    const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp', toolFilters } } })
    const agent = createMockAgent()

    await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
    const toolsResult = await tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agent))
    await expect(
      tool.invoke({ command: 'call_tool', connection_id: 'c1', tool_name: 'delete_everything' }, createContext(agent))
    ).rejects.toThrow('Tool "delete_everything" is not available on connection "c1"')
    const callResult = await tool.invoke(
      { command: 'call_tool', connection_id: 'c1', tool_name: 'list_items' },
      createContext(agent)
    )

    expect((toolsResult as Array<{ name: string }>).map((spec) => spec.name)).toStrictEqual(['list_items'])
    expect((callResult as Array<{ text: string }>)[0]!.text).toBe('ok')
    expect(sdkCallTool.mock.calls.map((call) => (call[0] as { name: string }).name)).toStrictEqual(['list_items'])
  })
})
