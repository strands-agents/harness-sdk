/**
 * Modern-Era MCP Integration Tests
 *
 * The modern half of the dual-era acceptance gate for the MCP client swap
 * (https://github.com/strands-agents/harness-sdk/issues/1659): mcp.test.node.ts
 * drives legacy 2025-era servers, and this suite proves the same build
 * negotiates the 2026-07-28 protocol revision against a modern server over
 * streamable HTTP and runs the same agent flows on it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpClient, Agent } from '@strands-agents/sdk'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { URL } from 'node:url'
import { startModernHTTPServer, type ModernHttpServerInfo } from '../__fixtures__/test-mcp-server-modern.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import type { McpCallToolResult } from '../__fixtures__/test-helpers.js'

describe('MCP modern era (2026-07-28) over Streamable HTTP', () => {
  let serverInfo: ModernHttpServerInfo

  beforeAll(async () => {
    serverInfo = await startModernHTTPServer()
  }, 30000)

  afterAll(async () => {
    await serverInfo.close()
  }, 30000)

  it('negotiates protocol revision 2026-07-28 and calls tools on the modern connection', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(serverInfo.url))
    const client = new McpClient({
      applicationName: 'test-mcp-modern',
      transport,
    })

    const tools = await client.listTools()

    expect(transport.protocolVersion).toBe('2026-07-28')
    expect(tools.map((tool) => tool.name).sort()).toEqual(['calculator', 'echo', 'error_tool'])

    const echoTool = tools.find((tool) => tool.name === 'echo')!
    const rawResult = (await client.callTool(echoTool, { message: 'modern era' })) as McpCallToolResult

    expect(rawResult.isError).toBeFalsy()
    expect(rawResult.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'modern era' }]))

    await client.disconnect()
  })

  it('agent can use multiple MCP tools in a conversation over the modern connection', async () => {
    const client = new McpClient({
      applicationName: 'test-mcp-modern-agent',
      url: serverInfo.url,
    })
    const model = bedrock.createModel({ maxTokens: 300 })

    const agent = new Agent({
      systemPrompt:
        'You are a helpful assistant. Use the echo tool to repeat messages and the calculator tool for arithmetic.',
      tools: [client],
      model,
    })

    await agent.invoke('Use the echo tool to say "Multi-turn test"')

    expect(client.client.getNegotiatedProtocolVersion()).toBe('2026-07-28')

    const hasEchoUse = agent.messages.some((msg) =>
      msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'echo')
    )
    expect(hasEchoUse).toBe(true)

    const result = await agent.invoke('Now use the calculator tool to add 15 and 27')

    expect(result).toBeDefined()
    expect(result.stopReason).toBeDefined()

    const hasCalculatorUse = agent.messages.some((msg) =>
      msg.content.some((block) => block.type === 'toolUseBlock' && block.name === 'calculator')
    )
    expect(hasCalculatorUse).toBe(true)

    await client.disconnect()
  }, 60000)

  it('agent handles MCP tool errors gracefully over the modern connection', async () => {
    const client = new McpClient({
      applicationName: 'test-mcp-modern-errors',
      url: serverInfo.url,
    })
    const model = bedrock.createModel({ maxTokens: 200 })

    const agent = new Agent({
      systemPrompt: 'You are a helpful assistant. If asked to test errors, use the error_tool.',
      tools: [client],
      model,
    })

    const result = await agent.invoke('Use the error_tool to test error handling.')

    expect(result).toBeDefined()
    expect(client.client.getNegotiatedProtocolVersion()).toBe('2026-07-28')

    const hasErrorResult = agent.messages.some((msg) =>
      msg.content.some((block) => block.type === 'toolResultBlock' && block.status === 'error')
    )
    expect(hasErrorResult).toBe(true)

    await client.disconnect()
  }, 30000)
})
