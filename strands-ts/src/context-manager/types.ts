/**
 * Configuration types for the ContextManager.
 *
 * @experimental
 */

import type { Storage } from '../storage/storage.js'
import type { Stash } from './stash.js'
import type { LocalAgent } from '../types/agent.js'
import type { Message } from '../types/messages.js'

/**
 * A context reduction strategy that can offload, summarize, or otherwise
 * transform the message array to reduce token usage.
 *
 * Strategies are applied in order during `apply()`. Each decides whether
 * to act based on the current context state (utilization, message count, etc.).
 */
export interface ContextStrategy {
  /** Stable identifier for logging and observability. */
  readonly name: string

  /**
   * Called once when the ContextManager is attached to an agent.
   * Strategies can use this to register hooks (e.g., eager offloading on message arrival).
   */
  init?(agent: LocalAgent, stash?: Stash): void

  /**
   * Attempt to reduce context. Returns true if it made changes, false if it
   * decided not to act (e.g., conditions not met, nothing to offload).
   */
  apply(context: ContextState): Promise<boolean>
}

/**
 * State passed to strategies during apply().
 */
export interface ContextState {
  /** The agent's current message array (the context window). Strategies mutate this in place. */
  messages: Message[]

  /** The agent instance. */
  agent: LocalAgent

  /** Current context utilization ratio (0-1+). Above 1.0 means overflow. */
  utilization: number

  /** L1 stash for persisting offloaded content. Present when storage is configured. */
  stash?: Stash
}

/**
 * Configuration for the L1 stash (offloaded content persistence).
 */
export interface StashConfig {
  /** Storage backend. Defaults to InMemoryStorage when omitted. */
  storage?: Storage

  /**
   * Whether to register the `retrieve_context` tool for the agent.
   * Set to `false` to keep stash persistence without exposing the retrieval tool.
   * Defaults to `true`.
   */
  retrievalTool?: false
}

/**
 * Full configuration for a ContextManager instance.
 */
export interface ContextManagerConfig {
  /**
   * Strategies for context reduction. Applied as an ordered pipeline: each strategy
   * sees the output of the previous. Order determines priority — if two strategies
   * target the same content, the first one to shrink it below the next strategy's
   * threshold wins. When omitted, uses the default pipeline.
   */
  strategies?: ContextStrategy[]

  /**
   * L1 stash configuration. The stash persists offloaded content so the agent can
   * retrieve it on demand via the `retrieve_context` tool.
   *
   * - Omit or `true` → stash enabled with InMemoryStorage (default)
   * - `{ storage }` → stash enabled with the given backend
   * - `false` → stash disabled (no persistence, no retrieval tool)
   */
  stash?: StashConfig | boolean
}
