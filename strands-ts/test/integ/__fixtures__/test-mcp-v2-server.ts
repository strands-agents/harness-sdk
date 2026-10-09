/**
 * Test MCP Server Implementation
 *
 * Provides a simple MCP server with test tools for integration testing.
 * Supports stdio and HTTP transports.
 */

import {
  acceptedContent,
  createMcpHandler,
  inputRequired,
  inputResponse,
  McpServer,
} from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import * as z from 'zod/v4'

/**
 * Creates a test MCP server with echo, calculator, and error_tool tools using registerTool.
 */
function createTestServer(): McpServer {
  const confirmationSchema = z.object({
    confirmed: z.boolean().describe('Whether the user confirms'),
  })

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
    ({ action }, context) => {
      const response = inputResponse(context.mcpReq.inputResponses, 'confirmation')
      if (response.kind === 'missing') {
        return inputRequired({
          inputRequests: {
            confirmation: inputRequired.elicit({
              message: `Do you want to proceed with: ${action}?`,
              requestedSchema: confirmationSchema,
            }),
          },
        })
      }

      if (response.kind !== 'elicit') {
        throw new Error('Confirmation input returned an unexpected response type')
      }
      if (response.action !== 'accept') {
        const outcome = response.action === 'cancel' ? 'cancelled' : 'declined'
        return { content: [{ type: 'text', text: `Action "${action}" was ${outcome} by user` }] }
      }

      const content = acceptedContent(context.mcpReq.inputResponses, 'confirmation', confirmationSchema)
      return content?.confirmed
        ? { content: [{ type: 'text', text: `Action "${action}" confirmed by user` }] }
        : { content: [{ type: 'text', text: `Action "${action}" was declined by user` }] }
    }
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
  const protocolHandler = createMcpHandler(createTestServer)
  const nodeHandler = toNodeHandler(protocolHandler)
  const httpServer = createServer((request, response) => {
    const protocolRequest = request as Parameters<typeof nodeHandler>[0]
    if (new URL(request.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp') {
      response.writeHead(404)
      response.end()
      return
    }
    void nodeHandler(protocolRequest, response)
  })

  await once(httpServer.listen(0, '127.0.0.1'), 'listening')
  const address = httpServer.address() as AddressInfo
  return {
    server: httpServer,
    port: address.port,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async (): Promise<void> => {
      await protocolHandler.close()
      await promisify(httpServer.close.bind(httpServer))()
    },
  }
}

// Start the stdio server when this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  void serveStdio(createTestServer)
}
