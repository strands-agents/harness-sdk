import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeMcpRouter, MCP_ROUTER_DESCRIPTION } from '../index.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { McpClient } from '../../../mcp/index.js'
import { McpTool } from '../../../tools/mcp-tool.js'

/**
 * Build a fresh ToolContext backed by a specific agent object.
 * Each call with the same agent returns a context that shares that agent identity.
 */
function createContext(agent?: object, controller?: AbortController): ToolContext {
  const mockAgent = agent ?? createMockAgent()
  return {
    toolUse: { name: 'mcp_router', toolUseId: 'test-id', input: {} },
    agent: mockAgent,
    invocationState: {},
    cancelSignal: controller?.signal ?? new AbortController().signal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  } as unknown as ToolContext
}

/** Create a mock McpClient with the methods the router uses. */
function createMockClient(overrides?: Partial<McpClient>): McpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn().mockResolvedValue({}),
    connectionState: 'connected',
    ...overrides,
  } as unknown as McpClient
}

describe('mcp_router tool', () => {
  let loadServersSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    loadServersSpy = vi.spyOn(McpClient, 'loadServers')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('server validation', () => {
    it('rejects empty allowlist', () => {
      expect(() => makeMcpRouter({ servers: {} })).toThrow(/must not be empty/)
    })

    it('rejects zero maxConnections', () => {
      expect(() =>
        makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } }, maxConnections: 0 })
      ).toThrow(/maxConnections/)
    })

    it('description includes server names', () => {
      const tool = makeMcpRouter({ servers: { 'my-server': { url: 'https://mcp.example.com/mcp' } } })
      expect(tool.toolSpec.description).toContain('my-server')
    })
  })

  describe('connect', () => {
    it('rejects server not on allowlist', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      await expect(
        tool.invoke({ command: 'connect', server_name: 'evil', connection_id: 'c1' }, createContext())
      ).rejects.toThrow(/not on the MCP server allowlist/)
    })

    it('rejects missing connection_id', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      await expect(tool.invoke({ command: 'connect', server_name: 'mcp' }, createContext())).rejects.toThrow(
        /connection_id/
      )
    })

    it('rejects missing server_name', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      await expect(tool.invoke({ command: 'connect', connection_id: 'c1' }, createContext())).rejects.toThrow(
        /server_name/
      )
    })

    it('supports multiple simultaneous connections', async () => {
      const tool = makeMcpRouter({
        servers: {
          'server-a': { url: 'https://a.example.com/mcp' },
          'server-b': { url: 'https://b.example.com/mcp' },
        },
      })
      const agent = createMockAgent()
      const clientA = createMockClient()
      const clientB = createMockClient()

      loadServersSpy.mockResolvedValueOnce([clientA]).mockResolvedValueOnce([clientB])

      await tool.invoke({ command: 'connect', server_name: 'server-a', connection_id: 'conn-a' }, createContext(agent))
      await tool.invoke({ command: 'connect', server_name: 'server-b', connection_id: 'conn-b' }, createContext(agent))

      // Both connections should be reachable
      await tool.invoke({ command: 'list_tools', connection_id: 'conn-a' }, createContext(agent))
      await tool.invoke({ command: 'list_tools', connection_id: 'conn-b' }, createContext(agent))

      expect(clientA.listTools).toHaveBeenCalled()
      expect(clientB.listTools).toHaveBeenCalled()
    })

    it('rejects reconnect with same id', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()
      const clientA = createMockClient()
      const clientB = createMockClient()

      loadServersSpy.mockResolvedValueOnce([clientA]).mockResolvedValueOnce([clientB])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      await expect(
        tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      ).rejects.toThrow(/already exists/)

      // The second client should have been stopped
      expect(clientB.disconnect).toHaveBeenCalled()
    })

    it('enforces connection cap', async () => {
      const tool = makeMcpRouter({
        servers: { mcp: { url: 'https://mcp.example.com/mcp' } },
        maxConnections: 2,
      })
      const agent = createMockAgent()

      loadServersSpy
        .mockResolvedValueOnce([createMockClient()])
        .mockResolvedValueOnce([createMockClient()])
        .mockResolvedValueOnce([createMockClient()])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c2' }, createContext(agent))
      await expect(
        tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c3' }, createContext(agent))
      ).rejects.toThrow(/Connection limit of 2/)
    })

    it('isolates connections between agents', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agentA = createMockAgent()
      const agentB = createMockAgent()

      loadServersSpy.mockResolvedValueOnce([createMockClient()])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agentA))
      await expect(tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agentB))).rejects.toThrow(
        /No active connection/
      )
    })

    it('cleans up on start failure', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()
      const brokenClient = createMockClient({
        connect: vi.fn().mockRejectedValue(new Error('connection refused')),
      })

      loadServersSpy.mockResolvedValueOnce([brokenClient])

      await expect(
        tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      ).rejects.toThrow(/connection refused/)

      expect(brokenClient.disconnect).toHaveBeenCalled()

      // No connection should have been registered
      await expect(tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agent))).rejects.toThrow(
        /connection_id.*required|No active connection/
      )
    })

    it('rejects when client silently enters failed state (continueOnError)', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()
      const failedClient = createMockClient({
        connect: vi.fn().mockResolvedValue(undefined),
        connectionState: 'failed' as const,
      })

      loadServersSpy.mockResolvedValueOnce([failedClient])

      await expect(
        tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      ).rejects.toThrow(/failed to connect/)

      expect(failedClient.disconnect).toHaveBeenCalled()
    })

    it('throws when allowlisted server has disabled: true', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp', disabled: true } as any } })
      const agent = createMockAgent()

      // loadServers returns an empty array for disabled servers.
      loadServersSpy.mockResolvedValueOnce([])

      await expect(
        tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      ).rejects.toThrow(/failed to initialise/)
    })
  })

  describe('session lifecycle', () => {
    it('runs full connect → list_tools → call_tool → disconnect flow', async () => {
      const mockMcpTool = new McpTool({
        name: 'echo',
        description: 'Echoes input',
        inputSchema: { type: 'object', properties: {} },
        client: createMockClient(),
      })

      const mockClient = createMockClient({
        listTools: vi.fn().mockResolvedValue([mockMcpTool]),
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hello world' }] }),
      })

      loadServersSpy.mockResolvedValueOnce([mockClient])

      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()

      // connect
      const connectResult = await tool.invoke(
        { command: 'connect', server_name: 'mcp', connection_id: 'c1' },
        createContext(agent)
      )
      expect(connectResult).toBe('Successfully connected to mcp as "c1"')
      expect(mockClient.connect).toHaveBeenCalled()

      // list_tools
      const toolsResult = await tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agent))
      expect(toolsResult).toHaveLength(1)
      expect((toolsResult as Array<{ name: string }>)[0]!.name).toBe('echo')
      expect(mockClient.listTools).toHaveBeenCalledWith({ prefix: '' })

      // call_tool
      const callResult = await tool.invoke(
        {
          command: 'call_tool',
          connection_id: 'c1',
          tool_name: 'echo',
          arguments: { msg: 'hi' },
        },
        createContext(agent)
      )
      expect(callResult).toHaveLength(1)
      expect((callResult as Array<{ text: string }>)[0]!.text).toBe('hello world')
      expect(mockClient.callTool).toHaveBeenCalled()
      const callArgs = (mockClient.callTool as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(callArgs[0]!.name).toBe('echo')
      expect(callArgs[1]).toEqual({ msg: 'hi' })

      // disconnect
      const disconnectResult = await tool.invoke({ command: 'disconnect', connection_id: 'c1' }, createContext(agent))
      expect(disconnectResult).toBe('Successfully disconnected')
      expect(mockClient.disconnect).toHaveBeenCalled()

      // Connection should no longer be active
      await expect(tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agent))).rejects.toThrow(
        /No active connection/
      )
    })

    it('rejects call_tool without tool_name', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()

      loadServersSpy.mockResolvedValueOnce([createMockClient()])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      await expect(tool.invoke({ command: 'call_tool', connection_id: 'c1' }, createContext(agent))).rejects.toThrow(
        /tool_name/
      )
    })

    it('throws McpRouterToolError when MCP tool returns isError', async () => {
      const mockClient = createMockClient({
        callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'boom' }], isError: true }),
      })

      loadServersSpy.mockResolvedValueOnce([mockClient])

      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      await expect(
        tool.invoke(
          { command: 'call_tool', connection_id: 'c1', tool_name: 'fail', arguments: {} },
          createContext(agent)
        )
      ).rejects.toThrow(/boom/)
    })

    it('disconnect succeeds even when client.disconnect throws', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()
      const brokenStop = createMockClient({
        disconnect: vi.fn().mockRejectedValue(new Error('already closed')),
      })

      loadServersSpy.mockResolvedValueOnce([brokenStop])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      const result = await tool.invoke({ command: 'disconnect', connection_id: 'c1' }, createContext(agent))
      expect(result).toBe('Successfully disconnected')

      // Connection should be evicted
      await expect(tool.invoke({ command: 'list_tools', connection_id: 'c1' }, createContext(agent))).rejects.toThrow(
        /No active connection/
      )
    })

    it('forwards cancel signal to callTool', async () => {
      const mockClient = createMockClient({
        callTool: vi.fn().mockResolvedValue({ content: [] }),
      })

      loadServersSpy.mockResolvedValueOnce([mockClient])

      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agent = createMockAgent()
      const controller = new AbortController()

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agent))
      await tool.invoke(
        { command: 'call_tool', connection_id: 'c1', tool_name: 'slow' },
        createContext(agent, controller)
      )

      const callArgs = (mockClient.callTool as ReturnType<typeof vi.fn>).mock.calls[0]!
      expect(callArgs[2]).toEqual({ signal: controller.signal })
    })
  })

  describe('config forwarding', () => {
    it('forwards server config and name to loadServers', async () => {
      const serverConfig = { url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': 'secret' } }
      const tool = makeMcpRouter({ servers: { 'my-api': serverConfig } })
      const agent = createMockAgent()

      loadServersSpy.mockResolvedValueOnce([createMockClient()])

      await tool.invoke({ command: 'connect', server_name: 'my-api', connection_id: 'c1' }, createContext(agent))

      expect(loadServersSpy).toHaveBeenCalledWith({ 'my-api': serverConfig })
    })
  })

  describe('list_connections', () => {
    it('returns sorted open connection IDs', async () => {
      const tool = makeMcpRouter({
        servers: {
          'server-a': { url: 'https://a.example.com/mcp' },
          'server-b': { url: 'https://b.example.com/mcp' },
        },
      })
      const agent = createMockAgent()

      // No connections yet
      const empty = await tool.invoke({ command: 'list_connections' }, createContext(agent))
      expect(empty).toBe('')

      loadServersSpy.mockResolvedValueOnce([createMockClient()]).mockResolvedValueOnce([createMockClient()])

      // Connect in reverse alphabetical order so .sort() is load-bearing.
      await tool.invoke({ command: 'connect', server_name: 'server-b', connection_id: 'conn-b' }, createContext(agent))
      await tool.invoke({ command: 'connect', server_name: 'server-a', connection_id: 'conn-a' }, createContext(agent))

      const result = await tool.invoke({ command: 'list_connections' }, createContext(agent))
      expect(result).toBe('conn-a, conn-b')
    })

    it('isolates connections between agents', async () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const agentA = createMockAgent()
      const agentB = createMockAgent()

      loadServersSpy.mockResolvedValueOnce([createMockClient()])

      await tool.invoke({ command: 'connect', server_name: 'mcp', connection_id: 'c1' }, createContext(agentA))

      const result = await tool.invoke({ command: 'list_connections' }, createContext(agentB))
      expect(result).toBe('')
    })
  })

  describe('tool metadata', () => {
    it('uses custom name', () => {
      const tool = makeMcpRouter({
        servers: { mcp: { url: 'https://mcp.example.com/mcp' } },
        name: 'my_mcp',
      })
      expect(tool.name).toBe('my_mcp')
    })

    it('exposes expected schema fields', () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      const props = (tool.toolSpec.inputSchema as { properties: Record<string, unknown> }).properties
      expect(props).toHaveProperty('command')
      expect(props).toHaveProperty('server_name')
      expect(props).toHaveProperty('connection_id')
      // tool_context should NOT appear in the schema
      expect(props).not.toHaveProperty('tool_context')
    })

    it('uses default description with MCP_ROUTER_DESCRIPTION', () => {
      const tool = makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
      expect(tool.toolSpec.description).toContain(MCP_ROUTER_DESCRIPTION)
    })

    it('accepts custom description', () => {
      const tool = makeMcpRouter({
        servers: { mcp: { url: 'https://mcp.example.com/mcp' } },
        description: 'Custom desc',
      })
      expect(tool.toolSpec.description).toBe('Custom desc')
    })
  })

  describe('garbage collection cleanup', () => {
    it('disconnects all connections when the callback fires and swallows errors', async () => {
      let capturedCallback: ((connections: Map<string, McpClient>) => void) | undefined
      const originalFinalizationRegistry = globalThis.FinalizationRegistry

      globalThis.FinalizationRegistry = class MockFinalizationRegistry {
        register = vi.fn()
        unregister = vi.fn()
        constructor(callback: (connections: Map<string, McpClient>) => void) {
          capturedCallback = callback
        }
      } as unknown as typeof FinalizationRegistry

      try {
        const clientA = createMockClient()
        const clientB = createMockClient({
          disconnect: vi.fn().mockRejectedValue(new Error('transport gone')),
        })

        makeMcpRouter({ servers: { mcp: { url: 'https://mcp.example.com/mcp' } } })
        expect(capturedCallback).toBeDefined()

        const connections = new Map<string, McpClient>([
          ['conn-a', clientA],
          ['conn-b', clientB],
        ])

        // Should not throw even though clientB rejects.
        expect(() => capturedCallback!(connections)).not.toThrow()

        await vi.waitFor(() => {
          expect(clientA.disconnect).toHaveBeenCalledOnce()
          expect(clientB.disconnect).toHaveBeenCalledOnce()
        })
      } finally {
        globalThis.FinalizationRegistry = originalFinalizationRegistry
      }
    })
  })
})
