/**
 * Description for the default swarm tool.
 */
export const DEFAULT_SWARM_DESCRIPTION =
  'Spin up a team of AI agents that solve a task together by handing off to one another. ' +
  'Each agent has its own name, system prompt, and tools (drawn from your own). ' +
  'Agents hand off through their structured response and cannot start another swarm; your other tools are ' +
  'passed through. The `entry_point` agent (default: the first in `agents`) receives the task and starts the ' +
  "work. The run ends when an agent finishes without handing off. Returns each participating agent's final " +
  'output, prefixed with its name. If the team does not complete (an agent fails, a handoff loop is detected, ' +
  'or a step or time limit is hit), the call fails with the partial output.'

/**
 * Upper bound on the number of agents a single swarm invocation may create.
 */
export const DEFAULT_SWARM_MAX_AGENTS = 20

/**
 * Default cap on total agent executions per swarm invocation.
 */
export const DEFAULT_SWARM_MAX_STEPS = 20

/**
 * Default wall-clock ceiling for a swarm invocation, in milliseconds.
 */
export const DEFAULT_SWARM_TIMEOUT = 900_000

/**
 * Default wall-clock ceiling for each agent in a swarm, in milliseconds.
 */
export const DEFAULT_SWARM_NODE_TIMEOUT = 300_000

/**
 * One agent in a {@link SwarmInput}. Only `name` is always present; the other parameters appear in the schema
 * depending on the axis policies passed to `makeSwarm`.
 */
export interface SwarmAgentInput {
  /** A unique name for this agent. */
  name: string
  /** Which preset to use; present when presets are configured. */
  agent_type?: string
  /** System prompt for the agent; present when the instructions axis is `Open` or `Choice`. */
  instructions?: string
  /** Subset of tools to grant the agent; present when the tools axis is a `Choice`. */
  tools?: string[]
  /** Model option name; present when the model axis is a `Choice`. */
  model?: string
}

/**
 * Input parameters accepted by the swarm tool.
 */
export interface SwarmInput {
  /** The objective for the agent team. */
  task: string
  /** Agent specifications. */
  agents: SwarmAgentInput[]
  /** Name of the agent that receives the task and starts the swarm. Defaults to the first agent. */
  entry_point?: string
}
