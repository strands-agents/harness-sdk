import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'
import { logger } from '../../../logging/logger.js'
import { heuristicJson } from '../../../models/model.js'
import { countRequestTokens } from '../../../models/model-proxy.js'
import type { DeferredToolLoading } from '../../../models/model-info.js'
import { tool } from '../../../tools/tool-factory.js'
import type { Tool } from '../../../tools/tool.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { ToolSpec } from '../../../tools/types.js'
import { JsonBlock, Message, TextBlock, ToolReferenceBlock, ToolResultBlock } from '../../../types/messages.js'
import { McpTool } from '../../../tools/mcp-tool.js'
import type { McpClient } from '../../../mcp/index.js'
import type { JSONSchema, JSONValue } from '../../../types/json.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { BackgroundTasksConfig } from '../../../background-tasks/types.js'
import type { Plugin } from '../../../plugins/plugin.js'
import type { ContextStrategy } from '../../types.js'
import type { StrategyPresetName } from '../../presets.js'
import type { Snapshot } from '../../../types/snapshot.js'
import { Offload, type DeferConfig, type DeferTarget, type ToolSearch } from '../offload/index.js'
import type { ToolSearchContext, ToolSearcher } from '../../../tools/search-tools.js'
import { ContextOffloader } from '../../../vended-plugins/context-offloader/plugin.js'
import { ModelRouter } from '../../../models/routing/router.js'

const makeTool = (name: string) =>
  tool({
    name,
    description: `Run ${name}.`,
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => `${name}:${value}`,
  })

const [shell, read, write] = [makeTool('shell'), makeTool('read'), makeTool('write')]
const schemaTokens = 3 * heuristicJson(shell.toolSpec.inputSchema)

interface AgentOptions {
  strategy?: ContextStrategy | StrategyPresetName
  tools?: Tool[]
  backgroundTasks?: BackgroundTasksConfig
  plugins?: Plugin[]
  /** Puts the model behind a router whose default model has this capability and that sends every call to it. */
  routerDefault?: DeferredToolLoading
}

function makeAgent(
  deferredToolLoading?: DeferredToolLoading,
  options: AgentOptions = {}
): { agent: Agent; model: MockMessageModel } {
  const model = new MockMessageModel()
  model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading } } })
  const agent = new Agent({
    model: options.routerDefault ? routeTo(model, options.routerDefault) : model,
    tools: options.tools ?? [shell, read, write],
    contextManager: { strategies: [options.strategy ?? Offload.defer('toolSpecs')] },
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

/** The tools a model call defers, in the order of its tool specs. */
function deferredNames(model: MockMessageModel, call = 0): string[] {
  const [, options] = vi.mocked(model.stream).mock.calls[call]!
  return (options?.toolSpecs ?? []).filter((spec) => options?.deferredTools?.has(spec.name)).map((spec) => spec.name)
}

/** A router whose default model has this capability, and that sends every call to `model`. */
function routeTo(model: MockMessageModel, defaultCapability: DeferredToolLoading): ModelRouter {
  const defaultModel = new MockMessageModel()
  defaultModel.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: defaultCapability } } })
  return new ModelRouter([defaultModel, model], { strategy: { select: async (context) => context.candidates[1] } })
}

/**
 * Runs the model's tool calls, interrupting the last one, then approves that call on a restored agent, which runs it
 * before its first model call.
 *
 * @returns The interrupted call's result, and the restored agent's model
 */
async function resumeCall(
  calls: { name: string; input: JSONValue }[],
  options: AgentOptions = {},
  deferredToolLoading: DeferredToolLoading = 'native'
): Promise<{ result: ToolResultBlock; model: MockMessageModel }> {
  const interrupted = calls.at(-1)!
  const approve = (event: BeforeToolCallEvent): void => {
    if (event.toolUse.name !== interrupted.name) return
    if (event.interrupt<string>({ name: 'approve', reason: 'Run this tool?' }) !== 'yes') event.cancel = 'not approved'
  }
  const { agent, model } = makeAgent(deferredToolLoading, options)
  agent.addHook(BeforeToolCallEvent, approve)
  calls.forEach(({ name, input }, index) =>
    model.addTurn({ type: 'toolUseBlock', name, toolUseId: `call-${index}`, input })
  )
  const first = await agent.invoke('List the files.')
  expect(first.stopReason).toBe('interrupt')
  const snapshot = JSON.parse(JSON.stringify(agent.takeSnapshot({ preset: 'session' }))) as Snapshot

  const { agent: restored, model: restoredModel } = makeAgent(deferredToolLoading, options)
  restored.addHook(BeforeToolCallEvent, approve)
  restoredModel.addTurn({ type: 'textBlock', text: 'done' })
  restored.loadSnapshot(snapshot)
  const interruptId = first.interrupts![0]!.id
  await restored.invoke([new InterruptResponseContent({ interruptId, response: 'yes' })])
  const toolUseId = `call-${calls.length - 1}`
  const result = restored.messages
    .flatMap((message) => message.content)
    .find((block): block is ToolResultBlock => block.type === 'toolResultBlock' && block.toolUseId === toolUseId)!
  return { result, model: restoredModel }
}

describe('DeferredToolLoadingStrategy', () => {
  it('defers every tool spec but the sdk ones on a native model, keeps the tools list fixed, and loads through load_tools', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'load_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [first, ...later] = sentToolSpecs(model)
    expect(later).toEqual([first, first])
    expect([0, 1, 2].map((call) => deferredNames(model, call))).toEqual(Array(3).fill(['shell', 'read', 'write']))
    expect(first!.map((spec) => spec.name)).toEqual(['shell', 'read', 'write', 'retrieve_context', 'load_tools'])
    const reference = new ToolReferenceBlock({ name: 'shell' })
    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([reference])
    const sentLoadResult = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentLoadResult.content).toEqual([reference])
  })

  it.each([
    ['a name that is not a tool', ['shell', 'nope'], 'nope is not a tool'],
    ['a tool shown in full', ['shell', 'retrieve_context'], 'retrieve_context is shown in full, so call it directly'],
    [
      'both',
      ['nope', 'retrieve_context', 'other'],
      'retrieve_context is shown in full, so call it directly; nope, other are not tools',
    ],
  ])('loads nothing when the call asks for %s', async (_name, names, reason) => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'load_tools', toolUseId: 'load-1', input: { names } })
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
        name: 'load_tools',
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
      .addTurn({ type: 'toolUseBlock', name: 'load_tools', toolUseId: 'load-1', input: { names: [] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).status).toBe('error')
  })

  describe('search', () => {
    const weatherTools = [
      ['get_weather', 'Get the current weather for a city.'],
      ['get_forecast', 'Get the weather forecast for the next days.'],
      ['create_ticket', 'Create a support ticket.'],
      ['weather', 'Look up weather station data.'],
    ].map(([name, description]) =>
      tool({
        name: name!,
        description: description!,
        inputSchema: z.object({ city: z.string() }),
        callback: () => 'ok',
      })
    )
    const searching = (search: ToolSearch = 'client'): ContextStrategy => Offload.defer('toolSpecs', { search })

    /** The result of the model's one search_tools call with this input. */
    async function searchResult(input: JSONValue, tools: Tool[] = weatherTools): Promise<ToolResultBlock> {
      const { agent, model } = makeAgent('native', { tools, strategy: searching() })
      model
        .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'search-1', input })
        .addTurn({ type: 'textBlock', text: 'done' })
      await agent.invoke('Find the tools.')
      return agent.messages[2]!.content[0] as ToolResultBlock
    }

    it.each([
      ['load_tools without search', undefined, 'load_tools'],
      ['search_tools with search', 'client' as const, 'search_tools'],
    ])('registers %s', async (_name, search, loader) => {
      const strategy = search ? searching(search) : Offload.defer('toolSpecs')
      const { agent, model } = makeAgent('native', { strategy })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      const names = sentToolSpecs(model)[0]!.map((spec) => spec.name)
      expect(names).toContain(loader)
      expect(names).not.toContain(loader === 'load_tools' ? 'search_tools' : 'load_tools')
    })

    it.each([
      [{ query: 'weather' }, ['weather', 'get_weather', 'get_forecast']],
      [{ query: 'weather', limit: 2 }, ['weather', 'get_weather']],
      [{ query: 'support tickets' }, ['create_ticket']],
      [{ names: ['create_ticket'], query: 'forecast' }, ['create_ticket', 'get_forecast']],
    ])('with %o loads %o: an exact name first, then the best keyword matches', async (input, expected) => {
      expect((await searchResult(input)).content).toEqual(expected.map((name) => new ToolReferenceBlock({ name })))
    })

    it('rejects a query asking for more than 20 tools', async () => {
      const result = await searchResult({ query: 'weather', limit: 21 })

      expect(result.status).toBe('error')
      expect(JSON.stringify(result.content)).toContain('limit')
    })

    describe('searcher', () => {
      /** The model's one search_tools call with this input, searched by this searcher. */
      async function searchedBy(searcher: ToolSearcher, input: JSONValue): Promise<ToolResultBlock> {
        const strategy = Offload.defer('toolSpecs', { search: 'client', searcher }).when({ toolCount: 1 })
        const { agent, model } = makeAgent('native', { tools: weatherTools, strategy })
        model
          .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'search-1', input })
          .addTurn({ type: 'textBlock', text: 'done' })
        await agent.invoke('Find the tools.')
        return agent.messages[2]!.content[0] as ToolResultBlock
      }

      /** The tools of the search with these names, in this order. */
      const named = (context: ToolSearchContext, ...names: string[]): Tool[] =>
        names.map((name) => context.tools.find((candidate) => candidate.name === name)!)

      it('loads what it picks, without tools it may not return or repeats, and at most the limit', async () => {
        const lookalike = makeTool('get_forecast')
        const search = vi.fn(async (context: ToolSearchContext) => [
          lookalike,
          ...named(context, 'get_forecast', 'get_forecast', 'get_weather', 'weather'),
        ])

        const result = await searchedBy({ search }, { query: 'rain', limit: 2 })

        expect(result.content).toEqual([
          new ToolReferenceBlock({ name: 'get_forecast' }),
          new ToolReferenceBlock({ name: 'get_weather' }),
        ])
        const [context] = search.mock.calls[0]!
        expect(context).toMatchObject({ query: 'rain', limit: 2 })
        expect(context.tools.map((candidate) => candidate.name)).toEqual([
          'get_weather',
          'get_forecast',
          'create_ticket',
          'weather',
        ])
        expect(context.cancelSignal).toBeInstanceOf(AbortSignal)
      })

      it('searches only the tools the call does not name', async () => {
        const search = vi.fn(async (context: ToolSearchContext) => named(context, 'get_forecast'))

        const result = await searchedBy({ search }, { names: ['create_ticket'], query: 'rain' })

        expect(result.content).toEqual([
          new ToolReferenceBlock({ name: 'create_ticket' }),
          new ToolReferenceBlock({ name: 'get_forecast' }),
        ])
        const [context] = search.mock.calls[0]!
        expect(context.tools.map((candidate) => candidate.name)).not.toContain('create_ticket')
      })

      it('leaves the search to the keywords when it declines', async () => {
        const result = await searchedBy({ search: async () => undefined }, { query: 'weather' })

        expect(result.content).toEqual(
          ['weather', 'get_weather', 'get_forecast'].map((name) => new ToolReferenceBlock({ name }))
        )
      })

      it('answers the call with its error when it throws', async () => {
        const result = await searchedBy(
          { search: async () => Promise.reject(new Error('index offline')) },
          { query: 'rain' }
        )

        expect(result.status).toBe('error')
        expect(result.content).toEqual([new TextBlock('Error: index offline')])
      })

      it.each([
        [{ searcher: { search: async () => [] } }, 'searcher never runs with no search, where the model loads by name'],
        [{ search: 'server', searcher: { search: async () => [] } }, "searcher never runs with search 'server'"],
        [{ search: 'client', searcher: {} }, 'searcher is invalid: expected an object with a search method'],
      ])('rejects %o', (config, message) => {
        expect(() => Offload.defer('toolSpecs', config as DeferConfig)).toThrow(message)
      })
    })

    it("matches a query to an MCP tool's server name", async () => {
      const client = { serverVersion: { name: 'github', version: '1.0.0' } } as unknown as McpClient
      const issues = new McpTool({
        name: 'list_issues',
        description: 'List issues.',
        inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
        client,
      })

      expect((await searchResult({ query: 'github' }, [shell, issues])).content).toEqual([
        new ToolReferenceBlock({ name: 'list_issues' }),
      ])
    })

    it.each([
      [{ query: 'pizza' }, 'no tool matches "pizza". Search with other words, or name the tools.'],
      [{ query: '  ' }, 'name the tools to load, or search for them with a query.'],
      [{}, 'name the tools to load, or search for them with a query.'],
    ])('loads nothing and says why with %o', async (input, reason) => {
      expect((await searchResult(input)).content).toEqual([new TextBlock(`Error: Nothing loaded: ${reason}`)])
    })

    it.each([
      ['auto', 'native', true],
      ['server', 'native', true],
      ['client', 'native', undefined],
      ['auto', 'stubs', undefined],
      ['client', 'stubs', undefined],
    ] as const)(
      "with search '%s' on a %s model, asks the provider to search: %s",
      async (search, delivery, serverToolSearch) => {
        const { agent, model } = makeAgent(delivery, { strategy: searching(search) })
        model.addTurn({ type: 'textBlock', text: 'ok' })

        await agent.invoke('Hi.')

        expect(vi.mocked(model.stream).mock.calls[0]![1]!.serverToolSearch).toBe(serverToolSearch)
        expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
      }
    )

    it('points each stub at search_tools', async () => {
      const { agent, model } = makeAgent('stubs', { strategy: searching('auto') })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(sentToolSpecs(model)[0]!.find((spec) => spec.name === 'shell')!.description).toBe(
        'Run shell.\nCall search_tools with this name for its parameters first.'
      )
    })

    it.each(['stubs', 'unsupported'] as const)(
      "throws with search 'server' on a %s model, which has no provider tool search",
      async (delivery) => {
        const { agent, model } = makeAgent(delivery, { strategy: searching('server') })
        model.addTurn({ type: 'textBlock', text: 'ok' })

        await expect(agent.invoke('Hi.')).rejects.toThrow(
          "Offload.defer search 'server' needs the provider's tool search, which model test-model doesn't have: " +
            "set search to 'auto' or 'client'"
        )
      }
    )

    it("sends a model that can not take stubs only the tools it searched for under 'client', in full, in load order", async () => {
      const { agent, model } = makeAgent('unsupported', { strategy: searching('client') })
      model
        .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'search-1', input: { names: ['write'] } })
        .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'search-2', input: { names: ['shell'] } })
        .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
        .addTurn({ type: 'textBlock', text: 'done' })

      await agent.invoke('List the files.')

      const sent = sentToolSpecs(model).map((specs) => specs.map((spec) => spec.name))
      expect(sent).toEqual([
        ['retrieve_context', 'search_tools'],
        ['retrieve_context', 'search_tools', 'write'],
        ['retrieve_context', 'search_tools', 'write', 'shell'],
        ['retrieve_context', 'search_tools', 'write', 'shell'],
      ])
      expect(sentToolSpecs(model)[2]!.at(-1)).toEqual(shell.toolSpec)
      const listings = sentToolSpecs(model).map(
        (specs) => specs.find((spec) => spec.name === 'search_tools')!.description.split('Tools you can load:\n')[1]
      )
      expect(listings.slice(0, 3)).toEqual([
        '- shell: Run shell.\n- read: Run read.\n- write: Run write.',
        '- shell: Run shell.\n- read: Run read.',
        '- read: Run read.',
      ])
      expect(vi.mocked(model.stream).mock.calls.map(([, options]) => options?.deferredTools)).toEqual(
        Array(4).fill(undefined)
      )
      expect(agent.messages[6]!.content[0]).toMatchObject({ toolUseId: 'shell-1', status: 'success' })
    })

    it('answers a call to a tool a model that can not take stubs has not searched for, and loads it', async () => {
      const { agent, model } = makeAgent('unsupported', { strategy: searching('client') })
      model
        .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: { value: 'ls' } })
        .addTurn({ type: 'textBlock', text: 'done' })

      await agent.invoke('List the files.')

      expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([
        new TextBlock(
          'Not run: shell was called before its parameters were loaded. They are loaded now; call it again.'
        ),
        new ToolReferenceBlock({ name: 'shell' }),
      ])
      expect(sentToolSpecs(model)[1]!.map((spec) => spec.name)).toEqual(['retrieve_context', 'search_tools', 'shell'])
    })

    it.each([
      ['the model loads by name', undefined],
      ["search is 'auto'", 'auto' as const],
    ])('sends every full spec without a loader to a model that can not take stubs when %s', async (_name, search) => {
      const { agent, model } = makeAgent('unsupported', search ? { strategy: searching(search) } : {})
      model.addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
      model.addTurn({ type: 'textBlock', text: 'done' })

      await agent.invoke('List the files.')

      expect(sentToolSpecs(model)[0]!.slice(0, 3)).toEqual([shell, read, write].map((each) => each.toolSpec))
      expect(sentToolSpecs(model)[0]!.map((spec) => spec.name)).toEqual(['shell', 'read', 'write', 'retrieve_context'])
      expect(agent.messages[2]!.content[0]).toMatchObject({ toolUseId: 'shell-1', status: 'success' })
    })

    it("runs a call to a tool the provider's own search loaded", async () => {
      const callback = vi.fn(() => 'ok')
      const searched = tool({
        name: 'shell',
        description: 'Run shell.',
        inputSchema: z.object({ value: z.string() }),
        callback,
      })
      const { agent, model } = makeAgent('native', { tools: [searched, read, write], strategy: searching('auto') })
      model
        .addTurn([
          {
            type: 'serverToolBlock',
            provider: 'anthropic',
            data: { type: 'tool_search_tool_result' },
            loadedTools: ['shell'],
          },
          { type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } },
        ])
        .addTurn({ type: 'textBlock', text: 'done' })

      await agent.invoke('List the files.')

      expect(callback).toHaveBeenCalledTimes(1)
    })

    it("runs an approved call on a restored agent to a tool the provider's search loaded in the same response", async () => {
      const callback = vi.fn(() => 'ok')
      const build = (): { agent: Agent; model: MockMessageModel } => {
        const searched = tool({
          name: 'shell',
          description: 'Run shell.',
          inputSchema: z.object({ value: z.string() }),
          callback,
        })
        const built = makeAgent('native', { tools: [searched, read, write], strategy: searching('auto') })
        built.agent.addHook(BeforeToolCallEvent, (event) => {
          if (event.interrupt<string>({ name: 'approve', reason: 'Run this tool?' }) !== 'yes') event.cancel = 'no'
        })
        return built
      }
      const { agent, model } = build()
      model.addTurn([
        {
          type: 'serverToolBlock',
          provider: 'anthropic',
          data: { type: 'tool_search_tool_result' },
          loadedTools: ['shell'],
        },
        { type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } },
      ])
      const first = await agent.invoke('List the files.')
      const snapshot = JSON.parse(JSON.stringify(agent.takeSnapshot({ preset: 'session' }))) as Snapshot
      const { agent: restored, model: restoredModel } = build()
      restoredModel.addTurn({ type: 'textBlock', text: 'done' })
      restored.loadSnapshot(snapshot)

      await restored.invoke([new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })])

      expect(callback).toHaveBeenCalledTimes(1)
    })

    it("answers a call to a tool the provider's search loaded when the call's model only got its stub", async () => {
      const callback = vi.fn(() => 'ok')
      const searched = tool({
        name: 'shell',
        description: 'Run shell.',
        inputSchema: z.object({ value: z.string() }),
        callback,
      })
      const native = new MockMessageModel()
      native.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'native' } } })
      const stubs = new MockMessageModel()
      stubs.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'stubs' } } })
      native.addTurn([
        {
          type: 'serverToolBlock',
          provider: 'anthropic',
          data: { type: 'tool_search_tool_result' },
          loadedTools: ['shell'],
        },
        { type: 'textBlock', text: 'Which directory?' },
      ])
      stubs
        .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
        .addTurn({ type: 'textBlock', text: 'done' })
      let call = 0
      const agent = new Agent({
        model: new ModelRouter([native, stubs], {
          strategy: { select: async (context) => context.candidates[call++ === 0 ? 0 : 1] },
        }),
        tools: [searched, read, write],
        contextManager: { strategies: [searching('auto')] },
        printer: false,
      })

      await agent.invoke('List the files.')
      await agent.invoke('The current one.')

      expect(callback).not.toHaveBeenCalled()
      expect((agent.messages[4]!.content[0] as ToolResultBlock).content.at(-1)).toEqual(
        new ToolReferenceBlock({ name: 'shell' })
      )
    })

    it('keeps the config when .when() sets conditions', async () => {
      const { agent, model } = makeAgent('native', {
        strategy: Offload.defer('toolSpecs', { search: 'client' }).when({ toolCount: 1 }),
      })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(sentToolSpecs(model)[0]!.map((spec) => spec.name)).toContain('search_tools')
    })

    it('rejects a search it does not know', () => {
      expect(() => Offload.defer('toolSpecs', { search: 'hosted' } as unknown as DeferConfig)).toThrow(
        "search=\"hosted\" is invalid: expected 'auto', 'client' or 'server'"
      )
    })
  })

  it("keeps the ContextOffloader's retrieval tool, which its previews tell the model to call, out of the deferred tools", async () => {
    const { agent, model } = makeAgent('native', { plugins: [new ContextOffloader({})] })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(toolSpecs!.map((spec) => spec.name)).toContain('retrieve_offloaded_content')
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it('keeps the AgentSkills skills tool, which the skills listing tells the model to call, out of the deferred tools', async () => {
    // Protected by name, so a tool with the name AgentSkills gives its tool stands in for the plugin, which reads files.
    const { agent, model } = makeAgent('native', { tools: [shell, read, write, makeTool('skills')] })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(toolSpecs!.map((spec) => spec.name)).toContain('skills')
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it.each([
    ['its default name', {}, 'strands_manage_background_task'],
    ['a manageToolName', { manageToolName: 'tasks' }, 'tasks'],
  ])('keeps the background-tasks manage tool out of the deferred tools under %s', async (_name, config, toolName) => {
    const { agent, model } = makeAgent('native', { backgroundTasks: config })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(toolSpecs!.map((spec) => spec.name)).toContain(toolName)
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it('sends stubs that point at load_tools and answers a call made before the load with the schema', async () => {
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
      description: 'Run shell.\nCall load_tools with this name for its parameters first.',
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
    const sentGuard = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentGuard.content).toEqual([
      new TextBlock('Not run: shell was called before its parameters were loaded. They are loaded now; call it again.'),
      new TextBlock(`shell parameters: ${JSON.stringify(guarded.toolSpec.inputSchema)}`),
    ])
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ value: 'ls' }, expect.anything())
  })

  it('answers a call to a natively deferred tool made before its load, and runs a tool kept in full', async () => {
    const { agent, model } = makeAgent('native', { strategy: Offload.defer(['!read']).when({ toolCount: 1 }) })
    model
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: { value: 'ls' } })
      .addTurn({ type: 'toolUseBlock', name: 'read', toolUseId: 'direct', input: { value: 'notes' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content[0]).toEqual(
      new TextBlock('Not run: shell was called before its parameters were loaded. They are loaded now; call it again.')
    )
    expect(agent.messages[4]!.content[0]).toMatchObject({ toolUseId: 'direct', status: 'success' })
  })

  it('answers an early call on the model a ModelRouter picked, though its default model can not defer tools', async () => {
    const { agent, model } = makeAgent('stubs', { routerDefault: 'unsupported' })
    model
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: {} })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content[0]).toEqual(
      new TextBlock('Not run: shell was called before its parameters were loaded. They are loaded now; call it again.')
    )
  })

  it('keeps deferring when a later call model defers another way', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'stubs' } } })
    await agent.invoke('Second.')

    const [first, second] = sentToolSpecs(model)
    expect(first!.find((spec) => spec.name === 'shell')).toEqual(shell.toolSpec)
    expect(second!.find((spec) => spec.name === 'shell')?.inputSchema).toEqual({ type: 'object' })
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write'])
  })

  it('defers a tool registered after the first call', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    agent.toolRegistry.add(makeTool('late'))
    await agent.invoke('Second.')

    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write', 'late'])
  })

  it('starts deferring on the first call whose tools meet the conditions, and logs the change once', async () => {
    using debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    const { agent, model } = makeAgent('native', { strategy: Offload.defer('toolSpecs').when({ toolCount: 6 }) })
    model
      .addTurn({ type: 'textBlock', text: 'one' })
      .addTurn({ type: 'textBlock', text: 'two' })
      .addTurn({ type: 'textBlock', text: 'three' })

    await agent.invoke('First.')
    agent.toolRegistry.add(makeTool('late'))
    await agent.invoke('Second.')
    await agent.invoke('Third.')

    const [first, second] = sentToolSpecs(model)
    expect(deferredNames(model)).toEqual([])
    expect(first!.map((spec) => spec.name)).not.toContain('load_tools')
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write', 'late'])
    expect(second!.map((spec) => spec.name)).toContain('load_tools')
    const changes = debugSpy.mock.calls.filter(([message]) => String(message).includes('deferred tools changed'))
    expect(changes).toEqual([[`model_id=<${model.modelId}>, deferred=<4> | deferred tools changed`]])
  })

  it('runs load_tools in the foreground when background tasks are on', async () => {
    const { agent, model } = makeAgent('native', { backgroundTasks: { always: ['*'] } })
    model
      .addTurn({ type: 'toolUseBlock', name: 'load_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new ToolReferenceBlock({ name: 'shell' }),
    ])
  })

  it('sends the same tools list after a session restore, with nothing saved for it', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' })
    await agent.invoke('First.')
    const snapshot = agent.takeSnapshot({ preset: 'session' })

    const { agent: restored, model: restoredModel } = makeAgent('native')
    restoredModel.addTurn({ type: 'textBlock', text: 'two' })
    restored.loadSnapshot(snapshot)
    await restored.invoke('Second.')

    expect(snapshot.data.state).toEqual({})
    expect(sentToolSpecs(restoredModel)).toEqual(sentToolSpecs(model))
    expect(deferredNames(restoredModel)).toEqual(deferredNames(model))
  })

  it.each([
    ['the target covers', {}],
    [
      'the call defers once background tasks add to the schemas schemaTokens measures',
      { strategy: Offload.defer('toolSpecs').when({ schemaTokens: schemaTokens + 1 }), backgroundTasks: {} },
    ],
    [
      'the call defers on the model a router picks over a default that can not defer tools',
      { routerDefault: 'unsupported' },
    ],
  ] as [string, AgentOptions][])(
    'loads a tool %s when an interrupted load resumes on a restored agent, before its first model call',
    async (_name, options) => {
      const { result, model } = await resumeCall([{ name: 'load_tools', input: { names: ['shell'] } }], options)

      expect(result.content).toEqual([new ToolReferenceBlock({ name: 'shell' })])
      expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
    }
  )

  it.each(['native', 'stubs'] as const)(
    'answers a call to an unloaded deferred tool when the interrupted call resumes on a restored agent, on a %s model',
    async (deferredToolLoading) => {
      const { result } = await resumeCall([{ name: 'shell', input: { value: 'ls' } }], {}, deferredToolLoading)

      expect(result).toEqual(
        new ToolResultBlock({
          toolUseId: 'call-0',
          status: 'error',
          content: [
            new TextBlock(
              'Not run: shell was called before its parameters were loaded. They are loaded now; call it again.'
            ),
            new ToolReferenceBlock({ name: 'shell' }),
          ],
        })
      )
    }
  )

  it.each([
    ['its tools are below the conditions', { strategy: 'deferredToolLoading' }, 'native'],
    ['its model can not defer tools', {}, 'unsupported'],
  ] as [string, AgentOptions, DeferredToolLoading][])(
    'runs an approved call that resumes on a restored agent when %s, so nothing was deferred',
    async (_name, options, deferredToolLoading) => {
      using _warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const { result } = await resumeCall([{ name: 'shell', input: { value: 'ls' } }], options, deferredToolLoading)

      expect(result).toMatchObject({ toolUseId: 'call-0', status: 'success' })
    }
  )

  it("runs an approved call on a restored agent behind a router whose default takes stubs, when the provider's search loaded the tool in the same response", async () => {
    const callback = vi.fn(() => 'ok')
    const build = (): { agent: Agent; model: MockMessageModel } => {
      const searched = tool({
        name: 'shell',
        description: 'Run shell.',
        inputSchema: z.object({ value: z.string() }),
        callback,
      })
      const built = makeAgent('native', { tools: [searched, read, write], routerDefault: 'stubs' })
      built.agent.addHook(BeforeToolCallEvent, (event) => {
        if (event.interrupt<string>({ name: 'approve', reason: 'Run this tool?' }) !== 'yes') event.cancel = 'no'
      })
      return built
    }
    const { agent, model } = build()
    model.addTurn([
      {
        type: 'serverToolBlock',
        provider: 'anthropic',
        data: { type: 'tool_search_tool_result' },
        loadedTools: ['shell'],
      },
      { type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } },
    ])
    const first = await agent.invoke('List the files.')
    const snapshot = JSON.parse(JSON.stringify(agent.takeSnapshot({ preset: 'session' }))) as Snapshot
    const { agent: restored, model: restoredModel } = build()
    restoredModel.addTurn({ type: 'textBlock', text: 'done' })
    restored.loadSnapshot(snapshot)

    await restored.invoke([new InterruptResponseContent({ interruptId: first.interrupts![0]!.id, response: 'yes' })])

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('runs a resumed call on a restored agent to a tool its conversation loaded', async () => {
    const { result } = await resumeCall([
      { name: 'load_tools', input: { names: ['shell'] } },
      { name: 'shell', input: { value: 'ls' } },
    ])

    expect(result).toMatchObject({ toolUseId: 'call-1', status: 'success' })
  })

  it('loads no tool the target keeps in full when an interrupted load resumes on a restored agent', async () => {
    const { result } = await resumeCall([{ name: 'load_tools', input: { names: ['read'] } }], {
      strategy: Offload.defer(['!read']),
    })

    expect(result.content).toEqual([
      new TextBlock(
        'Error: Nothing loaded: read is shown in full, so call it directly. Load only tools whose parameters are not shown.'
      ),
    ])
  })

  it.each([
    [
      'counts each deferred tool by its name and description',
      'native' as const,
      ['shell', 'read', 'write', 'retrieve_context', 'load_tools'],
      ['shell', 'read', 'write'],
      '',
    ],
    [
      'counts each deferred tool as its stub on a model that takes stubs',
      'stubs' as const,
      ['shell', 'read', 'write', 'retrieve_context', 'load_tools'],
      ['shell', 'read', 'write'],
      '\nCall load_tools with this name for its parameters first.',
    ],
    [
      'counts every tool the request sends in full on a model that can not defer tools',
      'unsupported' as const,
      ['shell', 'read', 'write', 'retrieve_context'],
      [],
      '',
    ],
  ])(
    '%s when the context manager measures the next request',
    async (_name, deferredToolLoading, sent, deferred, hint) => {
      const { agent, model } = makeAgent(deferredToolLoading)
      await agent.initialize()
      const countSpy = vi.spyOn(model, 'countTokens')

      await countRequestTokens(agent, agent.messages)

      const [, options] = countSpy.mock.calls[0]!
      expect(options?.toolSpecs).toEqual(
        sent.map((name) => {
          const { toolSpec } = agent.toolRegistry.get(name)!
          return (deferred as string[]).includes(name)
            ? { name, description: `${toolSpec.description}${hint}`, inputSchema: { type: 'object' } }
            : toolSpec
        })
      )
    }
  )

  it('keeps the order sortTools gives, in the model call and when the context manager measures the next request', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
    model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'stubs' } } })
    const agent = new Agent({
      model,
      tools: [write, shell, read],
      sortTools: true,
      contextManager: { strategies: [Offload.defer('toolSpecs')] },
      printer: false,
    })
    const streamSpy = vi.spyOn(model, 'stream')
    const countSpy = vi.spyOn(model, 'countTokens')

    await agent.invoke('Hi.')
    await countRequestTokens(agent, agent.messages)

    const sorted = ['load_tools', 'read', 'retrieve_context', 'shell', 'write']
    expect(streamSpy.mock.calls[0]![1]!.toolSpecs!.map((spec) => spec.name)).toEqual(sorted)
    expect(countSpy.mock.calls.at(-1)![1]!.toolSpecs!.map((spec) => spec.name)).toEqual(sorted)
  })

  it.each([
    ['in full on a native model', 'native' as const, shell.toolSpec],
    [
      'as its stub on a model that only got the stub',
      'stubs' as const,
      expect.objectContaining({ inputSchema: { type: 'object' } }),
    ],
  ])(
    "counts a tool the provider's search loaded %s when the context manager measures the next request",
    async (_name, deferredToolLoading, counted) => {
      const { agent, model } = makeAgent(deferredToolLoading)
      model.addTurn([
        {
          type: 'serverToolBlock',
          provider: 'anthropic',
          data: { type: 'tool_search_tool_result' },
          loadedTools: ['shell'],
        },
        { type: 'textBlock', text: 'Which directory?' },
      ])
      await agent.invoke('List the files.')
      const countSpy = vi.spyOn(model, 'countTokens')

      await countRequestTokens(agent, agent.messages)

      const [, options] = countSpy.mock.calls[0]!
      expect(options!.toolSpecs!.find((spec) => spec.name === 'shell')).toEqual(counted)
    }
  )

  it('counts a loaded tool by its full schema when the context manager measures the next request', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'load_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })
    await agent.invoke('List the files.')
    const countSpy = vi.spyOn(model, 'countTokens')

    await countRequestTokens(agent, agent.messages)

    const [messages] = countSpy.mock.calls[0]!
    expect((messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new JsonBlock({ json: shell.toolSpec.inputSchema as JSONValue }),
    ])
  })

  it.each([
    ['', undefined, 'never-defers'],
    [" with search 'auto'", 'auto' as const, 'never-defers-auto'],
  ])('sends every spec without the loader on a model that can not defer tools%s', async (_name, search, modelId) => {
    using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent(
      'unsupported',
      search ? { strategy: Offload.defer('toolSpecs', { search }) } : {}
    )
    // The warning is once per process and model, so this model has an id no other test uses.
    model.updateConfig({ modelId })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    const [toolSpecs] = sentToolSpecs(model)
    expect(deferredNames(model)).toEqual([])
    expect(toolSpecs!.map((spec) => spec.name)).not.toContain('load_tools')
    expect(toolSpecs!.map((spec) => spec.name)).not.toContain('search_tools')
    expect(warnSpy).toHaveBeenCalledWith(
      `model_id=<${modelId}> | model or its config can not defer tool schemas | sending every tool spec`
    )
  })

  it.each([
    ['warns once when it sends stubs to a model the shared model info does not list', undefined, 'unlisted-a', 1],
    ['does not warn when the model config chose stubs', 'stubs' as const, 'unlisted-b', 0],
    ['does not warn when the shared model info lists the model', undefined, 'gpt-5.4', 0],
  ])('%s', async (_name, deferredToolLoading, modelId, warnings) => {
    using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent(deferredToolLoading)
    model.updateConfig({ modelId })
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    await agent.invoke('Second.')

    expect(model.modelInfo.capabilities?.deferredToolLoading).toBe('stubs')
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes('not in the shared model info'))).toEqual(
      Array(warnings).fill([
        `model_id=<${modelId}> | model is not in the shared model info | sending deferred tools as stubs, set ` +
          'modelInfo.capabilities.deferredToolLoading to unsupported if it calls them badly',
      ])
    )
  })

  it('sends every spec without the loader when a later call model can not defer tools', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'unsupported' } } })
    await agent.invoke('Second.')

    const [, second] = sentToolSpecs(model)
    expect(deferredNames(model, 1)).toEqual([])
    expect(second!.map((spec) => spec.name)).not.toContain('load_tools')
  })

  it('defers tools on a later call whose model can, after a first call on a model that can not', async () => {
    using _warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent('unsupported')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading: 'native' } } })
    await agent.invoke('Second.')

    const [, second] = sentToolSpecs(model)
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write'])
    expect(second!.map((spec) => spec.name)).toContain('load_tools')
  })

  describe('target', () => {
    it.each([
      [['!shell'], ['read', 'write']],
      [['!tool::shell', '!read'], ['write']],
      [['shell'], ['shell']],
      [['tool::shell', 'read', '!read'], ['shell']],
    ])('with %o defers %o and sends the other tools in full', async (target, expected) => {
      const { agent, model } = makeAgent('native', { strategy: Offload.defer(target) })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toEqual(expected)
    })

    it('never defers an sdk tool the target names', async () => {
      const { agent, model } = makeAgent('native', {
        strategy: Offload.defer(['shell', 'load_tools', 'retrieve_context']),
      })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toEqual(['shell'])
    })

    it.each([
      ['', {}],
      [', with background tasks adding a parameter to every schema in the call', { backgroundTasks: {} }],
    ] as [string, AgentOptions][])(
      'never defers a tool that takes no parameters%s, so a call to it runs without a load',
      async (_name, options) => {
        const ping = tool({
          name: 'ping',
          description: 'Ping the service.',
          inputSchema: z.object({}),
          callback: () => 'pong',
        })
        const { agent, model } = makeAgent('stubs', { tools: [shell, ping], ...options })
        model
          .addTurn({ type: 'toolUseBlock', name: 'ping', toolUseId: 'ping-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'done' })

        await agent.invoke('Ping it.')

        expect(deferredNames(model)).toEqual(['shell'])
        expect(sentToolSpecs(model)[0]!.find((spec) => spec.name === 'ping')?.description).toBe('Ping the service.')
        expect(agent.messages[2]!.content[0]).toMatchObject({ toolUseId: 'ping-1', status: 'success' })
      }
    )

    it.each([
      [{ type: 'object' }, false],
      [{ type: 'object', properties: {}, required: [], additionalProperties: false, title: 'Ping' }, false],
      [{ type: 'object', properties: { host: { type: 'string' } } }, true],
      [{ type: 'object', additionalProperties: { type: 'string' } }, true],
      [{ type: 'object', oneOf: [{ required: ['host'] }, { required: ['ip'] }] }, true],
    ] as [JSONSchema, boolean][])('with the input schema %o, defers the tool: %s', async (inputSchema, deferred) => {
      const target = tool({ name: 'target', description: 'Run target.', inputSchema, callback: () => 'ok' })
      const { agent, model } = makeAgent('native', { tools: [target] })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toEqual(deferred ? ['target'] : [])
    })

    it.each([
      [[], 'Empty array target matches nothing — provide at least one target'],
      [['shell', '!shell'], 'Tool target ["shell","!shell"] excludes every tool it includes, so it matches nothing'],
      [
        ['toolSpecs', '!shell'],
        `Offload.defer target ${JSON.stringify(['toolSpecs', '!shell'])} lists 'toolSpecs', which is not a tool name: ` +
          "use 'toolSpecs' alone, or list only the tools to keep in full, such as ['!shell']",
      ],
      [
        'toolResults',
        `Offload.defer target ${JSON.stringify('toolResults')} is invalid: expected 'toolSpecs' or a list of tool names`,
      ],
    ])('rejects %o', (target, message) => {
      expect(() => Offload.defer(target as DeferTarget)).toThrow(message)
    })
  })

  it('warns once per process when the strategy has no conditions', () => {
    using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

    Offload.defer(['write']).init!(createMockAgent())
    Offload.defer(['write']).init!(createMockAgent())
    Offload.defer(['write']).when({ toolCount: 1 }).init!(createMockAgent())

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      'strategy=<offload:defer>, target=<["write"]> | strategy has no conditions, so it defers every tool it targets ' +
        'at any tool count | use .when() to set toolCount or schemaTokens'
    )
  })

  describe('conditions', () => {
    // The call holds 5 tools: the 3 below, retrieve_context and load_tools.
    it.each([
      [undefined, 3],
      [{ toolCount: 5 }, 3],
      [{ toolCount: 6 }, 0],
      [{ schemaTokens }, 3],
      [{ schemaTokens: schemaTokens + 1 }, 0],
      [{ toolCount: 6, schemaTokens }, 3],
      [{ toolCount: 5, schemaTokens: schemaTokens + 1 }, 3],
      [{ toolCount: 6, schemaTokens: schemaTokens + 1 }, 0],
    ])('with %o defers %i of 3 tools', async (conditions, expected) => {
      const { agent, model } = makeAgent('native', { strategy: Offload.defer('toolSpecs').when(conditions) })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toHaveLength(expected)
    })

    it.each([
      ['toolCount counts a tool kept in full and the sdk tools', { toolCount: 5 }, ['read', 'write']],
      ['schemaTokens measures only the tools it would defer', { schemaTokens: schemaTokens }, []],
    ])('%s', async (_name, conditions, expected) => {
      const { agent, model } = makeAgent('native', { strategy: Offload.defer(['!shell']).when(conditions) })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toEqual(expected)
    })

    it('toolCount leaves out the structured output tool, so an invocation with structured output defers the same tools', async () => {
      const { agent, model } = makeAgent('native', { strategy: Offload.defer('toolSpecs').when({ toolCount: 6 }) })
      model
        .addTurn({ type: 'textBlock', text: 'one' })
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'out-1',
          input: { answer: 'two' },
        })
        .addTurn({ type: 'textBlock', text: 'three' })

      await agent.invoke('First.')
      await agent.invoke('Second.', { structuredOutputSchema: z.object({ answer: z.string() }) })
      await agent.invoke('Third.')

      const [first, second, third] = sentToolSpecs(model)
      expect(second!.map((spec) => spec.name)).toContain('strands_structured_output')
      expect([0, 1, 2].map((call) => deferredNames(model, call))).toEqual([[], [], []])
      expect(third).toEqual(first)
    })

    it.each([
      ['1%', 3],
      ['2%', 0],
    ] as const)('with schemaTokens %s of the context window defers %i of 3 tools', async (share, expected) => {
      const { agent, model } = makeAgent('native', {
        strategy: Offload.defer('toolSpecs').when({ schemaTokens: share }),
      })
      model.updateConfig({
        modelInfo: { capabilities: { deferredToolLoading: 'native' }, limits: { contextWindow: 100 * schemaTokens } },
      })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toHaveLength(expected)
    })

    it.each([
      [{ toolCount: 0 }, 'toolCount=0 is invalid: expected a whole tool count above 0'],
      [{ toolCount: '20' }, 'toolCount="20" is invalid: expected a whole tool count above 0'],
      [{ schemaTokens: '100%' }, 'schemaTokens="100%" is invalid: expected a "N%" string below "100%"'],
      [{ minTools: 20 }, 'unknown condition "minTools": expected toolCount or schemaTokens'],
    ])('rejects %o', (conditions, message) => {
      expect(() => Offload.defer('toolSpecs').when(conditions as never)).toThrow(message)
    })
  })

  it.each([
    [
      'defers tools',
      'native' as const,
      ['shell', 'read', 'write', 'retrieve_context', 'load_tools'],
      ['shell', 'read', 'write'],
    ],
    ['can not defer tools', 'unsupported' as const, ['shell', 'read', 'write', 'retrieve_context'], undefined],
  ])(
    'replays the tools of the first model call in a summary before and after it when the model %s',
    async (_name, deferredToolLoading, toolNames, deferred) => {
      using _warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a summary' })
        .addTurn({ type: 'textBlock', text: 'ok' })
        .addTurn({ type: 'textBlock', text: 'another summary' })
      model.updateConfig({ modelInfo: { capabilities: { deferredToolLoading } } })
      const summarize = Offload.summarize('*').when({ contextUtilization: '80%', preserveRecent: 1 })
      const agent = new Agent({
        model,
        tools: [shell, read, write],
        messages: ['task', 'old', 'more', 'older'].map(
          (text, index) => new Message({ role: index % 2 ? 'assistant' : 'user', content: [new TextBlock(text)] })
        ),
        contextManager: { strategies: [Offload.defer('toolSpecs'), summarize] },
        printer: false,
      })
      const streamSpy = vi.spyOn(model, 'stream')
      const summarizeSpy = vi.spyOn(model, 'summarize')
      await agent.initialize()

      expect(await summarize.apply({ messages: agent.messages, agent, utilization: 0.9 })).toBe(true)
      await agent.invoke('next')
      const [, sent] = streamSpy.mock.calls.at(-1)!
      expect(await summarize.apply({ messages: agent.messages, agent, utilization: 0.9 })).toBe(true)

      expect(sent?.toolSpecs?.map((spec) => spec.name)).toEqual(toolNames)
      expect(sent?.deferredTools).toEqual(deferred && new Set(deferred))
      const replays = summarizeSpy.mock.calls.map(([, options]) => ({
        toolSpecs: options?.toolSpecs,
        deferredTools: options?.deferredTools,
      }))
      expect(replays).toEqual(Array(2).fill({ toolSpecs: sent?.toolSpecs, deferredTools: sent?.deferredTools }))
    }
  )

  it.each([
    [17, 0],
    [18, 18],
  ])(
    'the deferredToolLoading preset, counting load_tools and retrieve_context, with %i tools defers %i',
    async (count, expected) => {
      const tools = Array.from({ length: count }, (_, index) => makeTool(`tool_${index}`))
      const { agent, model } = makeAgent('native', { strategy: 'deferredToolLoading', tools })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toHaveLength(expected)
    }
  )
})
