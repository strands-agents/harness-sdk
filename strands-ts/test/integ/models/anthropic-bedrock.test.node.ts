/**
 * Integration tests for the Anthropic-compatible Bedrock Mantle pathway.
 *
 * Exercises `AnthropicModel` with `bedrockMantleConfig` against the live
 * `bedrock-mantle.<region>.api.aws/anthropic` endpoint. Credentials come from the
 * ambient AWS credential chain (same gate as the other Bedrock integ tests).
 */

import { describe, expect, it } from 'vitest'
import { Agent, Message, TextBlock } from '@strands-agents/sdk'
import { AnthropicModel } from '$/sdk/models/anthropic.js'

import { bedrock } from '../__fixtures__/model-providers.js'

const REGION = 'us-east-1'
const MODEL_ID = 'anthropic.claude-sonnet-5'
const MAX_TOKENS = 512

describe.skipIf(bedrock.skip)('AnthropicModel (Bedrock Mantle) Integration Tests', () => {
  it('reaches Mantle via bedrockMantleConfig', async () => {
    const model = new AnthropicModel({
      modelId: MODEL_ID,
      maxTokens: MAX_TOKENS,
      bedrockMantleConfig: { region: REGION },
    })
    const agent = new Agent({
      model,
      systemPrompt: 'Reply in one short sentence.',
      printer: false,
    })

    const result = await agent.invoke('What is 2+2?')

    expect(result.stopReason).toBe('endTurn')
    expect(String(result)).toContain('4')
  })

  it('defaults to a model the Mantle catalog serves', async () => {
    // The direct-API default is Sonnet 4.6, which Mantle does not serve; omitting
    // modelId must still reach a model that exists on the endpoint.
    const model = new AnthropicModel({
      maxTokens: MAX_TOKENS,
      bedrockMantleConfig: { region: REGION },
    })
    const agent = new Agent({
      model,
      systemPrompt: 'Reply in one short sentence.',
      printer: false,
    })

    const result = await agent.invoke('What is 2+2?')

    expect(result.stopReason).toBe('endTurn')
    expect(String(result)).toContain('4')
  })

  it('counts tokens natively through Mantle', async () => {
    const model = new AnthropicModel({
      modelId: MODEL_ID,
      maxTokens: MAX_TOKENS,
      useNativeTokenCount: true,
      bedrockMantleConfig: { region: REGION },
    })
    const messages = [new Message({ role: 'user', content: [new TextBlock('What is 2+2?')] })]

    const count = await model.countTokens(messages)

    expect(count).toBeGreaterThan(0)
  })
})
