import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest'
import { McpClient, Agent } from '@strands-agents/sdk'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { MockMessageModel } from '$/sdk/__fixtures__/mock-message-model.js'
import { startHTTPServer, type HttpServerInfo } from '../__fixtures__/test-mcp-v2-server.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { hasToolUse, countToolResults, getToolResultText } from '../__fixtures__/test-helpers.js'

import type { ElicitationCallback as ElicitationCallback, McpClientOptions } from '@strands-agents/sdk'

describe('MCP v2 Integration Tests', () => {
  const serverPath = resolve('test/integ/__fixtures__/test-mcp-v2-server.ts')
  let httpServerInfo: HttpServerInfo

  beforeAll(async () => {
    httpServerInfo = await startHTTPServer()
  }, 30000)

  afterAll(async () => {
    await httpServerInfo?.close()
  }, 30000)

  function createStdioClient(options: McpClientOptions = {}): McpClient {
    const client = new McpClient({
      applicationName: 'test-mcp-stdio',
      transport: new StdioClientTransport({ command: 'npx', args: ['tsx', serverPath] }),
      ...options,
    })
    onTestFinished(() => client.disconnect())
    return client
  }

  describe('filtering and prefixing through Agent', () => {
    it('registers a prefixed filtered tool and executes it through the direct Agent tool API', async () => {
      const client = createStdioClient({ prefix: 'filtered', toolFilters: { allowed: ['echo'] } })
      const agent = new Agent({ tools: [client], model: new MockMessageModel() })

      await agent.initialize()
      const result = await agent.tool.filtered_echo!.invoke({ message: 'direct integration' })

      expect(agent.toolRegistry.list().map((tool) => tool.name)).toEqual(['filtered_echo'])
      expect(result).toMatchObject({
        status: 'success',
        content: [{ type: 'textBlock', text: 'direct integration' }],
      })
    })

    it('reuses one filtered and prefixed client across two Agents', async () => {
      const client = createStdioClient({ prefix: 'shared', toolFilters: { allowed: ['echo'] } })
      const agent1 = new Agent({ tools: [client], model: new MockMessageModel() })
      const agent2 = new Agent({ tools: [client], model: new MockMessageModel() })

      await agent1.initialize()
      await agent2.initialize()
      const result1 = await agent1.tool.shared_echo!.invoke({ message: 'Agent 1' })
      const result2 = await agent2.tool.shared_echo!.invoke({ message: 'Agent 2' })

      expect(agent1.toolRegistry.list().map((tool) => tool.name)).toEqual(['shared_echo'])
      expect(agent2.toolRegistry.list().map((tool) => tool.name)).toEqual(['shared_echo'])
      expect(result1.content).toEqual([{ type: 'textBlock', text: 'Agent 1' }])
      expect(result2.content).toEqual([{ type: 'textBlock', text: 'Agent 2' }])
    })

    it('registers two distinct prefixes without collisions and invokes each raw server tool', async () => {
      const echoClient = createStdioClient({ prefix: 'server1', toolFilters: { allowed: ['echo'] } })
      const calculatorClient = createStdioClient({ prefix: 'server2', toolFilters: { allowed: ['calculator'] } })
      const agent = new Agent({ tools: [echoClient, calculatorClient], model: new MockMessageModel() })

      await agent.initialize()
      const echoResult = await agent.tool.server1_echo!.invoke({ message: 'From Server 1' })
      const calculatorResult = await agent.tool.server2_calculator!.invoke({ operation: 'add', a: 2, b: 3 })

      expect(
        agent.toolRegistry
          .list()
          .map((tool) => tool.name)
          .sort()
      ).toEqual(['server1_echo', 'server2_calculator'])
      expect(echoResult.content).toEqual([{ type: 'textBlock', text: 'From Server 1' }])
      expect(calculatorResult.content).toEqual([{ type: 'textBlock', text: 'Result: 5' }])
    })
  })

  const transports = [
    { name: 'stdio', createClient: createStdioClient },
    {
      name: 'Streamable HTTP',
      createClient: (): McpClient => {
        const client = new McpClient({
          applicationName: 'test-mcp-http',
          transport: new StreamableHTTPClientTransport(new URL(httpServerInfo.url)),
        })
        onTestFinished(() => client.disconnect())
        return client
      },
    },
  ]

  describe.each(transports)('$name transport', ({ createClient }) => {
    it('agent can use multiple MCP tools in a conversation', async () => {
      const model = new MockMessageModel()
      const agent = new Agent({ tools: [createClient()], model })
      for (const { name, input } of [
        { name: 'echo', input: { message: 'Multi-turn test' } },
        { name: 'calculator', input: { operation: 'add', a: 15, b: 27 } },
      ]) {
        model
          .addTurn({ type: 'toolUseBlock', name, toolUseId: name, input })
          .addTurn({ type: 'textBlock', text: 'Done' })
        await expect(agent.invoke(`Use ${name}`)).resolves.toMatchObject({ stopReason: 'endTurn' })
        expect(hasToolUse(agent.messages, name)).toBe(true)
      }

      expect(countToolResults(agent.messages, 'success')).toBe(2)
      expect(getToolResultText(agent.messages)).toBe('Multi-turn test Result: 42')
    }, 60000)

    it('agent handles MCP tool errors gracefully', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'error_tool', toolUseId: 'error', input: {} })
        .addTurn({ type: 'textBlock', text: 'Error handled' })
      const agent = new Agent({ tools: [createClient()], model })
      await expect(agent.invoke('Test error handling')).resolves.toMatchObject({ stopReason: 'endTurn' })
      expect(countToolResults(agent.messages, 'error')).toBe(1)
    }, 30000)
  })

  describe('elicitation', () => {
    it('agent can use MCP tool that requests elicitation with a live model', async () => {
      const elicitationCallback: ElicitationCallback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { confirmed: true },
      })
      const agent = new Agent({
        systemPrompt: 'You are a helpful assistant. Use the confirm_action tool when asked to confirm something.',
        tools: [createStdioClient({ elicitationCallback })],
        model: bedrock.createModel({ maxTokens: 300 }),
      })

      const result = await agent.invoke('Use the confirm_action tool to confirm "deploy to production"')

      expect(result.stopReason).toBeDefined()
      expect(elicitationCallback).toHaveBeenCalled()
      expect(hasToolUse(agent.messages, 'confirm_action')).toBe(true)
      expect(countToolResults(agent.messages, 'success')).toBeGreaterThan(0)
    }, 60000)
  })
})
