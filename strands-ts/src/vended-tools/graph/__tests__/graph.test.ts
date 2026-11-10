import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GRAPH_DESCRIPTION,
  DEFAULT_GRAPH_MAX_EDGES,
  DEFAULT_GRAPH_MAX_NODES,
  graph,
  makeGraph,
  type MakeGraphOptions,
} from '../index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { Interrupt, InterruptError, InterruptState } from '../../../interrupt.js'
import { logger } from '../../../logging/logger.js'
import { NodeResultEvent } from '../../../multiagent/events.js'
import { Graph } from '../../../multiagent/graph.js'
import { Fixed, Preset } from '../../../multiagent/spec.js'
import { MultiAgentState, Status } from '../../../multiagent/state.js'
import type { AgentSpec } from '../../../multiagent/spec.js'
import type { Tool, ToolContext, ToolStreamEvent } from '../../../tools/tool.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { JSONValue } from '../../../types/json.js'
import { serializeStateSerializable } from '../../../types/serializable.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import { handoffToUser } from '../../handoff-to-user/index.js'

const NODES = [
  { name: 'a', instructions: 'Do A.' },
  { name: 'b', instructions: 'Do B.' },
]
const EDGES = [{ from_node: 'a', to_node: 'b' }]

function run(
  tool: Tool,
  input: JSONValue,
  agent: Agent = new Agent({ model: new MockMessageModel(), printer: false })
): ReturnType<typeof collectGenerator> {
  const context = {
    toolUse: { name: tool.name, toolUseId: 't1', input },
    agent,
    invocationState: { userKey: 'v' },
    cancelSignal: new AbortController().signal,
  } as unknown as ToolContext
  return collectGenerator(tool.stream(context))
}

/** Builds each node as an agent that answers `<name> done`, leaving every agent the default id. */
function textBuilder(spec: AgentSpec): Agent {
  return new Agent({
    model: new MockMessageModel().addTurn({ type: 'textBlock', text: `${spec.name} done` }),
    printer: false,
  })
}

function interruptState(agent: Agent): InterruptState {
  return (agent as unknown as { _interruptState: InterruptState })._interruptState
}

function storedTurns(agent: Agent): Record<string, JSONValue> {
  return (interruptState(agent).context['subAgentInterruptedTurns'] ?? {}) as Record<string, JSONValue>
}

function success(text: string): ToolResultBlock {
  return new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock(text)] })
}

function errorResult(text: string | RegExp): unknown {
  return expect.objectContaining({
    status: 'error',
    content: [expect.objectContaining({ text: expect.stringMatching(text) })],
  })
}

/** A parent resuming with an answer to `graph:t1:approval`; `turn` is stored as the interrupted graph. */
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

function toolUseTurn(model: MockMessageModel, name: string, input: JSONValue, toolUseId: string): MockMessageModel {
  return model.addTurn({ type: 'toolUseBlock', name, toolUseId, input })
}

describe('graph tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tool metadata', () => {
    it('exports the default instance and derives its schema', () => {
      expect(graph.name).toBe('graph')
      expect(makeGraph({ name: 'dag' }).name).toBe('dag')
      expect(makeGraph({ maxNodes: 3, maxEdges: 4 }).toolSpec.inputSchema).toMatchObject({
        properties: { nodes: { maxItems: 3 }, edges: { maxItems: 4 } },
      })
      expect(graph.toolSpec.description).toBe(DEFAULT_GRAPH_DESCRIPTION)
      expect(graph.toolSpec.inputSchema).toEqual({
        type: 'object',
        required: ['task', 'nodes', 'edges'],
        properties: {
          task: { type: 'string', description: 'The objective for the graph; entry-point nodes receive it directly.' },
          nodes: {
            type: 'array',
            description: 'Agent specifications, one per node.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'A unique name for this node, referenced by edges.' },
                instructions: { type: 'string', description: "A system prompt defining this agent's role." },
              },
              required: ['name', 'instructions'],
              additionalProperties: false,
            },
            minItems: 2,
            maxItems: DEFAULT_GRAPH_MAX_NODES,
          },
          edges: {
            type: 'array',
            description: 'Directed edges between node names. Use an empty list for fully parallel nodes.',
            items: {
              type: 'object',
              properties: {
                from_node: { type: 'string', description: 'Name of the upstream node.' },
                to_node: { type: 'string', description: 'Name of the node that runs after from_node.' },
              },
              required: ['from_node', 'to_node'],
              additionalProperties: false,
            },
            maxItems: DEFAULT_GRAPH_MAX_EDGES,
          },
        },
      })
    })

    it.each([
      [{ presets: { w: new Preset() } }, ['name']],
      [{ instructions: new Fixed('x') }, ['name']],
    ] as [MakeGraphOptions, string[]][])('requires instructions only without a fallback (%#)', (options, required) => {
      expect(makeGraph(options).toolSpec.inputSchema).toMatchObject({
        properties: { nodes: { items: { required } } },
      })
    })
  })

  describe('factory validation', () => {
    it.each([
      [{ maxNodes: 1 }, 'maxNodes must be an integer >= 2.'],
      [{ maxNodes: 2.5 }, 'maxNodes must be an integer >= 2.'],
      [{ maxEdges: 0 }, 'maxEdges must be a positive integer (>= 1).'],
      [{ maxSteps: 0 }, 'maxSteps must be a positive integer (>= 1) or Infinity.'],
      [{ timeout: 0 }, 'timeout must be a positive number.'],
      [{ nodeTimeout: -1.5 }, 'nodeTimeout must be a positive number.'],
      [{ name: '' }, 'name must be a non-empty string.'],
      [{ description: '' }, 'description must be a non-empty string.'],
      [{ presets: { w: new Preset() }, defaultPreset: 'x' }, "defaultPreset 'x' is not one of the presets: w."],
    ] as [MakeGraphOptions, string][])('rejects invalid options %#', (options, message) => {
      expect(() => makeGraph(options)).toThrow(message)
    })
  })

  describe('input validation', () => {
    it.each([
      [{ nodes: NODES, edges: [] }, /Missing required parameter 'task'/],
      [{ task: 't', nodes: NODES.slice(0, 1), edges: [] }, /Between 2 and 3 nodes required, got 1/],
      [
        { task: 't', nodes: ['0', '1', '2', '3'].map((name) => ({ name, instructions: 'x' })), edges: [] },
        /Between 2 and 3 nodes required, got 4/,
      ],
      [{ task: 't', nodes: [NODES[0], NODES[0]], edges: [] }, /Duplicate node name "a" at index 1/],
      [{ task: 't', nodes: NODES, edges: 'bad' }, /edges must be an array/],
      [{ task: 't', nodes: NODES, edges: [EDGES[0], EDGES[0], EDGES[0], EDGES[0]] }, /At most 3 edges allowed/],
      [{ task: 't', nodes: NODES, edges: ['x'] }, /Edge at index 0 must be an object/],
      [{ task: 't', nodes: NODES, edges: [{ from_node: 'a' }] }, /from_node and to_node must be strings/],
      [{ task: 't', nodes: NODES, edges: [{ from_node: 'a', to_node: 'z' }] }, /"z" is not a declared node/],
      [{ task: 't', nodes: NODES, edges: [{ from_node: 'a', to_node: 'a' }] }, /self-loop on "a"/],
      [
        {
          task: 't',
          nodes: [...NODES, { name: 'c', instructions: 'Do C.' }],
          edges: [
            { from_node: 'a', to_node: 'b' },
            { from_node: 'b', to_node: 'c' },
            { from_node: 'c', to_node: 'b' },
          ],
        },
        /Edges form a cycle: b -> c -> b/,
      ],
    ])('returns an error result for invalid input %#', async (input, message) => {
      const { result } = await run(makeGraph({ maxNodes: 3, maxEdges: 3 }), input as JSONValue)
      expect(result).toEqual(errorResult(message))
    })
  })

  describe('execution', () => {
    it('streams node events, forwards the invocation state, collapses repeated edges, and returns every node output', async () => {
      const stream = vi.spyOn(Graph.prototype, 'stream')
      const nodes = [...NODES, { name: 'c', instructions: 'Do C.' }]
      const edges = [
        { from_node: ' a', to_node: 'b ' },
        { from_node: 'a', to_node: 'b' },
        { from_node: 'a', to_node: 'c' },
      ]

      const { items, result } = await run(makeGraph({ builder: textBuilder }), { task: 'go', nodes, edges })

      const graphInstance = stream.mock.contexts[0] as Graph
      expect(stream).toHaveBeenCalledWith('go', expect.objectContaining({ invocationState: { userKey: 'v' } }))
      expect(graphInstance.edges.map((edge) => [edge.source.id, edge.target.id])).toEqual([
        ['a', 'b'],
        ['a', 'c'],
      ])
      const nodeIds = items
        .map((event) => (event as ToolStreamEvent).data)
        .filter((data) => data instanceof NodeResultEvent)
        .map((data) => data.nodeId)
      expect(nodeIds).toEqual(['a', 'b', 'c'])
      expect(result).toEqual(success('a: a done\nb: b done\nc: c done'))
    })

    it.each([
      [{}, { maxSteps: Infinity, timeout: 900_000, nodeTimeout: 300_000 }],
      [
        { maxSteps: 5, timeout: Infinity, nodeTimeout: 30_000 },
        { maxSteps: 5, timeout: Infinity, nodeTimeout: 30_000 },
      ],
    ])('applies the limits %o to the graph', async (limits, expected) => {
      const stream = vi.spyOn(Graph.prototype, 'stream')

      await run(makeGraph({ builder: textBuilder, ...limits }), { task: 't', nodes: NODES, edges: [] })

      expect((stream.mock.contexts[0] as Graph).config).toMatchObject(expected)
    })

    it('returns an error result with the partial output when a step limit stops the graph', async () => {
      const { result } = await run(makeGraph({ builder: textBuilder, maxSteps: 1 }), {
        task: 't',
        nodes: NODES,
        edges: EDGES,
      })

      expect(result).toEqual(
        errorResult(/^Error: Graph stopped before completing \(.+\)\. Partial output:\na: a done$/)
      )
    })

    it('returns an error result with the partial output and every failed node when nodes fail', async () => {
      const builder = (spec: AgentSpec): Agent =>
        spec.name === 'ok'
          ? textBuilder(spec)
          : new Agent({
              model: new MockMessageModel().addTurn(new Error(`${spec.name} exploded`)),
              printer: false,
            })

      const { result } = await run(makeGraph({ builder }), {
        task: 't',
        nodes: [{ name: 'ok' }, { name: 'x' }, { name: 'y' }].map((node) => ({ ...node, instructions: 'Do.' })),
        edges: [],
      })

      expect(result).toEqual(
        errorResult(
          /^Error: Graph stopped before completing \(status=FAILED: x exploded\)\. Partial output:\nx: failed: x exploded\ny: failed: y exploded\nok: ok done$/
        )
      )
    })

    it('returns an error result when the builder fails on a fresh run', async () => {
      const builder = (): Agent => {
        throw new Error('model endpoint unavailable')
      }

      const { result } = await run(makeGraph({ builder }), { task: 't', nodes: NODES, edges: EDGES })

      expect(result).toEqual(errorResult(/^Error: model endpoint unavailable$/))
    })

    it('defaults nodes to the first preset and strips every graph tool from them', async () => {
      const specs: AgentSpec[] = []
      const agents: Agent[] = []
      const keep = createMockTool('keep', () => 'ok')
      const builder = (spec: AgentSpec): Agent => {
        specs.push(spec)
        const agent = textBuilder(spec)
        agent.toolRegistry.add([custom, graph, makeGraph({ name: 'other' }), handoffToUser, keep])
        agents.push(agent)
        return agent
      }
      const custom = makeGraph({
        name: 'nested_graph',
        builder,
        presets: { writer: new Preset({ instructions: 'Locked.' }), other: new Preset() },
      })

      await run(custom, { task: 't', nodes: [{ name: 'a' }, { name: 'b' }], edges: EDGES })

      expect(specs.map((spec) => [spec.name, spec.agentType, spec.instructions])).toEqual([
        ['a', 'writer', 'Locked.'],
        ['b', 'writer', 'Locked.'],
      ])
      expect(agents.map((agent) => agent.toolRegistry.list().map((tool) => tool.name))).toEqual([
        ['handoff_to_user', 'keep'],
        ['handoff_to_user', 'keep'],
      ])
    })
  })

  describe('interrupt persistence', () => {
    it('returns the unavailable message without running the graph when no turn is stored', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {})
      const stream = vi.spyOn(Graph.prototype, 'stream')
      const { parent } = resumingParent()

      const { result } = await run(
        makeGraph({ builder: textBuilder }),
        { task: 't', nodes: NODES, edges: EDGES },
        parent
      )

      expect(stream).not.toHaveBeenCalled()
      expect(result).toEqual(errorResult(/^Error: Graph did NOT run and the response was NOT applied/))
    })

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
  })

  describe('with real agents', () => {
    it('surfaces a node handoff on the parent, stores the graph under a stable id, and resumes it', async () => {
      const model = toolUseTurn(new MockMessageModel(), 'graph', { task: 'go', nodes: NODES, edges: EDGES }, 'p1')
      toolUseTurn(model, 'handoff_to_user', { message: 'Approve?' }, 'c1')
        .addTurn({ type: 'textBlock', text: 'a done' })
        .addTurn({ type: 'textBlock', text: 'b done' })
        .addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model, tools: [graph, handoffToUser], printer: false })

      const interrupted = await parent.invoke('start')
      expect(interrupted.stopReason).toBe('interrupt')
      expect(interrupted.interrupts).toMatchObject([
        { id: expect.stringMatching(/^graph:p1:/), reason: 'Approve?', source: 'tool' },
      ])
      expect(storedTurns(parent)['p1']).toMatchObject({ scope: 'multiAgent', data: { orchestratorId: 'graph:p1' } })
      const result = await parent.invoke([
        new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'approved' }),
      ])

      expect(result.toString()).toBe('parent final')
      expect(parent.messages[2]!.content).toEqual([
        new ToolResultBlock({ toolUseId: 'p1', status: 'success', content: [new TextBlock('a: a done\nb: b done')] }),
      ])
    })

    it('keeps the outputs of nodes that finished before the interrupt when a limit stops the resumed graph', async () => {
      // eslint-disable-next-line require-yield
      const slow = createMockTool('slow', async function* (context) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return new ToolResultBlock({ toolUseId: context.toolUse.toolUseId, status: 'success', content: [] })
      })
      const models: Record<string, MockMessageModel> = {
        a: new MockMessageModel().addTurn({ type: 'textBlock', text: 'a done' }),
        b: toolUseTurn(new MockMessageModel(), 'handoff_to_user', { message: 'Approve?' }, 'h1').addTurn({
          type: 'toolUseBlock',
          name: 'slow',
          toolUseId: 's1',
          input: {},
        }),
      }
      const builder = (spec: AgentSpec): Agent =>
        new Agent({ model: models[spec.name!]!, tools: [handoffToUser, slow], printer: false })
      const parentModel = toolUseTurn(new MockMessageModel(), 'graph', { task: 'go', nodes: NODES, edges: EDGES }, 'p1')
      const parent = new Agent({ model: parentModel, tools: [makeGraph({ builder, timeout: 50 })], printer: false })

      const interrupted = await parent.invoke('start')
      parentModel.addTurn({ type: 'textBlock', text: 'parent final' })
      await parent.invoke([
        new InterruptResponseContent({ interruptId: interrupted.interrupts![0]!.id, response: 'yes' }),
      ])

      expect(parent.messages[2]!.content).toEqual([
        errorResult(/^Error: Graph stopped before completing \(.+\)\. Partial output:\na: a done$/),
      ])
    })

    it('resumes parallel node handoffs one at a time', async () => {
      // Nodes are rebuilt on each resume, so each node's scripted model must outlive a single build.
      const models = Object.fromEntries(
        ['a', 'b'].map((name) => [
          name,
          toolUseTurn(new MockMessageModel(), 'handoff_to_user', { message: `Approve ${name}?` }, name).addTurn({
            type: 'textBlock',
            text: `${name} done`,
          }),
        ])
      )
      // Every build gets a new agent id, so resume must not depend on agent ids.
      let builds = 0
      const builder = (spec: AgentSpec): Agent =>
        new Agent({ model: models[spec.name!]!, tools: [handoffToUser], printer: false, id: `agent-${(builds += 1)}` })
      const parentModel = toolUseTurn(
        new MockMessageModel(),
        'graph',
        { task: 'go', nodes: NODES, edges: [] },
        'p1'
      ).addTurn({ type: 'textBlock', text: 'parent final' })
      const parent = new Agent({ model: parentModel, tools: [makeGraph({ builder }), handoffToUser], printer: false })

      let result = await parent.invoke('start')
      const reasons: string[] = []
      // Bounded so a resume that keeps re-raising fails instead of hanging.
      for (let turn = 0; result.stopReason === 'interrupt' && turn < 4; turn += 1) {
        const [interrupt] = result.interrupts!
        reasons.push(interrupt!.reason as string)
        result = await parent.invoke([new InterruptResponseContent({ interruptId: interrupt!.id, response: 'ok' })])
      }

      expect(reasons.sort()).toEqual(['Approve a?', 'Approve b?'])
      expect(result.toString()).toBe('parent final')
      const [block] = parent.messages[2]!.content as ToolResultBlock[]
      expect((block!.content[0] as TextBlock).text.split('\n').sort()).toEqual(['a: a done', 'b: b done'])
    })
  })
})
