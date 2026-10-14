import { Preset } from '../../multiagent/spec.js'

/**
 * Description for the default subagent tool.
 */
export const DEFAULT_SUBAGENT_DESCRIPTION =
  'Delegate a self-contained task to a subagent that runs in its own context and returns a ' +
  'final report. Reach for this when a subtask would otherwise flood your context with ' +
  'intermediate work and you only need its conclusion.'

/**
 * Upper bound on the number of nested delegation levels.
 */
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2

/**
 * Built-in generalist preset.
 */
export const GENERALIST = new Preset({
  instructions:
    'You are a general-purpose subagent handling a focused subtask on behalf of a parent ' +
    'agent. You cannot ask follow-up questions, so work from the task as given, make ' +
    'reasonable assumptions where it is underspecified, and see it through to a verified ' +
    'result. Return a self-contained answer: state what you did, what you found, and ' +
    'anything the parent needs to act on. Your final message is the only thing that returns ' +
    'to the parent, so put the substance there rather than in intermediate steps.',
  description: 'a general-purpose agent for a focused subtask that runs in its own context',
})

/**
 * Input parameters accepted by the subagent tool. Only `task` is always present; the other
 * parameters appear in the schema depending on the axis policies passed to `makeSubagent`.
 */
export interface SubagentInput {
  /** The self-contained task, including all context the subagent needs. */
  task: string
  /** Which preset to use; present when presets are configured. */
  agent_type?: string
  /** System prompt for the child; present when the instructions axis is `Open` or `Choice`. */
  instructions?: string
  /** Subset of tools to grant the child; present when the tools axis is a `Choice`. */
  tools?: string[]
  /** Subset of MCP servers to grant the child; present when the mcpServers axis is a `Choice`. */
  mcp_servers?: string[]
  /** Model option name; present when the model axis is a `Choice`. */
  model?: string
  /** Context option name; present when the context axis is a `Choice`. */
  context?: string
  /** Limit the shared context to the last N messages; present when context can be shared. */
  last_messages?: number
}
