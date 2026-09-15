/**
 * Test MCP Server Implementation
 *
 * Provides a simple MCP server with test tools for integration testing.
 * Supports stdio and HTTP transports.
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as z from 'zod/v4'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/**
 * Creates a test MCP server with echo, calculator, and error_tool tools using registerTool.
 */
function createTestServer(): McpServer {
  const server = new McpServer(
    {
      name: 'test-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register echo tool
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
      const output = { echo: message }
      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        structuredContent: output,
      }
    }
  )

  // Register calculator tool
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

      const output = { result }
      return {
        content: [
          {
            type: 'text',
            text: `Result: ${result}`,
          },
        ],
        structuredContent: output,
      }
    }
  )

  // Register confirm_action tool (tests elicitation)
  server.registerTool(
    'confirm_action',
    {
      title: 'Confirm Action Tool',
      description: 'Asks the user to confirm before proceeding. Use this tool when you need user confirmation.',
      inputSchema: {
        action: z.string(),
      },
    },
    async ({ action }) => {
      const result = await server.server.elicitInput({
        message: `Do you want to proceed with: ${action}?`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirmed: { type: 'boolean', description: 'Whether the user confirms' },
          },
        },
      })

      if (result.action === 'accept') {
        return {
          content: [{ type: 'text', text: `Action "${action}" confirmed by user` }],
        }
      }

      return {
        content: [{ type: 'text', text: `Action "${action}" was ${result.action}d by user` }],
      }
    }
  )

  // Register a prompt, a static resource, and a resource template (exercises the
  // prompts/resources client APIs)
  server.registerPrompt(
    'summarize',
    {
      title: 'Summarize Prompt',
      description: 'Builds a summarization request for a topic',
      argsSchema: {
        topic: z.string(),
      },
    },
    ({ topic }) => ({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Summarize the topic: ${topic}` },
        },
      ],
    })
  )

  server.registerResource(
    'greeting',
    'test://greeting.txt',
    {
      title: 'Greeting Resource',
      description: 'A static text resource',
      mimeType: 'text/plain',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, text: 'Hello from the test resource', mimeType: 'text/plain' }],
    })
  )

  server.registerResource(
    'user-file',
    new ResourceTemplate('test://users/{userId}', { list: undefined }),
    {
      title: 'User File Template',
      description: 'A templated resource addressed by user id',
    },
    async (uri, { userId }) => ({
      contents: [{ uri: uri.href, text: `Data for user ${String(userId)}`, mimeType: 'text/plain' }],
    })
  )

  // Register error tool
  server.registerTool(
    'error_tool',
    {
      title: 'Error Tool',
      description: 'Intentionally throws an error for testing error handling',
      inputSchema: {
        error_message: z.string().optional(),
      },
      outputSchema: {
        error: z.string(),
      },
    },
    async ({ error_message }) => {
      const message = error_message || 'Intentional error'
      throw new Error(message)
    }
  )

  return server
}

/**
 * Interface for HTTP-based server info
 */
export interface HttpServerInfo {
  server: HttpServer
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Creates and starts a Streamable HTTP MCP server on a random port.
 * Uses stateless mode - creates a new transport for each request.
 */
export async function startHTTPServer(): Promise<HttpServerInfo> {
  const mcpServer = createTestServer()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/mcp' && req.method === 'POST') {
      try {
        // Read request body
        let body = ''
        await new Promise<void>((resolve) => {
          req.on('data', (chunk) => {
            body += chunk.toString()
          })
          req.on('end', () => {
            resolve()
          })
        })

        const parsedBody = body ? JSON.parse(body) : undefined

        // Create a new transport for each request (stateless mode)
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        })

        res.on('close', async () => {
          await transport.close()
        })

        await mcpServer.connect(transport as Transport)
        await transport.handleRequest(req, res, parsedBody)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Internal server error',
              },
              id: null,
            })
          )
        }
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as AddressInfo
      const port = address.port
      const url = `http://localhost:${port}/mcp`

      resolve({
        server: httpServer,
        port,
        url,
        close: async () => {
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

// Start the stdio server when this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createTestServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
