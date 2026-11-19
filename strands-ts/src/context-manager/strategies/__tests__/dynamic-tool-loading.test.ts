import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockMessageModel, NativeDeferralMockModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { BeforeToolCallEvent } from '../../../hooks/events.js'
import { logger } from '../../../logging/logger.js'
import { heuristicJson } from '../../../models/model.js'
import { countRequestTokens } from '../../../models/model-proxy.js'
import { McpTool } from '../../../tools/mcp-tool.js'
import { tool } from '../../../tools/tool-factory.js'
import type { Tool } from '../../../tools/tool.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { ToolSpec } from '../../../tools/types.js'
import { JsonBlock, Message, TextBlock, ToolReferenceBlock, ToolResultBlock } from '../../../types/messages.js'
import type { JSONSchema, JSONValue } from '../../../types/json.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { BackgroundTasksConfig } from '../../../background-tasks/types.js'
import type { McpClient } from '../../../mcp/index.js'
import type { Plugin } from '../../../plugins/plugin.js'
import type { ContextStrategy } from '../../types.js'
import type { StrategyPresetName } from '../../presets.js'
import type { Snapshot } from '../../../types/snapshot.js'
import { Offload, type DeferTarget } from '../offload/index.js'
import { ContextOffloader } from '../../../vended-plugins/context-offloader/plugin.js'
import { AgentSkills, Skill } from '../../../vended-plugins/skills/index.js'
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
const NOT_RUN = 'Not run: shell was called before its parameters were loaded. They are loaded now; call it again.'

/** How a model takes deferred tools: with its API's deferral flag, or each tool's spec once the model loads it. */
type Delivery = 'native' | 'onLoad'

interface AgentOptions {
  strategy?: ContextStrategy | StrategyPresetName
  tools?: Tool[]
  backgroundTasks?: BackgroundTasksConfig
  plugins?: Plugin[]
  /** Puts the model behind a router whose default model takes deferred tools this way, and that calls `model`. */
  routerDefault?: Delivery
}

function makeModel(delivery: Delivery): MockMessageModel {
  if (delivery === 'onLoad') return new MockMessageModel()
  const model = new NativeDeferralMockModel()
  model.updateConfig({ modelInfo: { capabilities: { dynamicToolLoading: 'native' } } })
  return model
}

function makeAgent(delivery: Delivery, options: AgentOptions = {}): { agent: Agent; model: MockMessageModel } {
  const model = makeModel(delivery)
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

/** The names of the tools a model call sent. */
function sentNames(model: MockMessageModel, call = 0): string[] {
  return sentToolSpecs(model)[call]!.map((spec) => spec.name)
}

/** The tools a model call defers natively, in the order of its tool specs. */
function deferredNames(model: MockMessageModel, call = 0): string[] {
  const [, options] = vi.mocked(model.stream).mock.calls[call]!
  return (options?.toolSpecs ?? []).filter((spec) => options?.deferredTools?.has(spec.name)).map((spec) => spec.name)
}

/** The search tool's spec a model call sent. */
function sentSearchTool(model: MockMessageModel, call = 0): ToolSpec {
  return sentToolSpecs(model)[call]!.find((spec) => spec.name === 'search_tools')!
}

/** A router whose default model takes deferred tools this way, and that sends every call to `model`. */
function routeTo(model: MockMessageModel, defaultDelivery: Delivery): ModelRouter {
  return new ModelRouter([makeModel(defaultDelivery), model], {
    strategy: { select: async (context) => context.candidates[1] },
  })
}

/**
 * Interrupts the model's first tool call, then approves it on a restored agent, which runs it before its first model
 * call.
 *
 * @returns The call's result, and the restored agent's model
 */
async function resumeCall(
  name: string,
  input: JSONValue,
  options: AgentOptions = {}
): Promise<{ result: ToolResultBlock; model: MockMessageModel }> {
  const approve = (event: BeforeToolCallEvent): void => {
    if (event.interrupt<string>({ name: 'approve', reason: 'Run this tool?' }) !== 'yes') event.cancel = 'not approved'
  }
  const { agent, model } = makeAgent('native', options)
  agent.addHook(BeforeToolCallEvent, approve)
  model.addTurn({ type: 'toolUseBlock', name, toolUseId: 'call-1', input })
  const interrupted = await agent.invoke('List the files.')
  expect(interrupted.stopReason).toBe('interrupt')
  const snapshot = JSON.parse(JSON.stringify(agent.takeSnapshot({ preset: 'session' }))) as Snapshot

  const { agent: restored, model: restoredModel } = makeAgent('native', options)
  restored.addHook(BeforeToolCallEvent, approve)
  restoredModel.addTurn({ type: 'textBlock', text: 'done' })
  restored.loadSnapshot(snapshot)
  const interruptId = interrupted.interrupts![0]!.id
  await restored.invoke([new InterruptResponseContent({ interruptId, response: 'yes' })])
  return { result: restored.messages[2]!.content[0] as ToolResultBlock, model: restoredModel }
}

describe('DynamicToolLoadingStrategy', () => {
  it('defers every tool spec but the sdk ones on a model that defers natively, keeps the tools list fixed, and loads through search_tools', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [first, ...later] = sentToolSpecs(model)
    expect(later).toEqual([first, first])
    expect([0, 1, 2].map((call) => deferredNames(model, call))).toEqual(Array(3).fill(['shell', 'read', 'write']))
    expect(sentNames(model)).toEqual(['shell', 'read', 'write', 'retrieve_context', 'search_tools'])
    const reference = new ToolReferenceBlock({ name: 'shell' })
    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([reference])
    const sentLoadResult = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentLoadResult.content).toEqual([reference])
  })

  it('sends a deferred tool once the conversation loads it, after the other tools, on a model that does not defer natively', async () => {
    const { agent, model } = makeAgent('onLoad')
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'shell-1', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [first, second, third] = sentToolSpecs(model)
    expect(sentNames(model)).toEqual(['retrieve_context', 'search_tools'])
    expect(second).toEqual([...first!, shell.toolSpec])
    expect(third).toEqual(second)
    expect(vi.mocked(model.stream).mock.calls.map(([, options]) => options?.deferredTools)).toEqual(
      Array(3).fill(undefined)
    )
    const sentLoadResult = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentLoadResult.content).toEqual([new TextBlock('Loaded shell.')])
    expect(agent.messages[4]!.content[0]).toMatchObject({ toolUseId: 'shell-1', status: 'success' })
  })

  it('appends loaded tools in the order the conversation loaded them', async () => {
    const { agent, model } = makeAgent('onLoad')
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['write'] } })
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-2', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('Write the files.')

    expect(sentNames(model, 2)).toEqual(['retrieve_context', 'search_tools', 'write', 'shell'])
  })

  it.each(['native', 'onLoad'] as const)(
    'lists the deferred tools in the description of search_tools when the model takes them %s',
    async (delivery) => {
      const { agent, model } = makeAgent(delivery)
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(sentSearchTool(model).description).toBe(
        `${agent.toolRegistry.get('search_tools')!.description}\n\nTools you can load:\n` +
          '- shell: Run shell.\n- read: Run read.\n- write: Run write.'
      )
    }
  )

  describe('listing', () => {
    const tools = Array.from({ length: 10 }, (_, index) => makeTool(`tool_${index}`))

    /** The listing a model with this context window gets in the description of search_tools. */
    async function listingFor(contextWindow: number, listed: Tool[] = tools): Promise<string> {
      const { agent, model } = makeAgent('onLoad', { tools: listed })
      model.updateConfig({ modelInfo: { limits: { contextWindow } } })
      model.addTurn({ type: 'textBlock', text: 'ok' })
      await agent.invoke('Hi.')
      return sentSearchTool(model).description!.split('Tools you can load:\n')[1]!
    }

    it.each([
      [
        'each name with its first sentence while they fit',
        5_500,
        tools.map((t) => `- ${t.name}: Run ${t.name}.`).join('\n'),
      ],
      ['names alone when only they fit', 2_000, tools.map((t) => t.name).join(', ')],
      ['the names that fit and a count of the rest otherwise', 1_000, 'tool_0, and 9 more; search to find them'],
    ])('lists %s, in 1%% of the context window', async (_name, contextWindow, expected) => {
      expect(await listingFor(contextWindow)).toBe(expected)
    })

    it('lists the first sentence of each description, cut at 120 characters', async () => {
      const reader = tool({
        name: 'reader',
        description: 'Reads a file. Use it for text files.',
        inputSchema: z.object({ path: z.string() }),
        callback: () => 'ok',
      })
      const long = tool({
        name: 'long',
        description: `${'x'.repeat(130)} and more.`,
        inputSchema: z.object({ path: z.string() }),
        callback: () => 'ok',
      })

      expect(await listingFor(200_000, [reader, long])).toBe(`- reader: Reads a file.\n- long: ${'x'.repeat(119)}…`)
    })
  })

  describe('search_tools', () => {
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

    /** The result of the model's one search_tools call with this input. */
    async function searchResult(input: JSONValue, tools: Tool[] = [shell, read, write]): Promise<ToolResultBlock> {
      const { agent, model } = makeAgent('native', { tools })
      model
        .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input })
        .addTurn({ type: 'textBlock', text: 'done' })
      await agent.invoke('Find the tools.')
      return agent.messages[2]!.content[0] as ToolResultBlock
    }

    it.each([
      ['a name that is not a tool', ['shell', 'nope'], 'nope is not a tool'],
      ['a tool shown in full', ['shell', 'retrieve_context'], 'retrieve_context is shown in full, so call it directly'],
      [
        'both',
        ['nope', 'retrieve_context', 'other'],
        'retrieve_context is shown in full, so call it directly; nope, other are not tools',
      ],
    ])('loads nothing when the call names %s', async (_name, names, reason) => {
      const result = await searchResult({ names })

      expect(result.status).toBe('error')
      expect(result.content).toEqual([
        new TextBlock(`Error: Nothing loaded: ${reason}. Load only tools whose parameters are not shown.`),
      ])
    })

    it('loads each tool once when the call names it twice', async () => {
      expect((await searchResult({ names: ['shell', 'shell'] })).content).toEqual([
        new ToolReferenceBlock({ name: 'shell' }),
      ])
    })

    it.each([{}, { names: [] }, { query: '  ' }])(
      'loads nothing when the call has no names or query: %o',
      async (input) => {
        expect((await searchResult(input)).content).toEqual([
          new TextBlock('Error: Nothing loaded: name the tools to load, or search for them with a query.'),
        ])
      }
    )

    it.each([
      [{ query: 'weather' }, ['weather', 'get_weather', 'get_forecast']],
      [{ query: 'weather', limit: 2 }, ['weather', 'get_weather']],
      [{ query: 'support tickets' }, ['create_ticket']],
      [{ names: ['create_ticket'], query: 'forecast' }, ['create_ticket', 'get_forecast']],
    ])('with %o loads %o: an exact name first, then the best keyword matches', async (input, expected) => {
      expect((await searchResult(input, weatherTools)).content).toEqual(
        expected.map((name) => new ToolReferenceBlock({ name }))
      )
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

    it('loads nothing and says so when no tool matches the query', async () => {
      expect((await searchResult({ query: 'pizza' }, weatherTools)).content).toEqual([
        new TextBlock('Error: Nothing loaded: no tool matches "pizza". Search with other words, or name the tools.'),
      ])
    })
  })

  it("keeps the ContextOffloader's retrieval tool, which its previews tell the model to call, out of the deferred tools", async () => {
    const { agent, model } = makeAgent('native', { plugins: [new ContextOffloader({})] })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(sentNames(model)).toContain('retrieve_offloaded_content')
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it('keeps the AgentSkills skills tool, which the skills listing tells the model to call, out of the deferred tools', async () => {
    const skills = new AgentSkills({ skills: [new Skill({ name: 'notes', description: 'Take notes.' })] })
    const { agent, model } = makeAgent('native', { plugins: [skills] })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(sentNames(model)).toContain('skills')
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it.each([
    ['its default name', {}, 'strands_manage_background_task'],
    ['a manageToolName', { manageToolName: 'tasks' }, 'tasks'],
  ])('keeps the background-tasks manage tool out of the deferred tools under %s', async (_name, config, toolName) => {
    const { agent, model } = makeAgent('native', { backgroundTasks: config })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(sentNames(model)).toContain(toolName)
    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it('answers a call to a natively deferred tool made before its load, and runs a tool kept in full', async () => {
    const { agent, model } = makeAgent('native', { strategy: Offload.defer(['!read']).when({ toolCount: 1 }) })
    model
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: { value: 'ls' } })
      .addTurn({ type: 'toolUseBlock', name: 'read', toolUseId: 'direct', input: { value: 'notes' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content[0]).toEqual(new TextBlock(NOT_RUN))
    expect(agent.messages[4]!.content[0]).toMatchObject({ toolUseId: 'direct', status: 'success' })
  })

  it('answers a call to a tool the request did not send, then sends the tool once its schema is loaded', async () => {
    const callback = vi.fn(({ value }: { value: string }) => `shell:${value}`)
    const guarded = tool({
      name: 'shell',
      description: 'Run shell.',
      inputSchema: z.object({ value: z.string() }),
      callback,
    })
    const { agent, model } = makeAgent('onLoad', { tools: [guarded] })
    model
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'early', input: {} })
      .addTurn({ type: 'toolUseBlock', name: 'shell', toolUseId: 'loaded', input: { value: 'ls' } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    const [first, second] = sentToolSpecs(model)
    expect(sentNames(model)).toEqual(['retrieve_context', 'search_tools'])
    expect(second).toEqual([...first!, guarded.toolSpec])
    expect(agent.messages[2]!.content[0]).toEqual(
      new ToolResultBlock({
        toolUseId: 'early',
        status: 'error',
        content: [new TextBlock(NOT_RUN), new ToolReferenceBlock({ name: 'shell' })],
      })
    )
    const sentGuard = vi.mocked(model.stream).mock.calls[1]![0][2]!.content[0] as ToolResultBlock
    expect(sentGuard.content).toEqual([new TextBlock(NOT_RUN), new TextBlock('Loaded shell.')])
    expect(callback).toHaveBeenCalledExactlyOnceWith({ value: 'ls' }, expect.anything())
  })

  it('renders the tools for the model a ModelRouter picks, not for its default model', async () => {
    const { agent, model } = makeAgent('native', { routerDefault: 'onLoad' })
    model.addTurn({ type: 'textBlock', text: 'ok' })

    await agent.invoke('Hi.')

    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
  })

  it('sends deferred tools only once loaded when a later call model does not defer natively', async () => {
    const { agent, model } = makeAgent('native')
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { dynamicToolLoading: 'unsupported' } } })
    await agent.invoke('Second.')

    expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
    expect(sentNames(model, 1)).toEqual(['retrieve_context', 'search_tools'])
  })

  it('defers natively on a later call whose model can, after a first call on a model that does not', async () => {
    const { agent, model } = makeAgent('native')
    model.updateConfig({ modelInfo: { capabilities: { dynamicToolLoading: 'unsupported' } } })
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    model.updateConfig({ modelInfo: { capabilities: { dynamicToolLoading: 'native' } } })
    await agent.invoke('Second.')

    expect(sentNames(model)).toEqual(['retrieve_context', 'search_tools'])
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write'])
  })

  it('warns once and sends deferred tools once loaded under a native override on a provider that can not defer natively', async () => {
    using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const { agent, model } = makeAgent('onLoad')
    model.updateConfig({ modelId: 'native-override', modelInfo: { capabilities: { dynamicToolLoading: 'native' } } })
    model.addTurn({ type: 'textBlock', text: 'one' }).addTurn({ type: 'textBlock', text: 'two' })

    await agent.invoke('First.')
    await agent.invoke('Second.')

    expect(sentNames(model)).toEqual(['retrieve_context', 'search_tools'])
    expect(deferredNames(model)).toEqual([])
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes('can not defer tools natively'))).toEqual([
      [
        'model_id=<native-override> | provider can not defer tools natively, so dynamicToolLoading native has no ' +
          'effect | sending each deferred tool once it is loaded',
      ],
    ])
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

    expect(deferredNames(model)).toEqual([])
    expect(sentNames(model)).not.toContain('search_tools')
    expect(deferredNames(model, 1)).toEqual(['shell', 'read', 'write', 'late'])
    expect(sentNames(model, 1)).toContain('search_tools')
    const changes = debugSpy.mock.calls.filter(([message]) => String(message).includes('deferred tools changed'))
    expect(changes).toEqual([[`model_id=<${model.modelId}>, deferred=<4> | deferred tools changed`]])
  })

  it('runs search_tools in the foreground when background tasks are on', async () => {
    const { agent, model } = makeAgent('native', { backgroundTasks: { always: ['*'] } })
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })

    await agent.invoke('List the files.')

    expect((agent.messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new ToolReferenceBlock({ name: 'shell' }),
    ])
  })

  it.each([
    ['defers tools natively', 'native', [] as string[]],
    ['takes each loaded tool with the request, read from the messages', 'onLoad', ['shell']],
  ] as const)(
    'sends the same tools list after a session restore, with nothing saved for it, when the model %s',
    async (_name, delivery, loaded) => {
      const { agent, model } = makeAgent(delivery)
      model
        .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
        .addTurn({ type: 'textBlock', text: 'one' })
      await agent.invoke('First.')
      const snapshot = agent.takeSnapshot({ preset: 'session' })

      const { agent: restored, model: restoredModel } = makeAgent(delivery)
      restoredModel.addTurn({ type: 'textBlock', text: 'two' })
      restored.loadSnapshot(snapshot)
      await restored.invoke('Second.')

      expect(snapshot.data.state).toEqual({})
      expect(sentToolSpecs(restoredModel)[0]).toEqual(sentToolSpecs(model).at(-1))
      expect(sentNames(restoredModel).slice(delivery === 'native' ? 5 : 2)).toEqual(loaded)
    }
  )

  it.each([
    ['the target covers', {}],
    [
      'the call defers once background tasks add to the schemas schemaTokens measures',
      { strategy: Offload.defer('toolSpecs').when({ schemaTokens: schemaTokens + 1 }), backgroundTasks: {} },
    ],
    [
      'the call defers on the model a router picks over a default that does not defer natively',
      { routerDefault: 'onLoad' },
    ],
  ] as [string, AgentOptions][])(
    'loads a tool %s when an interrupted load resumes on a restored agent, before its first model call',
    async (_name, options) => {
      const { result, model } = await resumeCall('search_tools', { names: ['shell'] }, options)

      expect(result.content).toEqual([new ToolReferenceBlock({ name: 'shell' })])
      expect(deferredNames(model)).toEqual(['shell', 'read', 'write'])
    }
  )

  it('loads no tool the target keeps in full when an interrupted load resumes on a restored agent', async () => {
    const { result } = await resumeCall('search_tools', { names: ['read'] }, { strategy: Offload.defer(['!read']) })

    expect(result.content).toEqual([
      new TextBlock(
        'Error: Nothing loaded: read is shown in full, so call it directly. Load only tools whose parameters are not shown.'
      ),
    ])
  })

  it('answers a call to an unloaded deferred tool when the interrupted call resumes on a restored agent', async () => {
    const { result } = await resumeCall('shell', { value: 'ls' })

    expect(result).toEqual(
      new ToolResultBlock({
        toolUseId: 'call-1',
        status: 'error',
        content: [new TextBlock(NOT_RUN), new ToolReferenceBlock({ name: 'shell' })],
      })
    )
  })

  it('runs a resumed call on a restored agent whose tools the conditions would not defer', async () => {
    const { result } = await resumeCall(
      'shell',
      { value: 'ls' },
      { strategy: Offload.defer('toolSpecs').when({ toolCount: 50 }) }
    )

    expect(result).toMatchObject({ toolUseId: 'call-1', status: 'success' })
  })

  it('counts each natively deferred tool by its name and description when the context manager measures the next request', async () => {
    const { agent, model } = makeAgent('native')
    await agent.initialize()
    const countSpy = vi.spyOn(model, 'countTokens')

    await countRequestTokens(agent, agent.messages)

    const [, options] = countSpy.mock.calls[0]!
    expect(options?.toolSpecs?.map((spec) => spec.name)).toEqual([
      'shell',
      'read',
      'write',
      'retrieve_context',
      'search_tools',
    ])
    expect(options?.toolSpecs?.slice(0, 3)).toEqual(
      [shell, read, write].map(({ name, description }) => ({ name, description, inputSchema: { type: 'object' } }))
    )
  })

  it('counts a natively loaded tool by its full schema where it was loaded when the context manager measures the next request', async () => {
    const { agent, model } = makeAgent('native')
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })
    await agent.invoke('List the files.')
    const countSpy = vi.spyOn(model, 'countTokens')

    await countRequestTokens(agent, agent.messages)

    const [messages] = countSpy.mock.calls[0]!
    expect((messages[2]!.content[0] as ToolResultBlock).content).toEqual([
      new JsonBlock({ json: shell.toolSpec.inputSchema as JSONValue }),
    ])
  })

  it('counts the tools the request sends on a model that does not defer natively, a loaded one in full and its load as text', async () => {
    const { agent, model } = makeAgent('onLoad')
    model
      .addTurn({ type: 'toolUseBlock', name: 'search_tools', toolUseId: 'load-1', input: { names: ['shell'] } })
      .addTurn({ type: 'textBlock', text: 'done' })
    await agent.invoke('List the files.')
    const countSpy = vi.spyOn(model, 'countTokens')

    await countRequestTokens(agent, agent.messages)

    const [messages, options] = countSpy.mock.calls[0]!
    expect(options?.toolSpecs?.map((spec) => spec.name)).toEqual(['retrieve_context', 'search_tools', 'shell'])
    expect(options?.toolSpecs?.at(-1)).toEqual(shell.toolSpec)
    expect((messages[2]!.content[0] as ToolResultBlock).content).toEqual([new TextBlock('Loaded shell.')])
  })

  it('keeps the order sortTools gives, in the model call and when the context manager measures the next request', async () => {
    const model = makeModel('native').addTurn({ type: 'textBlock', text: 'ok' })
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

    const sorted = ['read', 'retrieve_context', 'search_tools', 'shell', 'write']
    expect(streamSpy.mock.calls[0]![1]!.toolSpecs!.map((spec) => spec.name)).toEqual(sorted)
    expect(countSpy.mock.calls.at(-1)![1]!.toolSpecs!.map((spec) => spec.name)).toEqual(sorted)
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
        strategy: Offload.defer(['shell', 'search_tools', 'retrieve_context']),
      })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toEqual(['shell'])
    })

    const ping = tool({
      name: 'ping',
      description: 'Ping the service.',
      inputSchema: z.object({}),
      callback: () => 'pong',
    })

    it.each([
      ['', {}],
      [', with background tasks adding a parameter to every schema in the call', { backgroundTasks: {} }],
    ] as [string, AgentOptions][])(
      'never defers a tool that takes no parameters%s, so a call to it runs without a load',
      async (_name, options) => {
        const { agent, model } = makeAgent('onLoad', { tools: [shell, ping], ...options })
        model
          .addTurn({ type: 'toolUseBlock', name: 'ping', toolUseId: 'ping-1', input: {} })
          .addTurn({ type: 'textBlock', text: 'done' })

        await agent.invoke('Ping it.')

        expect(sentNames(model)[0]).toBe('ping')
        expect(sentNames(model)).not.toContain('shell')
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
    // The call holds 5 tools: the 3 below, retrieve_context and search_tools.
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
        modelInfo: { capabilities: { dynamicToolLoading: 'native' }, limits: { contextWindow: 100 * schemaTokens } },
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
      'defers tools natively',
      'native',
      ['shell', 'read', 'write', 'retrieve_context', 'search_tools'],
      ['shell', 'read', 'write'],
    ],
    ['does not defer tools natively', 'onLoad', ['retrieve_context', 'search_tools'], undefined],
  ] as const)(
    'replays the tools of the first model call in a summary before and after it when the model %s',
    async (_name, delivery, toolNames, deferred) => {
      const model = makeModel(delivery)
        .addTurn({ type: 'textBlock', text: 'a summary' })
        .addTurn({ type: 'textBlock', text: 'ok' })
        .addTurn({ type: 'textBlock', text: 'another summary' })
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
    'the dynamicToolLoading preset, counting search_tools and retrieve_context, with %i tools defers %i',
    async (count, expected) => {
      const tools = Array.from({ length: count }, (_, index) => makeTool(`tool_${index}`))
      const { agent, model } = makeAgent('native', { strategy: 'dynamicToolLoading', tools })
      model.addTurn({ type: 'textBlock', text: 'ok' })

      await agent.invoke('Hi.')

      expect(deferredNames(model)).toHaveLength(expected)
    }
  )
})
