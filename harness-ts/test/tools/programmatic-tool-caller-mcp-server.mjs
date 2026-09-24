/**
 * MCP server for programmatic-tool-caller integration testing.
 *
 * Exposes a few simple tools, including one whose name is not a valid JavaScript identifier
 * (`ptc-dash`), so the test can verify that agent-authored code can call MCP tools regardless of how
 * the server names them. Spawned over stdio by the test.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const text = (value) => ({ content: [{ type: 'text', text: value }] })

const server = new McpServer({ name: 'Programmatic Tool Caller Test Server', version: '0.0.0' })

server.registerTool('ptc_echo', { description: 'Echoes the given text back', inputSchema: { text: z.string() } }, (a) =>
  text(`echo:${a.text}`)
)
server.registerTool(
  'ptc_add',
  { description: 'Adds two integers', inputSchema: { a: z.number(), b: z.number() } },
  (a) => text(String(a.a + a.b))
)
server.registerTool(
  'ptc-dash',
  { description: 'Tool whose name contains a hyphen', inputSchema: { value: z.string() } },
  (a) => text(`dash:${a.value}`)
)
server.registerTool('ptc_boom', { description: 'Always raises', inputSchema: {} }, () => {
  throw new Error('mcp tool exploded')
})

await server.connect(new StdioServerTransport())
