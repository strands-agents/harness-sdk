import { describe, expect, it } from 'vitest'
import { Agent } from '$/sdk/index.js'
import { bash } from '$/sdk/vended-tools/bash/index.js'
import { getMessageText } from '../__fixtures__/model-test-helpers.js'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip || process.platform === 'win32')('Bash Tool Integration', () => {
  // Shared agent configuration for all tests
  const createAgent = () =>
    new Agent({
      model: bedrock.createModel({
        region: 'us-east-1',
      }),
      tools: [bash],
    })

  describe('basic execution', () => {
    it('captures stdout streams correctly', async () => {
      const agent = createAgent()
      const stdoutResult = await agent.invoke('Use bash to echo "Hello from bash"')
      expect(getMessageText(stdoutResult.lastMessage)).toContain('Hello from bash')
    })

    it('captures stderr streams correctly', async () => {
      const agent = createAgent()
      const stderrResult = await agent.invoke('Use bash to run: echo "error" >&2')
      expect(getMessageText(stderrResult.lastMessage)).toContain('error')
    })

    it('handles complex command patterns', async () => {
      const agent = createAgent()

      // Test command sequencing
      const seqResult = await agent.invoke('Use bash to: create a variable TEST=hello, then echo it')
      expect(getMessageText(seqResult.lastMessage).toLowerCase()).toContain('hello')
    })
  })

  describe('error handling', () => {
    it('handles command errors gracefully', async () => {
      const agent = createAgent()
      const result = await agent.invoke('Use bash to run: nonexistent_command_xyz')

      // Should indicate command not found or error
      const lastMessage = getMessageText(result.lastMessage).toLowerCase()
      expect(lastMessage).toMatch(/not found|error|command/)
    })
  })
})
