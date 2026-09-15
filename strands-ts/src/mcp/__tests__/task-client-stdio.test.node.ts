import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it } from 'vitest'

import { McpClient } from '../client.js'
import { McpTool } from '../../tools/mcp-tool.js'

const LEGACY_STDIO_SERVER = `
import { createInterface } from 'node:readline'

const lines = createInterface({ input: process.stdin })
const send = (message) => {
  process.stdout.write(JSON.stringify(message) + '\\n')
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'server/discover') {
    process.exit(0)
  }
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-stdio-test-server', version: '1.0.0' },
      },
    })
  } else if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'legacy stdio direct' }] },
    })
  }
})
`

describe('McpClient SEP-2663 tasks', () => {
  describe('protocol compatibility', () => {
    it('uses a disposable probe when a legacy stdio server exits on server/discover', async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--input-type=module', '--eval', LEGACY_STDIO_SERVER],
        stderr: 'pipe',
      })
      const client = new McpClient({
        transport,
        tasksConfig: {
          ttl: 1_000,
          timeoutMs: 2_000,
          useNotifications: false,
        },
      })
      const tool = new McpTool({
        name: 'legacy_tool',
        description: 'Legacy direct tool',
        inputSchema: { type: 'object' },
        client,
      })

      try {
        await expect(client.callTool(tool, {})).resolves.toEqual({
          content: [{ type: 'text', text: 'legacy stdio direct' }],
        })
        expect(client.client.getProtocolEra()).toBe('legacy')
      } finally {
        await client.disconnect().catch(() => undefined)
      }
    })
  })
})
