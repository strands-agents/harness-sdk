import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GRAPH_DESCRIPTION,
  DEFAULT_GRAPH_MAX_EDGES,
  DEFAULT_GRAPH_MAX_NODES,
  DEFAULT_GRAPH_NODE_TIMEOUT,
  DEFAULT_GRAPH_TIMEOUT,
  graph,
  makeGraph,
} from '../index.js'
import { _validateEdges } from '../graph.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { MockSnapshotStorage } from '../../../__fixtures__/mock-storage-provider.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { stop } from '../../../experimental/vended-tools/stop/index.js'
import { Interrupt, InterruptError, InterruptState } from '../../../interrupt.js'
import { logger } from '../../../logging/logger.js'
import { BeforeMultiAgentInvocationEvent, NodeResultEvent } from '../../../multiagent/events.js'
import type { Graph } from '../../../multiagent/graph.js'
import { Choice, Fixed, Inherit, Preset } from '../../../multiagent/spec.js'
import type { AgentSpec } from '../../../multiagent/spec.js'
import { MultiAgentState, Status } from '../../../multiagent/state.js'
import { SessionManager } from '../../../session/session-manager.js'
import type { Tool, ToolContext, ToolStreamEvent } from '../../../tools/tool.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { JSONValue } from '../../../types/json.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { serializeStateSerializable } from '../../../types/serializable.js'
import { handoffToUser } from '../../handoff-to-user/index.js'

const NODES = [
  { name: 'a', instructions: 'Do A.' },
  { name: 'b', instructions: 'Do B.' },
]
const EDGES = [{ from_node: 'a', to_node: 'b' }]

function textModel(...texts: string[]): MockMessageModel {
  const model = new MockMessageModel()
  for (const text of texts) model.addTurn({ type: 'textBlock', text })
  return model
}

/** Builds each node from `models`, keyed by node name, so a model outlives a rebuild on resume. */
function modelBuilder(models: Record<string, MockMessageModel>, tools: Tool[] = []) {
  return (spec: AgentSpec): Agent =>
    new Agent({ model: models[spec.name!]!, printer: false, id: spec.name!, tools: [...tools] })
}

function run(
  tool: Tool,
  input: JSONValue,
  agent: Agent = new Agent({ model: new MockMessageModel(), printer: false }),
  invocationState: Record<string, unknown> = {}
) {
  const context = {
    toolUse: { name: tool.name, toolUseId: 't1', input },
    agent,
    invocationState,
    cancelSignal: new AbortController().signal,
  } as unknown as ToolContext
  return collectGenerator(tool.stream(context))
}

function interruptState(agent: Agent): InterruptState {
  return (agent as unknown as { _interruptState: InterruptState })._interruptState
}

function storedTurns(agent: Agent): Record<string, JSONValue> {
  return (interruptState(agent).context['subAgentInterruptedTurns'] ?? {}) as Record<string, JSONValue>
}

function errorResult(text: string): unknown {
  return expect.objectContaining({ status: 'error', content: [expect.objectContaining({ text })] })
}

function graphToolResult(agent: Agent): ToolResultBlock {
  return agent.messages
    .flatMap((message) => message.content)
    .find((block): block is ToolResultBlock => block instanceof ToolResultBlock)!
}

describe('graph tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tool metadata', () => {
    it('exposes the default name, description, and schema', () => {
      expect(graph.name).toBe('graph')
      expect(makeGraph({ name: 'dag' }).name).toBe('dag')
      expect(graph.toolSpec.description).toBe(DEFAULT_GRAPH_DESCRIPTION)
      expect(graph.toolSpec.inputSchema).toEqual({
        type: 'object',
        required: ['task', 'nodes', 'edges'],
        properties: {
          task: {
            type: 'string',
            description: 'The objective for the graph; entry-point nodes receive it directly.',
          },
          nodes: {
            type: 'array',
            description: 'Agent specifications, one per node.',
            items: {
              type: 'object',
              required: ['name', 'instructions'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'A unique name for this node, referenced by edges.' },
                instructions: { type: 'string', description: "A system prompt defining this agent's role." },
              },
            },
            minItems: 2,
            maxItems: DEFAULT_GRAPH_MAX_NODES,
          },
          edges: {
            type: 'array',
            description: 'Directed edges between node names. Use an empty list for fully parallel nodes.',
            items: {
              type: 'object',
              required: ['from_node', 'to_node'],
              additionalProperties: false,
              properties: {
                from_node: { type: 'string', description: 'Name of the upstream node.' },
                to_node: { type: 'string', description: 'Name of the node that runs after from_node.' },
              },
            },
            maxItems: DEFAULT_GRAPH_MAX_EDGES,
          },
        },
      })
    })

    it('wires maxNodes, maxEdges, and a tools Choice into the schema', () => {
      const schema = makeGraph({ maxNodes: 3, maxEdges: 4, tools: new Choice(['calc'], true) }).toolSpec.inputSchema
      expect(schema).toMatchObject({
        properties: {
          nodes: { maxItems: 3, items: { properties: { tools: { items: { enum: ['calc'] } } } } },
          edges: { maxItems: 4 },
        },
      })
    })

    it.each([
      [{}, ['name', 'instructions'], ['name', 'instructions']],
      [{ presets: { w: new Preset() } }, ['name'], ['name', 'agent_type', 'instructions']],
      [{ instructions: new Fixed('x'), tools: new Inherit(), model: new Fixed('m') }, ['name'], ['name']],
      [
        {
          presets: { w: new Preset() },
          instructions: new Choice(['A']),
          tools: new Choice(['calc'], true),
          model: new Choice(['fast']),
        },
        ['name'],
        ['name', 'agent_type', 'instructions', 'tools', 'model'],
      ],
    ])('derives the node item from the axes (%#)', (options, required, properties) => {
      const items = (
        makeGraph(options).toolSpec.inputSchema as {
          properties: { nodes: { items: { required: string[]; properties: object } } }
        }
      ).properties.nodes.items
      expect(items.required).toEqual(required)
      expect(Object.keys(items.properties).sort()).toEqual([...properties].sort())
    })
  })

  describe('factory validation', () => {
    it.each([
      [{ maxNodes: 1 }, 'maxNodes must be an integer of at least 2.'],
      [{ maxNodes: 2.5 }, 'maxNodes must be an integer of at least 2.'],
      [{ maxEdges: 0 }, 'maxEdges must be a positive integer (>= 1).'],
      [{ maxSteps: 0 }, 'maxSteps must be a positive integer (>= 1) or Infinity.'],
      [{ timeout: 0.5 }, 'timeout must be at least 1 millisecond.'],
      [{ nodeTimeout: -1.5 }, 'nodeTimeout must be at least 1 millisecond.'],
      [{ name: '' }, 'name must be a non-empty string.'],
      [{ description: '' }, 'description must be a non-empty string.'],
      [{ presets: { w: new Preset() }, defaultPreset: 'x' }, "defaultPreset 'x' is not one of the presets: w."],
      [{ tools: new Choice([], true) }, 'offers no options'],
      [{ tools: new Choice(['a']) }, 'must set multiple'],
    ])('rejects invalid options %#', (options, message) => {
      expect(() => makeGraph(options)).toThrow(message)
    })
  })

  describe('edge validation', () => {
    it.each([
      ['bad', 'must be an array'],
      [Array(4).fill(EDGES[0]), 'At most 3'],
      [['x'], 'must be an object'],
      [[{ from_node: 'a' }], 'must be strings'],
      [[{ from_node: 'a', to_node: 'z' }], '"z" is not a declared node'],
      [[{ from_node: 'a', to_node: 'a' }], 'self-loop'],
      [
        [
          { from_node: 'a', to_node: 'b' },
          { from_node: 'b', to_node: 'c' },
          { from_node: 'c', to_node: 'b' },
        ],
        'cycle: b -> c -> b',
      ],
    ])('rejects invalid edges %#', (edges, message) => {
      expect(() => _validateEdges(edges, ['a', 'b', 'c'], 3)).toThrow(message)
    })

    it('accepts a DAG, strips names, and drops repeated edges', () => {
      const edges = [
        { from_node: ' a', to_node: 'b ' },
        { from_node: 'a', to_node: 'c' },
        { from_node: 'a', to_node: 'b' },
      ]
      expect(_validateEdges(edges, ['a', 'b', 'c'], 5)).toEqual([
        ['a', 'b'],
        ['a', 'c'],
      ])
    })
  })

  describe('execution', () => {
    it('streams events, forwards a copy of the invocation state, and returns each node output', async () => {
      const builder = modelBuilder({ a: textModel('a done'), b: textModel('b done') })
      const invocationState = { userKey: 'v' }
      const { items, result } = await run(
        makeGraph({ builder }),
        { task: 'go', nodes: NODES, edges: EDGES },
        undefined,
        invocationState
      )

      const events = items.map((item) => (item as ToolStreamEvent).data)
      const before = events.find((data) => data instanceof BeforeMultiAgentInvocationEvent)
      expect((before as BeforeMultiAgentInvocationEvent).invocationState).toEqual(invocationState)
      expect((before as BeforeMultiAgentInvocationEvent).invocationState).not.toBe(invocationState)
      expect(
        events.filter((data) => data instanceof NodeResultEvent).map((data) => (data as NodeResultEvent).result.nodeId)
      ).toEqual(['a', 'b'])
      expect(result).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('a: a done\nb: b done')] })
      )
    })

    it.each([
      [{}, { maxSteps: Infinity, timeout: DEFAULT_GRAPH_TIMEOUT, nodeTimeout: DEFAULT_GRAPH_NODE_TIMEOUT }],
      [
        { maxSteps: 5, timeout: 60_000, nodeTimeout: 30_000 },
        { maxSteps: 5, timeout: 60_000, nodeTimeout: 30_000 },
      ],
    ])('forwards the configured limits to the graph (%#)', async (limits, expected) => {
      const builder = modelBuilder({ a: textModel('a done'), b: textModel('b done') })
      const { items } = await run(makeGraph({ builder, ...limits }), { task: 'go', nodes: NODES, edges: [] })

      const before = items
        .map((item) => (item as ToolStreamEvent).data)
        .find((data) => data instanceof BeforeMultiAgentInvocationEvent) as BeforeMultiAgentInvocationEvent
      expect((before.orchestrator as Graph).config).toMatchObject(expected)
    })

    it.each([
      [NODES.slice(0, 1), 'Error: Between 2 and 3 nodes required, got 1.'],
      [
        ['0', '1', '2', '3'].map((name) => ({ name, instructions: 'x' })),
        'Error: Between 2 and 3 nodes required, got 4.',
      ],
      [[NODES[0], NODES[0]], 'Error: Duplicate node name "a" at index 1'],
    ])('returns an error result for invalid input %#', async (nodes, message) => {
      const { result } = await run(makeGraph({ maxNodes: 3 }), { task: 't', nodes, edges: [] } as JSONValue)
      expect(result).toEqual(errorResult(message))
    })

    it('returns an error result with the partial output when a limit stops the graph', async () => {
      const builder = modelBuilder({ a: textModel('a done'), b: textModel('b done') })
      const { result } = await run(makeGraph({ builder, maxSteps: 1 }), { task: 't', nodes: NODES, edges: EDGES })
      expect(result).toEqual(
        errorResult(
          'Error: Graph stopped before completing (steps=<1> | max steps reached). Partial output:\na: a done'
        )
      )
    })

    it('returns an error result with the partial output when a node fails', async () => {
      const builder = modelBuilder({
        a: new MockMessageModel().addTurn(new Error('model exploded')),
        b: textModel('b done'),
      })
      const { result } = await run(makeGraph({ builder }), {
        task: 't',
        nodes: NODES,
        edges: [{ from_node: 'b', to_node: 'a' }],
      })
      expect(result).toEqual(
        errorResult(
          'Error: Graph stopped before completing (status=FAILED). Partial output:\nb: b done\na: failed: model exploded'
        )
      )
    })

    it('reports every failed node with its own error', async () => {
      const builder = modelBuilder({
        a: new MockMessageModel().addTurn(new Error('a exploded.')),
        b: new MockMessageModel().addTurn(new Error('b exploded')),
      })
      const { result } = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: [] })
      expect(result).toEqual(
        errorResult(
          'Error: Graph stopped before completing (status=FAILED). Partial output:\na: failed: a exploded.\nb: failed: b exploded'
        )
      )
    })

    it('maps node names to agent ids that differ from them', async () => {
      const models: Record<string, MockMessageModel> = { a: textModel('a done'), b: textModel('b done') }
      const builder = (spec: AgentSpec): Agent =>
        new Agent({ model: models[spec.name!]!, printer: false, id: `id-${spec.name}` })
      const { result } = await run(makeGraph({ builder }), { task: 'go', nodes: NODES, edges: EDGES })
      expect(result).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('a: a done\nb: b done')] })
      )
    })

    it('returns an error result when the builder does not give each node a unique agent id', async () => {
      const builder = (): Agent => new Agent({ model: textModel('done'), printer: false })
      const { result } = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES })
      expect(result).toEqual(errorResult('Error: makeGraph builder must give each node spec a unique agent id.'))
    })

    it('returns an error result when the builder fails on a fresh run', async () => {
      const builder = (): Agent => {
        throw new Error('model endpoint unavailable')
      }
      const { result } = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES })
      expect(result).toEqual(errorResult('Error: model endpoint unavailable'))
    })

    it('defaults nodes to the first preset', async () => {
      const specs: AgentSpec[] = []
      const builder = (spec: AgentSpec): Agent => {
        specs.push(spec)
        return new Agent({ model: textModel('done'), printer: false, id: spec.name! })
      }
      const tool = makeGraph({
        builder,
        presets: { writer: new Preset({ instructions: 'Write.' }), other: new Preset() },
      })

      await run(tool, { task: 't', nodes: [{ name: 'a' }, { name: 'b' }], edges: [] })

      expect(specs.map((spec) => [spec.agentType, spec.instructions])).toEqual([
        ['writer', 'Write.'],
        ['writer', 'Write.'],
      ])
    })

    it('strips every graph tool from the nodes and keeps the others', async () => {
      const specs: AgentSpec[] = []
      const agents: Agent[] = []
      const builder = (spec: AgentSpec): Agent => {
        specs.push(spec)
        const agent = new Agent({
          model: textModel('done'),
          printer: false,
          id: spec.name!,
          tools: [custom, graph, makeGraph({ name: 'other' }), handoffToUser],
        })
        agents.push(agent)
        return agent
      }
      const custom = makeGraph({ name: 'nested_graph', builder, instructions: new Fixed('Locked.') })

      await run(custom, { task: 't', nodes: [{ name: 'a' }, { name: 'b' }], edges: EDGES })

      expect(specs.map((spec) => [spec.name, spec.instructions])).toEqual([
        ['a', 'Locked.'],
        ['b', 'Locked.'],
      ])
      for (const agent of agents) {
        expect(agent.toolRegistry.list().map((tool) => tool.name)).toEqual([handoffToUser.name])
      }
    })
  })

  describe('with real agents', () => {
    it("runs a graph built from the parent and a child's stop does not halt the parent", async () => {
      // Parent and nodes share the inherited model, so turns are consumed in call order.
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'graph',
          toolUseId: 'p1',
          input: { task: 'go', nodes: NODES, edges: EDGES },
        })
        .addTurn({ type: 'toolUseBlock', name: 'stop', toolUseId: 'c1', input: { message: 'a done' } })
        .addTurn({ type: 'textBlock', text: 'b done' })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [graph, stop], printer: false })

      const result = await parent.invoke('start')

      expect(result.stopReason).toBe('endTurn')
      expect(result.toString()).toBe('parent final')
      expect(graphToolResult(parent).content).toEqual([new TextBlock('a: a done\nb: b done')])
    })

    it('surfaces a node interrupt on the parent and resumes the downstream nodes', async () => {
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'graph',
          toolUseId: 'p1',
          input: { task: 'go', nodes: NODES, edges: EDGES },
        })
        .addTurn({ type: 'toolUseBlock', name: 'handoff_to_user', toolUseId: 'c1', input: { message: 'Approve?' } })
        .addTurn({ type: 'textBlock', text: 'a done' })
        .addTurn({ type: 'textBlock', text: 'b done' })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [graph, handoffToUser], printer: false })

      const interrupted = await parent.invoke('start')
      expect(interrupted.stopReason).toBe('interrupt')
      expect(interrupted.interrupts).toMatchObject([{ reason: 'Approve?' }])
      const resumed = await parent.invoke([
        new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'approved' }),
      ])

      expect(resumed.toString()).toBe('parent final')
      expect(graphToolResult(parent).content).toEqual([new TextBlock('a: a done\nb: b done')])
    })

    it('surfaces parallel node interrupts on the parent and resumes them', async () => {
      const models = Object.fromEntries(
        ['a', 'b'].map((name) => [
          name,
          new MockMessageModel()
            .addTurn({
              type: 'toolUseBlock',
              name: 'handoff_to_user',
              toolUseId: name,
              input: { message: `Approve ${name}?` },
            })
            .addTurn({ type: 'textBlock', text: `${name} done` }),
        ])
      )
      const parentModel = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'graph',
          toolUseId: 'p1',
          input: { task: 'go', nodes: NODES, edges: [] },
        })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const tool = makeGraph({ builder: modelBuilder(models, [handoffToUser]) })
      const parent = new Agent({ model: parentModel, tools: [tool, handoffToUser], printer: false })

      let result = await parent.invoke('start')
      const reasons: unknown[] = []
      while (result.stopReason === 'interrupt') {
        reasons.push(...result.interrupts!.map((interrupt) => interrupt.reason))
        result = await parent.invoke(
          result.interrupts!.map(
            (interrupt) => new InterruptResponseContent({ interruptId: interrupt.id, response: 'approved' })
          )
        )
      }

      expect(new Set(reasons)).toEqual(new Set(['Approve a?', 'Approve b?']))
      expect(result.toString()).toBe('parent final')
      const [content] = graphToolResult(parent).content as TextBlock[]
      expect(new Set(content!.text.split('\n'))).toEqual(new Set(['a: a done', 'b: b done']))
    })

    it('resumes an interrupted graph after the parent is rebuilt', async () => {
      const storage = new MockSnapshotStorage()
      const build = (model: MockMessageModel): Agent =>
        new Agent({
          model,
          tools: [graph, handoffToUser],
          printer: false,
          sessionManager: new SessionManager({ sessionId: 's1', storage: { snapshot: storage } }),
        })
      const first = build(
        new MockMessageModel()
          .addTurn({
            type: 'toolUseBlock',
            name: 'graph',
            toolUseId: 'p1',
            input: { task: 'go', nodes: NODES, edges: EDGES },
          })
          .addTurn({ type: 'toolUseBlock', name: 'handoff_to_user', toolUseId: 'c1', input: { message: 'Approve?' } })
      )
      const interrupted = await first.invoke('start')
      expect(Object.keys(storedTurns(first))).toEqual(['p1'])

      // Process boundary: every agent is rebuilt and only the session survives.
      const second = build(textModel('a done', 'b done', 'parent final'))
      const result = await second.invoke([
        new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'approved' }),
      ])

      expect(result.toString()).toBe('parent final')
      expect(second.messages.at(-2)!.content).toEqual([
        new ToolResultBlock({ toolUseId: 'p1', status: 'success', content: [new TextBlock('a: a done\nb: b done')] }),
      ])
    })
  })

  describe('interrupt persistence', () => {
    it('stores the interrupted graph under a stable id and namespaces its interrupts', async () => {
      const builder = modelBuilder(
        {
          a: new MockMessageModel().addTurn({
            type: 'toolUseBlock',
            name: 'confirmTool',
            toolUseId: 'c1',
            input: {},
          }),
          b: textModel('b done'),
        },
        [createMockTool('confirmTool', (context) => context.interrupt({ name: 'confirm', reason: 'ok?' }))]
      )
      const parent = new Agent({ model: new MockMessageModel(), printer: false })

      const error = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES }, parent).catch(
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(InterruptError)
      expect((error as InterruptError).interrupts).toMatchObject([
        { id: 'graph:t1:tool:c1:confirm', name: 'confirm', reason: 'ok?', source: 'tool' },
      ])
      expect(storedTurns(parent)['t1']).toMatchObject({ scope: 'multiAgent', data: { orchestratorId: 'graph:t1' } })
    })

    function resumingParent(turn?: JSONValue): { parent: Agent; answered: Interrupt } {
      const answered = new Interrupt({ id: 'graph:t1:approval', name: 'confirm' })
      const parent = new Agent({ model: new MockMessageModel(), printer: false })
      const state = interruptState(parent)
      state.registerInterrupt(answered)
      if (turn !== undefined) state.context['subAgentInterruptedTurns'] = { t1: turn }
      state.activate()
      state.resume([new InterruptResponseContent({ interruptId: answered.id, response: 'yes' })])
      return { parent, answered }
    }

    it('raises the interrupt again and keeps the turn when a node cannot be rebuilt on resume', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const awaited = new MultiAgentState({ nodeIds: ['a', 'b'] })
      awaited.node('a')!.status = Status.INTERRUPTED
      awaited.node('a')!.interrupts = [new Interrupt({ id: 'approval', name: 'confirm' })]
      const turn = { scope: 'multiAgent', data: { state: serializeStateSerializable(awaited) } } as unknown as JSONValue
      const { parent, answered } = resumingParent(turn)
      const builder = (): Agent => {
        throw new Error('model endpoint unavailable')
      }

      const error = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES }, parent).catch(
        (caught: unknown) => caught
      )

      expect((error as InterruptError).interrupts.map((interrupt) => [interrupt.id, interrupt.response])).toEqual([
        [answered.id, undefined],
      ])
      expect(storedTurns(parent)).toEqual({ t1: turn })
    })

    it('returns the unavailable message when resuming without a stored turn', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {})
      const { parent } = resumingParent()
      const builder = modelBuilder({ a: new MockMessageModel(), b: new MockMessageModel() })

      const { result } = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES }, parent)

      expect(result).toEqual(
        errorResult(
          'Error: Graph did NOT run and the response was NOT applied: its interrupted turn is not available. ' +
            'Do not report the task as completed; if it is still needed, start the graph again.'
        )
      )
    })
  })
})
