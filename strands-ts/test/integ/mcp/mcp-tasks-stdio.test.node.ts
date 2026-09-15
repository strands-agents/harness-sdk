import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpClient } from '@strands-agents/sdk'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

describe('McpClient legacy MCP tasks', () => {
  describe('stdio transport', () => {
    const client = new McpClient({
      applicationName: 'test-legacy-task-stdio',
      transport: new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', resolve('test/integ/__fixtures__/test-mcp-task-server.ts')],
        stderr: 'pipe',
      }),
      tasksConfig: { ttl: 1_000, pollTimeout: 5_000 },
    })

    beforeAll(async () => {
      await client.connect()
    }, 30_000)

    afterAll(async () => {
      await client.disconnect()
    }, 30_000)

    it.each([
      {
        name: 'instant_task',
        args: { value: 'stdio instant result' },
        text: 'stdio instant result',
      },
      {
        name: 'long_running_task',
        args: { duration: 100, message: 'stdio long-running result' },
        text: 'stdio long-running result',
      },
    ])('returns the final result from $name', async ({ name, args, text }) => {
      const tools = await client.listTools()
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) throw new Error(`${name} tool not found`)

      await expect(client.callTool(tool, args)).resolves.toMatchObject({
        content: [{ type: 'text', text }],
      })
    })

    it('rejects a failed task', async () => {
      const tools = await client.listTools()
      const tool = tools.find((candidate) => candidate.name === 'failing_task')
      if (!tool) throw new Error('failing_task tool not found')

      await expect(client.callTool(tool, { error_message: 'stdio task failed' })).rejects.toThrow(/failed/i)
    })
  })
})
