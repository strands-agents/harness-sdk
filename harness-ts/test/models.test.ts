import { afterEach, describe, expect, it, vi } from 'vitest'
import { Model, ModelRouter } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

import {
  resolveModel,
  resolveWebFetchModel,
  supportsMedia,
  supportsThinking,
  supportsWebSearch,
} from '../src/models.js'
import type { Effort } from '../src/types/agent.js'
import { DEFAULT_EFFORT } from '../src/defaults.js'
import { configureLogging, resetWarnOnce } from '../src/logging.js'

const DEFAULT = 'bedrock/global.anthropic.claude-opus-4-8'

afterEach(() => {
  resetWarnOnce()
  vi.unstubAllEnvs()
})

function resolve(
  model: Model | string | undefined,
  effort: Effort = 'auto',
  webSearch = false,
  caching = false,
  cachingExplicit = false
): Promise<Model> {
  return resolveModel(model, DEFAULT, effort, webSearch, caching, cachingExplicit) as Promise<Model>
}

describe('resolveModel', () => {
  it.each(['anthropic.claude-3-haiku-20240307-v1:0', 'us.anthropic.claude-3-haiku-20240307-v1:0'])(
    'does not send automatic cache points to %s',
    async (id) => {
      expect((await resolve(`bedrock/${id}`, 'auto', false, true)).getConfig().cacheConfig).toBeUndefined()
      await expect(resolve(`bedrock/${id}`, 'auto', false, true, true)).rejects.toThrow(
        'does not support prompt caching'
      )
    }
  )

  it('uses AWS_DEFAULT_REGION when AWS_REGION is absent and gives AWS_REGION precedence', async () => {
    vi.stubEnv('AWS_REGION', undefined)
    vi.stubEnv('AWS_DEFAULT_REGION', 'us-east-2')
    const region = async (): Promise<string> => {
      const model = await resolve(DEFAULT)
      const client = (model as unknown as { _client: { config: { region(): Promise<string> } } })._client
      return client.config.region()
    }
    expect(await region()).toBe('us-east-2')
    vi.stubEnv('AWS_REGION', 'us-west-2')
    expect(await region()).toBe('us-west-2')
  })
  it('resolves undefined to the default with thinking', async () => {
    const model = await resolve(undefined)
    expect(model).toBeInstanceOf(BedrockModel)
    const config = model.getConfig()
    expect(config.modelId).toBe('global.anthropic.claude-opus-4-8')
    expect(config.additionalRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    })
  })

  it('treats a bare string as a Bedrock model id', async () => {
    const model = await resolve('my.custom.model-id')
    expect(model).toBeInstanceOf(BedrockModel)
    expect(model.getConfig().modelId).toBe('my.custom.model-id')
  })

  it('passes a Model instance through untouched', async () => {
    const instance = new BedrockModel({ modelId: 'anything' })
    expect(await resolve(instance)).toBe(instance)
  })

  it('passes a ModelRouter through untouched', async () => {
    const router = new ModelRouter([new BedrockModel({ modelId: 'fast' }), new BedrockModel({ modelId: 'deep' })])
    expect(await resolveModel(router, DEFAULT, 'auto')).toBe(router)
  })

  it('uses the Bedrock model id directly', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8')
    expect(model.getConfig().modelId).toBe('global.anthropic.claude-opus-4-8')
  })

  it('passes a Bedrock name through', async () => {
    const model = await resolve('bedrock/some.other.model')
    expect(model.getConfig().modelId).toBe('some.other.model')
  })

  it('enables prompt caching for Bedrock when requested', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'auto', false, true)
    expect(model.getConfig().cacheConfig).toEqual({ strategy: 'auto' })
  })

  it('enables Bedrock caching even with effort off', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'off', false, true)
    expect(model.getConfig().cacheConfig).toEqual({ strategy: 'auto' })
  })

  it('does not set cacheConfig when caching is off', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'auto', false, false)
    expect(model.getConfig().cacheConfig).toBeUndefined()
  })

  it('leaves provider defaults when effort is off', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'off')
    expect(model.getConfig().additionalRequestFields).toBeUndefined()
  })

  it('rejects an effort outside the enum by name', async () => {
    await expect(resolve('bedrock/global.anthropic.claude-opus-4-8', 'bogus' as Effort)).rejects.toThrow(
      'Effort "bogus" is not valid. Supported: auto, off, minimal, low, medium, high, xhigh, max.'
    )
  })

  it('applies an explicit thinking level', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'low')
    const fields = model.getConfig().additionalRequestFields as { output_config: { effort: string } }
    expect(fields.output_config.effort).toBe('low')
  })

  it('accepts a provider-specific level', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8', 'max')
    const fields = model.getConfig().additionalRequestFields as { output_config: { effort: string } }
    expect(fields.output_config.effort).toBe('max')
  })

  it('maps OpenAI-on-Bedrock thinking to reasoning effort', async () => {
    const model = await resolve('bedrock/us.openai.gpt-5.6-luna', 'max')
    expect(model.getConfig().additionalRequestFields).toEqual({
      reasoning: { effort: 'max' },
    })
  })

  it('uses the GPT-OSS Bedrock reasoning field and levels', async () => {
    const model = await resolve('bedrock/openai.gpt-oss-120b-1:0', 'medium')
    expect(model.getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'medium',
    })
    await expect(resolve('bedrock/openai.gpt-oss-120b-1:0', 'max')).rejects.toThrow(
      'not supported by Bedrock model openai.gpt-oss-120b-1:0'
    )
  })

  it.each(['openai.gpt-6-astra', 'global.openai.gpt-6-astra', 'us.openai.gpt-6-astra'])(
    'resolves Astra effort for %s',
    async (modelId) => {
      for (const [thinking, effort] of [
        ['auto', 'high'],
        ['low', 'low'],
        ['max', 'max'],
      ] as const) {
        const model = await resolve(`bedrock/${modelId}`, thinking)
        expect(model.getConfig().additionalRequestFields).toEqual({ reasoning: { effort } })
      }
      expect((await resolve(`bedrock/${modelId}`, 'off')).getConfig().additionalRequestFields).toEqual({
        reasoning: { effort: 'none' },
      })
      await expect(resolve(`bedrock/${modelId}`, 'minimal')).rejects.toThrow(
        "Supported levels: low, medium, high, xhigh, max (or 'auto', 'off')."
      )
    }
  )

  it('uses the Qwen Bedrock reasoning field and levels', async () => {
    const model = await resolve('bedrock/qwen.qwen3-32b-v1:0', 'minimal')
    expect(model.getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'minimal',
    })
    const regional = await resolve('bedrock/us.qwen.qwen3-32b-v1:0', 'high')
    expect(regional.getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'high',
    })
    expect((await resolve('bedrock/qwen.qwen3-32b-v1:0', 'off')).getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'none',
    })
  })

  it('uses the xAI Grok Bedrock reasoning field and levels', async () => {
    const model = await resolve('bedrock/us.xai.grok-4.6', 'xhigh')
    expect(model.getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'xhigh',
    })
    const automatic = await resolve('bedrock/us.xai.grok-4.6', 'auto')
    expect(automatic.getConfig().additionalRequestFields).toEqual({
      reasoning_effort: 'high',
    })
    await expect(resolve('bedrock/us.xai.grok-4.6', 'max')).rejects.toThrow(
      'not supported by Bedrock model us.xai.grok-4.6'
    )
  })

  it('does not attach Claude thinking fields to an unknown Bedrock family', async () => {
    const model = await resolve('bedrock/amazon.nova-pro-v1:0')
    expect(model.getConfig().additionalRequestFields).toBeUndefined()
  })

  it('rejects explicit thinking for an unknown Bedrock family', async () => {
    await expect(resolve('bedrock/amazon.nova-pro-v1:0', 'high')).rejects.toThrow('not supported by Bedrock model')
  })

  it('rejects a level the provider does not support', async () => {
    await expect(resolve('google/gemini-3.5-flash', 'xhigh')).rejects.toThrow('not supported by this provider')
    await expect(resolve('openai/gpt-5.6-sol', 'max')).rejects.toThrow('not supported by this provider')
  })

  it('rejects a level the model does not support', async () => {
    await expect(resolve('bedrock/global.anthropic.claude-opus-4-8', 'minimal')).rejects.toThrow(
      'not supported by Bedrock model global.anthropic.claude-opus-4-8'
    )
  })

  it('rejects an unknown provider', async () => {
    await expect(resolve('mistral/whatever')).rejects.toThrow('Unknown model provider')
  })

  it('does not treat a gemini prefix as a provider', async () => {
    await expect(resolve('gemini/gemini-3.5-flash')).rejects.toThrow('Unknown model provider')
  })

  it('maps google auto to the high thinking level', async () => {
    const model = await resolve('google/gemini-3.5-flash')
    expect(model).toBeInstanceOf(Model)
    const params = model.getConfig().params as { thinkingConfig: { thinkingLevel: string } }
    expect(params.thinkingConfig.thinkingLevel).toBe('high')
  })

  it('uses the google model id directly', async () => {
    const model = await resolve('google/gemini-3.5-flash', 'off')
    expect(model.getConfig().modelId).toBe('gemini-3.5-flash')
  })

  it('maps openai to reasoning effort', async () => {
    const model = await resolve('openai/gpt-5.6-sol')
    expect(model).toBeInstanceOf(Model)
    const params = model.getConfig().params as { reasoning: { effort: string } }
    expect(params.reasoning.effort).toBe('high')
  })

  it('maps anthropic to thinking and max tokens', async () => {
    const model = await resolve('anthropic/claude-opus-4-8')
    const config = model.getConfig()
    expect(config.modelId).toBe('claude-opus-4-8')
    expect(config.maxTokens).toBe(128_000)
    const params = config.params as { thinking: unknown }
    expect(params.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('gives anthropic haiku its own tier max tokens', async () => {
    const model = await resolve('anthropic/claude-haiku-4-5-20251001')
    expect(model.getConfig().maxTokens).toBe(64_000)
  })

  it('falls back to a flat max tokens for an unrecognized anthropic tier', async () => {
    const model = await resolve('anthropic/claude-mythos-1')
    expect(model.getConfig().maxTokens).toBe(32_000)
  })

  it('gives a bedrock claude model tier max tokens', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-opus-4-8')
    expect(model.getConfig().maxTokens).toBe(128_000)
  })

  it('gives a bedrock claude haiku model its own tier max tokens', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(model.getConfig().maxTokens).toBe(64_000)
  })

  const ADAPTIVE = {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
  }

  const EXTENDED = { thinking: { type: 'enabled', budget_tokens: 16_384 } }

  const EXTENDED_CLAUDE = [
    'global.anthropic.claude-haiku-4-5-20251001-v1:0',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    'global.anthropic.claude-opus-4-5-20251101-v1:0',
  ]

  const NO_THINKING_CLAUDE = [
    'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'global.anthropic.claude-sonnet-4-20250514-v1:0',
    'anthropic.claude-opus-4-20250514-v1:0',
    'us.anthropic.claude-3-haiku-20240307-v1:0',
    'us.anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3.5-sonnet-20241022-v2:0',
    'anthropic.claude-3-7-sonnet-20250219-v1:0',
  ]
  const ADAPTIVE_CLAUDE = [
    'global.anthropic.claude-opus-4-6-v1',
    'global.anthropic.claude-sonnet-4-6',
    'global.anthropic.claude-opus-4-7',
    'global.anthropic.claude-opus-4-8',
    'global.anthropic.claude-opus-5',
    'global.anthropic.claude-sonnet-5',
    'global.anthropic.claude-fable-5',
    'global.anthropic.claude-fable-5-1',
    'anthropic.claude-mythos-preview',
    'anthropic.claude-mythos-5-1',
  ]

  it.each(NO_THINKING_CLAUDE)('sends no thinking block to %s', async (modelId) => {
    const model = await resolve(`bedrock/${modelId}`)
    expect(model.getConfig().additionalRequestFields).toBeUndefined()
  })

  it.each(EXTENDED_CLAUDE)('sends the extended block to %s', async (modelId) => {
    const model = await resolve(`bedrock/${modelId}`)
    expect(model.getConfig().additionalRequestFields).toEqual(EXTENDED)
  })

  it.each([
    ['low', 2_048],
    ['medium', 8_192],
    ['high', 16_384],
    ['xhigh', 32_768],
    ['max', 49_152],
  ] as const)('maps %s to a budget of %d that the api accepts', async (level, budget) => {
    const config = (await resolve('bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0', level)).getConfig()
    expect(config.additionalRequestFields).toEqual({ thinking: { type: 'enabled', budget_tokens: budget } })
    expect(budget).toBeLessThan(config.maxTokens!)
  })

  it.each([
    ['claude-sonnet-4-5-20250929-v1:0', 64_000],
    ['claude-sonnet-4.5', 64_000],
    ['claude-sonnet-4-6', 128_000],
    ['claude-sonnet-4.6', 128_000],
    ['claude-sonnet-5', 128_000],
    ['claude-opus-4-5-20251101-v1:0', 64_000],
    ['claude-opus-4.5', 64_000],
    ['claude-opus-4-8', 128_000],
    ['claude-opus-5', 128_000],
  ] as const)('gives %s a max tokens ceiling of %d', async (modelId, maxTokens) => {
    const model = await resolve(`bedrock/global.anthropic.${modelId}`)
    expect(model.getConfig().maxTokens).toBe(maxTokens)
  })

  it.each(['claude-haiku-latest', 'claude-haiku'])('falls open to extended, not adaptive, for %s', async (modelId) => {
    const model = await resolve(`bedrock/global.anthropic.${modelId}`)
    expect(model.getConfig().additionalRequestFields).toEqual(EXTENDED)
  })

  it('clamps the budget below a small max tokens', async () => {
    const model = await resolve('anthropic/claude-haiku', 'max')
    expect(model.getConfig().maxTokens).toBe(32_000)
    expect(model.getConfig().params).toEqual({ thinking: { type: 'enabled', budget_tokens: 31_999 } })
  })

  it.each(ADAPTIVE_CLAUDE)('sends the adaptive block to %s', async (modelId) => {
    const model = await resolve(`bedrock/${modelId}`)
    expect(model.getConfig().additionalRequestFields).toEqual(ADAPTIVE)
  })

  it('rejects an explicit thinking level on a claude below the thinking floor', async () => {
    await expect(resolve('bedrock/us.anthropic.claude-3-haiku-20240307-v1:0', 'high')).rejects.toThrow(
      /not supported by Bedrock model/
    )
  })

  it('sends extended thinking params to an anthropic-direct haiku model', async () => {
    const model = await resolve('anthropic/claude-haiku-4-5-20251001')
    expect(model.getConfig().params).toEqual(EXTENDED)
  })

  it('sends no thinking params to an anthropic-direct claude below the floor', async () => {
    const model = await resolve('anthropic/claude-3-haiku-20240307')
    expect(model.getConfig().params).toBeUndefined()
  })

  it('gives a bedrock claude sonnet model tier max tokens', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-sonnet-5')
    expect(model.getConfig().maxTokens).toBe(128_000)
  })

  it('gives a bedrock claude fable model tier max tokens', async () => {
    const model = await resolve('bedrock/global.anthropic.claude-fable-5')
    expect(model.getConfig().maxTokens).toBe(128_000)
  })

  it('does not force max tokens on a non-claude bedrock model', async () => {
    const model = await resolve('bedrock/amazon.nova-pro-v1:0')
    expect(model.getConfig().maxTokens).toBeUndefined()
  })

  it('does not force max tokens on a legacy claude 3 bedrock id', async () => {
    const model = await resolve('bedrock/anthropic.claude-3-haiku-20240307-v1:0')
    expect(model.getConfig().maxTokens).toBeUndefined()
  })

  it('builds bedrock-mantle via the OpenAI provider', async () => {
    const { OpenAIModel } = await import('@strands-agents/sdk/models/openai')
    const model = await resolve('bedrock-mantle/openai.gpt-oss-120b')
    expect(model).toBeInstanceOf(OpenAIModel)
    const config = model.getConfig() as { modelId: string; params: { reasoning: { effort: string } } }
    expect(config.modelId).toBe('openai.gpt-oss-120b')
    expect(config.params.reasoning.effort).toBe('high')
  })

  it('rejects an unsupported thinking level for bedrock-mantle', async () => {
    await expect(resolve('bedrock-mantle/openai.gpt-oss-120b', 'max')).rejects.toThrow('not supported by this provider')
  })

  it('adds the Bedrock Web Search tool for bedrock-mantle web_search', async () => {
    const model = await resolve('bedrock-mantle/openai.gpt-5.6-luna', 'auto', true)
    const params = model.getConfig().params as { reasoning: { effort: string }; tools: unknown }
    expect(params.reasoning.effort).toBe('high')
    expect(params.tools).toEqual([{ type: 'web_search', external_web_access: true }])
  })

  it('adds the Bedrock Web Search tool with effort off', async () => {
    const model = await resolve('bedrock-mantle/openai.gpt-5.6-luna', 'off', true)
    expect(model.getConfig().params).toEqual({
      reasoning: { effort: 'none' },
      tools: [{ type: 'web_search', external_web_access: true }],
    })
  })

  it('adds the Bedrock Web Search tool on GPT-6', async () => {
    const model = await resolve('bedrock-mantle/openai.gpt-6-astra', 'off', true)
    expect(model.getConfig().params).toEqual({
      reasoning: { effort: 'none' },
      tools: [{ type: 'web_search', external_web_access: true }],
    })
  })

  it('omits bedrock-mantle tools when web_search is off', async () => {
    const model = await resolve('bedrock-mantle/openai.gpt-5.6-luna', 'auto', false)
    const params = model.getConfig().params as { tools?: unknown }
    expect(params.tools).toBeUndefined()
  })

  it('adds the openai web_search tool alongside reasoning', async () => {
    const model = await resolve('openai/gpt-5.6-sol', 'high', true)
    const params = model.getConfig().params as { reasoning: { effort: string }; tools: unknown }
    expect(params.reasoning.effort).toBe('high')
    expect(params.tools).toEqual([{ type: 'web_search' }])
  })

  it('adds the openai web_search tool with effort off', async () => {
    const model = await resolve('openai/gpt-5.6-sol', 'off', true)
    const params = model.getConfig().params as { tools: unknown; reasoning?: unknown }
    expect(params.tools).toEqual([{ type: 'web_search' }])
    expect(params.reasoning).toEqual({ effort: 'none' })
  })

  it('omits openai tools when web_search is off', async () => {
    const model = await resolve('openai/gpt-5.6-sol', 'high', false)
    const params = model.getConfig().params as { tools?: unknown }
    expect(params.tools).toBeUndefined()
  })

  it('adds the google googleSearch built-in tool for web_search', async () => {
    const model = await resolve('google/gemini-3.5-flash', 'medium', true)
    expect(model.getConfig().builtInTools).toEqual([{ googleSearch: {} }])
  })

  it('omits google built-in tools when web_search is off', async () => {
    const model = await resolve('google/gemini-3.5-flash', 'medium', false)
    expect(model.getConfig().builtInTools).toBeUndefined()
  })

  it('never adds a native search tool where the model has none', async () => {
    // The factory only passes web_search for models that have it; the builders never add the tool elsewhere.
    for (const id of ['bedrock-mantle/qwen.qwen3-32b-v1:0', 'bedrock-mantle/openai.gpt-oss-120b-1:0']) {
      expect((await resolve(id, 'high', true)).getConfig().params).not.toHaveProperty('tools')
    }
    expect((await resolve('anthropic/claude-opus-4-8', 'high', true)).getConfig()).not.toHaveProperty('anthropicTools')
  })

  it('warns instead of throwing when an effort level is requested on a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const instance = new BedrockModel({ modelId: 'anything' })
    expect(await resolve(instance, 'high')).toBe(instance)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('effort "high" not applied'))
  })

  it('does not warn for a Model instance with default effort and no web_search or caching', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const instance = new BedrockModel({ modelId: 'anything' })
    expect(await resolve(instance, DEFAULT_EFFORT)).toBe(instance)
    expect(warn).not.toHaveBeenCalled()
  })

  it('enables prompt caching for anthropic direct when requested', async () => {
    const model = await resolve('anthropic/claude-opus-4-8', 'auto', false, true)
    expect(model.getConfig().cacheConfig).toEqual({ strategy: 'auto' })
  })

  it('does not set cacheConfig for anthropic direct when caching is off', async () => {
    const model = await resolve('anthropic/claude-opus-4-8', 'auto', false, false)
    expect(model.getConfig().cacheConfig).toBeUndefined()
  })

  it('warns instead of throwing when caching is explicitly requested on a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const instance = new BedrockModel({ modelId: 'anything' })
    expect(await resolve(instance, 'auto', false, true, true)).toBe(instance)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pre-built Model instance'))
  })

  it('does not warn when default caching hits a Model instance', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const instance = new BedrockModel({ modelId: 'anything' })
    const model = await resolve(instance, 'auto', false, true, false)
    expect(model).toBe(instance)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn when caching is supported', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    await resolve('bedrock-mantle/openai.gpt-oss-120b', 'auto', false, true, false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn when caching is supported for litellm', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    await resolve('litellm/gpt-4o', 'auto', false, true, false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('builds litellm with explicit caching and sets no cacheConfig', async () => {
    const model = await resolve('litellm/gpt-4o', 'auto', false, true, true)
    expect(model.getConfig().cacheConfig).toBeUndefined()
  })
})

// https://github.com/strands-agents/harness-sdk/issues/4472
describe('default effort', () => {
  // [model spec, path of the effort field in the resolved config]
  const HIGH_BY_DEFAULT: [string, string[]][] = [
    ['bedrock/global.anthropic.claude-opus-5', ['additionalRequestFields', 'output_config', 'effort']],
    ['bedrock/global.anthropic.claude-sonnet-5', ['additionalRequestFields', 'output_config', 'effort']],
    ['bedrock/us.anthropic.claude-sonnet-4-6', ['additionalRequestFields', 'output_config', 'effort']],
    ['bedrock/global.anthropic.claude-fable-5-1', ['additionalRequestFields', 'output_config', 'effort']],
    ['bedrock/openai.gpt-5.6-sol', ['additionalRequestFields', 'reasoning', 'effort']],
    ['bedrock/global.openai.gpt-6-astra', ['additionalRequestFields', 'reasoning', 'effort']],
    ['bedrock/openai.gpt-oss-120b-1:0', ['additionalRequestFields', 'reasoning_effort']],
    ['bedrock/qwen.qwen3-32b-v1:0', ['additionalRequestFields', 'reasoning_effort']],
    ['bedrock/us.xai.grok-4', ['additionalRequestFields', 'reasoning_effort']],
    ['anthropic/claude-opus-5', ['params', 'output_config', 'effort']],
    ['openai/gpt-5.6-sol', ['params', 'reasoning', 'effort']],
    ['bedrock-mantle/openai.gpt-5.6-sol', ['params', 'reasoning', 'effort']],
    ['google/gemini-3.5-flash', ['params', 'thinkingConfig', 'thinkingLevel']],
  ]

  it.each(HIGH_BY_DEFAULT)('is high on %s', async (spec, path) => {
    const config = (await resolve(spec, DEFAULT_EFFORT)).getConfig() as Record<string, unknown>
    const at = path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config)
    expect(at).toBe('high')
    expect(config).toEqual((await resolve(spec, 'high')).getConfig())
  })

  it.each(['bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic/claude-haiku-4-5-20251001'])(
    'is the high budget on extended-thinking %s',
    async (spec) => {
      const config = (await resolve(spec, DEFAULT_EFFORT)).getConfig()
      const block = spec.startsWith('bedrock/') ? config.additionalRequestFields : config.params
      expect(block).toEqual({ thinking: { type: 'enabled', budget_tokens: 16_384 } })
      expect(config).toEqual((await resolve(spec, 'high')).getConfig())
    }
  )

  it.each([
    'ollama/llama3',
    'litellm/gpt-4o',
    'bedrock/amazon.nova-pro-v1:0',
    'bedrock/us.anthropic.claude-3-haiku-20240307-v1:0',
    'anthropic/claude-3-haiku-20240307',
  ])('sends no reasoning field to %s, where high would be rejected', async (spec) => {
    const config = (await resolve(spec, DEFAULT_EFFORT)).getConfig()
    expect(config).not.toHaveProperty('additionalRequestFields')
    expect(config).not.toHaveProperty('params')
    await expect(resolve(spec, 'high')).rejects.toThrow(/not supported/)
  })
})

describe('supportsThinking', () => {
  const NO_THINKING_BEDROCK = [
    'amazon.nova-pro-v1:0',
    'us.amazon.nova-pro-v1:0',
    'meta.llama3-3-70b-instruct-v1:0',
    'deepseek.r1-v1:0',
    'mistral.mistral-large-2407-v1:0',
  ]
  const CROSS_REGION_PREFIXES = ['', 'global.', 'apac.', 'us.', 'eu.', 'au.', 'jp.']

  it('answers for consumers', () => {
    expect(supportsThinking('bedrock/global.anthropic.claude-opus-4-8')).toBe(true)
    expect(supportsThinking('bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true)
    expect(supportsThinking('anthropic/claude-haiku-4-5-20251001')).toBe(true)
    expect(supportsThinking('bedrock/us.anthropic.claude-3-haiku-20240307-v1:0')).toBe(false)
    expect(supportsThinking('anthropic/claude-3-haiku-20240307')).toBe(false)
    expect(supportsThinking('ollama/llama3')).toBe(false)
    expect(supportsThinking(undefined)).toBe(true)
  })

  it('is true for a Model instance', () => {
    expect(supportsThinking(new BedrockModel({ modelId: 'anything' }))).toBe(true)
  })

  it('is true for a ModelRouter', () => {
    const router = new ModelRouter([new BedrockModel({ modelId: 'fast' })])
    expect(supportsThinking(router)).toBe(true)
  })

  it.each(NO_THINKING_BEDROCK)('is false for %s, which takes no level', async (modelId) => {
    expect(supportsThinking(`bedrock/${modelId}`)).toBe(false)
    await expect(resolve(`bedrock/${modelId}`, 'high')).rejects.toThrow(/not supported by Bedrock model/)
  })

  it.each(CROSS_REGION_PREFIXES)('resolves the claude family behind the %s prefix', async (prefix) => {
    const modelId = `bedrock/${prefix}anthropic.claude-opus-4-8`
    expect(supportsThinking(modelId)).toBe(true)
    const model = await resolve(modelId, 'max')
    expect(model.getConfig().additionalRequestFields).toEqual({
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'max' },
    })
  })

  it.each([
    ['claude-opus-4.8', true],
    ['claude-sonnet-4.6', true],
    ['claude-opus-4.5', true],
    ['claude-haiku-4.5', true],
    ['claude-opus-4.1', false],
  ] as const)('reads the dot-separated version in %s as thinking=%s', (modelId, thinks) => {
    expect(supportsThinking(`bedrock/global.anthropic.${modelId}`)).toBe(thinks)
  })

  it.each(['claude-opus-latest', 'claude-sonnet-latest', 'claude-opus-100'])(
    'fails open to adaptive for %s, whose version does not parse',
    async (modelId) => {
      expect(supportsThinking(`bedrock/global.anthropic.${modelId}`)).toBe(true)
      const model = await resolve(`bedrock/global.anthropic.${modelId}`)
      expect(model.getConfig().additionalRequestFields).toEqual({
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'high' },
      })
    }
  )

  it('is true for an unrecognized claude family', () => {
    expect(supportsThinking('bedrock/global.anthropic.claude-quasar-6')).toBe(true)
  })
})

describe('supportsWebSearch', () => {
  it('is true for openai, google and bedrock-mantle', () => {
    expect(supportsWebSearch('openai/gpt-5.6-sol')).toBe(true)
    expect(supportsWebSearch('google/gemini-3.5-flash')).toBe(true)
    expect(supportsWebSearch('bedrock-mantle/openai.gpt-5.6-luna')).toBe(true)
    expect(supportsWebSearch('bedrock-mantle/openai.gpt-6-astra')).toBe(true)
    expect(supportsWebSearch('bedrock-mantle/openai.gpt-oss-120b')).toBe(false)
    expect(supportsWebSearch('bedrock-mantle/qwen.qwen3-32b-v1:0')).toBe(false)
  })

  it('is false for bedrock and anthropic', () => {
    expect(supportsWebSearch('bedrock/global.anthropic.claude-opus-4-8')).toBe(false)
    expect(supportsWebSearch('anthropic/claude-opus-4-8')).toBe(false)
  })

  it('uses the default model provider for undefined', () => {
    expect(supportsWebSearch(undefined)).toBe(false)
  })

  it('is false for a Model instance', () => {
    expect(supportsWebSearch(new BedrockModel({ modelId: 'anything' }))).toBe(false)
  })

  it('is false for a ModelRouter', () => {
    const router = new ModelRouter([new BedrockModel({ modelId: 'fast' })])
    expect(supportsWebSearch(router)).toBe(false)
  })
})

describe('resolveWebFetchModel', () => {
  it('defaults to the provider small model with no thinking', async () => {
    const model = await resolveWebFetchModel('bedrock/global.anthropic.claude-opus-4-8', undefined)
    expect(model).toBeInstanceOf(BedrockModel)
    const config = model.getConfig()
    expect(config.modelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0')
    expect(config.additionalRequestFields).toBeUndefined()
  })

  it('uses the openai small model for an openai-on-bedrock main model', async () => {
    const model = await resolveWebFetchModel('bedrock/openai.gpt-5.6-luna', undefined)
    expect(model).toBeInstanceOf(BedrockModel)
    expect(model.getConfig().modelId).toBe('openai.gpt-5.6-luna')
  })

  it('keeps a cross-region prefix for openai-on-bedrock', async () => {
    const model = await resolveWebFetchModel('bedrock/us.openai.gpt-5.6-sol', undefined)
    expect(model.getConfig().modelId).toBe('us.openai.gpt-5.6-luna')
  })

  it('keeps a global prefix for openai-on-bedrock', async () => {
    const model = await resolveWebFetchModel('bedrock/global.openai.gpt-5.6-sol', undefined)
    expect(model.getConfig().modelId).toBe('global.openai.gpt-5.6-luna')
  })

  it('keeps haiku for an anthropic-on-bedrock main model', async () => {
    const model = await resolveWebFetchModel('bedrock/global.anthropic.claude-opus-4-8', undefined)
    expect(model.getConfig().modelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  it('reuses the main model and warns for an unidentifiable bedrock family', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const model = await resolveWebFetchModel('bedrock/amazon.nova-pro-v1:0', undefined)
    expect(model).toBeInstanceOf(BedrockModel)
    expect(model.getConfig().modelId).toBe('amazon.nova-pro-v1:0')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not identify the Bedrock model family'))
  })

  it('does not warn for an unidentifiable bedrock family with an explicit override', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    const override = new BedrockModel({ modelId: 'explicit' })
    expect(await resolveWebFetchModel('bedrock/amazon.nova-pro-v1:0', override)).toBe(override)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reuses a main Model instance when no override is given', async () => {
    const main = new BedrockModel({ modelId: 'whatever' })
    expect(await resolveWebFetchModel(main, undefined)).toBe(main)
  })

  it('uses a main ModelRouter default when no override is given', async () => {
    const defaultModel = new BedrockModel({ modelId: 'fast' })
    const router = new ModelRouter([defaultModel, new BedrockModel({ modelId: 'deep' })])
    expect(await resolveWebFetchModel(router, undefined)).toBe(defaultModel)
  })

  it('uses an explicit ModelRouter default', async () => {
    const defaultModel = new BedrockModel({ modelId: 'fast' })
    const router = new ModelRouter([defaultModel, new BedrockModel({ modelId: 'deep' })])
    expect(await resolveWebFetchModel(undefined, router)).toBe(defaultModel)
  })

  it('uses an explicit Model instance override', async () => {
    const override = new BedrockModel({ modelId: 'explicit' })
    expect(await resolveWebFetchModel('bedrock/global.anthropic.claude-opus-4-8', override)).toBe(override)
  })

  it('resolves an explicit provider/name override string', async () => {
    const model = await resolveWebFetchModel(
      'bedrock/global.anthropic.claude-opus-4-8',
      'anthropic/claude-haiku-4-5-20251001'
    )
    expect(model).toBeInstanceOf(Model)
    expect(model.getConfig().modelId).toBe('claude-haiku-4-5-20251001')
  })

  it('has a default fetch model for bedrock-mantle', async () => {
    const model = await resolveWebFetchModel('bedrock-mantle/openai.gpt-oss-120b', undefined)
    expect(model.getConfig().modelId).toBe('openai.gpt-5.6-luna')
  })
})

describe('supportsMedia', () => {
  it('is false for OpenAI-family models on Bedrock Converse', async () => {
    expect(await supportsMedia('bedrock/us.openai.gpt-6-astra')).toBe(false)
    expect(await supportsMedia('bedrock/openai.gpt-5.6-sol')).toBe(false)
  })

  it('is true elsewhere', async () => {
    expect(await supportsMedia('bedrock/global.anthropic.claude-opus-4-8')).toBe(true)
    expect(await supportsMedia('anthropic/claude-haiku-4-5-20251001')).toBe(true)
    expect(await supportsMedia('bedrock-mantle/openai.gpt-6-astra')).toBe(true)
    expect(await supportsMedia(undefined)).toBe(true)
  })

  it('reads a Bedrock instance model id', async () => {
    expect(await supportsMedia(new BedrockModel({ modelId: 'global.anthropic.claude-opus-4-8' }))).toBe(true)
    expect(await supportsMedia(new BedrockModel({ modelId: 'us.openai.gpt-6-astra' }))).toBe(false)
  })

  it('requires every router candidate to support media', async () => {
    const capable = new ModelRouter([new BedrockModel({ modelId: 'global.anthropic.claude-opus-4-8' })])
    expect(await supportsMedia(capable)).toBe(true)

    const mixed = new ModelRouter([
      new BedrockModel({ modelId: 'global.anthropic.claude-opus-4-8' }),
      new BedrockModel({ modelId: 'us.openai.gpt-6-astra' }),
    ])
    expect(await supportsMedia(mixed)).toBe(false)
  })
})

describe('web_fetch summarizer on a repointed endpoint', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.OPENAI_BASE_URL
  })

  it('reuses the main model when ANTHROPIC_BASE_URL is set', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1'
    const model = await resolveWebFetchModel('anthropic/anthropic.claude-fable-5', undefined)
    expect(model.getConfig().modelId).toBe('anthropic.claude-fable-5')
  })

  it('reuses the main model when OPENAI_BASE_URL is set', async () => {
    process.env.OPENAI_BASE_URL = 'https://bedrock-mantle.us-west-2.api.aws/v1'
    const model = await resolveWebFetchModel('openai/gpt-oss-20b', undefined)
    expect(model.getConfig().modelId).toBe('gpt-oss-20b')
  })

  it('still uses the small model on the first-party endpoint', async () => {
    const model = await resolveWebFetchModel('anthropic/claude-opus-4-5-20251101', undefined)
    expect(model.getConfig().modelId).toBe('claude-haiku-4-5-20251001')
  })

  it('does not affect bedrock', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://example.invalid/anthropic'
    const model = await resolveWebFetchModel('bedrock/global.anthropic.claude-opus-4-8', undefined)
    expect(model.getConfig().modelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0')
  })
})
