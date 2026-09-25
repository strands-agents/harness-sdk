import { describe, it, expect, vi } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { TextBlock, ToolResultBlock } from '../../types/messages.js'
import { McpClient } from '../client.js'

describe('McpClient tool names', () => {
  it.each(['aws-iac', 'awslabs_aws-iac-mcp-server'])(
    'invokes the registered tool with prefix %s after rediscovery',
    async (prefix) => {
      // Prefixed MCP tools must remain usable within the registry name limit (#4513).
      const server = new McpServer({ name: 'name-limit-test', version: '1.0.0' })
      const serverToolName = 'get_cloudformation_pre_deploy_validation_instructions'
      const executeTool = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'validation instructions' }],
      }))
      server.registerTool(
        serverToolName,
        { description: 'Return validation instructions', inputSchema: {} },
        executeTool
      )
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.connect(serverTransport)
      const client = new McpClient({ transport: clientTransport, prefix })
      const model = new MockMessageModel()
      const agent = new Agent({ model, tools: [client], printer: false })

      try {
        await agent.initialize()
        expect(agent.tools).toHaveLength(1)
        const registeredName = agent.tools[0]!.toolSpec.name
        expect(registeredName.length).toBeLessThanOrEqual(64)
        const tools = await client.listTools()
        expect(tools).toHaveLength(1)
        expect(tools[0]!.name.length).toBeLessThanOrEqual(64)
        expect(await client.callTool(tools[0]!, {})).toEqual({
          content: [{ type: 'text', text: 'validation instructions' }],
        })

        model
          .addTurn({ type: 'toolUseBlock', name: registeredName, toolUseId: 'validation', input: {} })
          .addTurn({ type: 'textBlock', text: 'Validation complete' })
        await agent.invoke('Get validation instructions')

        const toolResults = agent.messages
          .flatMap((message) => message.content)
          .filter((block) => block.type === 'toolResultBlock')
        expect(toolResults).toEqual([
          new ToolResultBlock({
            toolUseId: 'validation',
            status: 'success',
            content: [new TextBlock('validation instructions')],
          }),
        ])
        expect(executeTool).toHaveBeenCalledTimes(2)
      } finally {
        await client.disconnect()
        await server.close()
      }
    }
  )
})
