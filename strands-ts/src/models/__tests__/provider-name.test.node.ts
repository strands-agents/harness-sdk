import { beforeEach, describe, expect, it, vi } from 'vitest'
import OpenAI from 'openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { AnthropicModel } from '../anthropic.js'
import { BedrockModel } from '../bedrock.js'
import { GoogleModel } from '../google/index.js'
import { OpenAIModel } from '../openai/index.js'
import { modelKey } from '../provider-name.js'
import { VercelModel } from '../vercel.js'
import type { Model } from '../model.js'

vi.mock('../../logging/warn-once.js', () => ({ warnOnce: vi.fn() }))

type AnthropicClient = NonNullable<NonNullable<ConstructorParameters<typeof AnthropicModel>[0]>['client']>

// Stand-ins for the clients of the optional `@anthropic-ai/bedrock-sdk`, which the SDK tells apart by class name.
class AnthropicBedrock {}
class AnthropicBedrockMantle {}

function anthropicOn(client: object): AnthropicModel {
  return new AnthropicModel({ client: client as AnthropicClient, modelId: 'anthropic.claude-a', maxTokens: 1 })
}

function anthropicWith(clientConfig: { baseURL: string }): AnthropicModel {
  return new AnthropicModel({ apiKey: 'k', clientConfig, modelId: 'claude-a', maxTokens: 1 })
}

describe('modelKey', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_BASE_URL', undefined)
    vi.stubEnv('ANTHROPIC_BASE_URL', undefined)
  })

  it('names the provider of each vended class and of its subclasses', () => {
    class BedrockSubclass extends BedrockModel {}
    class GoogleSubclass extends GoogleModel {}
    const models = [
      new BedrockModel({ modelId: 'model-a' }),
      new BedrockSubclass({ modelId: 'model-a' }),
      new GoogleModel({ apiKey: 'test-key', modelId: 'model-a' }),
      new GoogleSubclass({ apiKey: 'test-key', modelId: 'model-a' }),
    ]

    expect(models.map(modelKey)).toStrictEqual([
      { providerName: 'bedrock', modelId: 'model-a' },
      { providerName: 'bedrock', modelId: 'model-a' },
      { providerName: 'google', modelId: 'model-a' },
      { providerName: 'google', modelId: 'model-a' },
    ])
  })

  it.each<[string, () => Model, string | undefined, string | undefined]>([
    ['openai', () => new OpenAIModel({ modelId: 'gpt-a' }), 'openai', 'gpt-a'],
    ['openai chat', () => new OpenAIModel({ api: 'chat', modelId: 'gpt-a' }), 'openai', 'gpt-a'],
    [
      'openai explicit default base URL',
      () => new OpenAIModel({ clientConfig: { baseURL: 'https://api.openai.com/v1' }, modelId: 'gpt-a' }),
      'openai',
      'gpt-a',
    ],
    ['openai default client', () => new OpenAIModel({ client: new OpenAI(), modelId: 'gpt-a' }), 'openai', 'gpt-a'],
    [
      'openai custom base URL',
      () => new OpenAIModel({ clientConfig: { baseURL: 'https://llm.example.com/v1' }, modelId: 'm' }),
      undefined,
      'm',
    ],
    [
      'openai chat custom base URL',
      () => new OpenAIModel({ api: 'chat', clientConfig: { baseURL: 'http://localhost:8000' }, modelId: 'm' }),
      undefined,
      'm',
    ],
    [
      'openai client with custom base URL',
      () => new OpenAIModel({ client: new OpenAI({ baseURL: 'https://llm.example.com/v1' }), modelId: 'm' }),
      undefined,
      'm',
    ],
    ['openai client without base URL', () => new OpenAIModel({ client: {} as OpenAI, modelId: 'm' }), undefined, 'm'],
    [
      'openai on mantle',
      () => new OpenAIModel({ modelId: 'openai.gpt-a', bedrockMantleConfig: { region: 'us-east-1' } }),
      'bedrock',
      'openai.gpt-a',
    ],
    [
      'openai client with mantle base URL',
      () =>
        new OpenAIModel({
          client: new OpenAI({ baseURL: 'https://bedrock-mantle.us-east-1.api.aws/v1' }),
          modelId: 'openai.gpt-a',
        }),
      'bedrock',
      'openai.gpt-a',
    ],
    [
      'openai with bedrock-runtime base URL',
      () =>
        new OpenAIModel({
          clientConfig: { baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1' },
          modelId: 'openai.gpt-a',
        }),
      'bedrock',
      'openai.gpt-a',
    ],
    [
      'openai with bedrock-runtime-fips base URL',
      () =>
        new OpenAIModel({
          clientConfig: { baseURL: 'https://bedrock-runtime-fips.us-east-1.amazonaws.com/openai/v1' },
          modelId: 'openai.gpt-a',
        }),
      'bedrock',
      'openai.gpt-a',
    ],
    [
      'openai with a bedrock lookalike base URL',
      () => new OpenAIModel({ clientConfig: { baseURL: 'https://bedrock-mantle.example.com/v1' }, modelId: 'm' }),
      undefined,
      'm',
    ],
    [
      'openai with a bedrock host as the prefix of another host',
      () =>
        new OpenAIModel({
          clientConfig: { baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com.evil.io' },
          modelId: 'm',
        }),
      undefined,
      'm',
    ],
    [
      'anthropic',
      () => new AnthropicModel({ apiKey: 'k', modelId: 'claude-a', maxTokens: 1 }),
      'anthropic',
      'claude-a',
    ],
    [
      'anthropic with the anthropic base URL',
      () => anthropicWith({ baseURL: 'https://api.anthropic.com' }),
      'anthropic',
      'claude-a',
    ],
    [
      'anthropic with a custom base URL',
      () => anthropicWith({ baseURL: 'https://llm.example.com' }),
      undefined,
      'claude-a',
    ],
    [
      'anthropic with a bedrock-mantle base URL',
      () => anthropicWith({ baseURL: 'https://bedrock-mantle.us-east-1.api.aws/anthropic' }),
      'bedrock',
      'claude-a',
    ],
    ['anthropic on bedrock client', () => anthropicOn(new AnthropicBedrock()), 'bedrock', 'anthropic.claude-a'],
    ['anthropic on mantle client', () => anthropicOn(new AnthropicBedrockMantle()), 'bedrock', 'anthropic.claude-a'],
    ['anthropic on unknown client', () => anthropicOn({}), undefined, 'anthropic.claude-a'],
    [
      'anthropic on a client with a bedrock-runtime base URL',
      () => anthropicOn({ baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com' }),
      'bedrock',
      'anthropic.claude-a',
    ],
    [
      'anthropic on a client with a bedrock lookalike in the query',
      () => anthropicOn({ baseURL: 'https://evil.example/x?bedrock-runtime.y' }),
      undefined,
      'anthropic.claude-a',
    ],
    [
      'anthropic on a client with a bedrock host as the suffix of another host',
      () => anthropicOn({ baseURL: 'https://xbedrock-runtime.us-east-1.amazonaws.com' }),
      undefined,
      'anthropic.claude-a',
    ],
    [
      'anthropic on a client with a bedrock host as the userinfo',
      () => anthropicOn({ baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com@evil.io/' }),
      undefined,
      'anthropic.claude-a',
    ],
    [
      'anthropic on a client with a bedrock host as the prefix of another host',
      () => anthropicOn({ baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com.evil.io' }),
      undefined,
      'anthropic.claude-a',
    ],
    [
      'vercel',
      () => new VercelModel({ provider: { modelId: 'gpt-a', provider: 'openai.chat' } as LanguageModelV3 }),
      undefined,
      'gpt-a',
    ],
    ['custom model', () => new MockMessageModel(), undefined, 'test-model'],
    ['no model', () => undefined as unknown as Model, undefined, undefined],
  ])('names a model by the endpoint it calls: %s', (_name, createModel, providerName, modelId) => {
    expect(modelKey(createModel())).toStrictEqual({
      ...(providerName !== undefined && { providerName }),
      ...(modelId !== undefined && { modelId }),
    })
  })

  it('names no provider for an OpenAI base URL set in the environment', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://llm.example.com/v1')

    expect(modelKey(new OpenAIModel({ modelId: 'm' }))).toStrictEqual({ modelId: 'm' })
  })

  it('names no provider for an Anthropic base URL set in the environment', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://llm.example.com')

    expect(modelKey(new AnthropicModel({ apiKey: 'k', modelId: 'claude-a', maxTokens: 1 }))).toStrictEqual({
      modelId: 'claude-a',
    })
  })

  it.each<[string, () => unknown]>([
    [
      'throws',
      () => {
        throw new Error('no config')
      },
    ],
    ['no model id', () => undefined],
    ['number model id', () => 7],
    ['null model id', () => null],
  ])('never throws on a model id it cannot read: %s', (_name, readModelId) => {
    const model = new OpenAIModel({ modelId: 'gpt-a' })
    vi.spyOn(model, 'modelId', 'get').mockImplementation(readModelId as () => string)

    expect(modelKey(model)).toStrictEqual({ providerName: 'openai' })
  })

  it('names no provider when naming it throws', () => {
    const model = new OpenAIModel({ modelId: 'gpt-a' })
    vi.spyOn(model, '_providerName', 'get').mockImplementation(() => {
      throw new Error('no name')
    })

    expect(modelKey(model)).toStrictEqual({ modelId: 'gpt-a' })
  })
})
