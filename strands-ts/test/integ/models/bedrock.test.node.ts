import { describe, expect, it, vi } from 'vitest'
import { bedrock } from '../__fixtures__/model-providers.js'
import { Agent } from '$/sdk/agent/agent.js'

describe.skipIf(bedrock.skip)('BedrockModel Integration Tests', () => {
  describe('Agent with String Model ID', () => {
    it.concurrent('accepts string model ID and creates functional Agent', async () => {
      // Create agent with string model ID
      const agent = new Agent({
        model: 'global.anthropic.claude-sonnet-4-6',
        printer: false,
      })

      // Invoke agent with simple prompt
      const result = await agent.invoke('Say hello')

      // Verify agent works correctly
      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      expect(result.lastMessage.content.length).toBeGreaterThan(0)

      // Verify message contains text content
      const textContent = result.lastMessage.content.find((block) => block.type === 'textBlock')
      expect(textContent).toBeDefined()
      expect(textContent?.text).toBeTruthy()
    })
  })

  describe('Region Configuration', () => {
    it('uses AWS_REGION environment variable when set', async () => {
      // Use vitest to stub the environment variable
      vi.stubEnv('AWS_REGION', 'eu-central-1')

      const provider = bedrock.createModel({
        maxTokens: 50,
      })

      // Validate AWS_REGION environment variable is used
      // Making an actual request doesn't guarantee the correct region is being used
      const regionResult = await provider['_client'].config.region()
      expect(regionResult).toBe('eu-central-1')
    })

    it('explicit region takes precedence over environment variable', async () => {
      // Use vitest to stub the environment variable
      vi.stubEnv('AWS_REGION', 'eu-west-1')

      const provider = bedrock.createModel({
        region: 'ap-southeast-2',
        maxTokens: 50,
      })

      // Validate explicit region takes precedence over environment variable
      // Making an actual request doesn't guarantee the correct region is being used
      const regionResult = await provider['_client'].config.region()
      expect(regionResult).toBe('ap-southeast-2')
    })
  })
})
