import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { logger } from '../../../logging/logger.js'
import { heuristicJson } from '../../../models/model.js'
import { ModelRouter } from '../../../models/routing/router.js'
import type { DeferredTools } from '../../../models/model-info.js'
import type { JSONValue } from '../../../types/json.js'
import { tool } from '../../../tools/tool-factory.js'
import type { ToolSpec } from '../../../tools/types.js'
import { TextBlock, ToolReferenceBlock, ToolResultBlock } from '../../../types/messages.js'
import type { BackgroundTasksConfig } from '../../../background-tasks/types.js'
import type { Plugin } from '../../../plugins/plugin.js'
import type { ContextStrategy } from '../../types.js'
import type { StrategyPresetName } from '../../presets.js'
import { DynamicToolLoadingStrategy } from '../dynamic-tool-loading.js'
import { ContextOffloader } from '../../../vended-plugins/context-offloader/plugin.js'

const makeTool = (name: string) =>
  tool({
    name,
    description: `Run ${name}.`,
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => `${name}:${value}`,
  })

const [shell, read, write] = [makeTool('shell'), makeTool('read'), makeTool('write')]

function makeAgent(
  deferredTools?: DeferredTools,
  options: {
    strategy?: ContextStrategy | StrategyPresetName
    tools?: ReturnType<typeof makeTool>[]
    appState?: Record<string, JSONValue>
    backgroundTasks?: BackgroundTasksConfig
    plugins?: Plugin[]
  } = {}
): { agent: Agent; model: MockMessageModel } {
  const model = new MockMessageModel()
  model.updateConfig({ modelInfo: { capabilities: { deferredTools } } })
  const agent = new Agent({
    model,
    tools: options.tools ?? [shell, read, write],
    contextManager: { strategies: [options.strategy ?? new DynamicToolLoadingStrategy()] },
    ...(options.appState && { appState: options.appState }),
    ...(options.backgroundTasks && { backgroundTasks: options.backgroundTasks }),
    ...(options.plugins && { plugins: options.plugins }),
    printer: false,
  })
  vi.spyOn(model, 'stream')
  return { agent, model }
}

/** The tool specs the model received on each call. */
function sentToolSpecs(model: MockMessageModel): ToolSpec[][] {
  return vi.mocked(model.stream).mock.calls.map(([, options]) => options?.toolSpecs ?? [])
}

function deferredNames(toolSpecs: ToolSpec[]): string[] {
  return toolSpecs.filter((spec) => spec.deferLoading).map((spec) => spec.name)
}

describe('DynamicToolLoadingStrategy', () => {
  it('defers every tool spec but the sdk ones on a native model, keeps the tools list fixed, and loads through strands_load_tools', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'strands_load_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [first, ...later] = sentToolSpecs(model)
    expect(later).toEqual([first, first])
    expect(deferredNames(first!)).toEqual(['shell', 'read', 'write'])
    expect(first!.map((spec) => spec.name)).toEqual([
      'shell',
      'read',
      'write',
      'retrieve_context',
      'strands_load_tools',
    ])
    const reference = new ToolReferenceBlock({ name: 'shell' })
    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([reference])
    const sentLoadResult = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentLoadResult.content).toEqual([reference])
    expect(agent.appState.get('strands.dynamicToolLoading')).toEqual({ deferred: ['shell', 'read', 'write'] })
  })

  it.each([
    ['a name that is not a tool', ['shell', 'nope'], 'nope is not a deferred tool'],
    ['a tool that is not deferred', ['shell', 'retrieve_context'], 'retrieve_context is not a deferred tool'],
  ])('loads nothing when the call asks for %s', async (_name, names, reason) => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'strands_load_tools', toolUseId: 'load-1', input: { names } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const loadResult = agent.messages[2]!.content[0] as ToolResultBlock
    expect(loadResult.status).toBe('error')
    expect(loadResult.content).toEqual([
      new TextBlock(`Error: Nothing loaded: ${reason}. Load only tools whose parameters are not shown.`),
    ])
  })

  it('loads each tool once when the call names it twice', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({
        type: 'toolUseBlock',
        name: 'strands_load_tools',
        toolUseId: 'load-1',
        input: { names: ['shell', 'shell'] },
      })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new ToolReferenceBlock({ name: 'shell' }),
    ])
  })

  it('loads nothing and reports an error when the call names no tool', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'strands_load_tools', toolUseId: 'load-1', input: { names: [] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).status).toBe('error')
  })

  it("keeps the ContextOffloader's retrieval tool, which its previews tell the model to call, out of the deferred tools", async () => {
    const { agent, model } = makeAgent('native', { plugins: [new ContextOffloader({})] })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(toolSpecs!.map((spec) => spec.name)).toContain('retrieve_offloaded_content')
    expect(deferredNames(toolSpecs!)).toEqual(['shell', 'read', 'write'])
  })

  it('sends stubs that point at strands_load_tools and answers a call made before the load with the schema', async () => {
    const callback = vi.fn(({ value }: { value: string }) => `shell:${value}`)
    const guarded = tool({
      name: 'shell',
      description: 'Run shell.',
      inputSchema: z.object({ value: z.string() }),
      callback,
    })
    const { agent, model } = makeAgent('stubs', { tools: [guarded] })
    model
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: {} })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'loaded', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(toolSpecs!.find((spec) => spec.name === 'shell')).toEqual({
      name: 'shell',
      description: 'Run shell.\nCall strands_load_tools with this name for its parameters first.',
      inputSchema: { type: 'object' },
    })
    expect(agent.messages[2]!.content[0]).toEqual(
      new ToolResultBlock({
        toolUseId: 'early',
        status: 'error',
        content: [
          new TextBlock(
            'Not run: shell was called before its parameters were loaded. They are loaded now; call it again.'
          ),
          new ToolReferenceBlock({ name: 'shell' }),
        ],
      })
    )
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ value: 'ls' }, expect.anything())
  })

  it('guards a stub call made by the model a ModelRouter picked, not by the default model', async () => {
    const callback = vi.fn(({ value }: { value: string }) => `shell:${value}`)
    const guarded = tool({
      name: 'shell',
      description: 'Run shell.',
      inputSchema: z.object({ value: z.string() }),
      callback,
    })
    const stubs = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })
    stubs.updateConfig({ modelInfo: { capabilities: { deferredTools: 'stubs' } } })
    const router = new ModelRouter([new MockMessageModel(), stubs], {
      strategy: { select: async (context) => context.candidates[1] },
    })
    const agent = new Agent({
      model: router,
      tools: [guarded],
      contextManager: { strategies: [new DynamicToolLoadingStrategy()] },
      printer: false,
    })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content[0]).toEqual(
      new TextBlock('Not run: shell was called before its parameters were loaded. They are loaded now; call it again.')
    )
    expect(callback).not.toHaveBeenCalled()
  })

  it('keeps the first call plan when a tool is registered later, and sends the new tool in full', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })
    const late = makeTool('late')

    await agent.invoke('First.')
    agent.toolRegistry.add(late)
    await agent.invoke('Second.')

    const [first, second] = sentToolSpecs(model)
    expect(deferredNames(first!)).toEqual(['shell', 'read', 'write'])
    expect(deferredNames(second!)).toEqual(['shell', 'read', 'write'])
    expect(second!.find((spec) => spec.name === 'late')).toEqual(late.toolSpec)
  })

  it('runs strands_load_tools in the foreground when background tasks are on', async () => {
    const { agent, model } = makeAgent('native', { backgroundTasks: { always: ['*'] } })
    model
      .addTurn({ type: 'toolUseBlock', name: 'strands_load_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new ToolReferenceBlock({ name: 'shell' }),
    ])
  })

  it('loads nothing for a deferred tool that is no longer registered', async () => {
    const { agent, model } = makeAgent('native', {
      appState: { 'strands.dynamicToolLoading': { deferred: ['shell', 'gone'] } },
    })
    model
      .addTurn({ type: 'toolUseBlock', name: 'strands_load_tools', toolUseId: 'load-1', input: { names: ['gone'] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('Use gone.')

    expect(agent.messages[2]!.content[0]).toEqual(
      expect.objectContaining({
        status: 'error',
        content: [
          new TextBlock(
            'Error: Nothing loaded: gone is not a deferred tool. Load only tools whose parameters are not shown.'
          ),
        ],
      })
    )
  })

  it('uses the plan restored with the session', async () => {
    const { agent, model } = makeAgent('native', {
      appState: { 'strands.dynamicToolLoading': { deferred: ['shell'] } },
    })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(deferredNames(sentToolSpecs(model)[0]!)).toEqual(['shell'])
  })

  it('keeps deferring when a later call model defers another way', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredTools: 'stubs' } } })
    await agent.invoke('Second.')

    const [, second] = sentToolSpecs(model)
    expect(second!.find((spec) => spec.name === 'shell')?.inputSchema).toEqual({ type: 'object' })
  })

  it('sends every spec without the loader on a model that can not defer', async () => {
    using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent('unsupported')
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(deferredNames(toolSpecs!)).toEqual([])
    expect(toolSpecs!.map((spec) => spec.name)).not.toContain('strands_load_tools')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('model or its config can not defer tool schemas'))
  })

  it('sends every spec without the loader when a later call model can not defer', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredTools: 'unsupported' } } })
    await agent.invoke('Second.')

    const [, second] = sentToolSpecs(model)
    expect(deferredNames(second!)).toEqual([])
    expect(second!.map((spec) => spec.name)).not.toContain('strands_load_tools')
  })

  it('defers on a later call whose model can defer, after a first call on a model that can not', async () => {
    using _warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent('unsupported')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredTools: 'native' } } })
    await agent.invoke('Second.')

    const [, second] = sentToolSpecs(model)
    expect(deferredNames(second!)).toEqual(['shell', 'read', 'write'])
    expect(second!.map((spec) => spec.name)).toContain('strands_load_tools')
  })

  describe('minimums', () => {
    const schemaTokens = 3 * heuristicJson(shell.toolSpec.inputSchema)

    it.each([
      [{ minTools: 3 }, 3],
      [{ minTools: 4 }, 0],
      [{ minSchemaTokens: schemaTokens }, 3],
      [{ minSchemaTokens: schemaTokens + 1 }, 0],
      [{ minTools: 3, minSchemaTokens: schemaTokens + 1 }, 0],
    ])('with %o defers %i of 3 tools', async (config, expected) => {
      const { agent, model } = makeAgent('native', { strategy: new DynamicToolLoadingStrategy(config) })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(sentToolSpecs(model)[0]!)).toHaveLength(expected)
    })
  })

  it.each([
    [19, 0],
    [20, 20],
  ])('the dynamicToolLoading preset with %i tools defers %i', async (count, expected) => {
    const tools = Array.from({ length: count }, (_, index) => makeTool(`tool_${index}`))
    const { agent, model } = makeAgent('native', { strategy: 'dynamicToolLoading', tools })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(deferredNames(sentToolSpecs(model)[0]!)).toHaveLength(expected)
  })
})
