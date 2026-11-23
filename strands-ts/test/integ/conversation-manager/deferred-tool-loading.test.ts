import { describe, it, expect, vi } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import type { Model } from '@strands-agents/sdk'
import { Offload, type ToolSearch } from '@strands-agents/sdk/context-manager'
import { z } from 'zod'
import { anthropic, bedrock, gemini, openai, openaiResponses, vercelBedrock } from '../__fixtures__/model-providers.js'

describe.each<{
  name: string
  provider: { skip: boolean }
  createModel: () => Model
  delivery: string
  /** The search modes to run besides loading by name. */
  searches: ToolSearch[]
}>([
  {
    name: 'Claude API',
    provider: anthropic,
    createModel: (): Model => anthropic.createModel({ modelId: 'claude-haiku-4-5', maxTokens: 1024 }),
    delivery: 'native',
    searches: ['auto', 'client'],
  },
  {
    name: 'Bedrock Converse with Claude',
    provider: bedrock,
    createModel: (): Model =>
      bedrock.createModel({ modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', maxTokens: 1024 }),
    delivery: 'stubs',
    searches: ['auto'],
  },
  {
    name: 'Bedrock Converse with Nova',
    provider: bedrock,
    createModel: (): Model => bedrock.createModel({ modelId: 'us.amazon.nova-pro-v1:0', maxTokens: 1024 }),
    delivery: 'unsupported',
    searches: ['auto', 'client'],
  },
  {
    name: 'Bedrock Converse with Qwen',
    provider: bedrock,
    createModel: (): Model => bedrock.createModel({ modelId: 'qwen.qwen3-next-80b-a3b', maxTokens: 1024 }),
    delivery: 'stubs',
    searches: [],
  },
  {
    name: 'Gemini',
    provider: gemini,
    createModel: (): Model => gemini.createModel({ modelId: 'gemini-2.5-flash' }),
    delivery: 'stubs',
    searches: [],
  },
  {
    name: 'OpenAI Chat Completions',
    provider: openai,
    createModel: (): Model => openai.createModel({ modelId: 'gpt-5.4' }),
    delivery: 'stubs',
    searches: [],
  },
  {
    name: 'OpenAI Responses',
    provider: openaiResponses,
    createModel: (): Model => openaiResponses.createModel({ modelId: 'gpt-5.4' }),
    delivery: 'native',
    searches: ['auto', 'client'],
  },
  {
    name: 'Vercel AI SDK on Bedrock',
    provider: vercelBedrock,
    createModel: (): Model => vercelBedrock.createModel(),
    delivery: 'stubs',
    searches: [],
  },
])('deferred tool loading on $name', ({ provider, createModel, delivery, searches }) => {
  it.skipIf(provider.skip).each([undefined, ...searches])(
    'calls the weather tool with valid input, loading it first when deferred, with search %s',
    async (search) => {
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
      // The strategy defers from 20 tools, the SDK's own included.
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
        contextManager: {
          strategies: [Offload.defer('toolSpecs', search ? { search } : {}).when({ toolCount: 20 })],
        },
        printer: false,
      })
      // The provider's input, after ModelProxy builds any stubs.
      const streamSpy = vi.spyOn(model, 'stream')

      const result = await agent.invoke('What is the weather in Paris, in celsius? Use the tools.')

      expect(model.modelInfo.capabilities?.deferredToolLoading).toBe(delivery)
      expect(result.stopReason).toBe('endTurn')
      expect(weatherCalls).toEqual([{ city: 'Paris', unit: 'celsius' }])
      const sent = streamSpy.mock.calls.map(([, options]) => options)
      const names = sent[0]?.toolSpecs?.map((spec) => spec.name)
      const sentWeather = sent[0]?.toolSpecs?.find((spec) => spec.name === 'get_weather')
      if (delivery === 'unsupported' && search !== 'client') {
        // A model that can't take stubs gets every spec in full and no loader, unless search is 'client'.
        expect(sentWeather).toEqual(getWeather.toolSpec)
        expect(names).not.toContain('load_tools')
        return
      }
      expect(names).toContain(search ? 'search_tools' : 'load_tools')
      if (delivery === 'unsupported') {
        // One that searches gets a tool in full once it searched for it, so its tools list grows.
        expect(sentWeather).toBeUndefined()
        expect(sent.at(-1)?.toolSpecs?.find((spec) => spec.name === 'get_weather')).toEqual(getWeather.toolSpec)
      } else {
        expect(new Set(sent.map((options) => JSON.stringify(options?.toolSpecs))).size).toBe(1)
        if (delivery === 'native') expect(sent[0]?.deferredTools?.has('get_weather')).toBe(true)
        else expect(sentWeather?.inputSchema).toEqual({ type: 'object' })
      }
      // A model that can't take stubs gets the tools it searched for in full, so its call defers none.
      expect(sent[0]?.toolSearch).toBe(delivery === 'unsupported' ? undefined : search)
      // A load is a reference in a tool result, or the provider's own search naming the tool it loaded.
      const loaded = agent.messages
        .flatMap((message) => message.content)
        .flatMap((block) => {
          if (block.type === 'serverToolBlock') return block.loadedTools ?? []
          if (block.type !== 'toolResultBlock') return []
          return block.content.flatMap((content) => (content.type === 'toolReferenceBlock' ? [content.name] : []))
        })
      expect(loaded).toContain('get_weather')
    },
    120_000
  )
})
