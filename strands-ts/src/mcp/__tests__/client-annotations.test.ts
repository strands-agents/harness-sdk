import { describe, it, expect } from 'vitest'
import { InMemoryTransport, type ToolAnnotations } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { McpClient } from '../client.js'

/**
 * Exercises annotation pass-through over a real (in-memory) MCP transport, unlike
 * client.test.ts, which mocks the MCP SDK Client and therefore bypasses the SDK's
 * Zod validation of listTools responses.
 */
describe('McpClient annotations over a real transport', () => {
  async function listToolsFromServer(annotations: Record<string, unknown> | undefined): Promise<McpClient> {
    const server = new McpServer({ name: 'annotations-test-server', version: '1.0.0' })
    server.registerTool(
      'echo',
      {
        description: 'Echoes input',
        inputSchema: { value: z.string() },
        ...(annotations !== undefined && { annotations: annotations as ToolAnnotations }),
      },
      async ({ value }) => ({ content: [{ type: 'text', text: value }] })
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    return new McpClient({ transport: clientTransport })
  }

  it('surfaces known annotation keys from the server', async () => {
    const client = await listToolsFromServer({ title: 'Echo', readOnlyHint: true, openWorldHint: false })

    const tools = await client.listTools()

    expect(tools[0]!.toolSpec.annotations).toEqual({ title: 'Echo', readOnlyHint: true, openWorldHint: false })
  })

  it('preserves explicitly-false hints', async () => {
    const client = await listToolsFromServer({ readOnlyHint: false, destructiveHint: false })

    const tools = await client.listTools()

    expect(tools[0]!.toolSpec.annotations).toEqual({ readOnlyHint: false, destructiveHint: false })
  })

  it('strips unknown annotation keys at the MCP SDK boundary', async () => {
    // The MCP SDK's ToolAnnotationsSchema is a non-passthrough Zod object: keys outside the
    // spec'd vocabulary are dropped during listTools validation, before McpClient sees them.
    // If this test starts failing with futureSepKey present, the SDK now passes unknown keys
    // through and the pass-through comment in client.ts should be updated to match Python.
    const client = await listToolsFromServer({ readOnlyHint: true, futureSepKey: 'x' })

    const tools = await client.listTools()

    expect(tools[0]!.toolSpec.annotations).toEqual({ readOnlyHint: true })
  })

  it('omits annotations when the server declares none', async () => {
    const client = await listToolsFromServer(undefined)

    const tools = await client.listTools()

    expect(tools[0]!.toolSpec).not.toHaveProperty('annotations')
  })
})
