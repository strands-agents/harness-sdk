/**
 * Swarm meta-agent tool for spinning up a handoff-based team of agents at runtime.
 *
 * Provides {@link makeSwarm}, a factory that lets the developer pin safety limits and authority
 * modes. The tool is a thin shim over {@link Swarm}: each call resolves the model's agent specs
 * through the authority-mode system, builds the agents via an {@link AgentBuilder}, runs the swarm,
 * and maps the result.
 */

import type { Agent } from '../../agent/agent.js'
import type { Interrupt } from '../../interrupt.js'
import { logger } from '../../logging/logger.js'
import {
  _defaultBuilder,
  _resolveSpecs,
  _toSchemaProperties,
  Inherit,
  Open,
  type AgentBuilder,
  type Choice,
  type Fixed,
  type Preset,
  type ResolveSpecAxes,
} from '../../multiagent/spec.js'
import { NodeResultEvent } from '../../multiagent/events.js'
import type { MultiAgentInput } from '../../multiagent/multiagent.js'
import { Status, type MultiAgentResult, type NodeResult } from '../../multiagent/state.js'
import { Swarm, type SwarmConfig } from '../../multiagent/swarm.js'
import { tool } from '../../tools/tool-factory.js'
import type { InvokableTool, Tool, ToolContext } from '../../tools/tool.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { JSONSchema, JSONValue } from '../../types/json.js'
import {
  DEFAULT_SWARM_DESCRIPTION,
  DEFAULT_SWARM_MAX_AGENTS,
  DEFAULT_SWARM_MAX_STEPS,
  DEFAULT_SWARM_NODE_TIMEOUT,
  DEFAULT_SWARM_TIMEOUT,
} from './types.js'
import type { SwarmInput } from './types.js'

/** Interrupted swarms awaiting a resume, keyed by the tool-use id that started them. */
type PendingSwarms = Map<string, { swarm: Swarm; interrupts: Interrupt[] }>

/** Every swarm tool created, so children lose all of them regardless of name or instance. */
const SWARM_TOOLS = new WeakSet<Tool>()

/** Options for {@link makeSwarm}. Unset repetitive-handoff limits fall back to the {@link Swarm} defaults. */
export interface MakeSwarmOptions extends SwarmConfig {
  /** Turns a resolved spec into an agent. Defaults to a builder that inherits from the parent. */
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
 * swarms do not nest. An agent's interrupt is raised on the parent; the interrupted swarm is
 * held in memory until resumed, so it cannot be resumed after a process restart.
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
  const pending: PendingSwarms = new Map()

  const swarmTool = tool({
    name,
    description,
    inputSchema: buildSchema({ ...axes, maxAgents }),
    callback: async function* (input, toolContext) {
      const interrupted = pending.get(toolContext.toolUse.toolUseId)
      let swarm: Swarm
      let swarmInput: MultiAgentInput
      if (interrupted) {
        swarm = interrupted.swarm
        swarmInput = interrupted.interrupts.map(
          (interrupt) =>
            new InterruptResponseContent({
              interruptId: interrupt.id,
              response: interruptParent(toolContext, interrupt),
            })
        )
      } else {
        const build = builder ?? _defaultBuilder(toolContext.agent as unknown as Agent)
        ;({ swarm, swarmInput } = buildSwarm(input, { axes, builder: build, maxAgents, limits }))
      }
      return yield* streamSwarm(swarm, swarmInput, toolContext, pending)
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
 * Builds a fresh swarm from the model's input.
 *
 * @returns The swarm and the task to run it on.
 * @throws Error if the task is missing, the agent specs are invalid, or the swarm cannot be constructed.
 */
function buildSwarm(
  input: unknown,
  config: { axes: ResolveSpecAxes; builder: AgentBuilder; maxAgents: number; limits: SwarmConfig }
): { swarm: Swarm; swarmInput: MultiAgentInput } {
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

  const agents = specs.map((spec) => {
    const agent = config.builder(spec)
    for (const agentTool of agent.toolRegistry.list()) {
      if (SWARM_TOOLS.has(agentTool)) {
        agent.toolRegistry.remove(agentTool.name)
      }
    }
    return agent
  })

  const swarm = new Swarm({ nodes: agents, start: agents[entryIndex]!.id, ...config.limits })
  logger.debug(`task=<${task.slice(0, 120)}>, agents=<${agents.length}> | starting swarm`)
  return { swarm, swarmInput: task }
}

/**
 * Streams the swarm's events and returns its output as the tool result.
 *
 * An interrupted swarm is held in `pending` under the tool-use id and its first interrupt is raised.
 *
 * @returns One `name: output` line per participating agent.
 * @throws InterruptError if the swarm is interrupted.
 * @throws Error with the partial output if the swarm does not complete.
 */
async function* streamSwarm(
  swarm: Swarm,
  swarmInput: MultiAgentInput,
  toolContext: ToolContext,
  pending: PendingSwarms
): AsyncGenerator<JSONValue, string> {
  const { toolUse, invocationState, cancelSignal, invocationContext } = toolContext
  // Step and time limits throw, so node results are collected as they stream to keep the partial output.
  const nodeResults: NodeResult[] = []
  const gen = swarm.stream(swarmInput, {
    invocationState: { ...invocationState },
    cancelSignal,
    ...(invocationContext && { invocationContext }),
  })
  let next
  try {
    next = await gen.next()
    while (!next.done) {
      if (next.value instanceof NodeResultEvent) nodeResults.push(next.value.result)
      yield next.value as unknown as JSONValue
      next = await gen.next()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Swarm stopped before completing (${message}). Partial output:\n${renderOutput(nodeResults)}`, {
      cause: error,
    })
  } finally {
    pending.delete(toolUse.toolUseId)
  }

  const result = next.value
  if (result.status === Status.INTERRUPTED && result.interrupts?.length) {
    pending.set(toolUse.toolUseId, { swarm, interrupts: result.interrupts })
    interruptParent(toolContext, result.interrupts[0]!)
  }
  const output = renderOutput(result.results)
  if (result.status !== Status.COMPLETED) {
    throw new Error(
      `Swarm stopped before completing (status=${result.status}${failureReason(result)}). Partial output:\n${output}`
    )
  }
  return output
}

/**
 * Raises an agent's interrupt on the parent, or returns the parent's answer when resuming.
 *
 * Raising for the first unanswered interrupt surfaces them to the user one per resume.
 *
 * @returns The parent's response to the interrupt.
 * @throws InterruptError if the parent has not answered it yet.
 */
function interruptParent(toolContext: ToolContext, interrupt: Interrupt): JSONValue {
  return toolContext.interrupt({
    name: interrupt.id,
    reason: { name: interrupt.name, ...(interrupt.reason !== undefined && { reason: interrupt.reason }) },
  })
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
 * The swarm's own error or, failing that, the first failed node's (such as a limit stop), as a message suffix.
 *
 * @param result - The swarm's result.
 * @returns `: <message>`, or an empty string when there is no error to report.
 */
function failureReason(result: MultiAgentResult): string {
  const error = result.error ?? result.results.find((nodeResult) => nodeResult.status === Status.FAILED)?.error
  return error ? `: ${error.message}` : ''
}

/**
 * Default swarm tool with no presets and all axes using their defaults.
 */
export const swarm = makeSwarm()
