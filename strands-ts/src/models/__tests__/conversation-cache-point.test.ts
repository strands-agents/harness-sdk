import { describe, expect, it, vi } from 'vitest'
import type OpenAI from 'openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { GoogleModel } from '../google/index.js'
import { OpenAIModel } from '../openai/index.js'
import { VercelModel } from '../vercel.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import type { Model } from '../model.js'

function vercelProvider(provider: string, modelId: string): LanguageModelV3 {
  return { specificationVersion: 'v3', provider, modelId, supportedUrls: {}, doGenerate: vi.fn(), doStream: vi.fn() }
}

function openai(config: Partial<ConstructorParameters<typeof OpenAIModel>[0]>): OpenAIModel {
  return new OpenAIModel({ api: 'responses', modelId: 'gpt-6-sol', client: {} as OpenAI, ...config } as never)
}

const CLAUDE_ON_BEDROCK = 'global.anthropic.claude-sonnet-4-6'
const NOVA = 'us.amazon.nova-pro-v1:0'
const LUNA = 'us.openai.gpt-6-luna'
const UNSUPPORTED = { capabilities: { promptCaching: 'unsupported' as const } }

describe('cachesConversationByPrefix', () => {
  it.each<[string, () => Model, boolean]>([
    [
      'Bedrock GPT, which Converse caches implicitly, without cacheConfig',
      () => new BedrockModel({ modelId: LUNA }),
      true,
    ],
    ['Bedrock GPT with cacheConfig', () => new BedrockModel({ modelId: LUNA, cacheConfig: {} }), true],
    [
      'Bedrock GPT with an explicit cache point strategy',
      () => new BedrockModel({ modelId: LUNA, cacheConfig: { strategy: 'anthropic' } }),
      false,
    ],
    [
      'Bedrock GPT with an explicit strategy but the conversation point off',
      () => new BedrockModel({ modelId: LUNA, cacheConfig: { strategy: 'anthropic', messagesTTL: false } }),
      true,
    ],
    ['Bedrock default model, which caches nothing without cacheConfig', () => new BedrockModel(), false],
    ['Bedrock Claude with cacheConfig', () => new BedrockModel({ modelId: CLAUDE_ON_BEDROCK, cacheConfig: {} }), false],
    ['Bedrock Nova with cacheConfig', () => new BedrockModel({ modelId: NOVA, cacheConfig: {} }), false],
    [
      'Anthropic with cacheConfig',
      () => new AnthropicModel({ modelId: 'claude-sonnet-4-6', client: {} as never, cacheConfig: {} }),
      false,
    ],
    ['OpenAI Chat with cacheConfig', () => openai({ api: 'chat', cacheConfig: {} }), true],
    ['OpenAI Responses on a cache-point model with cacheConfig', () => openai({ cacheConfig: {} }), false],
    ['OpenAI Responses on a cache-point model without cacheConfig', () => openai({}), true],
    ['OpenAI Responses with the conversation point off', () => openai({ cacheConfig: { messagesTTL: false } }), true],
    ['OpenAI Responses on a model without cache points', () => openai({ modelId: 'gpt-4.1', cacheConfig: {} }), true],
    ['OpenAI model the info marks uncached', () => openai({ api: 'chat', modelInfo: UNSUPPORTED }), false],
    ['Gemini', () => new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-3.5-flash' }), true],
    [
      'Gemini the info marks uncached',
      () => new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-3.5-flash', modelInfo: UNSUPPORTED }),
      false,
    ],
    ['Vercel openai', () => new VercelModel({ provider: vercelProvider('openai.responses', 'gpt-6-sol') }), true],
    [
      'Vercel google',
      () => new VercelModel({ provider: vercelProvider('google.generative-ai', 'gemini-3.5-flash') }),
      true,
    ],
    [
      'Vercel anthropic with cacheConfig',
      () => new VercelModel({ provider: vercelProvider('anthropic.messages', 'claude-sonnet-4-6'), cacheConfig: {} }),
      false,
    ],
    [
      'Vercel amazon-bedrock GPT with cacheConfig',
      () => new VercelModel({ provider: vercelProvider('amazon-bedrock', LUNA), cacheConfig: {} }),
      true,
    ],
    [
      'Vercel amazon-bedrock GPT with an explicit cache point strategy',
      () =>
        new VercelModel({ provider: vercelProvider('amazon-bedrock', LUNA), cacheConfig: { strategy: 'anthropic' } }),
      false,
    ],
    [
      'Vercel amazon-bedrock Claude with cacheConfig',
      () => new VercelModel({ provider: vercelProvider('amazon-bedrock', CLAUDE_ON_BEDROCK), cacheConfig: {} }),
      false,
    ],
    [
      'Vercel provider the SDK knows nothing about',
      () => new VercelModel({ provider: vercelProvider('mistral.chat', 'x') }),
      false,
    ],
    ['Custom model with no model info', () => new MockMessageModel(), false],
    [
      'Custom model whose model info says the provider caches implicitly',
      () => {
        const model = new MockMessageModel()
        model.updateConfig({ modelInfo: { capabilities: { promptCaching: 'auto' } } })
        return model
      },
      true,
    ],
  ])('%s', (_name, build, expected) => {
    expect(build().cachesConversationByPrefix()).toBe(expected)
  })
})
