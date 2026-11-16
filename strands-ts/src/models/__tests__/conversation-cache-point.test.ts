import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { OpenAIModel } from '../openai/index.js'
import { VercelModel } from '../vercel.js'
import type { Model } from '../model.js'

function vercelProvider(provider: string, modelId: string): LanguageModelV3 {
  return { specificationVersion: 'v3', provider, modelId, supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() }
}

const CLAUDE_ON_BEDROCK = 'global.anthropic.claude-sonnet-4-6'
const NOVA = 'us.amazon.nova-pro-v1:0'
const LUNA = 'us.openai.gpt-6-luna'

describe('placesConversationCachePoint', () => {
  it.each<[string, () => Model, boolean]>([
    ['Bedrock Claude with cacheConfig', () => new BedrockModel({ modelId: CLAUDE_ON_BEDROCK, cacheConfig: {} }), true],
    ['Bedrock Nova with cacheConfig', () => new BedrockModel({ modelId: NOVA, cacheConfig: {} }), true],
    ['Bedrock Claude without cacheConfig', () => new BedrockModel({ modelId: CLAUDE_ON_BEDROCK }), false],
    [
      'Bedrock Claude with the conversation point turned off',
      () => new BedrockModel({ modelId: CLAUDE_ON_BEDROCK, cacheConfig: { messagesTTL: false } }),
      false,
    ],
    [
      'Bedrock GPT, which Converse caches implicitly',
      () => new BedrockModel({ modelId: LUNA, cacheConfig: {} }),
      false,
    ],
    [
      'Anthropic with cacheConfig',
      () => new AnthropicModel({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-ant-test', cacheConfig: {} }),
      true,
    ],
    [
      'Anthropic without cacheConfig',
      () => new AnthropicModel({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-ant-test' }),
      false,
    ],
    [
      'OpenAI Responses with cacheConfig on a model that takes cache points',
      () => new OpenAIModel({ api: 'responses', modelId: 'gpt-6-sol', cacheConfig: {}, client: {} as OpenAI }),
      true,
    ],
    [
      'OpenAI Responses without cacheConfig',
      () => new OpenAIModel({ api: 'responses', modelId: 'gpt-6-sol', client: {} as OpenAI }),
      false,
    ],
    [
      'OpenAI Chat, which places no cache points',
      () => new OpenAIModel({ api: 'chat', modelId: 'gpt-6-sol', cacheConfig: {}, client: {} as OpenAI }),
      false,
    ],
    [
      'Vercel anthropic with cacheConfig',
      () => new VercelModel({ provider: vercelProvider('anthropic.messages', 'claude-sonnet-4-6'), cacheConfig: {} }),
      true,
    ],
    [
      'Vercel amazon-bedrock Claude with cacheConfig',
      () => new VercelModel({ provider: vercelProvider('amazon-bedrock', CLAUDE_ON_BEDROCK), cacheConfig: {} }),
      true,
    ],
    [
      'Vercel amazon-bedrock GPT, which Converse caches implicitly',
      () => new VercelModel({ provider: vercelProvider('amazon-bedrock', LUNA), cacheConfig: {} }),
      false,
    ],
    [
      'Vercel openai, which sends only cache options',
      () => new VercelModel({ provider: vercelProvider('openai.responses', 'gpt-6-sol'), cacheConfig: {} }),
      false,
    ],
  ])('%s → %s', (_name, build, expected) => {
    expect(build().placesConversationCachePoint()).toBe(expected)
  })
})
