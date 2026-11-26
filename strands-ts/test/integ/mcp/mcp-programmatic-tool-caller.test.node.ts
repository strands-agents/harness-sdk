/**
 * Programmatic tool caller driving real MCP tools over stdio. No model is invoked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Agent, McpClient } from '@strands-agents/sdk'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { resolve } from 'node:path'
import { programmaticToolCaller } from '$/sdk/vended-tools/programmatic-tool-caller/index.js'

describe('programmatic_tool_caller over MCP', () => {
  const serverPath = resolve(process.cwd(), 'test/integ/__fixtures__/test-mcp-server.ts')
  let client: McpClient
  let agent: Agent

  beforeAll(async () => {
    client = new McpClient({
      applicationName: 'test-mcp-programmatic-tool-caller',
      transport: new StdioClientTransport({ command: 'npx', args: ['tsx', serverPath] }),
    })
    agent = new Agent({ tools: [programmaticToolCaller, client] })
    await agent.initialize()
  }, 30000)

  afterAll(async () => {
    await client?.disconnect()
  })

  async function run(code: string): Promise<{ status: string; text: string }> {
    const result = await agent.tool.programmatic_tool_caller!.invoke({ code }, { recordDirectToolCall: false })
    return {
      status: result.status,
      text: result.content.map((block) => (block as { text?: string }).text ?? '').join('\n'),
    }
  }

  it('calls an MCP tool', async () => {
    expect(await run('print(await echo(message="hello"))')).toEqual({ status: 'success', text: 'hello' })
  })

  it('loops over MCP tool calls', async () => {
    const code = 'for i in range(3):\n    print(await calculator(operation="add", a=i, b=10))'
    expect((await run(code)).text).toBe('Result: 10\nResult: 11\nResult: 12')
  })

  it('runs MCP tools concurrently', async () => {
    const code = 'import asyncio\nprint(await asyncio.gather(*[echo(message=str(i)) for i in range(3)]))'
    expect((await run(code)).text).toBe("['0', '1', '2']")
  })

  it('surfaces an MCP tool error as a catchable exception', async () => {
    const code =
      "try:\n    await error_tool(error_message='mcp tool exploded')\nexcept RuntimeError as e:\n    print('caught:', e)"
    const result = await run(code)
    expect(result.status).toBe('success')
    expect(result.text).toContain('mcp tool exploded')
  })

  it('returns only printed output', async () => {
    expect((await run('x = await echo(message="secret")\nprint("done")')).text).toBe('done')
  })
})
