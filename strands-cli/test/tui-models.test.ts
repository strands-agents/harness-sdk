import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock'
import type { Agent } from '@strands-agents/sdk'
import { resolveModel } from '@strands-agents/harness/internal'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentModelRuntime } from '../src/tui/model/runtime.js'
import type { BedrockCatalogClient } from '../src/tui/provider/bedrock-catalog.js'
import type { ProviderId } from '../src/tui/config.js'
import { discoverProviderModels } from '../src/tui/provider/discovery.js'
import {
  profileEffort,
  resolveModelTarget,
  effortDisplayLabel,
  validateModelSelection,
  type EffortInput,
} from '../src/tui/model/selection.js'

afterEach(() => {
  vi.restoreAllMocks()
})

class BedrockModel {
  constructor(readonly modelId = 'anthropic.claude-current-v1:0') {}

  getConfig(): object {
    return {}
  }
}

class OpenAIModel {
  constructor(readonly modelId: string) {}
}

describe('AgentModelRuntime model ordering', () => {
  it('caches Bedrock discovery across concurrent and repeated model listings', async () => {
    const destroy = vi.fn()
    const client = {
      send: async (command: ListInferenceProfilesCommand | ListFoundationModelsCommand) =>
        command instanceof ListInferenceProfilesCommand
          ? { inferenceProfileSummaries: [] }
          : {
              modelSummaries: [
                foundationModel('amazon.nova-zulu-v1:0', 'Zulu Model'),
                foundationModel('anthropic.claude-current-v1:0', 'Current Model'),
                foundationModel('anthropic.claude-alpha-v1:0', 'Alpha Model'),
              ],
            },
      destroy,
    } as BedrockCatalogClient
    const createBedrockClient = vi.fn(() => client)
    const runtime = new AgentModelRuntime({ model: new BedrockModel() } as unknown as Agent, {
      initialModel: 'bedrock/anthropic.claude-current-v1:0',
      createBedrockClient,
    })

    const [models, concurrentModels] = await Promise.all([runtime.list(), runtime.list()])
    const repeatedModels = await runtime.list()

    expect(models.map((model) => model.name)).toEqual(['Current Model', 'Alpha Model', 'Zulu Model'])
    expect(concurrentModels).toEqual(models)
    expect(repeatedModels).toEqual(models)
    expect(models[0]?.active).toBe(true)
    expect(createBedrockClient).toHaveBeenCalledOnce()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('keeps the current model visible and retries Bedrock discovery after a failed request', async () => {
    const failedClient = {
      send: async () => {
        throw new Error('catalog unavailable')
      },
      destroy: vi.fn(),
    } as BedrockCatalogClient
    const recoveredClient = {
      send: async (command: ListInferenceProfilesCommand | ListFoundationModelsCommand) =>
        command instanceof ListInferenceProfilesCommand
          ? { inferenceProfileSummaries: [] }
          : { modelSummaries: [foundationModel('anthropic.claude-current-v1:0', 'Current Model')] },
      destroy: vi.fn(),
    } as BedrockCatalogClient
    const createBedrockClient = vi
      .fn<() => BedrockCatalogClient>()
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(recoveredClient)
    const runtime = new AgentModelRuntime({ model: new BedrockModel() } as unknown as Agent, {
      initialModel: 'bedrock/anthropic.claude-current-v1:0',
      createBedrockClient,
    })

    await expect(runtime.list()).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic.claude-current-v1:0', active: true }),
    ])
    await expect(runtime.list()).resolves.toEqual([
      expect.objectContaining({ id: 'anthropic.claude-current-v1:0', active: true }),
    ])
    expect(createBedrockClient).toHaveBeenCalledTimes(2)
    expect(failedClient.destroy).toHaveBeenCalledOnce()
    expect(recoveredClient.destroy).toHaveBeenCalledOnce()
  })

  it('lists each configured provider as a separate model catalog', async () => {
    const discoverProviderModels = vi.fn(async (provider: ProviderId) => ({
      available: true,
      models:
        provider === 'bedrock-mantle'
          ? [{ id: 'openai.gpt-5.6-sol', name: 'GPT-5.6 Sol' }]
          : [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }],
    }))
    const runtime = new AgentModelRuntime({ model: new OpenAIModel('openai.gpt-5.6-sol') } as unknown as Agent, {
      initialModel: 'bedrock-mantle/openai.gpt-5.6-sol',
      providers: ['bedrock-mantle', 'anthropic'],
      discoverProviderModels,
    })

    await expect(runtime.list()).resolves.toEqual([
      expect.objectContaining({
        active: true,
        catalog: 'bedrock-mantle',
        value: 'bedrock-mantle/openai.gpt-5.6-sol',
      }),
      expect.objectContaining({
        catalog: 'anthropic',
        value: 'anthropic/claude-opus-4-8',
      }),
    ])
    expect(discoverProviderModels.mock.calls).toEqual([
      ['bedrock-mantle', {}],
      ['anthropic', {}],
    ])
  })
})

describe('AgentModelRuntime thinking controls', () => {
  it('offers granular Claude effort levels behind a cross-region prefix', () => {
    const model = 'global.anthropic.claude-opus-4-8'
    const runtime = runtimeFor(model, 'high')

    expect(runtime.listEfforts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'low' }),
        expect.objectContaining({ id: 'high', active: true }),
        expect.objectContaining({ id: 'max' }),
      ])
    )
    expect(runtime.listEfforts()).toHaveLength(5)
    expect(runtimeFor(model, 'auto').listEfforts()).toContainEqual(
      expect.objectContaining({ id: 'high', active: true })
    )
  })

  it('does not show an effort control for unsupported model families', () => {
    expect(runtimeFor('vendor.reasoning-model', 'auto').listEfforts()).toEqual([])
  })

  it('offers no effort controls and rejects effort changes below the Claude thinking floor', async () => {
    const runtime = runtimeFor('us.anthropic.claude-3-haiku-20240307-v1:0', 'auto')
    expect(runtime.listEfforts()).toEqual([])
    await expect(runtime.setEffort('high')).rejects.toThrow()
  })

  it.each(['global.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-opus-4-5-20251101-v1:0'])(
    'offers levels for %s, which takes extended thinking',
    (modelId) => {
      expect(runtimeFor(modelId, 'auto').listEfforts()).toHaveLength(5)
    }
  )

  it('still offers levels for a Claude at the adaptive floor', () => {
    expect(runtimeFor('global.anthropic.claude-opus-4-6-v1', 'high').listEfforts()).toHaveLength(5)
  })

  it.each([
    ['high', 'bedrock/us.anthropic.claude-3-haiku-20240307-v1:0', 'auto'],
    ['max', 'bedrock/openai.gpt-oss-120b-1:0', 'auto'],
    ['high', 'bedrock/openai.gpt-oss-120b-1:0', 'high'],
  ] as const)('carries %s effort into %s as %s', async (thinking, target, expected) => {
    const requested: (EffortInput | undefined)[] = []
    const runtime = runtimeFor('global.anthropic.claude-opus-4-8', thinking, (options) => {
      requested.push(options.thinking)
      return Promise.resolve({ model: { modelId: 'x' } } as unknown as Agent)
    })

    await runtime.restart(target)

    expect(requested).toEqual([expected])
  })

  it.each([
    ['global.anthropic.claude-opus-4-5-20251101-v1:0', 'global.anthropic.claude-opus-4-8'],
    ['global.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    ['global.anthropic.claude-opus-4-8', 'us.anthropic.claude-opus-4-1-20250805-v1:0'],
  ])('requires a restart to switch across thinking tiers: %s -> %s', (from, to) => {
    expect(runtimeFor(from, 'high').changeMode(`bedrock/${to}`)).toBe('restart')
  })

  it.each([
    ['global.anthropic.claude-opus-4-8', 'us.anthropic.claude-opus-4-8'],
    ['us.anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-8'],
    ['global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8-20260101-v1:0'],
  ])('still switches live between config-identical ids of one model: %s -> %s', (from, to) => {
    expect(runtimeFor(from, 'high').changeMode(`bedrock/${to}`)).toBe('live')
  })

  it.each([
    'global.anthropic.claude-opus-4-8',
    'us.anthropic.claude-sonnet-4-6-v1:0',
    'openai.gpt-oss-120b-1:0',
    'us.qwen.qwen3-32b-v1:0',
  ])('offers only levels the library accepts for %s', async (modelId) => {
    const offered = runtimeFor(modelId, 'auto')
      .listEfforts()
      .map((option) => option.id)
    const rejected: string[] = []
    for (const level of offered) {
      await resolveModel(`bedrock/${modelId}`, `bedrock/${modelId}`, profileEffort(level)).catch(() =>
        rejected.push(level)
      )
    }

    expect(offered.length).toBeGreaterThan(0)
    expect(rejected).toEqual([])
  })

  it('offers Astra effort levels with High selected by default', () => {
    const runtime = runtimeFor('global.openai.gpt-6-astra', 'auto')

    expect(runtime.listEfforts().map((option) => option.id)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(runtime.listEfforts()).toContainEqual({ id: 'high', label: 'High', active: true })
  })

  it('labels the configured thinking for models without an effort mapping', () => {
    expect(effortDisplayLabel('auto')).toBe('Auto')
    expect(effortDisplayLabel(true)).toBe('Auto')
    expect(effortDisplayLabel(undefined)).toBe('Auto')
    expect(effortDisplayLabel(null)).toBe('Off')
    expect(effortDisplayLabel(false)).toBe('Off')
    expect(effortDisplayLabel('xhigh')).toBe('Extra high')
    expect(effortDisplayLabel('medium')).toBe('Medium')
  })

  it('preserves an explicit thinking-off setting when forking', () => {
    expect(runtimeFor('global.anthropic.claude-opus-4-8', null).forkConfiguration().thinking).toBeNull()
  })

  it('offers only the GPT-OSS effort levels accepted by the Bedrock resolver', async () => {
    const runtime = runtimeFor('openai.gpt-oss-120b-1:0', 'high')

    expect(runtime.listEfforts().map((option) => option.id)).toEqual(['low', 'medium', 'high'])
    await expect(runtime.setEffort('max')).rejects.toThrow('not supported')
  })

  it('offers the Qwen effort levels accepted by the Bedrock resolver', () => {
    expect(
      runtimeFor('us.qwen.qwen3-32b-v1:0', 'high')
        .listEfforts()
        .map((option) => option.id)
    ).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('offers the xAI Grok effort levels accepted by the Bedrock resolver', () => {
    const runtime = runtimeFor('us.xai.grok-4.6', 'auto')

    expect(runtime.listEfforts().map((option) => option.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(runtime.listEfforts()).toContainEqual(expect.objectContaining({ id: 'high', active: true }))
  })
})

describe('resolveModelTarget', () => {
  it('accepts direct providers and preserves bare Bedrock IDs', () => {
    expect(resolveModelTarget('bedrock/amazon.nova-pro-v1:0')).toMatchObject({
      provider: 'bedrock',
      modelId: 'amazon.nova-pro-v1:0',
    })
    expect(resolveModelTarget('openai/gpt-5.6-sol')).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
      specifier: 'openai/gpt-5.6-sol',
    })
    expect(resolveModelTarget('global.anthropic.claude-opus-4-8')).toEqual({
      provider: 'bedrock',
      modelId: 'global.anthropic.claude-opus-4-8',
      specifier: 'global.anthropic.claude-opus-4-8',
    })
    expect(resolveModelTarget('ollama/qwen3:8b')).toEqual({
      provider: 'ollama',
      modelId: 'qwen3:8b',
      specifier: 'ollama/qwen3:8b',
    })
  })

  it('rejects unknown providers', () => {
    expect(() => resolveModelTarget('unknown/model')).toThrow('Unsupported model provider')
  })

  it('rejects multiple slash-command arguments without changing their meaning', () => {
    expect(() => resolveModelTarget('ollama/qwen3:8b extra')).toThrow('Enter one model ID without spaces.')
  })
})

describe('model selection validation', () => {
  const lookupEnvironment = {
    ANTHROPIC_API_KEY: { value: 'test-anthropic-key', source: 'process' as const },
    GEMINI_API_KEY: { value: 'test-google-key', source: 'process' as const },
  }

  it.each([
    ['llama3.2', 'llama3.2:latest'],
    ['llama3.2:latest', 'llama3.2'],
  ])('accepts Ollama default-tag aliases: %s', async (requested, available) => {
    await expect(
      validateModelSelection(
        `ollama/${requested}`,
        async () => ({ available: true, models: [{ id: available, name: available }] }),
        {}
      )
    ).resolves.toBeUndefined()
  })

  it.each(['anthropic', 'google'] as const)(
    'rejects a confirmed missing %s model without changing state',
    async (provider) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        globalThis.Response.json(
          { error: provider === 'anthropic' ? { type: 'not_found_error' } : { status: 'NOT_FOUND' } },
          { status: 404 }
        )
      )
      const agent = { model: { modelId: 'current-model' } } as unknown as Agent
      const restartAgent = vi.fn()
      const onModelChange = vi.fn()
      const runtime = new AgentModelRuntime(agent, {
        initialModel: `${provider}/current-model`,
        thinking: 'high',
        discoverProviderModels: async () => ({ available: false, models: [] }),
        providerEnvironment: lookupEnvironment,
        restartAgent,
        onModelChange,
      })
      await expect(runtime.restart(`${provider}/definitely-not-a-model`)).rejects.toThrow(
        `Unknown model "${provider}/definitely-not-a-model". Use /model to choose an available model.`
      )
      expect(runtime.agent).toBe(agent)
      expect(runtime.current).toBe('current-model')
      expect(runtime.thinking).toBe('high')
      expect(restartAgent).not.toHaveBeenCalled()
      expect(onModelChange).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['anthropic/claude-haiku-4-5', 'https://api.anthropic.com/v1/models/claude-haiku-4-5'],
    ['google/gemini-flash-latest', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest'],
    [
      'google/models/gemini-flash-latest',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest',
    ],
    ['google/tunedModels/custom-model', 'https://generativelanguage.googleapis.com/v1beta/tunedModels/custom-model'],
  ] as const)('resolves unlisted aliases and resource names through the provider: %s', async (model, url) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(globalThis.Response.json({ id: 'canonical-model-id' }))
    await expect(
      validateModelSelection(model, async () => ({ available: true, complete: true, models: [] }), lookupEnvironment)
    ).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledWith(url, {
      headers: model.startsWith('anthropic/')
        ? { 'anthropic-version': '2023-06-01', 'x-api-key': 'test-anthropic-key' }
        : { 'x-goog-api-key': 'test-google-key' },
      signal: expect.any(AbortSignal),
    })
  })

  it.each(['anthropic', 'google'] as const)('keeps inconclusive %s lookups permissive', async (provider) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const discover = async () => ({ available: true, complete: true, models: [] })
    for (const status of [403, 404]) {
      fetch.mockResolvedValueOnce(globalThis.Response.json({ error: { message: 'Unavailable' } }, { status }))
      await expect(
        validateModelSelection(`${provider}/custom-model`, discover, lookupEnvironment)
      ).resolves.toBeUndefined()
    }
    fetch.mockResolvedValueOnce(new globalThis.Response('Proxy not found', { status: 404 }))
    await expect(
      validateModelSelection(`${provider}/custom-model`, discover, lookupEnvironment)
    ).resolves.toBeUndefined()
    fetch.mockRejectedValueOnce(new Error('Connection timed out'))
    await expect(
      validateModelSelection(`${provider}/custom-model`, discover, lookupEnvironment)
    ).resolves.toBeUndefined()
    fetch.mockClear()
    await expect(validateModelSelection(`${provider}/custom-model`, discover, {})).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('skips lookup for listed Google names and resources outside the base/tuned model APIs', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const discover = async () => ({
      available: true,
      complete: true,
      models: [{ id: 'gemini-flash-latest', name: 'Gemini' }],
    })
    for (const model of [
      'google/models/gemini-flash-latest',
      'google/projects/project/locations/us-central1/publishers/google/models/gemini-flash-latest',
    ]) {
      await expect(validateModelSelection(model, discover, lookupEnvironment)).resolves.toBeUndefined()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects unknown Bedrock IDs after complete enumeration while retaining custom profiles', async () => {
    const current = 'anthropic.claude-opus-4-8'
    const customProfile = 'a1b2c3d4e5f6'
    vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof ListInferenceProfilesCommand) {
        return command.input.nextToken
          ? {
              inferenceProfileSummaries: [
                {
                  inferenceProfileId: customProfile,
                  status: 'ACTIVE',
                  models: [{ modelArn: 'arn:aws:bedrock:us-east-1:123456789012:custom-model/custom' }],
                },
              ],
            }
          : { inferenceProfileSummaries: [], nextToken: 'second-page' }
      }
      return { modelSummaries: [foundationModel(current, 'Claude')] }
    })
    const catalog = await discoverProviderModels('bedrock', {})
    expect(catalog).toMatchObject({ available: true, complete: true, knownModelIds: [current, customProfile] })
    expect(catalog.models.map((model) => model.id)).not.toContain(customProfile)
    const discover = async () => catalog
    await expect(validateModelSelection(`bedrock/${customProfile}`, discover, {})).resolves.toBeUndefined()
    const agent = { model: { modelId: current } } as unknown as Agent
    const restartAgent = vi.fn()
    const onModelChange = vi.fn()
    const runtime = new AgentModelRuntime(agent, {
      initialModel: `bedrock/${current}`,
      thinking: 'high',
      discoverProviderModels: discover,
      restartAgent,
      onModelChange,
    })

    for (const model of ['definitely-not-a-model', 'bedrock/definitely-not-a-model']) {
      await expect(runtime.restart(model)).rejects.toThrow(
        `Unknown model "${model}". Use /model to choose an available model.`
      )
    }
    expect(runtime.agent).toBe(agent)
    expect(runtime.current).toBe(current)
    expect(runtime.thinking).toBe('high')
    expect(restartAgent).not.toHaveBeenCalled()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it.each(['profiles', 'foundations'])('allows unlisted Bedrock IDs when %s enumeration fails', async (failed) => {
    const modelId = 'anthropic.claude-opus-4-8'
    vi.spyOn(BedrockClient.prototype, 'send').mockImplementation(async (command) => {
      if (command instanceof ListInferenceProfilesCommand) {
        if (failed === 'profiles' && command.input.nextToken) {
          throw new Error('Cannot read the next page')
        }
        return {
          inferenceProfileSummaries: [
            {
              inferenceProfileId: `us.${modelId}`,
              status: 'ACTIVE',
              models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
            },
          ],
          ...(failed === 'profiles' ? { nextToken: 'second-page' } : {}),
        }
      }
      if (failed === 'foundations') {
        throw new Error('Cannot list foundation models')
      }
      return { modelSummaries: [foundationModel(modelId, 'Claude')] }
    })
    const catalog = await discoverProviderModels('bedrock', {})
    expect(catalog).toMatchObject({ available: true, complete: false })
    await expect(validateModelSelection('bedrock/custom-model-id', async () => catalog, {})).resolves.toBeUndefined()
  })

  it('rejects an invalid live-switch target before updating the current model', async () => {
    const updateConfig = vi.fn()
    const runtime = new AgentModelRuntime(
      { model: { modelId: 'global.anthropic.claude-opus-4-8', updateConfig } } as unknown as Agent,
      {
        initialModel: 'bedrock/global.anthropic.claude-opus-4-8',
        thinking: 'high',
        discoverProviderModels: async () => ({
          available: true,
          complete: true,
          models: [{ id: 'global.anthropic.claude-opus-4-8', name: 'Claude' }],
        }),
      }
    )

    await expect(runtime.switch('bedrock/us.anthropic.claude-opus-4-8-missing')).rejects.toThrow('Unknown model')
    expect(updateConfig).not.toHaveBeenCalled()
    expect(runtime.current).toBe('global.anthropic.claude-opus-4-8')
    expect(runtime.thinking).toBe('high')
  })

  it('rejects an unlisted model before rebuilding when the provider catalog is available', async () => {
    const agent = { model: { modelId: 'qwen3:8b' } } as unknown as Agent
    const restartAgent = vi.fn()
    const onModelChange = vi.fn()
    const runtime = new AgentModelRuntime(agent, {
      initialModel: 'ollama/qwen3:8b',
      thinking: 'auto',
      discoverProviderModels: async () => ({ models: [{ id: 'qwen3:8b', name: 'Qwen' }], available: true }),
      restartAgent,
      onModelChange,
    })

    await expect(runtime.restart('ollama/invalid-id')).rejects.toThrow(
      'Unknown model "ollama/invalid-id". Use /model to choose an available model.'
    )
    await expect(runtime.setEffort('turbo')).rejects.toThrow('Reasoning effort "turbo" is not supported. Choose: auto.')
    expect(runtime.agent).toBe(agent)
    expect(runtime.current).toBe('qwen3:8b')
    expect(runtime.thinking).toBe('auto')
    expect(restartAgent).not.toHaveBeenCalled()
    expect(onModelChange).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'incomplete', 'error', 'available'] as const)(
    'allows a custom model with an %s catalog when it cannot be ruled out',
    async (status) => {
      const discoverProviderModels = async () => {
        if (status === 'error') throw new Error('catalog offline')
        return {
          available: status === 'available' || status === 'incomplete',
          ...(status === 'incomplete' ? { complete: false } : {}),
          models: [{ id: status === 'available' ? 'custom-model' : 'static-default', name: 'Model' }],
        }
      }
      const nextAgent = { model: { modelId: 'custom-model' } } as unknown as Agent
      const restartAgent = vi.fn(async () => nextAgent)
      const runtime = new AgentModelRuntime({ model: { modelId: 'qwen3:8b' } } as unknown as Agent, {
        initialModel: 'ollama/qwen3:8b',
        discoverProviderModels,
        restartAgent,
      })

      await expect(runtime.restart('ollama/custom-model')).resolves.toBe('custom-model')
      expect(runtime.agent).toBe(nextAgent)
      expect(restartAgent).toHaveBeenCalledOnce()
    }
  )

  it('allows Bedrock ARNs without a foundation-model catalog lookup', async () => {
    const discover = vi.fn(async () => ({ available: true, complete: true, models: [] }))
    const arn = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/custom'
    await expect(validateModelSelection(arn, discover, {})).resolves.toBeUndefined()
    await expect(validateModelSelection(`bedrock/${arn}`, discover, {})).resolves.toBeUndefined()
    expect(discover).not.toHaveBeenCalled()
  })

  it('allows unlisted Bedrock profiles when catalog completeness is unspecified', async () => {
    await expect(
      validateModelSelection('bedrock/my-inference-profile', async () => ({ available: true, models: [] }), {})
    ).resolves.toBeUndefined()
  })

  it('keeps the active model and effort when rebuilding fails', async () => {
    const agent = { model: { modelId: 'qwen3:8b' } } as unknown as Agent
    const runtime = new AgentModelRuntime(agent, {
      initialModel: 'ollama/qwen3:8b',
      thinking: 'auto',
      restartAgent: async () => {
        throw new Error('provider failed')
      },
    })

    await expect(runtime.restart('ollama/custom-model')).rejects.toThrow('provider failed')
    expect(runtime.agent).toBe(agent)
    expect(runtime.current).toBe('qwen3:8b')
    expect(runtime.thinking).toBe('auto')
  })
})

function runtimeFor(
  modelId: string,
  thinking: string | null,
  restartAgent?: (options: { thinking?: EffortInput }) => Promise<Agent>
): AgentModelRuntime {
  return new AgentModelRuntime({ model: new BedrockModel(modelId) } as unknown as Agent, {
    initialModel: `bedrock/${modelId}`,
    thinking,
    ...(restartAgent ? { restartAgent } : {}),
  })
}

function foundationModel(
  modelId: string,
  modelName: string
): {
  modelId: string
  modelName: string
  modelLifecycle: { status: 'ACTIVE' }
  outputModalities: ['TEXT']
  responseStreamingSupported: true
  inferenceTypesSupported: ['ON_DEMAND']
} {
  return {
    modelId,
    modelName,
    modelLifecycle: { status: 'ACTIVE' },
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
  }
}

describe('AgentModelRuntime persistence', () => {
  it('reports model and effort changes with config-normalized effort', async () => {
    const onModelChange = vi.fn(async () => {})
    const runtime = new AgentModelRuntime({ model: new BedrockModel() } as unknown as Agent, {
      initialModel: 'bedrock/anthropic.claude-current-v1:0',
      thinking: 'auto',
      restartAgent: async () => ({ model: new OpenAIModel('gpt-5') }) as unknown as Agent,
      onModelChange,
    })

    await runtime.setEffort('low')
    expect(onModelChange).toHaveBeenLastCalledWith({ model: 'bedrock/anthropic.claude-current-v1:0', effort: 'low' })

    await runtime.setEffort('auto')
    expect(onModelChange).toHaveBeenLastCalledWith({
      model: 'bedrock/anthropic.claude-current-v1:0',
      effort: 'auto',
    })

    await runtime.setEffort('high')
    expect(onModelChange).toHaveBeenLastCalledWith({
      model: 'bedrock/anthropic.claude-current-v1:0',
      effort: 'high',
    })

    await runtime.restart('openai/gpt-5')
    expect(onModelChange).toHaveBeenLastCalledWith({ model: 'openai/gpt-5', effort: 'high' })

    await runtime.setEffort('none')
    expect(onModelChange).toHaveBeenLastCalledWith({ model: 'openai/gpt-5', effort: 'off' })

    await expect(runtime.setEffort('turbo')).rejects.toThrow('not supported')
    expect(onModelChange).toHaveBeenCalledTimes(5)
  })
})
