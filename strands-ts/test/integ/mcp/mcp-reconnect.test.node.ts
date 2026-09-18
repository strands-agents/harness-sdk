/**
 * MCP Reconnection Integration Tests
 *
 * Exercises McpClient recovery against a real streamable HTTP server: a failed connect
 * under continueOnError recovers with connect(true) once the server is up, and a client
 * can connect again after disconnect. Guards against #4095.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { McpClient } from '@strands-agents/sdk'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { startHTTPServer, type HttpServerInfo } from '../__fixtures__/test-mcp-server.js'

/** Reserves a free TCP port by binding to port 0 and releasing it. */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

describe('MCP Reconnection Integration Tests', () => {
  let httpServerInfo: HttpServerInfo | undefined

  afterEach(async () => {
    if (httpServerInfo) {
      await httpServerInfo.close()
      httpServerInfo = undefined
    }
  })

  it('recovers with connect(true) once the server becomes available', async () => {
    const port = await reserveFreePort()
    const client = new McpClient({
      applicationName: 'test-mcp-reconnect',
      url: `http://localhost:${port}/mcp`,
      continueOnError: true,
    })

    const toolsWhileDown = await client.listTools()
    expect(toolsWhileDown).toEqual([])
    expect(client.connectionState).toBe('failed')

    httpServerInfo = await startHTTPServer(port)
    await client.connect(true)
    expect(client.connectionState).toBe('connected')

    const tools = await client.listTools()
    const echoTool = tools.find((tool) => tool.name === 'echo')
    expect(echoTool).toBeDefined()

    const result = await client.callTool(echoTool!, { message: 'back online' })
    expect(JSON.stringify(result)).toContain('back online')

    await client.disconnect()
  }, 30000)

  it('connects again after disconnect', async () => {
    httpServerInfo = await startHTTPServer()
    const client = new McpClient({
      applicationName: 'test-mcp-reconnect',
      url: httpServerInfo.url,
    })

    const firstTools = await client.listTools()
    expect(firstTools.length).toBeGreaterThan(0)
    await client.disconnect()

    const secondTools = await client.listTools()
    expect(secondTools.map((tool) => tool.name)).toEqual(firstTools.map((tool) => tool.name))

    await client.disconnect()
  }, 30000)
})
