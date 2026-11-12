import { describe, it, expect, vi } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { z } from 'zod'
import { anthropic, bedrock, gemini, openai, vercelBedrock } from '../__fixtures__/model-providers.js'

describe.each([
  {
    name: 'Claude API',
    provider: anthropic,
    createModel: (): Model => anthropic.createModel({ modelId: 'claude-haiku-4-5', maxTokens: 1024 }),
    delivery: 'native',
  },
  {
    name: 'Bedrock Converse with Claude',
    provider: bedrock,
    createModel: (): Model =>
      bedrock.createModel({ modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', maxTokens: 1024 }),
    delivery: 'stubs',
  },
  {
    name: 'Bedrock Converse with Qwen',
    provider: bedrock,
    createModel: (): Model => bedrock.createModel({ modelId: 'qwen.qwen3-next-80b-a3b', maxTokens: 1024 }),
    delivery: 'stubs',
  },
  {
    name: 'Gemini',
    provider: gemini,
    createModel: (): Model => gemini.createModel({ modelId: 'gemini-2.5-flash' }),
    delivery: 'stubs',
  },
  {
    name: 'OpenAI Chat Completions',
    provider: openai,
    createModel: (): Model => openai.createModel({ modelId: 'gpt-5.4' }),
    delivery: 'stubs',
  },
  {
    name: 'Vercel AI SDK on Bedrock',
    provider: vercelBedrock,
    createModel: (): Model => vercelBedrock.createModel(),
    delivery: 'stubs',
  },
])('dynamic tool loading on $name', ({ provider, createModel, delivery }) => {
  it.skipIf(provider.skip)(
    'loads a deferred tool, calls it with valid input, and sends the same tools list on every call',
    async () => {
      const weatherCalls: unknown[] = []
      const getWeather = tool({
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        inputSchema: z.object({ city: z.string(), unit: z.enum(['celsius', 'fahrenheit']) }),
        callback: (input) => {
          weatherCalls.push(input)
          return 'Sunny, 21 degrees.'
        },
      })
      // The preset defers from 20 tools.
      const others = Array.from({ length: 19 }, (_, index) =>
        tool({
          name: `inventory_tool_${index}`,
          description: `Inventory operation ${index}.`,
          inputSchema: z.object({ sku: z.string() }),
          callback: () => 'ok',
        })
      )
      const model = createModel()
      const agent = new Agent({
        model,
        tools: [getWeather, ...others],
        contextManager: { strategies: ['dynamicToolLoading'] },
        printer: false,
      })
      // The provider's input, after ModelProxy builds the stubs.
      const streamSpy = vi.spyOn(model, 'stream')

      const result = await agent.invoke('What is the weather in Paris, in celsius? Use the tools.')

      expect(model.modelInfo.capabilities?.deferredTools).toBe(delivery)
      expect(result.stopReason).toBe('endTurn')
      expect(weatherCalls).toEqual([{ city: 'Paris', unit: 'celsius' }])
      const toolLists = streamSpy.mock.calls.map(([, options]) => options?.toolSpecs)
      expect(new Set(toolLists.map((toolSpecs) => JSON.stringify(toolSpecs))).size).toBe(1)
      expect(toolLists[0]!.find((spec) => spec.name === 'get_weather')).toEqual(
        delivery === 'native'
          ? expect.objectContaining({ deferLoading: true })
          : expect.objectContaining({ inputSchema: { type: 'object' } })
      )
      const loaded = agent.messages
        .flatMap((message) => message.content)
        .flatMap((block) => (block.type === 'toolResultBlock' ? block.content : []))
        .filter((content) => content.type === 'toolReferenceBlock')
        .map((content) => content.name)
      expect(loaded).toContain('get_weather')
    },
    120_000
  )
})
