import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { Agent } from '../../agent/agent.js'
import type { Agent as AgentType } from '../../agent/agent.js'
import { InvokeModelStage } from '../../middleware/index.js'
import { tool } from '../../tools/tool-factory.js'
import type { ToolSpec } from '../../tools/types.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'
import { buildPreview, TRUNCATED_HEADER, TRUNCATED_PREFIX, type TruncateConfig } from '../methods/truncate.js'
import type { ContextManagerStrategy } from '../context-manager.js'
import { Offload } from '../strategies/offload/index.js'
import { buildResultLimitMap } from '../strategies/offload/truncate.js'
import type { OffloadTarget } from '../strategies/offload/base.js'
import type { ContextManagerConfig, ContextState } from '../types.js'

const CHARS_PER_TOKEN = 4

function heuristicCountTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof TextBlock) total += Math.ceil(block.text.length / CHARS_PER_TOKEN)
      else if (block instanceof ToolResultBlock) {
        for (const content of block.content) {
          if (content instanceof TextBlock) total += Math.ceil(content.text.length / CHARS_PER_TOKEN)
        }
      }
    }
  }
  return total
}

function makeToolCall(toolUseId: string, resultTokens: number, input: JSONValue = {}): Message[] {
  return [
    new Message({
      role: 'assistant',
      content: [new ToolUseBlock({ toolUseId, name: 'search', input })],
    }),
    new Message({
      role: 'user',
      content: [
        new ToolResultBlock({
          toolUseId,
          status: 'success',
          content: [new TextBlock('x'.repeat(resultTokens * CHARS_PER_TOKEN))],
        }),
      ],
    }),
  ]
}

function makeContext(messages: Message[]): ContextState {
  const agent = createMockAgent({
    messages,
    extra: { model: { countTokens: async (msgs: Message[]) => heuristicCountTokens(msgs) } } as Partial<AgentType>,
  })
  return { messages, agent, utilization: 0.5 }
}

function resultText(messages: Message[], toolUseId: string): string {
  for (const message of messages) {
    for (const block of message.content) {
      if (block instanceof ToolResultBlock && block.toolUseId === toolUseId) {
        return (block.content[0] as TextBlock).text
      }
    }
  }
  throw new Error(`no tool result for ${toolUseId}`)
}

describe('TRUNCATED_HEADER', () => {
  it('recognises previews produced by buildPreview and nothing else', () => {
    expect(TRUNCATED_HEADER.test(buildPreview('x'.repeat(10_000), 1, { previewTokens: 100 }))).toBe(true)
    expect(TRUNCATED_HEADER.test(buildPreview('x'.repeat(10_000), 3, { previewTokens: 100 }))).toBe(true)
    expect(TRUNCATED_HEADER.test('[Truncated: by someone else]')).toBe(false)
    expect(TRUNCATED_HEADER.test('plain text')).toBe(false)
  })
})

describe('buildResultLimitMap', () => {
  it('reads valid limits from tool-use inputs and skips invalid ones', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ toolUseId: 'a', name: 't', input: { _max_result_tokens: 2000 } }),
          new ToolUseBlock({ toolUseId: 'b', name: 't', input: { _max_result_tokens: 12.7 } }),
          new ToolUseBlock({ toolUseId: 'c', name: 't', input: { _max_result_tokens: '500' } }),
          new ToolUseBlock({ toolUseId: 'd', name: 't', input: { _max_result_tokens: -1 } }),
          new ToolUseBlock({ toolUseId: 'e', name: 't', input: { other: 1 } }),
          new ToolUseBlock({ toolUseId: 'f', name: 't', input: 'not-an-object' }),
        ],
      }),
      new Message({ role: 'user', content: [new TextBlock('ignored')] }),
    ]
    expect(buildResultLimitMap(messages, Infinity)).toEqual(
      new Map([
        ['a', 2000],
        ['b', 12],
      ])
    )
  })

  it('clamps limits to maxTokens', () => {
    const messages = [
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ toolUseId: 'a', name: 't', input: { _max_result_tokens: 2000 } }),
          new ToolUseBlock({ toolUseId: 'b', name: 't', input: { _max_result_tokens: 50 } }),
        ],
      }),
    ]
    expect(buildResultLimitMap(messages, 500)).toEqual(
      new Map([
        ['a', 500],
        ['b', 50],
      ])
    )
  })
})

describe('model-selected result limits (strategy level)', () => {
  const threshold = 1000
  const previewTokens = 500

  function truncate(enabled: boolean, dynamicLimit = 1_000_000) {
    const config = enabled ? { previewTokens, dynamicLimit } : { previewTokens }
    return Offload.truncate('toolResults', config).when({ threshold })
  }

  it('keeps a result whole when the model limit is above its size', async () => {
    const messages = makeToolCall('tu-1', 2000, { _max_result_tokens: 5000 })
    const original = resultText(messages, 'tu-1')

    expect(await truncate(true).apply(makeContext(messages))).toBe(false)
    expect(resultText(messages, 'tu-1')).toBe(original)
  })

  it('truncates to the model limit when the result exceeds it', async () => {
    const messages = makeToolCall('tu-1', 2000, { _max_result_tokens: 100 })

    expect(await truncate(true).apply(makeContext(messages))).toBe(true)
    const text = resultText(messages, 'tu-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    // Preview is ~100 tokens, far below the configured 500-token preview.
    expect(text.length).toBeLessThan(200 * CHARS_PER_TOKEN)
    expect(text).not.toContain('[Set _max_result_tokens')
  })

  it('applies the model limit even below the configured threshold', async () => {
    const messages = makeToolCall('tu-1', 800, { _max_result_tokens: 200 })

    expect(await truncate(true).apply(makeContext(messages))).toBe(true)
    expect(resultText(messages, 'tu-1').startsWith(TRUNCATED_PREFIX)).toBe(true)
  })

  it('uses configured defaults for calls without a model limit', async () => {
    const messages = [...makeToolCall('tu-1', 2000), ...makeToolCall('tu-2', 2000, { _max_result_tokens: 5000 })]

    expect(await truncate(true).apply(makeContext(messages))).toBe(true)
    const defaultText = resultText(messages, 'tu-1')
    expect(defaultText.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(defaultText.length).toBeGreaterThan(previewTokens * CHARS_PER_TOKEN)
    expect(defaultText.endsWith('[Set _max_result_tokens on the call (e.g. 2000) to keep more of this result]')).toBe(
      true
    )
    expect(resultText(messages, 'tu-2').startsWith(TRUNCATED_PREFIX)).toBe(false)
  })

  it('clamps the suggested limit to the cap', async () => {
    const messages = makeToolCall('tu-1', 2000)

    expect(await truncate(true, 1500).apply(makeContext(messages))).toBe(true)
    expect(resultText(messages, 'tu-1')).toContain('(e.g. 1500)')
  })

  it('rejects a non-positive dynamicLimit', () => {
    expect(() => Offload.truncate('toolResults', { dynamicLimit: 0 })).toThrow(/dynamicLimit/)
    expect(() => Offload.truncate('toolResults', { dynamicLimit: -5 })).toThrow(/dynamicLimit/)
    expect(() => Offload.truncate('toolResults', { dynamicLimit: true })).not.toThrow()
  })

  it('ignores the property unless dynamicLimit is set', async () => {
    const messages = makeToolCall('tu-1', 2000, { _max_result_tokens: 5000 })

    expect(await truncate(false).apply(makeContext(messages))).toBe(true)
    const text = resultText(messages, 'tu-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(text).not.toContain('[Set _max_result_tokens')
  })

  it('is idempotent across repeated passes', async () => {
    const messages = makeToolCall('tu-1', 2000, { _max_result_tokens: 100 })
    const strategy = truncate(true)

    await strategy.apply(makeContext(messages))
    const afterFirst = resultText(messages, 'tu-1')
    await strategy.apply(makeContext(messages))
    expect(resultText(messages, 'tu-1')).toBe(afterFirst)
  })

  it('clamps the model limit to the configured maximum', async () => {
    const messages = makeToolCall('tu-1', 2000, { _max_result_tokens: 100_000 })

    expect(await truncate(true, 300).apply(makeContext(messages))).toBe(true)
    const text = resultText(messages, 'tu-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(text.length).toBeLessThan(400 * CHARS_PER_TOKEN)
  })

  it('still lets a later, smaller strategy shrink an existing preview when no model limit applies', async () => {
    const messages = makeToolCall('tu-1', 4000)
    const first = Offload.truncate('toolResults', { previewTokens: 750, dynamicLimit: 1_000_000 }).when({
      threshold: 1500,
    })
    const second = Offload.truncate('toolResults', { previewTokens: 100, dynamicLimit: 1_000_000 }).when({
      threshold: 300,
    })

    expect(await first.apply(makeContext(messages))).toBe(true)
    const afterFirst = resultText(messages, 'tu-1').length
    expect(await second.apply(makeContext(messages))).toBe(true)
    const text = resultText(messages, 'tu-1')
    expect(text.length).toBeLessThan(afterFirst)
    // The hint is sized from the original result and not re-issued from the preview.
    expect(text.match(/\[Set _max_result_tokens/g)).toHaveLength(1)
    expect(text).toContain('(e.g. 4000)')
  })
})

describe('dynamicLimit through ContextManager (agent level)', () => {
  const RESULT_TOKENS = 3000
  const AGENTIC = { previewTokens: 750, dynamicLimit: 1_000_000 }

  function agentic(
    config: ContextManagerConfig = {},
    truncateConfig: TruncateConfig = AGENTIC,
    target: OffloadTarget = 'toolResults'
  ) {
    return {
      ...config,
      strategies: [Offload.truncate(target, truncateConfig).when({ threshold: 1500 })],
    }
  }

  function makeAgent(
    limit: number | undefined,
    config: ContextManagerStrategy,
    inputSchema: z.ZodObject<z.ZodRawShape> = z.object({ query: z.string() }),
    contextWindowLimit?: number
  ) {
    const inputs: unknown[] = []
    const search = tool({
      name: 'search',
      description: 'Search.',
      inputSchema,
      callback: (input) => {
        inputs.push(input)
        return 'x'.repeat(RESULT_TOKENS * CHARS_PER_TOKEN)
      },
    })
    const other = tool({ name: 'other', description: 'Other.', inputSchema: z.object({}), callback: () => 'ok' })
    const model = new MockMessageModel()
      .addTurn({
        type: 'toolUseBlock',
        name: 'search',
        toolUseId: 'search-1',
        input: { query: 'q', ...(limit !== undefined && { _max_result_tokens: limit }) },
      })
      .addTurn({ type: 'textBlock', text: 'done' })
    if (contextWindowLimit !== undefined) model.updateConfig({ contextWindowLimit })
    const agent = new Agent({
      model,
      tools: [search, other],
      contextManager: config,
      printer: false,
    })
    const toolSpecs: ToolSpec[][] = []
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      toolSpecs.push([...context.toolSpecs])
      return yield* next(context)
    })
    return { agent, inputs, toolSpecs }
  }

  it('advertises _max_result_tokens on tools but not on retrieve_context', async () => {
    const { agent, toolSpecs } = makeAgent(undefined, agentic())
    await agent.invoke('go')

    const specs = toolSpecs[0]!
    const search = specs.find((spec) => spec.name === 'search')!
    const property = search.inputSchema?.properties?.['_max_result_tokens'] as { description: string }
    expect(property).toMatchObject({ type: 'integer', minimum: 0, maximum: 1_000_000 })
    // The default threshold/preview and when to raise the value are what get models to set it.
    expect(property.description).toContain('results over 1500 tokens are cut to a ~750-token preview')
    expect(property.description).toContain('stashed for retrieval')
    expect(property.description).toContain('Set a higher value when you need the complete output')
    expect(search.inputSchema?.properties?.['query']).toBeDefined()
    const retrieve = specs.find((spec) => spec.name === 'retrieve_context')!
    expect(retrieve.inputSchema?.properties?.['_max_result_tokens']).toBeUndefined()
  })

  it('advertises dynamicLimit as the schema maximum and clamps the model value to it', async () => {
    const { agent, toolSpecs } = makeAgent(100_000, agentic({}, { previewTokens: 100, dynamicLimit: 200 }))
    await agent.invoke('go')

    const property = toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.[
      '_max_result_tokens'
    ]
    expect(property).toMatchObject({ maximum: 200 })
    const text = resultText(agent.messages, 'search-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(text.length).toBeLessThan(300 * CHARS_PER_TOKEN)
  })

  it('does not promise retrieval when the stash is disabled', async () => {
    const { agent, toolSpecs } = makeAgent(undefined, agentic({ stash: false }))
    await agent.invoke('go')

    const property = toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.[
      '_max_result_tokens'
    ] as { description: string }
    expect(property.description).not.toContain('stashed')
  })

  it('leaves a tool that declares _max_result_tokens itself untouched', async () => {
    const { agent, inputs, toolSpecs } = makeAgent(
      42,
      agentic(),
      z.object({ query: z.string(), _max_result_tokens: z.number() })
    )
    await agent.invoke('go')

    const property = toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.[
      '_max_result_tokens'
    ]
    expect(property).toMatchObject({ type: 'number' })
    expect(inputs).toEqual([{ query: 'q', _max_result_tokens: 42 }])
  })

  it('advertises the property only on tools the strategy targets', async () => {
    const { agent, toolSpecs } = makeAgent(undefined, agentic({}, AGENTIC, ['tool::search']))
    await agent.invoke('go')

    const specs = toolSpecs[0]!
    expect(specs.find((spec) => spec.name === 'search')!.inputSchema?.properties?.['_max_result_tokens']).toBeDefined()
    expect(specs.find((spec) => spec.name === 'other')!.inputSchema?.properties?.['_max_result_tokens']).toBeUndefined()
  })

  it("advertises the first pipeline strategy's cap when two agentic strategies target the same tool", async () => {
    const { agent, toolSpecs } = makeAgent(undefined, {
      strategies: [
        Offload.truncate(['tool::search'], { previewTokens: 100, dynamicLimit: 20_000 }).when({ threshold: 1500 }),
        Offload.truncate('toolResults', { previewTokens: 100, dynamicLimit: 2_000 }).when({ threshold: 1500 }),
      ],
    })
    await agent.invoke('go')

    const specs = toolSpecs[0]!
    expect(specs.find((spec) => spec.name === 'search')!.inputSchema?.properties?.['_max_result_tokens']).toMatchObject(
      {
        maximum: 20_000,
      }
    )
    expect(specs.find((spec) => spec.name === 'other')!.inputSchema?.properties?.['_max_result_tokens']).toMatchObject({
      maximum: 2_000,
    })
  })

  it('caps at half the context window for dynamicLimit: true', async () => {
    const { agent, toolSpecs } = makeAgent(
      100_000,
      agentic({}, { previewTokens: 100, dynamicLimit: true }),
      undefined,
      4 * RESULT_TOKENS
    )
    await agent.invoke('go')

    const property = toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.[
      '_max_result_tokens'
    ]
    expect(property).toMatchObject({ maximum: 2 * RESULT_TOKENS })
    expect(resultText(agent.messages, 'search-1')).toBe('x'.repeat(RESULT_TOKENS * CHARS_PER_TOKEN))
  })

  it('falls back to the default context window when the model has none configured', async () => {
    const { agent, toolSpecs } = makeAgent(undefined, agentic({}, { previewTokens: 100, dynamicLimit: true }))
    await agent.invoke('go')

    const property = toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.[
      '_max_result_tokens'
    ]
    expect(property).toMatchObject({ maximum: 100_000 })
  })

  it("is on by default in the 'agentic' preset", async () => {
    const { agent, toolSpecs } = makeAgent(undefined, 'agentic')
    await agent.invoke('go')

    expect(
      toolSpecs[0]!.find((spec) => spec.name === 'search')!.inputSchema?.properties?.['_max_result_tokens']
    ).toBeDefined()
  })

  it('does not advertise the property without a dynamic truncate strategy', async () => {
    const { agent, toolSpecs } = makeAgent(undefined, {})
    await agent.invoke('go')

    const search = toolSpecs[0]!.find((spec) => spec.name === 'search')!
    expect(search.inputSchema?.properties?.['_max_result_tokens']).toBeUndefined()
  })

  it('strips the property from tool input and keeps the result whole up to the model limit', async () => {
    const { agent, inputs } = makeAgent(RESULT_TOKENS + 500, agentic())
    await agent.invoke('go')

    expect(inputs).toEqual([{ query: 'q' }])
    expect(resultText(agent.messages, 'search-1')).toBe('x'.repeat(RESULT_TOKENS * CHARS_PER_TOKEN))
    const toolUse = agent.messages[1]!.content[0] as ToolUseBlock
    expect(toolUse.input).toEqual({ query: 'q', _max_result_tokens: RESULT_TOKENS + 500 })
  })

  it('truncates to the model limit when it is below the default', async () => {
    const { agent } = makeAgent(100, agentic())
    await agent.invoke('go')

    const text = resultText(agent.messages, 'search-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    expect(text.length).toBeLessThan(200 * CHARS_PER_TOKEN)
  })

  it('falls back to the default truncation when the model sets no limit', async () => {
    const { agent, inputs } = makeAgent(undefined, agentic())
    await agent.invoke('go')

    expect(inputs).toEqual([{ query: 'q' }])
    const text = resultText(agent.messages, 'search-1')
    expect(text.startsWith(TRUNCATED_PREFIX)).toBe(true)
    // Default auto preview is 750 tokens.
    expect(text.length).toBeGreaterThan(700 * CHARS_PER_TOKEN)
    expect(text.length).toBeLessThan(900 * CHARS_PER_TOKEN)
  })
})
