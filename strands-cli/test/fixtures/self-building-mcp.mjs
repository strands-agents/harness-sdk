import { readFile } from 'node:fs/promises'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'self-building-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'probe', description: 'Read the workspace marker.', inputSchema: { type: 'object' } }],
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        cwd: process.cwd(),
        pid: process.pid,
        marker: await readFile('mcp-marker.txt', 'utf8'),
      }),
    },
  ],
}))
await server.connect(new StdioServerTransport())
