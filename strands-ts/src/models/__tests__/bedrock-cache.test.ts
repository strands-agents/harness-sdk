import { describe, expect, it } from 'vitest'
import { bedrockCacheModelInfo, bedrockLimitsCachePoints } from '../bedrock-cache.js'

describe('bedrockCacheModelInfo', () => {
  it.each([
    ['us.openai.gpt-5.6-luna', 'auto'],
    ['us.openai.gpt-6-luna', 'auto'],
    ['openai.gpt-6.1-sol', 'auto'],
    ['us.openai.gpt-5.4', 'auto'],
    ['us.xai.grok-4.7', 'auto'],
    ['amazon.nova-pro-v1:0', 'cachePoints'],
    ['us.amazon.nova-lite-v1:0', 'cachePoints'],
    ['us.amazon.nova-micro-v1:0', 'cachePoints'],
    ['us.amazon.nova-2-lite-v1:0', 'cachePoints'],
    ['openai.gpt-oss-120b-1:0', undefined],
    ['us.openai.gpt-oss-20b-1:0', undefined],
    ['us.amazon.nova-premier-v1:0', undefined],
    ['us.amazon.nova-2-pro-preview-20251202-v1:0', undefined],
    ['global.anthropic.claude-sonnet-4-6', undefined],
    ['meta.llama4-maverick-17b-instruct-v1:0', undefined],
  ])('%s → %s', (modelId, promptCaching) => {
    expect(bedrockCacheModelInfo(modelId)?.capabilities?.promptCaching).toBe(promptCaching)
  })
})

describe('bedrockLimitsCachePoints', () => {
  it.each([
    ['amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-lite-v1:0', true],
    ['us.amazon.nova-micro-v1:0', true],
    ['us.amazon.nova-2-lite-v1:0', true],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-pro-v1:0', true],
    ['us.amazon.nova-premier-v1:0', false],
    ['global.anthropic.claude-sonnet-4-6', false],
    ['us.openai.gpt-6-luna', false],
  ])('%s → %s', (modelId, expected) => {
    expect(bedrockLimitsCachePoints(modelId)).toBe(expected)
  })
})
