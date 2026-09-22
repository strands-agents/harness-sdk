/**
 * Modern-Era Test MCP Server Implementation
 *
 * Serves the 2026-07-28 protocol revision over streamable HTTP using
 * `@modelcontextprotocol/server`'s `createMcpHandler`, mounted on a plain
 * node:http server with `toNodeHandler` from `@modelcontextprotocol/node`.
 *
 * Registers the same echo, calculator, and error_tool tools as the legacy
 * fixture (test-mcp-server.ts) so both protocol eras run the same flows.
 * The legacy fixture's confirm_action tool is deliberately absent: the
 * 2026-07-28 revision has no server-initiated elicitation channel.
 */

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as z from 'zod/v4'

/**
 * Creates a modern-era test MCP server with echo, calculator, and error_tool tools.
 */
function createModernTestServer(): McpServer {
  const server = new McpServer(
    {
      name: 'test-mcp-server-modern',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  server.registerTool(
    'echo',
    {
      title: 'Echo Tool',
      description: 'Echoes back the input message',
      inputSchema: {
        message: z.string(),
      },
      outputSchema: {
        echo: z.string(),
      },
    },
    async ({ message }) => {
      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        structuredContent: { echo: message },
      }
    }
  )

  server.registerTool(
    'calculator',
    {
      title: 'Calculator Tool',
      description: 'Performs basic arithmetic operations',
      inputSchema: {
        operation: z.enum(['add', 'subtract', 'multiply', 'divide']),
        a: z.number(),
        b: z.number(),
      },
      outputSchema: {
        result: z.number(),
      },
    },
    async ({ operation, a, b }) => {
      let result: number

      switch (operation) {
        case 'add':
          result = a + b
          break
        case 'subtract':
          result = a - b
          break
        case 'multiply':
          result = a * b
          break
        case 'divide':
          if (b === 0) {
            throw new Error('Division by zero')
          }
          result = a / b
          break
      }

      return {
        content: [
          {
            type: 'text',
            text: `Result: ${result}`,
          },
        ],
        structuredContent: { result },
      }
    }
  )

  server.registerTool(
    'error_tool',
    {
      title: 'Error Tool',
      description: 'Intentionally throws an error for testing error handling',
      inputSchema: {
        error_message: z.string().optional(),
      },
    },
    async ({ error_message }) => {
      throw new Error(error_message || 'Intentional error')
    }
  )

  return server
}

/**
 * Interface for modern-era HTTP server info
 */
export interface ModernHttpServerInfo {
  server: HttpServer
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Creates and starts a modern-era (2026-07-28) streamable HTTP MCP server on a random port.
 * `createMcpHandler` builds a fresh server instance for each request, so serving is stateless.
 */
export async function startModernHTTPServer(): Promise<ModernHttpServerInfo> {
  const mcpHandler = createMcpHandler(() => createModernTestServer())
  const nodeHandler = toNodeHandler(mcpHandler)

  const httpServer = createServer((req, res) => {
    // Node types `method`/`url` as `string | undefined` while the adapter's duck-typed shape
    // uses bare optionals, which exactOptionalPropertyTypes rejects; the runtime shapes match.
    nodeHandler(req as Parameters<typeof nodeHandler>[0], res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500)
      }
      res.end()
    })
  })

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as AddressInfo
      const port = address.port

      resolve({
        server: httpServer,
        port,
        url: `http://localhost:${port}/mcp`,
        close: async () => {
          // A connected 2026-07-28 client holds a `subscriptions/listen` stream open, and
          // `httpServer.close()` waits for it. Tear down the handler's modern exchanges and
          // drop remaining sockets so close never hangs on a client that did not disconnect.
          await mcpHandler.close()
          httpServer.closeAllConnections()
          return new Promise((resolveClose) => {
            httpServer.close(() => {
              resolveClose()
            })
          })
        },
      })
    })
  })
}
