import { describe, it, expect } from 'vitest'
import { McpClient } from '../client.js'

// The unit-browser project has no setupFiles registering the MCP server loader,
// mirroring a real browser where index.node.ts never loads.
describe('McpClient.loadServers (browser)', () => {
  it('throws because no Node loader is registered', async () => {
    await expect(McpClient.loadServers({ server: { command: 'node' } })).rejects.toThrow(
      'McpClient.loadServers is only available in Node.js'
    )
  })
})
