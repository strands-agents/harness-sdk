import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { ContextManager } from '../context-manager.js'
import { RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { Hide } from '../strategies/hide/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { tool } from '../../tools/tool-factory.js'
import { TextBlock, ToolResultBlock, ToolUseBlock } from '../../types/messages.js'
import type { ToolSearchStrategy } from '../strategies/hide/index.js'
import type { Tool } from '../../tools/tool.js'
import type { Message } from '../../types/messages.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import type { StreamOptions } from '../../models/model.js'

/** Records the tool specs each stream() call receives, which is what reaches the provider. */
class RecordingModel extends MockMessageModel {
  readonly seenToolSpecs: string[][] = []

  override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    this.seenToolSpecs.push((options?.toolSpecs ?? []).map((spec) => spec.name))
    yield* super.stream(messages, options)
  }
}

/** A tool search strategy that returns fixed names best-first, ignoring the query and candidates. */
function createStaticToolSearch(names: string[]): ToolSearchStrategy {
  return { search: async () => names.map((name, index) => ({ name, score: names.length - index })) }
}

/** Tools across unrelated topics, so a `keep` well below the count hides most of them. */
function topicCatalog(): Tool[] {
  const make = (name: string, description: string, result: string): Tool =>
    tool({ name, description, inputSchema: z.object({}).passthrough(), callback: () => result })
  return [
    make('search_invoices', 'Search invoices by customer', 'no invoices found'),
    make('refund_invoice', 'Refund an invoice by id', 'refund issued'),
    make('create_ticket', 'Create a support ticket', 'ticket created'),
    make('send_email', 'Send an email to a customer', 'sent'),
    make('track_package', 'Track a shipping package by tracking number', 'in transit'),
    make('schedule_meeting', 'Schedule a calendar meeting', 'scheduled'),
    make('translate_text', 'Translate text between languages', 'translated'),
    make('convert_currency', 'Convert an amount between currencies', '42.00'),
    make('get_weather', 'Current weather conditions for a city', 'Sunny, 24C'),
    make('city_guide', 'Sightseeing tips for a city', 'Visit the museum'),
  ]
}

describe('Hide through ContextManager', () => {
  it('sends the model only the selected tools from a multi-topic catalog', async () => {
    const model = new RecordingModel()
      .addTurn(new ToolUseBlock({ name: 'get_weather', toolUseId: 'use-1', input: { city: 'Paris' } }))
      .addTurn(new TextBlock('Sunny and 24C in Paris.'))
    const agent = new Agent({
      model,
      tools: topicCatalog(),
      systemPrompt: 'You are a travel assistant. Use tools when they help.',
      printer: false,
      contextManager: new ContextManager({ strategies: [Hide.drop('toolSpecs', { keep: 3 })], stash: false }),
    })

    const result = await agent.invoke('What is the weather in Paris right now?')

    // get_weather is the only keyword match; the budget is filled from catalog order.
    expect(model.seenToolSpecs).toEqual([
      ['search_invoices', 'refund_invoice', 'get_weather'],
      ['search_invoices', 'refund_invoice', 'get_weather'],
    ])
    expect(result.stopReason).toBe('endTurn')
    const toolResults = agent.messages.flatMap((message) =>
      message.content.filter((block): block is ToolResultBlock => block instanceof ToolResultBlock)
    )
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.toolUseId).toBe('use-1')
    expect(agent.tools).toHaveLength(10)
  })

  it('filters the specs the model receives and leaves the registry intact', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['beta']])
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('reuses the selection across every model call of one invocation', async () => {
    const model = new RecordingModel()
      .addTurn(new ToolUseBlock({ name: 'beta', toolUseId: 'use-1', input: {} }))
      .addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const search = createStaticToolSearch(['beta'])
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search, keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['beta'], ['beta']])
  })

  it('carries the selection into a continuation turn', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done')).addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const search: ToolSearchStrategy = {
      search: async (query) => (query === 'hello' ? [{ name: 'beta', score: 1 }] : []),
    }
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search, keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')
    await agent.invoke('thanks')

    expect(model.seenToolSpecs).toEqual([['beta'], ['beta']])
  })

  it('falls back on a new topic that matches nothing', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done')).addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const search: ToolSearchStrategy = {
      search: async (query) => (query === 'hello' ? [{ name: 'beta', score: 1 }] : []),
    }
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search, keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')
    await agent.invoke('where is my package')

    expect(model.seenToolSpecs).toEqual([['beta'], ['alpha', 'beta', 'gamma']])
  })

  it('passes the catalog through until count is met', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 }).when({ count: 4 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['alpha', 'beta', 'gamma']])
  })

  it('never ships an alwaysHide tool', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { alwaysHide: ['gamma'] })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['alpha', 'beta']])
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('ships the same prefix on the forced structured-output call', async () => {
    const model = new RecordingModel()
      .addTurn(new TextBlock('plain response'))
      .addTurn(new ToolUseBlock({ name: STRUCTURED_OUTPUT_TOOL_NAME, toolUseId: 'so-1', input: { name: 'Alice' } }))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      structuredOutputSchema: z.object({ name: z.string() }),
      contextManager: new ContextManager({
        strategies: [Hide.drop('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([
      ['beta', STRUCTURED_OUTPUT_TOOL_NAME],
      ['beta', STRUCTURED_OUTPUT_TOOL_NAME],
    ])
  })

  it('keeps the retrieval tool visible alongside an offload preset', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [
          'largeToolOffloading',
          Hide.drop('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 }),
        ],
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['beta', RETRIEVAL_TOOL_NAME]])
  })

  it('leaves the catalog unchanged when Hide is not configured', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({ stash: false }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['alpha', 'beta']])
  })
})
