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

describe('modelKey', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key')
    vi.stubEnv('OPENAI_BASE_URL', undefined)
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

  it.each<[string, () => Model, string | null, string | null]>([
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
      null,
      'm',
    ],
    [
      'openai chat custom base URL',
      () => new OpenAIModel({ api: 'chat', clientConfig: { baseURL: 'http://localhost:8000' }, modelId: 'm' }),
      null,
      'm',
    ],
    [
      'openai client with custom base URL',
      () => new OpenAIModel({ client: new OpenAI({ baseURL: 'https://llm.example.com/v1' }), modelId: 'm' }),
      null,
      'm',
    ],
    ['openai client without base URL', () => new OpenAIModel({ client: {} as OpenAI, modelId: 'm' }), null, 'm'],
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
      null,
      'm',
    ],
    [
      'anthropic',
      () => new AnthropicModel({ apiKey: 'k', modelId: 'claude-a', maxTokens: 1 }),
      'anthropic',
      'claude-a',
    ],
    ['anthropic on bedrock client', () => anthropicOn(new AnthropicBedrock()), 'bedrock', 'anthropic.claude-a'],
    ['anthropic on mantle client', () => anthropicOn(new AnthropicBedrockMantle()), 'bedrock', 'anthropic.claude-a'],
    ['anthropic on unknown client', () => anthropicOn({}), null, 'anthropic.claude-a'],
    [
      'vercel',
      () => new VercelModel({ provider: { modelId: 'gpt-a', provider: 'openai.chat' } as LanguageModelV3 }),
      null,
      'gpt-a',
    ],
    ['custom model', () => new MockMessageModel(), null, 'test-model'],
    ['no model', () => undefined as unknown as Model, null, null],
  ])('names a model by the endpoint it calls: %s', (_name, createModel, providerName, modelId) => {
    expect(modelKey(createModel())).toStrictEqual({ providerName, modelId })
  })

  it('names no provider for an OpenAI base URL set in the environment', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://llm.example.com/v1')

    expect(modelKey(new OpenAIModel({ modelId: 'm' }))).toStrictEqual({ providerName: null, modelId: 'm' })
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

    expect(modelKey(model)).toStrictEqual({ providerName: 'openai', modelId: null })
  })

  it('names no provider when naming it throws', () => {
    const model = new OpenAIModel({ modelId: 'gpt-a' })
    vi.spyOn(model, '_providerName', 'get').mockImplementation(() => {
      throw new Error('no name')
    })

    expect(modelKey(model)).toStrictEqual({ providerName: null, modelId: 'gpt-a' })
  })
})
