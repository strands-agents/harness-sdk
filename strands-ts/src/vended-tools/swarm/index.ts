/**
 * Swarm tool for spinning up a handoff-based team of agents at runtime.
 */

export { makeSwarm, swarm } from './swarm.js'
export type { MakeSwarmOptions } from './swarm.js'
export {
  DEFAULT_SWARM_DESCRIPTION,
  DEFAULT_SWARM_MAX_AGENTS,
  DEFAULT_SWARM_MAX_STEPS,
  DEFAULT_SWARM_NODE_TIMEOUT,
  DEFAULT_SWARM_TIMEOUT,
} from './types.js'
export type { SwarmAgentInput, SwarmInput } from './types.js'
