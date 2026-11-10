/**
 * Base A2A server that manages agent card and request handler setup.
 *
 * This module is browser-compatible. For Express-based HTTP serving,
 * see {@link A2AExpressServer} in `./express-server.ts`.
 *
 * The A2A protocol is experimental, so breaking changes in the underlying SDK
 * may require breaking changes in this module.
 */

import type { AgentCard, AgentSkill } from '@a2a-js/sdk'
import type { TaskStore, A2ARequestHandler } from '@a2a-js/sdk/server'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import type { InvokableAgent } from '../types/agent.js'
import { A2AExecutor, type AgentFactory } from './executor.js'

/** Placeholder context id used to build a representative agent for card metadata in factory mode. */
const AGENT_CARD_CONTEXT_ID = '__agent_card__'

/**
 * Configuration options for creating an A2AServer.
 *
 * Provide exactly one of `agent` (deprecated) or `agentFactory`.
 */
export interface A2AServerConfig {
  /** @deprecated The Strands Agent to serve via A2A protocol. Prefer `agentFactory`. */
  agent?: InvokableAgent
  /**
   * Callable that takes a `contextId` and returns a dedicated agent per A2A context.
   * Contexts run concurrently and the factory is where per-context concerns such as a
   * context-scoped `sessionManager` are wired. At construction it is invoked once with a
   * placeholder context id to derive the agent card metadata, so it should not
   * unconditionally allocate expensive resources.
   */
  agentFactory?: AgentFactory
  /**
   * Maximum number of per-context agents to retain concurrently (factory mode);
   * the least-recently-used is evicted beyond this. Must be at least 1.
   */
  maxContexts?: number
  /** Human-readable name for the agent */
  name: string
  /** Optional description of the agent's purpose */
  description?: string
  /** Public URL override for the agent card */
  httpUrl?: string
  /** Version string for the agent card (default: '0.0.1') */
  version?: string
  /** Skills to advertise in the agent card */
  skills?: AgentSkill[]
  /** Task store for persisting task state */
  taskStore?: TaskStore
}

/**
 * Base A2A server that manages agent card and request handler setup.
 *
 * Subclass this to integrate with different HTTP frameworks. For Express,
 * use {@link A2AExpressServer}.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { A2AExpressServer } from '@strands-agents/sdk/a2a/express'
 *
 * const agent = new Agent({ model: 'my-model' })
 * const server = new A2AExpressServer({
 *   agent,
 *   name: 'My Agent',
 *   description: 'An agent that helps with tasks',
 * })
 *
 * await server.serve()
 * ```
 */
export class A2AServer {
  protected _agentCard: AgentCard
  protected _requestHandler: A2ARequestHandler

  /**
   * Creates a new A2AServer.
   *
   * @param config - Configuration for the server
   */
  constructor(config: A2AServerConfig) {
    if ((config.agent === undefined) === (config.agentFactory === undefined)) {
      throw new Error("Provide exactly one of 'agent' or 'agentFactory'.")
    }

    const httpUrl = config.httpUrl ?? ''

    // Build a representative agent for card metadata (via the factory in factory mode).
    const cardAgent = config.agent ?? config.agentFactory!(AGENT_CARD_CONTEXT_ID)

    this._agentCard = {
      name: config.name,
      description: config.description ?? cardAgent.description ?? '',
      version: config.version ?? '0.0.1',
      protocolVersion: '0.2.0',
      url: httpUrl,
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: config.skills ?? [],
      capabilities: {
        streaming: true,
      },
    }

    const taskStore = config.taskStore ?? new InMemoryTaskStore()
    const executor = new A2AExecutor({
      ...(config.agent !== undefined && { agent: config.agent }),
      ...(config.agentFactory !== undefined && { agentFactory: config.agentFactory }),
      ...(config.maxContexts !== undefined && { maxContexts: config.maxContexts }),
    })
    this._requestHandler = new DefaultRequestHandler(this._agentCard, taskStore, executor)
  }

  /**
   * Returns the agent card for this server.
   */
  get agentCard(): AgentCard {
    return this._agentCard
  }
}
