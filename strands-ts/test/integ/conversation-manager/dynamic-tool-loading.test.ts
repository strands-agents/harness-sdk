import { describe, it, expect, vi } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { z } from 'zod'
import { anthropic, bedrock, gemini, openai, openaiResponses, vercelBedrock } from '../__fixtures__/model-providers.js'

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
    delivery: 'unsupported',
  },
  {
    name: 'Bedrock Converse with Nova',
    provider: bedrock,
    createModel: (): Model => bedrock.createModel({ modelId: 'us.amazon.nova-pro-v1:0', maxTokens: 1024 }),
    delivery: 'unsupported',
  },
  {
    name: 'Bedrock Converse with Qwen',
    provider: bedrock,
    createModel: (): Model => bedrock.createModel({ modelId: 'qwen.qwen3-next-80b-a3b', maxTokens: 1024 }),
    delivery: 'unsupported',
  },
  {
    name: 'Gemini',
    provider: gemini,
    createModel: (): Model => gemini.createModel({ modelId: 'gemini-2.5-flash' }),
    delivery: 'unsupported',
  },
  {
    name: 'OpenAI Chat Completions',
    provider: openai,
    createModel: (): Model => openai.createModel({ modelId: 'gpt-5.4' }),
    delivery: 'unsupported',
  },
  {
    name: 'OpenAI Responses',
    provider: openaiResponses,
    createModel: (): Model => openaiResponses.createModel({ modelId: 'gpt-5.4' }),
    delivery: 'unsupported',
  },
  {
    name: 'Vercel AI SDK on Bedrock',
    provider: vercelBedrock,
    createModel: (): Model => vercelBedrock.createModel(),
    delivery: 'unsupported',
  },
])('dynamic tool loading on $name', ({ provider, createModel, delivery }) => {
  it.skipIf(provider.skip)(
    'loads the weather tool through search_tools, then calls it with valid input',
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
      // The preset defers from 20 tools, the SDK's own included.
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
      // The provider's input, after the strategy renders each call's tools.
      const streamSpy = vi.spyOn(model, 'stream')

      const result = await agent.invoke('What is the weather in Paris, in celsius? Use the tools.')

      expect(model.modelInfo.capabilities?.dynamicToolLoading).toBe(delivery)
      expect(result.stopReason).toBe('endTurn')
      expect(weatherCalls).toEqual([{ city: 'Paris', unit: 'celsius' }])
      // The model loaded the tool first: the guard never turned a call away.
      const results = agent.messages
        .flatMap((message) => message.content)
        .flatMap((block) => (block.type === 'toolResultBlock' ? [block] : []))
      const turnedAway = results.filter((block) =>
        block.content.some((content) => content.type === 'textBlock' && content.text.startsWith('Not run:'))
      )
      expect(turnedAway).toEqual([])
      const loaded = results
        .flatMap((block) => block.content)
        .flatMap((content) => (content.type === 'toolReferenceBlock' ? [content.name] : []))
      expect(loaded).toContain('get_weather')
      const sent = streamSpy.mock.calls.map(([, options]) => options?.toolSpecs ?? [])
      if (delivery === 'native') {
        expect(new Set(sent.map((toolSpecs) => JSON.stringify(toolSpecs))).size).toBe(1)
        expect(streamSpy.mock.calls[0]?.[1]?.deferredTools?.has('get_weather')).toBe(true)
        return
      }
      // Without native deferral the tool goes out once loaded, and a load only adds to the end of the tools list.
      expect(sent[0]!.map((spec) => spec.name)).not.toContain('get_weather')
      expect(sent.at(-1)!.at(-1)).toEqual(getWeather.toolSpec)
      sent.slice(1).forEach((toolSpecs, index) => expect(toolSpecs.slice(0, sent[index]!.length)).toEqual(sent[index]))
    },
    120_000
  )
})
