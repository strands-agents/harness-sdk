/**
 * Legacy-Fallback MCP Integration Tests
 *
 * Part of the dual-era acceptance gate for the MCP client swap
 * (https://github.com/strands-agents/harness-sdk/issues/1659): mcp.test.node.ts
 * proves user-supplied legacy transports keep working, and this suite proves
 * the 2.0 client's OWN transports (the `url` config path and stdio commands)
 * work against a 2025-era server — auto version negotiation must probe for
 * 2026-07-28 and fall back to the legacy initialize handshake.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { McpClient } from '@strands-agents/sdk'
import type { ElicitationCallback } from '@strands-agents/sdk'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { resolve } from 'node:path'
import { URL } from 'node:url'
import { startHTTPServer, type HttpServerInfo } from '../__fixtures__/test-mcp-server.js'
import type { McpCallToolResult } from '../__fixtures__/test-helpers.js'

describe('MCP legacy era (2025-11-25) through the 2.0 client transports', () => {
  const serverPath = resolve(process.cwd(), 'test/integ/__fixtures__/test-mcp-server.ts')
  let httpServerInfo: HttpServerInfo

  beforeAll(async () => {
    httpServerInfo = await startHTTPServer()
  }, 30000)

  afterAll(async () => {
    await httpServerInfo.close()
  }, 30000)

  it('falls back to the legacy protocol revision over the 2.0 Streamable HTTP transport', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(httpServerInfo.url))
    const client = new McpClient({
      applicationName: 'test-mcp-legacy-fallback-http',
      transport,
    })

    const tools = await client.listTools()

    expect(transport.protocolVersion).toBe('2025-11-25')
    expect(tools.map((tool) => tool.name).sort()).toEqual(['calculator', 'confirm_action', 'echo', 'error_tool'])

    const echoTool = tools.find((tool) => tool.name === 'echo')!
    const rawResult = (await client.callTool(echoTool, { message: 'legacy fallback' })) as McpCallToolResult

    expect(rawResult.isError).toBeFalsy()
    expect(rawResult.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'legacy fallback' }]))

    await client.disconnect()
  })

  it('connects to a legacy server through the url config path', async () => {
    const client = new McpClient({
      applicationName: 'test-mcp-legacy-fallback-url',
      url: httpServerInfo.url,
    })

    const tools = await client.listTools()
    expect(client.client.getNegotiatedProtocolVersion()).toBe('2025-11-25')

    const calculatorTool = tools.find((tool) => tool.name === 'calculator')!
    const rawResult = (await client.callTool(calculatorTool, {
      operation: 'add',
      a: 15,
      b: 27,
    })) as McpCallToolResult

    expect(rawResult.isError).toBeFalsy()
    expect(rawResult.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'Result: 42' }]))

    await client.disconnect()
  })

  it('calls tools on a legacy server over the 2.0 stdio transport', async () => {
    const client = new McpClient({
      applicationName: 'test-mcp-legacy-fallback-stdio',
      transport: new StdioClientTransport({
        command: 'npx',
        args: ['tsx', serverPath],
      }),
    })

    const tools = await client.listTools()
    expect(client.client.getNegotiatedProtocolVersion()).toBe('2025-11-25')

    const echoTool = tools.find((tool) => tool.name === 'echo')!
    const rawResult = (await client.callTool(echoTool, { message: 'stdio fallback' })) as McpCallToolResult

    expect(rawResult.isError).toBeFalsy()
    expect(rawResult.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'stdio fallback' }]))

    await client.disconnect()
  })

  it('answers server-initiated elicitation on a legacy connection over the 2.0 stdio transport', async () => {
    const elicitationCallback: ElicitationCallback = vi.fn().mockResolvedValue({
      action: 'accept',
      content: { confirmed: true },
    })

    const client = new McpClient({
      applicationName: 'test-mcp-legacy-fallback-elicitation',
      transport: new StdioClientTransport({
        command: 'npx',
        args: ['tsx', serverPath],
      }),
      elicitationCallback,
    })

    const tools = await client.listTools()
    expect(client.client.getNegotiatedProtocolVersion()).toBe('2025-11-25')

    const confirmTool = tools.find((tool) => tool.name === 'confirm_action')!
    const rawResult = (await client.callTool(confirmTool, { action: 'deploy' })) as McpCallToolResult

    expect(elicitationCallback).toHaveBeenCalled()
    expect(rawResult.isError).toBeFalsy()
    expect(rawResult.content).toEqual(
      expect.arrayContaining([{ type: 'text', text: 'Action "deploy" confirmed by user' }])
    )

    await client.disconnect()
  })
})
