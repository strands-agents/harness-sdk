/**
 * Swarm meta-agent tool for spinning up a handoff-based team of agents at runtime.
 *
 * Provides {@link makeSwarm}, a factory that lets the developer pin safety limits and authority
 * modes. The tool is a thin shim over {@link Swarm}: each call resolves the model's agent specs
 * through the authority-mode system, builds the agents via an {@link AgentBuilder}, runs the swarm,
 * and maps the result.
 */

import type { Agent } from '../../agent/agent.js'
import { InterruptError, type InterruptState } from '../../interrupt.js'
import { logger } from '../../logging/logger.js'
import { AgentToolStreamer, ChildMultiAgentAdapter } from '../../multiagent/agent-tool-streamer.js'
import {
  _defaultBuilder,
  _resolveSpecs,
  _toSchemaProperties,
  Inherit,
  Open,
  type AgentBuilder,
  type AgentSpec,
  type Choice,
  type Fixed,
  type Preset,
  type ResolveSpecAxes,
} from '../../multiagent/spec.js'
import { NodeResultEvent } from '../../multiagent/events.js'
import type { MultiAgentInput } from '../../multiagent/multiagent.js'
import type { MultiAgentResult, NodeResult } from '../../multiagent/state.js'
import { Swarm, type SwarmConfig } from '../../multiagent/swarm.js'
import { tool } from '../../tools/tool-factory.js'
import type { InvokableTool, Tool } from '../../tools/tool.js'
import type { JSONSchema, JSONValue } from '../../types/json.js'
import {
  DEFAULT_SWARM_DESCRIPTION,
  DEFAULT_SWARM_MAX_AGENTS,
  DEFAULT_SWARM_MAX_STEPS,
  DEFAULT_SWARM_NODE_TIMEOUT,
  DEFAULT_SWARM_TIMEOUT,
} from './types.js'
import type { SwarmInput } from './types.js'

/** Every swarm tool created, so children lose all of them regardless of name or instance. */
const SWARM_TOOLS = new WeakSet<Tool>()

const SWARM_ADAPTER = new ChildMultiAgentAdapter({
  label: 'Swarm',
  render: (result): string => renderOutput(result.results),
})

const UNAVAILABLE_MESSAGE =
  'Swarm did NOT run and the response was NOT applied: its interrupted turn is not available. ' +
  'Do not report the task as completed; if it is still needed, start the swarm again.'

/** Options for {@link makeSwarm}. Unset repetitive-handoff limits fall back to the {@link Swarm} defaults. */
export interface MakeSwarmOptions extends SwarmConfig {
  /**
   * Turns a resolved spec into an agent. Defaults to a builder that inherits from the parent. Called again with
   * the same spec when an interrupted swarm resumes, so it must give each spec the same agent id.
   */
  builder?: AgentBuilder
  /** Named roles the model selects via `agent_type`. @defaultValue `{}` */
  presets?: Record<string, Preset>
  /** Preset used when the model omits `agent_type`. Defaults to the first preset. */
  defaultPreset?: string
  /** Policy for each agent's system prompt. @defaultValue `new Open()` */
  instructions?: Open | Choice | Fixed
  /** Policy for each agent's tools. A `Choice` must be `multiple`. @defaultValue `new Inherit()` */
  tools?: Choice | Fixed | Inherit
  /** Policy for each agent's model. @defaultValue `new Inherit()` */
  model?: Inherit | Choice | Fixed
  /** Upper bound on agents per call. Must be a positive integer. @defaultValue {@link DEFAULT_SWARM_MAX_AGENTS} */
  maxAgents?: number
  /** Max total agent executions. Pass `Infinity` for no limit. @defaultValue {@link DEFAULT_SWARM_MAX_STEPS} */
  maxSteps?: number
  /** Wall-clock ceiling for the whole swarm, in milliseconds. @defaultValue {@link DEFAULT_SWARM_TIMEOUT} */
  timeout?: number
  /** Per-agent wall-clock ceiling, in milliseconds. @defaultValue {@link DEFAULT_SWARM_NODE_TIMEOUT} */
  nodeTimeout?: number
  /** Tool name exposed to the model. @defaultValue `'swarm'` */
  name?: string
  /** Tool description shown to the model. @defaultValue {@link DEFAULT_SWARM_DESCRIPTION} */
  description?: string
}

/**
 * Creates a `swarm` tool whose schema is derived from the axis policies and presets.
 *
 * The model defines the agents it needs at runtime. Agents never receive a swarm tool, so
 * swarms do not nest. An agent's interrupt is raised on the parent and can be resumed after the
 * parent is restored from a snapshot.
 *
 * @param options - Configuration options.
 * @returns A tool that spins up and runs a {@link Swarm}. Invalid input, or a swarm that does not complete,
 * produces an error result.
 * @throws Error if `maxAgents` is not a positive integer, `name` or `description` is empty, `defaultPreset`
 * is not one of the presets, or a `Choice` axis violates its constraints (no options, or not `multiple` for
 * tools).
 *
 * @example
 * ```typescript
 * const team = makeSwarm({
 *   presets: { writer: new Preset({ instructions: 'You write clear prose.', description: 'writes' }) },
 *   maxAgents: 5,
 *   maxSteps: 10,
 * })
 * const agent = new Agent({ tools: [team] })
 * ```
 */
export function makeSwarm({
  builder,
  presets = {},
  defaultPreset = Object.keys(presets)[0],
  instructions = new Open(),
  tools,
  model,
  maxAgents = DEFAULT_SWARM_MAX_AGENTS,
  maxSteps = DEFAULT_SWARM_MAX_STEPS,
  timeout = DEFAULT_SWARM_TIMEOUT,
  nodeTimeout = DEFAULT_SWARM_NODE_TIMEOUT,
  name = 'swarm',
  description = DEFAULT_SWARM_DESCRIPTION,
  ...handoffLimits
}: MakeSwarmOptions = {}): InvokableTool<SwarmInput, JSONValue> {
  if (!name) {
    throw new Error('name must be a non-empty string.')
  }
  if (!description) {
    throw new Error('description must be a non-empty string.')
  }
  if (!Number.isInteger(maxAgents) || maxAgents < 1) {
    throw new Error('maxAgents must be a positive integer (>= 1).')
  }
  if (defaultPreset !== undefined && !Object.hasOwn(presets, defaultPreset)) {
    throw new Error(`defaultPreset '${defaultPreset}' is not one of the presets: ${Object.keys(presets).join(', ')}.`)
  }

  const axes: ResolveSpecAxes = { presets, defaultPreset, instructions, tools, model }
  const limits: SwarmConfig = { maxSteps, timeout, nodeTimeout, ...handoffLimits }

  const swarmTool = tool({
    name,
    description,
    inputSchema: buildSchema({ ...axes, maxAgents }),
    callback: async function* (input, toolContext) {
      const toolUseId = toolContext.toolUse.toolUseId
      const streamer = new AgentToolStreamer<MultiAgentResult>({
        interruptState: (toolContext.agent as unknown as { _interruptState?: InterruptState })._interruptState,
        toolUseId,
        namespace: 'swarm',
      })
      const { task, specs, entryIndex } = resolveSwarm(input, { axes, maxAgents })
      const build = builder ?? _defaultBuilder(toolContext.agent as unknown as Agent)
      let agents: Agent[]
      try {
        agents = buildAgents(specs, build)
      } catch (error) {
        if (!streamer.isResuming()) throw error
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`tool_use_id=<${toolUseId}>, error=<${message}> | failed to rebuild interrupted swarm`)
        await streamer.resume(SWARM_ADAPTER, undefined, UNAVAILABLE_MESSAGE)
        return raiseUnfinished(streamer)
      }

      // A stable id lets the stored turn be loaded into the swarm rebuilt on resume.
      const swarm = new Swarm({
        id: `swarm:${encodeURIComponent(toolUseId)}`,
        nodes: agents,
        start: agents[entryIndex]!.id,
        ...limits,
      })
      let swarmInput: MultiAgentInput = task
      if (streamer.isResuming()) {
        const resumed = await streamer.resume(SWARM_ADAPTER, swarm, UNAVAILABLE_MESSAGE)
        if (resumed === undefined) return raiseUnfinished(streamer)
        swarmInput = resumed
      }
      logger.debug(`task=<${task.slice(0, 120)}>, agents=<${agents.length}> | starting swarm`)
      // Step and time limits throw, so node results are collected as they stream to keep the partial output.
      const nodeResults: NodeResult[] = []
      const { invocationState, cancelSignal, invocationContext } = toolContext
      const gen = swarm.stream(swarmInput, {
        invocationState: { ...invocationState },
        cancelSignal,
        ...(invocationContext && { invocationContext }),
      })
      try {
        for await (const event of streamer.stream(SWARM_ADAPTER, swarm, gen)) {
          if (event instanceof NodeResultEvent) nodeResults.push(event.result)
          yield event as unknown as JSONValue
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Swarm stopped before completing (${message}). Partial output:\n${renderOutput(nodeResults)}`, {
          cause: error,
        })
      }

      if (streamer.interrupts !== undefined || streamer.error !== undefined) {
        raiseUnfinished(streamer)
      }
      return renderOutput(streamer.result!.results)
    },
  })
  SWARM_TOOLS.add(swarmTool)
  return swarmTool
}

/**
 * Derives the tool's input schema from the axis policies; hidden axes produce no agent property.
 *
 * @param axes - Presets, axis policies, and the agent cap.
 * @returns The JSON schema for the tool input.
 */
function buildSchema(axes: ResolveSpecAxes & { maxAgents: number }): JSONSchema {
  const { maxAgents, ...schemaAxes } = axes
  // Without a preset to fall back on, an Open prompt must come from the model.
  const required =
    axes.instructions instanceof Open && Object.keys(axes.presets).length === 0 ? ['name', 'instructions'] : ['name']
  return {
    type: 'object',
    required: ['task', 'agents'],
    properties: {
      task: { type: 'string', description: 'The objective for the agent team.' },
      entry_point: {
        type: 'string',
        description: 'Name of the agent that receives the task and starts the swarm. Defaults to the first agent.',
      },
      agents: {
        type: 'array',
        description: 'Agent specifications.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A unique name for this agent.' },
            ..._toSchemaProperties(schemaAxes),
          },
          required,
          additionalProperties: false,
        },
        minItems: 1,
        maxItems: maxAgents,
      },
    },
  } as JSONSchema
}

/**
 * Resolves and validates the model's input.
 *
 * @returns The task, the agent specs, and the index of the entry-point agent.
 * @throws Error if the task is missing or the agent specs are invalid.
 */
function resolveSwarm(
  input: unknown,
  config: { axes: ResolveSpecAxes; maxAgents: number }
): { task: string; specs: AgentSpec[]; entryIndex: number } {
  const raw = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<
    string,
    unknown
  >
  const task = raw['task']
  if (typeof task !== 'string' || !task.trim()) {
    throw new Error("Missing required parameter 'task': describe the objective for the agent team.")
  }
  const specs = _resolveSpecs(raw['agents'], config.axes)
  if (specs.length < 1 || specs.length > config.maxAgents) {
    throw new Error(`Between 1 and ${config.maxAgents} agents required, got ${specs.length}.`)
  }
  const entryPoint = raw['entry_point']
  const entryIndex = entryPoint == null ? 0 : specs.findIndex((spec) => spec.name === entryPoint)
  if (entryIndex === -1) {
    throw new Error(`entry_point ${JSON.stringify(entryPoint)} does not match any agent name.`)
  }
  return { task, specs, entryIndex }
}

/**
 * Builds the swarm's agents, stripping every swarm tool so swarms do not nest.
 *
 * @returns One agent per spec.
 * @throws Error if the builder fails.
 */
function buildAgents(specs: AgentSpec[], builder: AgentBuilder): Agent[] {
  return specs.map((spec) => {
    const agent = builder(spec)
    for (const agentTool of agent.toolRegistry.list()) {
      if (SWARM_TOOLS.has(agentTool)) {
        agent.toolRegistry.remove(agentTool.name)
      }
    }
    return agent
  })
}

/**
 * Raises the streamer's unfinished terminal state.
 *
 * @throws InterruptError if the swarm stopped on interrupts.
 * @throws Error with the streamer's error message otherwise.
 */
function raiseUnfinished(streamer: AgentToolStreamer<MultiAgentResult>): never {
  if (streamer.interrupts?.length) {
    throw new InterruptError(streamer.interrupts)
  }
  throw new Error(streamer.error)
}

/**
 * Renders each participating agent's latest output, prefixed with its name.
 *
 * @param results - The swarm's node results, in execution order.
 * @returns One `name: output` line per agent, in first-run order.
 */
function renderOutput(results: NodeResult[]): string {
  const outputs = new Map<string, string>()
  for (const nodeResult of results) {
    const handoffMessage = (nodeResult.structuredOutput as { message?: unknown } | undefined)?.message
    const text =
      typeof handoffMessage === 'string' && handoffMessage
        ? handoffMessage
        : nodeResult.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('')
    outputs.set(nodeResult.nodeId, text)
  }
  return [...outputs]
    .filter(([, text]) => text)
    .map(([nodeId, text]) => `${nodeId}: ${text}`)
    .join('\n')
}

/**
 * Default swarm tool with no presets and all axes using their defaults.
 */
export const swarm = makeSwarm()
