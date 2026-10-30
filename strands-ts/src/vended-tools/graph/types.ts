/**
 * Description for the default graph tool.
 */
export const DEFAULT_GRAPH_DESCRIPTION =
  'Run a team of AI agents as a directed acyclic graph to solve a task. ' +
  'Each node is an agent with its own name, system prompt, and tools (drawn from your own). ' +
  'Each edge `{from_node, to_node}` makes `to_node` run after `from_node` finishes; ' +
  'a node receives the task plus the outputs of its finished upstream nodes. ' +
  'Nodes with no incoming edges are entry points that receive the task directly, and ' +
  'nodes that become ready together run in parallel. Cycles are not allowed. ' +
  "Returns each node's final output, prefixed with its name. If the graph does not " +
  'complete (a node fails, or a node-execution or time limit is hit), the call fails ' +
  'with the partial output.'

/**
 * Upper bound on the number of nodes a single graph invocation may create.
 */
export const DEFAULT_GRAPH_MAX_NODES = 20

/**
 * Upper bound on the number of edges a single graph invocation may declare.
 */
export const DEFAULT_GRAPH_MAX_EDGES = 50

/**
 * Default wall-clock ceiling for a graph invocation, in milliseconds.
 */
export const DEFAULT_GRAPH_TIMEOUT = 900_000

/**
 * Default wall-clock ceiling for each node in a graph, in milliseconds.
 */
export const DEFAULT_GRAPH_NODE_TIMEOUT = 300_000

/**
 * One node in a {@link GraphInput}. Only `name` is always present; the other parameters appear in the schema
 * depending on the axis policies passed to `makeGraph`.
 */
export interface GraphNodeInput {
  /** A unique name for this node, referenced by edges. */
  name: string
  /** Which preset to use; present when presets are configured. */
  agent_type?: string
  /** System prompt for the node's agent; present when the instructions axis is `Open` or `Choice`. */
  instructions?: string
  /** Subset of tools to grant the node's agent; present when the tools axis is a `Choice`. */
  tools?: string[]
  /** Model option name; present when the model axis is a `Choice`. */
  model?: string
}

/**
 * One directed edge in a {@link GraphInput}.
 */
export interface GraphEdgeInput {
  /** Name of the upstream node. */
  from_node: string
  /** Name of the node that runs after `from_node`. */
  to_node: string
}

/**
 * Input parameters accepted by the graph tool.
 */
export interface GraphInput {
  /** The objective for the graph; entry-point nodes receive it directly. */
  task: string
  /** Agent specifications, one per node. */
  nodes: GraphNodeInput[]
  /** Directed edges between node names. */
  edges: GraphEdgeInput[]
}
