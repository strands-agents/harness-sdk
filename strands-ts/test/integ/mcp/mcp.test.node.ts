/**
 * MCP Integration Tests
 *
 * Tests Agent integration with MCP servers using all supported transport types.
 * Verifies that agents can successfully use MCP tools via the Bedrock model.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { McpClient, Agent } from '@strands-agents/sdk'
import type { ElicitationCallback } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { startHTTPServer, type HttpServerInfo } from '../__fixtures__/test-mcp-server.js'
import { bedrock } from '../__fixtures__/model-providers.js'

type TransportConfig = {
  name: string
  createClient: () => McpClient | Promise<McpClient>
  cleanup?: () => Promise<void>
}

describe('MCP Integration Tests', () => {
  const serverPath = resolve(process.cwd(), 'test/integ/__fixtures__/test-mcp-server.ts')
  let httpServerInfo: HttpServerInfo | undefined

  beforeAll(async () => {
    // Start HTTP server
    httpServerInfo = await startHTTPServer()
  }, 30000)

  afterAll(async () => {
    if (httpServerInfo) {
      await httpServerInfo.close()
    }
  }, 30000)

  const transports: TransportConfig[] = [
    {
      name: 'stdio',
      createClient: () => {
        return new McpClient({
          applicationName: 'test-mcp-stdio',
          transport: new StdioClientTransport({
            command: 'npx',
            args: ['tsx', serverPath],
          }),
        })
      },
    },
    {
      name: 'Streamable HTTP',
      createClient: () => {
        if (!httpServerInfo) throw new Error('HTTP server not started')
        return new McpClient({
          applicationName: 'test-mcp-http',
          transport: new StreamableHTTPClientTransport(new URL(httpServerInfo.url)),
        })
      },
    },
  ]

  describe('filtering and prefixing through Agent', () => {
    function createLocalClient(prefix: string, allowed: string[]): McpClient {
      return new McpClient({
        applicationName: `test-mcp-${prefix}`,
        transport: new StdioClientTransport({
          command: 'npx',
          args: ['tsx', serverPath],
        }),
        prefix,
        toolFilters: { allowed },
      })
    }

    it('registers a prefixed filtered tool and executes it through the direct Agent tool API', async () => {
      const client = createLocalClient('filtered', ['echo'])
      const agent = new Agent({ tools: [client] })

      await agent.initialize()
      const result = await agent.tool.filtered_echo!.invoke({ message: 'direct integration' })

      expect(agent.toolRegistry.list().map((tool) => tool.name)).toEqual(['filtered_echo'])
      expect(result).toMatchObject({
        status: 'success',
        content: [{ type: 'textBlock', text: 'direct integration' }],
      })
      await client.disconnect()
    })

    it('reuses one filtered and prefixed client across two Agents', async () => {
      const client = createLocalClient('shared', ['echo'])
      const agent1 = new Agent({ tools: [client] })
      const agent2 = new Agent({ tools: [client] })

      await agent1.initialize()
      await agent2.initialize()
      const result1 = await agent1.tool.shared_echo!.invoke({ message: 'Agent 1' })
      const result2 = await agent2.tool.shared_echo!.invoke({ message: 'Agent 2' })

      expect(agent1.toolRegistry.list().map((tool) => tool.name)).toEqual(['shared_echo'])
      expect(agent2.toolRegistry.list().map((tool) => tool.name)).toEqual(['shared_echo'])
      expect(result1.content).toEqual([{ type: 'textBlock', text: 'Agent 1' }])
      expect(result2.content).toEqual([{ type: 'textBlock', text: 'Agent 2' }])
      await client.disconnect()
    })

    it('registers two distinct prefixes without collisions and invokes each raw server tool', async () => {
      const echoClient = createLocalClient('server1', ['echo'])
      const calculatorClient = createLocalClient('server2', ['calculator'])
      const agent = new Agent({ tools: [echoClient, calculatorClient] })

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
      await echoClient.disconnect()
      await calculatorClient.disconnect()
    })
  })

  describe.each(transports)('$name transport', ({ createClient }) => {
    it('agent can use multiple MCP tools in a conversation', async () => {
      const client = await createClient()
      const model = bedrock.createModel({ maxTokens: 300 })

      const agent = new Agent({
        systemPrompt:
          'You are a helpful assistant. Use the echo tool to repeat messages and the calculator tool for arithmetic.',
        tools: [client],
        model,
      })

      // First turn: Use echo tool
      await agent.invoke('Use the echo tool to say "Multi-turn test"')

      // Verify echo tool was used
      const hasEchoUse = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'echo')
      )
      expect(hasEchoUse).toBe(true)

      // Second turn: Use calculator tool in same conversation
      const result = await agent.invoke('Now use the calculator tool to add 15 and 27')

      expect(result).toBeDefined()
      expect(result.stopReason).toBeDefined()

      // Verify calculator tool was used
      const hasCalculatorUse = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'calculator')
      )
      expect(hasCalculatorUse).toBe(true)
    }, 60000)

    it('agent handles MCP tool errors gracefully', async () => {
      const client = await createClient()
      const model = bedrock.createModel({ maxTokens: 200 })

      const agent = new Agent({
        systemPrompt: 'You are a helpful assistant. If asked to test errors, use the error_tool.',
        tools: [client],
        model,
      })

      const result = await agent.invoke('Use the error_tool to test error handling.')

      expect(result).toBeDefined()

      // Verify the error was encountered
      const hasErrorResult = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolResultBlock' && block.status === 'error')
      )
      expect(hasErrorResult).toBe(true)
    }, 30000)
  })

  // Elicitation handler registration is transport-agnostic (happens in McpClient.connect),
  // so a single transport suffices here.
  describe('elicitation', () => {
    it('agent can use MCP tool that requests elicitation', async () => {
      const elicitationCallback: ElicitationCallback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { confirmed: true },
      })

      const client = new McpClient({
        applicationName: 'test-mcp-elicitation',
        transport: new StdioClientTransport({
          command: 'npx',
          args: ['tsx', serverPath],
        }),
        elicitationCallback,
      })

      const model = bedrock.createModel({ maxTokens: 300 })

      const agent = new Agent({
        systemPrompt: 'You are a helpful assistant. Use the confirm_action tool when asked to confirm something.',
        tools: [client],
        model,
      })

      const result = await agent.invoke('Use the confirm_action tool to confirm "deploy to production"')

      expect(result).toBeDefined()
      expect(result.stopReason).toBeDefined()
      expect(elicitationCallback).toHaveBeenCalled()

      const hasConfirmUse = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'confirm_action')
      )
      expect(hasConfirmUse).toBe(true)

      const hasSuccessResult = agent.messages.some((msg) =>
        msg.content.some((block) => block.type === 'toolResultBlock' && block.status === 'success')
      )
      expect(hasSuccessResult).toBe(true)

      await client.disconnect()
    }, 60000)
  })

  // The prompts and resources methods behave the same over every transport, so one transport is enough.
  describe('prompts and resources', () => {
    it('lists and renders prompts, reads static and templated resources', async () => {
      const client = new McpClient({
        applicationName: 'test-mcp-prompts-resources',
        transport: new StdioClientTransport({
          command: 'npx',
          args: ['tsx', serverPath],
        }),
      })

      const prompts = await client.listPrompts()
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(['summarize'])

      const prompt = await client.getPrompt('summarize', { topic: 'AI' })
      expect(prompt.messages[0]).toMatchObject({
        role: 'user',
        content: { type: 'text', text: 'Summarize the topic: AI' },
      })

      const resources = await client.listResources()
      expect(resources.resources.map((resource) => resource.uri)).toEqual(['test://greeting.txt'])

      const readStatic = await client.readResource('test://greeting.txt')
      expect(readStatic.contents[0]).toMatchObject({ text: 'Hello from the test resource' })

      const templates = await client.listResourceTemplates()
      expect(templates.resourceTemplates.map((template) => template.uriTemplate)).toEqual(['test://users/{userId}'])

      const readTemplated = await client.readResource(new URL('test://users/42'))
      expect(readTemplated.contents[0]).toMatchObject({ text: 'Data for user 42' })

      await client.disconnect()
    }, 30000)
  })
})
