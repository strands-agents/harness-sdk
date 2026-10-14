import { once } from 'node:events'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { describe, it, expect, vi } from 'vitest'
import { McpClient } from '@strands-agents/sdk'
import type { AddressInfo } from 'node:net'

describe('McpClient', () => {
  describe('connect with an aborted creator', () => {
    // The real transport must remain usable while a cancelled creator's handshake is pending (#5045).
    it.each([false, true])(
      'shares the HTTP handshake and executes a tool (continueOnError=%s)',
      async (continueOnError) => {
        let received!: () => void
        const requestReceived = new Promise<void>((resolve) => {
          received = resolve
        })
        let release!: () => void
        const handshakeReleased = new Promise<void>((resolve) => {
          release = resolve
        })
        const handler = createMcpHandler(() => {
          const server = new McpServer({ name: 'connect-abort-test', version: '1.0.0' })
          server.registerTool('echo', { inputSchema: {} }, () => ({
            content: [{ type: 'text' as const, text: 'still usable' }],
          }))
          return server
        })
        const nodeHandler = toNodeHandler(handler)
        const httpServer = createServer((request, response) => {
          received()
          void handshakeReleased.then(() => nodeHandler(request as Parameters<typeof nodeHandler>[0], response))
        })
        await once(httpServer.listen(0, '127.0.0.1'), 'listening')
        const address = httpServer.address() as AddressInfo
        const client = new McpClient({
          applicationName: 'connect-abort-test',
          url: `http://127.0.0.1:${address.port}/mcp`,
          continueOnError,
        })
        const connect = vi.spyOn(client.client, 'connect')
        const controller = new AbortController()
        const reason = new Error('creator left')
        const creator = client.connect(false, { signal: controller.signal })
        // Attach before awaiting network I/O so a failure is never left unobserved.
        const cancelled = expect(creator).rejects.toBe(reason)

        try {
          await requestReceived
          controller.abort(reason)
          await cancelled
          const follower = client.connect()
          void follower.catch(() => undefined)
          expect(connect).toHaveBeenCalledTimes(1)
          release()
          await expect(follower).resolves.toBeUndefined()

          const tools = await client.listTools()
          expect(tools.map((tool) => tool.name)).toEqual(['echo'])
          expect(await client.callTool(tools[0]!, {})).toEqual({
            content: [{ type: 'text', text: 'still usable' }],
            _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'connect-abort-test', version: '1.0.0' } },
          })
          expect(client.connectionState).toBe('connected')
          expect(connect).toHaveBeenCalledTimes(1)
        } finally {
          release()
          await creator.catch(() => undefined)
          await client.disconnect()
          await handler.close()
          await promisify(httpServer.close.bind(httpServer))()
        }
      }
    )
  })
})
