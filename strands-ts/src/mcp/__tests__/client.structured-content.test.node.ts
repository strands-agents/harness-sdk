import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as z from 'zod/v4'
import { McpClient } from '../client.js'
import type { ToolResultBlock } from '../../types/messages.js'
import type { LocalAgent } from '../../types/agent.js'
import type { ToolContext } from '../../tools/tool.js'

/**
 * Transport-boundary coverage for structuredContent: a real MCP server connected
 * over a linked in-memory transport, so the MCP SDK's result validation runs.
 * The mocked tests in client.test.ts bypass that validation layer.
 */
describe('structuredContent through a real MCP transport', () => {
  let server: McpServer
  let client: McpClient

  beforeEach(async () => {
    server = new McpServer({ name: 'structured-content-test-server', version: '1.0.0' })
    server.registerTool(
      'weather',
      {
        description: 'Returns weather with structured output',
        inputSchema: { city: z.string() },
        outputSchema: { temperature: z.number(), conditions: z.string() },
      },
      async ({ city }) => ({
        content: [{ type: 'text', text: `Weather for ${city}` }],
        structuredContent: { temperature: 72, conditions: 'sunny' },
      })
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    client = new McpClient({ applicationName: 'structured-content-test', transport: clientTransport })
    await client.connect()
  })

  afterEach(async () => {
    await client.disconnect()
    await server.close()
  })

  it('preserves object-valued structuredContent end to end', async () => {
    const tools = await client.listTools()
    const weatherTool = tools.find((tool) => tool.name === 'weather')
    expect(weatherTool).toBeDefined()

    const toolContext: ToolContext = {
      toolUse: { toolUseId: 'id-123', name: 'weather', input: { city: 'NYC' } },
      agent: { cancelSignal: new AbortController().signal } as LocalAgent,
      invocationState: {},
      interrupt: () => {
        throw new Error('interrupt not available in test context')
      },
    }

    const generator = weatherTool!.stream(toolContext)
    let iteration = await generator.next()
    while (!iteration.done) {
      iteration = await generator.next()
    }
    const result = iteration.value as ToolResultBlock

    expect(result.status).toBe('success')
    expect(result.structuredContent).toEqual({ temperature: 72, conditions: 'sunny' })
  })
})
