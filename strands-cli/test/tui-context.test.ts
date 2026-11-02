import type { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { AnthropicModel } from '@strands-agents/sdk/models/anthropic'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentModelRuntime } from '../src/tui/model/runtime.js'
import { contextWindowLimit } from '../src/tui/model/context.js'
import { discoverContextWindow } from '../src/tui/provider/discovery.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('context window limits', () => {
  // https://github.com/strands-agents/harness-sdk/issues/5414
  it.each([
    ['claude-opus-5-5', 1_000_000],
    ['claude-fable-5-1', 1_000_000],
    ['claude-sonnet-5-5', 1_000_000],
    ['claude-haiku-5-5', 1_000_000],
    ['anthropic.claude-opus-5-5', 1_000_000],
    ['anthropic.claude-fable-5-1', 1_000_000],
    ['anthropic.claude-sonnet-5-5', 1_000_000],
    ['anthropic.claude-haiku-5-5', 1_000_000],
    ['zai.glm-4.7', 203_000],
    ['zai.glm-4.7-flash', 203_000],
    ['zai.glm-5', 200_000],
    ['zai.glm-5.3', 1_000_000],
    ['openai.gpt-oss-120b', 128_000],
    ['openai.gpt-oss-120b-1:0', 128_000],
    ['openai.gpt-oss-20b', 128_000],
    ['openai.gpt-oss-20b-1:0', 128_000],
    ['openai.gpt-oss-safeguard-120b', 128_000],
    ['openai.gpt-oss-safeguard-20b', 128_000],
    ['openai.gpt-6-astra', 1_050_000],
    ['openai.gpt-6.1-sol', 1_000_000],
    ['openai.gpt-6.1-terra', 1_050_000],
    ['openai.gpt-6-sol', 1_050_000],
    ['openai.gpt-6-luna', 1_050_000],
    ['openai.gpt-5.6-sol', 1_050_000],
    ['openai.gpt-5.6-terra', 1_050_000],
    ['openai.gpt-5.6-luna', 1_050_000],
    ['openai.gpt-5.5', 1_050_000],
    ['openai.gpt-5.4', 1_050_000],
    ['mistral.mistral-large-3-675b-instruct', 256_000],
    ['mistral.ministral-3-14b-instruct', 128_000],
    ['mistral.ministral-3-8b-instruct', 128_000],
    ['mistral.ministral-3-3b-instruct', 128_000],
    ['mistral.magistral-small-2509', 128_000],
    ['mistral.pixtral-large-2502-v1:0', 128_000],
    ['mistral.mistral-small-2402-v1:0', 32_000],
    ['mistral.mistral-large-2402-v1:0', 32_000],
    ['google.gemma-4-31b', 256_000],
    ['google.gemma-4-26b-a4b', 256_000],
    ['google.gemma-4-e2b', 128_000],
    ['xai.grok-4.7', 524_288],
    ['xai.grok-4.6', 500_000],
    ['xai.grok-4.3', 1_000_000],
    ['chat-latest', 272_000],
    ['gpt-6.1-sol', 1_050_000],
    ['gpt-6.1-terra', 1_050_000],
    ['gpt-6-sol', 1_050_000],
    ['gpt-6-luna', 1_050_000],
    ['gpt-oss-120b', 131_072],
    ['gpt-oss-20b', 131_072],
    ['gemini-4-argon', 1_048_576],
    ['gemini-3.8-flash', 1_048_576],
    ['gemini-3.7-flash', 1_048_576],
    ['global.openai.gpt-6-astra', 1_050_000],
    ['us.openai.gpt-6-sol', 1_050_000],
    ['us.openai.gpt-6.1-sol', 1_000_000],
    ['us.openai.gpt-6.1-terra', 1_050_000],
    ['in.openai.gpt-5.6-luna', 1_050_000],
    ['global.openai.gpt-oss-120b', 128_000],
    ['us-gov.mistral.mistral-large-3-675b-instruct', 256_000],
    ['ap.anthropic.claude-sonnet-5-5', 1_000_000],
    ['in.xai.grok-4.7', 524_288],
    ['arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.openai.gpt-oss-20b-1:0', 128_000],
  ])('fills missing SDK metadata for %s', (modelId, limit) => {
    expect(contextWindowLimit(new BedrockModel({ modelId }))).toBe(limit)
  })

  it('prefers SDK metadata over the fallback for newer models', () => {
    const model = new BedrockModel({ modelId: 'openai.gpt-oss-120b' })
    vi.spyOn(model, 'getConfig').mockReturnValue({ contextWindowLimit: 100_000 })

    expect(contextWindowLimit(model)).toBe(100_000)
  })

  it('honors a configured context cap and leaves unknown models unknown', () => {
    expect(contextWindowLimit(new BedrockModel({ modelId: 'openai.gpt-6-astra', contextWindowLimit: 100_000 }))).toBe(
      100_000
    )
    expect(contextWindowLimit(new BedrockModel({ modelId: 'vendor.unknown' }))).toBeUndefined()
    expect(contextWindowLimit(new BedrockModel({ modelId: 'constructor' }))).toBeUndefined()
  })

  it('prefers provider metadata over SDK defaults and caches it per model', async () => {
    const discover = vi.fn().mockResolvedValue(1_000_000)
    const model = new AnthropicModel({ modelId: 'claude-sonnet-4-6', apiKey: 'test-key' })
    const runtime = new AgentModelRuntime({ model } as unknown as Agent, {
      initialModel: 'anthropic/claude-sonnet-4-6',
      discoverContextWindow: discover,
    })

    await expect(Promise.all([runtime.contextWindow(), runtime.contextWindow()])).resolves.toEqual([
      1_000_000, 1_000_000,
    ])
    await expect(runtime.contextWindow()).resolves.toBe(1_000_000)
    expect(discover).toHaveBeenCalledOnce()
    model.updateConfig({ modelId: 'claude-other' })
    await expect(runtime.contextWindow()).resolves.toBe(1_000_000)
    expect(discover).toHaveBeenLastCalledWith('anthropic', 'claude-other', {})
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('retries unavailable metadata after falling back to the model config', async () => {
    const discover = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(1_000_000)
    const model = new AnthropicModel({ modelId: 'claude-test', apiKey: 'test-key', contextWindowLimit: 100_000 })
    const runtime = new AgentModelRuntime({ model } as unknown as Agent, {
      initialModel: 'anthropic/claude-test',
      discoverContextWindow: discover,
    })

    await expect(runtime.contextWindow()).resolves.toBe(100_000)
    await expect(runtime.contextWindow()).resolves.toBe(1_000_000)
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('refreshes the Ollama allocation while sharing concurrent lookups', async () => {
    const discover = vi.fn().mockResolvedValueOnce(4_096).mockResolvedValueOnce(32_768)
    const model = { modelId: 'llama3', getConfig: () => ({}) }
    const runtime = new AgentModelRuntime({ model } as unknown as Agent, {
      initialModel: 'ollama/llama3',
      discoverContextWindow: discover,
    })

    await expect(Promise.all([runtime.contextWindow(), runtime.contextWindow()])).resolves.toEqual([4_096, 4_096])
    expect(discover).toHaveBeenCalledOnce()
    await expect(runtime.contextWindow()).resolves.toBe(32_768)
    expect(discover).toHaveBeenCalledTimes(2)
  })
})

describe('provider context metadata', () => {
  it('reads the Anthropic input limit using the configured credential', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        globalThis.Response.json({ id: 'claude-test', max_input_tokens: 1_000_000, max_tokens: 128_000 })
      )

    await expect(
      discoverContextWindow('anthropic', 'claude-test', {
        ANTHROPIC_API_KEY: { value: 'test-key', source: 'config' },
      })
    ).resolves.toBe(1_000_000)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models/claude-test',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
      })
    )
  })

  it('reads the Google input limit without confusing it with the output limit', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(globalThis.Response.json({ inputTokenLimit: 1_048_576, outputTokenLimit: 65_536 }))

    await expect(
      discoverContextWindow('google', 'models/gemini-test', {
        GEMINI_API_KEY: { value: 'test-key', source: 'process' },
      })
    ).resolves.toBe(1_048_576)
    expect(fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test',
      expect.objectContaining({ headers: { 'x-goog-api-key': 'test-key' } })
    )
  })

  it.each(['llama3', 'llama3:latest'])('uses the running Ollama allocation for %s', async (modelId) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      globalThis.Response.json({
        models: [
          { name: 'other:latest', context_length: 4_096 },
          { name: 'llama3:latest', context_length: 32_768 },
        ],
      })
    )

    await expect(
      discoverContextWindow('ollama', modelId, {
        OLLAMA_HOST: { value: 'http://localhost:11434/v1/', source: 'config' },
      })
    ).resolves.toBe(32_768)
    expect(fetch).toHaveBeenCalledWith('http://localhost:11434/api/ps', expect.anything())
  })

  it.each([undefined, 0])('ignores an absent or zero provider limit: %s', async (limit) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(globalThis.Response.json({ max_input_tokens: limit }))

    await expect(
      discoverContextWindow('anthropic', 'claude-test', {
        ANTHROPIC_API_KEY: { value: 'test-key', source: 'process' },
      })
    ).resolves.toBeUndefined()
  })

  it('tolerates unavailable metadata without failing the turn', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('request timed out'))

    await expect(discoverContextWindow('ollama', 'llama3', {})).resolves.toBeUndefined()
  })

  it('does not request catalogs that omit context limits', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')

    await expect(discoverContextWindow('bedrock', 'openai.gpt-6-astra', {})).resolves.toBeUndefined()
    await expect(discoverContextWindow('bedrock-mantle', 'openai.gpt-6-astra', {})).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
