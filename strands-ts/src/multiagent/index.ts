/**
 * Multi-agent orchestration module.
 */

export { MultiAgentState, NodeState, Status, NodeResult, MultiAgentResult } from './state.js'
export type { NodeResultUpdate, ResultStatus } from './state.js'

export { Node, AgentNode, MultiAgentNode } from './nodes.js'
export type {
  NodeConfig,
  NodeInputOptions,
  AgentNodeOptions,
  MultiAgentNodeOptions,
  NodeDefinition,
  NodeType,
} from './nodes.js'

export {
  MultiAgentInitializedEvent,
  BeforeMultiAgentInvocationEvent,
  AfterMultiAgentInvocationEvent,
  BeforeNodeCallEvent,
  AfterNodeCallEvent,
  NodeStreamUpdateEvent,
  NodeResultEvent,
  NodeCancelEvent,
  MultiAgentHandoffEvent,
  MultiAgentResultEvent,
} from './events.js'
export type { MultiAgentStreamEvent, NodeStreamUpdateInnerEvent } from './events.js'

export { Edge } from './edge.js'
export type { EdgeHandler, EdgeDefinition } from './edge.js'

export { Graph } from './graph.js'
export type { GraphConfig, GraphOptions } from './graph.js'

export { Swarm } from './swarm.js'
export type { SwarmConfig, SwarmNodeDefinition, SwarmOptions } from './swarm.js'

export type { MultiAgentPlugin } from './plugins.js'

export type { MultiAgent, MultiAgentInput, MultiAgentInvokeOptions } from './multiagent.js'

export { AgentSpec, Choice, Fixed, Inherit, Open, Option, Preset } from './spec.js'
