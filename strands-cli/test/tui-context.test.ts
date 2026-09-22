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
  it.each(['openai.gpt-6-astra', 'global.openai.gpt-6-astra', 'us.openai.gpt-6-astra'])(
    'uses the documented Bedrock context window for %s',
    (modelId) => {
      expect(contextWindowLimit(new BedrockModel({ modelId }))).toBe(1_050_000)
    }
  )

  it('honors a configured context cap and leaves unknown models unknown', () => {
    expect(contextWindowLimit(new BedrockModel({ modelId: 'openai.gpt-6-astra', contextWindowLimit: 100_000 }))).toBe(
      100_000
    )
    expect(contextWindowLimit(new BedrockModel({ modelId: 'vendor.unknown' }))).toBeUndefined()
  })

  it('prefers provider metadata over SDK defaults and caches it per model', async () => {
    const discover = vi.fn().mockResolvedValue(1_000_000)
    const model = new AnthropicModel({ modelId: 'claude-sonnet-4-20250514', apiKey: 'test-key' })
    const runtime = new AgentModelRuntime({ model } as unknown as Agent, {
      initialModel: 'anthropic/claude-sonnet-4-20250514',
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
