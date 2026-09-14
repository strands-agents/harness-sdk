import { describe, it, expect } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { McpClient, type McpClientOptions, type McpProgress } from '../client.js'

/**
 * Exercises progress delivery over a real (in-memory) MCP transport, unlike client.test.ts,
 * which mocks the MCP SDK Client and therefore bypasses the wire, the progress token, and
 * the request timers.
 */
describe('McpClient progress over a real transport', () => {
  interface ServerToolExtra {
    mcpReq: {
      _meta?: { progressToken?: string | number }
      notify: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>
    }
  }

  async function connectToSlowServer(options: Omit<McpClientOptions, 'applicationName'>): Promise<McpClient> {
    const server = new McpServer({ name: 'progress-test-server', version: '1.0.0' })
    server.registerTool(
      'slow',
      { description: 'reports progress over several steps', inputSchema: { steps: z.number() } },
      async ({ steps }, extra) => {
        // On the 2.0 server the progress token lives at extra.mcpReq._meta.progressToken, not extra._meta.
        const mcpReq = (extra as unknown as ServerToolExtra).mcpReq
        const progressToken = mcpReq._meta?.progressToken
        for (let step = 1; step <= steps; step++) {
          await new Promise((resolve) => setTimeout(resolve, 200))
          if (progressToken !== undefined) {
            await mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress: step, total: steps },
            })
          }
        }
        return {
          content: [{ type: 'text', text: progressToken === undefined ? 'done without token' : 'done with token' }],
        }
      }
    )

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    return new McpClient({ transport: clientTransport, ...options })
  }

  it('resetTimeoutOnProgress still resets the request timer when the user callback owns the onprogress slot', async () => {
    const progressUpdates: McpProgress[] = []
    const client = await connectToSlowServer({
      requestTimeouts: { timeout: 300, resetTimeoutOnProgress: true },
      progressCallback: (progress) => progressUpdates.push(progress),
    })
    const tools = await client.listTools()

    // 5 steps of 200ms work under a 300ms per-request timeout: only a working reset finishes.
    await client.callTool(tools[0]!, { steps: 5 })

    expect(progressUpdates).toEqual([
      { progress: 1, total: 5 },
      { progress: 2, total: 5 },
      { progress: 3, total: 5 },
      { progress: 4, total: 5 },
      { progress: 5, total: 5 },
    ])
  }, 15000)

  it('sends no progress token when no callback is registered', async () => {
    const client = await connectToSlowServer({})
    const tools = await client.listTools()

    const result = (await client.callTool(tools[0]!, { steps: 1 })) as { content: { text: string }[] }

    expect(result.content[0]!.text).toBe('done without token')
  }, 15000)
})
