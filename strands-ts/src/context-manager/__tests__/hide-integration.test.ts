import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/agent.js'
import { ContextManager } from '../context-manager.js'
import { RETRIEVAL_TOOL_NAME } from '../retrieval-tool.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/structured-output-tool.js'
import { Hide } from '../strategies/hide/index.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { createStaticToolSearch } from '../../__fixtures__/search-helpers.js'
import { TextBlock, ToolUseBlock } from '../../types/messages.js'
import type { ToolSearchStrategy } from '../strategies/hide/index.js'
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

describe('Hide through ContextManager', () => {
  it('filters the specs the model receives and leaves the registry intact', async () => {
    const model = new RecordingModel().addTurn(new TextBlock('done'))
    const tools = ['alpha', 'beta', 'gamma'].map((name) => createMockTool(name, () => 'ok'))
    const agent = new Agent({
      model,
      tools,
      printer: false,
      contextManager: new ContextManager({
        strategies: [Hide.toolSpecs('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 })],
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
        strategies: [Hide.toolSpecs('toolSpecs', { search, keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')

    expect(model.seenToolSpecs).toEqual([['beta'], ['beta']])
  })

  it('carries the selection into a follow-up invocation with no matches', async () => {
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
        strategies: [Hide.toolSpecs('toolSpecs', { search, keep: 1 })],
        stash: false,
      }),
    })

    await agent.invoke('hello')
    await agent.invoke('thanks')

    expect(model.seenToolSpecs).toEqual([['beta'], ['beta']])
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
        strategies: [Hide.toolSpecs('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 })],
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
          Hide.toolSpecs('toolSpecs', { search: createStaticToolSearch(['beta']), keep: 1 }),
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
