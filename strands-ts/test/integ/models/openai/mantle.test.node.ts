/**
 * Integration tests for the OpenAI-compatible Bedrock Mantle pathway.
 *
 * Exercises `OpenAIModel` with `bedrockMantleConfig` against the live
 * `bedrock-mantle.<region>.api.aws/v1` endpoint. Credentials come from the
 * ambient AWS credential chain (same gate as the other Bedrock integ tests).
 */

import { describe, expect, it } from 'vitest'
import { Agent } from '@strands-agents/sdk'
import { OpenAIModel } from '$/sdk/models/openai/index.js'

import { bedrock } from '../../__fixtures__/model-providers.js'

const REGION = 'us-east-1'
const MODEL_ID = 'openai.gpt-oss-120b'

describe.skipIf(bedrock.skip)('OpenAIModel (Bedrock Mantle) Integration Tests', () => {
  it('reaches Mantle via bedrockMantleConfig on the Chat Completions API', async () => {
    const model = new OpenAIModel({
      api: 'chat',
      modelId: MODEL_ID,
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

  it('reaches Mantle via bedrockMantleConfig on the Responses API', async () => {
    const model = new OpenAIModel({
      modelId: MODEL_ID,
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

  it('supports server-side stateful conversations', async () => {
    const model = new OpenAIModel({
      modelId: MODEL_ID,
      stateful: true,
      bedrockMantleConfig: { region: REGION },
    })
    const agent = new Agent({
      model,
      systemPrompt: 'Reply in one short sentence.',
      printer: false,
    })

    await agent.invoke('My name is Alice.')
    const result = await agent.invoke('What is my name?')

    expect(String(result).toLowerCase()).toContain('alice')
  })

  it('handles reasoning content across multi-turn conversations', async () => {
    const model = new OpenAIModel({
      modelId: MODEL_ID,
      bedrockMantleConfig: { region: REGION },
      params: { reasoning: { effort: 'low' } },
    })
    const agent = new Agent({
      model,
      systemPrompt: 'Reply in one short sentence.',
      printer: false,
    })

    const first = await agent.invoke('What is 2+2?')
    expect(String(first)).toContain('4')

    // Second turn must not throw despite reasoningContent blocks present in
    // the message history. The local response shape varies by effort level,
    // so we only assert the round-trip completes cleanly.
    const second = await agent.invoke('What about 3+3?')
    expect(second.stopReason).toBe('endTurn')
  })
})
