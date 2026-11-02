/**
 * Graph meta-agent tool for running a directed acyclic graph of agents at runtime.
 *
 * Provides {@link makeGraph}, a factory that lets the developer pin safety limits and authority
 * modes. The tool is a thin shim over {@link Graph}: each call resolves the model's node specs
 * through the authority-mode system, builds the agents via an {@link AgentBuilder}, runs the graph,
 * and maps the result.
 */

import type { Agent } from '../../agent/agent.js'
import type { InterruptState } from '../../interrupt.js'
import { logger } from '../../logging/logger.js'
import { AgentToolStreamer, ChildMultiAgentAdapter } from '../../multiagent/agent-tool-streamer.js'
import { NodeResultEvent } from '../../multiagent/events.js'
import { Graph } from '../../multiagent/graph.js'
import { AgentNode } from '../../multiagent/nodes.js'
import type { MultiAgentInput } from '../../multiagent/multiagent.js'
import {
  _defaultBuilder,
  _resolveSpecs,
  _toSchemaProperties,
  Open,
  type AgentBuilder,
  type AgentSpec,
  type Choice,
  type Fixed,
  type Inherit,
  type Preset,
  type ResolveSpecAxes,
} from '../../multiagent/spec.js'
import { Status, type MultiAgentResult, type MultiAgentState, type NodeResult } from '../../multiagent/state.js'
import { tool } from '../../tools/tool-factory.js'
import type { InvokableTool, Tool, ToolContext } from '../../tools/tool.js'
import type { JSONSchema, JSONValue } from '../../types/json.js'
import {
  DEFAULT_GRAPH_DESCRIPTION,
  DEFAULT_GRAPH_MAX_EDGES,
  DEFAULT_GRAPH_MAX_NODES,
  DEFAULT_GRAPH_NODE_TIMEOUT,
  DEFAULT_GRAPH_TIMEOUT,
} from './types.js'
import type { GraphInput } from './types.js'

/** Every graph tool created, so children lose all of them regardless of name or instance. */
const GRAPH_TOOLS = new WeakSet<Tool>()

const GRAPH_ADAPTER = new ChildMultiAgentAdapter({
  label: 'Graph',
  render: (result): string => renderOutput(result.results),
})

const UNAVAILABLE_MESSAGE =
  'Graph did NOT run and the response was NOT applied: its interrupted turn is not available. ' +
  'Do not report the task as completed; if it is still needed, start the graph again.'

/** Options for {@link makeGraph}. */
export interface MakeGraphOptions {
  /**
   * Turns a resolved spec into an agent. Defaults to a builder that inherits from the parent. Called again with
   * the same spec when an interrupted graph resumes.
   */
  builder?: AgentBuilder
  /** Named roles the model selects via `agent_type`. @defaultValue `{}` */
  presets?: Record<string, Preset>
  /** Preset used when the model omits both `agent_type` and `instructions`. Defaults to the first preset. */
  defaultPreset?: string
  /** Policy for each node's system prompt. @defaultValue `new Open()` */
  instructions?: Open | Choice | Fixed
  /** Policy for each node's tools. A `Choice` must be `multiple`. @defaultValue `new Inherit()` */
  tools?: Choice | Fixed | Inherit
  /** Policy for each node's model. @defaultValue `new Inherit()` */
  model?: Inherit | Choice | Fixed
  /** Upper bound on nodes per call. Must be at least 2. @defaultValue {@link DEFAULT_GRAPH_MAX_NODES} */
  maxNodes?: number
  /** Upper bound on edges per call. Must be a positive integer. @defaultValue {@link DEFAULT_GRAPH_MAX_EDGES} */
  maxEdges?: number
  /** Max total node executions. @defaultValue `Infinity` (no limit) */
  maxSteps?: number
  /** Wall-clock ceiling for the whole graph, in milliseconds. @defaultValue {@link DEFAULT_GRAPH_TIMEOUT} */
  timeout?: number
  /** Per-node wall-clock ceiling, in milliseconds. @defaultValue {@link DEFAULT_GRAPH_NODE_TIMEOUT} */
  nodeTimeout?: number
  /** Tool name exposed to the model. @defaultValue `'graph'` */
  name?: string
  /** Tool description shown to the model. @defaultValue {@link DEFAULT_GRAPH_DESCRIPTION} */
  description?: string
}

/**
 * Creates a `graph` tool whose schema is derived from the axis policies and presets.
 *
 * The model defines the nodes and edges it needs at runtime. Nodes never receive a graph tool, so
 * graphs do not nest. A node's interrupt is raised on the parent and can be resumed after the
 * parent is restored from a snapshot.
 *
 * @param options - Configuration options.
 * @returns A tool that builds and runs a {@link Graph}. Invalid input, or a graph that does not complete,
 * produces an error result.
 * @throws Error if `maxNodes` is not an integer of at least 2, `maxEdges` is not a positive integer, `maxSteps` is not a
 * positive integer or `Infinity`, a timeout is not a positive number, `name` or `description` is empty,
 * `defaultPreset` is not one of the presets, or a `Choice` axis violates its constraints (no options, or not
 * `multiple` for tools).
 *
 * @example
 * ```typescript
 * const team = makeGraph({
 *   presets: { writer: new Preset({ instructions: 'Turn upstream findings into prose.', description: 'writes' }) },
 *   maxNodes: 6,
 *   timeout: 600_000,
 * })
 * const agent = new Agent({ tools: [team] })
 * ```
 */
export function makeGraph({
  builder,
  presets = {},
  defaultPreset = Object.keys(presets)[0],
  instructions = new Open(),
  tools,
  model,
  maxNodes = DEFAULT_GRAPH_MAX_NODES,
  maxEdges = DEFAULT_GRAPH_MAX_EDGES,
  maxSteps = Infinity,
  timeout = DEFAULT_GRAPH_TIMEOUT,
  nodeTimeout = DEFAULT_GRAPH_NODE_TIMEOUT,
  name = 'graph',
  description = DEFAULT_GRAPH_DESCRIPTION,
}: MakeGraphOptions = {}): InvokableTool<GraphInput, JSONValue> {
  if (!name) {
    throw new Error('name must be a non-empty string.')
  }
  if (!description) {
    throw new Error('description must be a non-empty string.')
  }
  validateLimits({ maxNodes, maxEdges, maxSteps, timeout, nodeTimeout })
  if (defaultPreset !== undefined && !Object.hasOwn(presets, defaultPreset)) {
    throw new Error(`defaultPreset '${defaultPreset}' is not one of the presets: ${Object.keys(presets).join(', ')}.`)
  }

  const axes: ResolveSpecAxes = { presets, defaultPreset, instructions, tools, model }

  const graphTool = tool({
    name,
    description,
    inputSchema: buildSchema({ ...axes, maxNodes, maxEdges }),
    callback: async function* (input, toolContext) {
      const toolUseId = toolContext.toolUse.toolUseId
      const streamer = new AgentToolStreamer<MultiAgentResult>({
        interruptState: (toolContext.agent as unknown as { _interruptState?: InterruptState })._interruptState,
        toolUseId,
        namespace: 'graph',
        raiseUnfinished: true,
      })
      const { task, specs, edges } = resolveGraph(input, { axes, maxNodes, maxEdges })
      const build = builder ?? _defaultBuilder(toolContext.agent as unknown as Agent)
      const agents: Agent[] = []
      try {
        for (const spec of specs) {
          const agent = build(spec)
          // Strip every graph tool so graphs do not nest.
          for (const agentTool of agent.toolRegistry.list()) {
            if (GRAPH_TOOLS.has(agentTool)) agent.toolRegistry.remove(agentTool.name)
          }
          agents.push(agent)
        }
      } catch (error) {
        if (!streamer.isResuming()) throw error
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`tool_use_id=<${toolUseId}>, error=<${message}> | failed to rebuild interrupted graph`)
        // Always throws: a missing child leaves the streamer unfinished.
        await streamer.resume(GRAPH_ADAPTER, undefined, UNAVAILABLE_MESSAGE)
        throw error
      }

      // Stable ids let the stored turn be loaded into the graph rebuilt on resume.
      const graph = new Graph({
        id: `graph:${encodeURIComponent(toolUseId)}`,
        // Keyed by the model's node name, since an AgentNode otherwise takes its agent's id.
        nodes: agents.map((agent, index) => Object.assign(new AgentNode({ agent }), { id: specs[index]!.name! })),
        edges,
        maxSteps,
        timeout,
        nodeTimeout,
      })
      const resumed = await streamer.resume(GRAPH_ADAPTER, graph, UNAVAILABLE_MESSAGE)
      const graphInput: MultiAgentInput = resumed ?? task
      logger.debug(`task=<${task.slice(0, 120)}>, nodes=<${agents.length}>, edges=<${edges.length}> | starting graph`)
      return yield* streamGraph(streamer, graph, graphInput, toolContext)
    },
  })
  GRAPH_TOOLS.add(graphTool)
  return graphTool
}

/**
 * Streams the graph through the tool lifecycle.
 *
 * @returns Every completed node's output.
 * @throws InterruptError or Error if the graph does not complete, with the partial output when a limit stops it.
 */
async function* streamGraph(
  streamer: AgentToolStreamer<MultiAgentResult>,
  graph: Graph,
  graphInput: MultiAgentInput,
  toolContext: ToolContext
): AsyncGenerator<JSONValue, string, undefined> {
  // Step and time limits throw, so node results are collected as they stream to keep the partial output,
  // starting from those a resumed graph restored, which it does not stream again.
  const restored = (graph as unknown as { _pendingInterruptState?: MultiAgentState })._pendingInterruptState
  const nodeResults = (restored?.results ?? []).filter((nodeResult) => nodeResult.status === Status.COMPLETED)
  const { invocationState, cancelSignal, invocationContext } = toolContext
  const gen = graph.stream(graphInput, {
    invocationState: { ...invocationState },
    cancelSignal,
    ...(invocationContext && { invocationContext }),
  })
  try {
    for await (const event of streamer.stream(GRAPH_ADAPTER, graph, gen)) {
      if (event instanceof NodeResultEvent) nodeResults.push(event.result)
      yield event as unknown as JSONValue
    }
  } catch (error) {
    // The streamer's own interrupt or error is already model-facing.
    if (streamer.interrupts !== undefined || streamer.error !== undefined) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Graph stopped before completing (${message}). Partial output:\n${renderOutput(nodeResults)}`, {
      cause: error,
    })
  }
  return renderOutput(streamer.result!.results)
}

/**
 * Validates the developer-supplied graph limits.
 *
 * @throws Error if a count limit is not a positive integer, a timeout is not a positive number, or `maxNodes` is below 2.
 */
function validateLimits(limits: {
  maxNodes: number
  maxEdges: number
  maxSteps: number
  timeout: number
  nodeTimeout: number
}): void {
  const { maxNodes, maxEdges, maxSteps, timeout, nodeTimeout } = limits
  if (!Number.isInteger(maxNodes) || maxNodes < 2) {
    throw new Error('maxNodes must be an integer >= 2.')
  }
  if (!Number.isInteger(maxEdges) || maxEdges < 1) {
    throw new Error('maxEdges must be a positive integer (>= 1).')
  }
  if (maxSteps !== Infinity && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    throw new Error('maxSteps must be a positive integer (>= 1) or Infinity.')
  }
  for (const [limitName, value] of [
    ['timeout', timeout],
    ['nodeTimeout', nodeTimeout],
  ] as const) {
    if (Number.isNaN(value) || value <= 0) {
      throw new Error(`${limitName} must be a positive number.`)
    }
  }
}

/**
 * Derives the tool's input schema from the axis policies; hidden axes produce no node property.
 *
 * @param axes - Presets, axis policies, and the node and edge caps.
 * @returns The JSON schema for the tool input.
 */
function buildSchema(axes: ResolveSpecAxes & { maxNodes: number; maxEdges: number }): JSONSchema {
  const { maxNodes, maxEdges, ...schemaAxes } = axes
  // Without a preset to fall back on, an Open prompt must come from the model.
  const required =
    axes.instructions instanceof Open && Object.keys(axes.presets).length === 0 ? ['name', 'instructions'] : ['name']
  return {
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
            ..._toSchemaProperties(schemaAxes),
          },
          required,
          additionalProperties: false,
        },
        minItems: 2,
        maxItems: maxNodes,
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
        maxItems: maxEdges,
      },
    },
  } as JSONSchema
}

/**
 * Resolves and validates the model's input.
 *
 * @returns The task, the node specs, and the validated edges as `[from, to]` node names.
 * @throws Error if the task is missing, or the node specs or edges are invalid.
 */
function resolveGraph(
  input: unknown,
  config: { axes: ResolveSpecAxes; maxNodes: number; maxEdges: number }
): { task: string; specs: AgentSpec[]; edges: [string, string][] } {
  const raw = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<
    string,
    unknown
  >
  const task = raw['task']
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error("Missing required parameter 'task': describe the objective for the graph.")
  }
  const specs = _resolveSpecs(raw['nodes'], config.axes, 'node')
  if (specs.length < 2 || specs.length > config.maxNodes) {
    throw new Error(`Between 2 and ${config.maxNodes} nodes required, got ${specs.length}.`)
  }
  const edges = validateEdges(
    raw['edges'],
    specs.map((spec) => spec.name!),
    config.maxEdges
  )
  return { task, specs, edges }
}

/**
 * Validates the model's edges against the declared node names.
 *
 * @returns The edges as trimmed `[from, to]` node names, with repeats removed.
 * @throws Error on bad types, unknown node references, self-loops, or cycles.
 */
function validateEdges(edges: unknown, nodeNames: string[], maxEdges: number): [string, string][] {
  if (!Array.isArray(edges)) {
    throw new Error('edges must be an array')
  }
  if (edges.length > maxEdges) {
    throw new Error(`At most ${maxEdges} edges allowed, got ${edges.length}.`)
  }
  const known = new Set(nodeNames)
  const validated = new Map<string, [string, string]>()
  for (const [index, edge] of (edges as unknown[]).entries()) {
    if (edge === null || typeof edge !== 'object' || Array.isArray(edge)) {
      throw new Error(`Edge at index ${index} must be an object`)
    }
    const { from_node: rawFrom, to_node: rawTo } = edge as Record<string, unknown>
    if (typeof rawFrom !== 'string' || typeof rawTo !== 'string') {
      throw new Error(`Edge at index ${index}: from_node and to_node must be strings`)
    }
    const from = rawFrom.trim()
    const to = rawTo.trim()
    const unknown = [from, to].find((end) => !known.has(end))
    if (unknown !== undefined) {
      throw new Error(`Edge at index ${index}: ${JSON.stringify(unknown)} is not a declared node`)
    }
    if (from === to) {
      throw new Error(`Edge at index ${index}: self-loop on ${JSON.stringify(from)}`)
    }
    // Keyed so a repeated edge, which would schedule its target twice, is kept once.
    validated.set(JSON.stringify([from, to]), [from, to])
  }
  const unique = [...validated.values()]
  // Edges are unconditional, so a cycle would re-run until a limit is hit.
  const cycle = findCycle(nodeNames, unique)
  if (cycle) {
    throw new Error(`Edges form a cycle: ${cycle.join(' -> ')}`)
  }
  return unique
}

/**
 * Finds one cycle in the graph.
 *
 * @returns The cycle as a closed path of node names, or `undefined` if the graph is acyclic.
 */
function findCycle(nodeNames: string[], edges: [string, string][]): string[] | undefined {
  const successors = new Map(nodeNames.map((name): [string, string[]] => [name, []]))
  for (const [from, to] of edges) successors.get(from)!.push(to)

  const visiting: string[] = []
  const done = new Set<string>()
  const visit = (node: string): string[] | undefined => {
    if (visiting.includes(node)) return [...visiting.slice(visiting.indexOf(node)), node]
    if (done.has(node)) return undefined
    visiting.push(node)
    for (const next of successors.get(node)!) {
      const found = visit(next)
      if (found) return found
    }
    visiting.pop()
    done.add(node)
    return undefined
  }

  for (const name of nodeNames) {
    const found = visit(name)
    if (found) return found
  }
  return undefined
}

/**
 * Renders each completed node's output and each failed node's error, prefixed with its node name.
 *
 * @param results - The graph's node results, in execution order.
 * @returns One `name: output` or `name: failed: error` line per completed or failed node.
 */
function renderOutput(results: NodeResult[]): string {
  return results
    .filter((nodeResult) => nodeResult.status === Status.COMPLETED || nodeResult.status === Status.FAILED)
    .map((nodeResult) => ({
      nodeId: nodeResult.nodeId,
      text:
        nodeResult.status === Status.FAILED
          ? `failed: ${nodeResult.error?.message ?? 'unknown error'}`
          : nodeResult.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join(''),
    }))
    .filter(({ text }) => text)
    .map(({ nodeId, text }) => `${nodeId}: ${text}`)
    .join('\n')
}

/**
 * Default graph tool with no presets and all axes using their defaults.
 */
export const graph = makeGraph()
