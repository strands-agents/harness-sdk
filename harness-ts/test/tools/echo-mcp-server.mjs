/**
 * MCP server fixture for tests that need a real stdio server.
 *
 * Exposes an `echo` tool and an `add` tool so tests can check that a server's tools reach an agent
 * (and its subagents) under the configured prefix. Spawned over stdio by the test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const text = (value) => ({ content: [{ type: 'text', text: value }] })

const server = new McpServer({ name: 'Echo Test Server', version: '0.0.0' })

server.registerTool('echo', { description: 'Echoes the given text back', inputSchema: { text: z.string() } }, (a) =>
  text(`echo:${a.text}`)
)
server.registerTool('add', { description: 'Adds two integers', inputSchema: { a: z.number(), b: z.number() } }, (a) =>
  text(String(a.a + a.b))
)

await server.connect(new StdioServerTransport())
