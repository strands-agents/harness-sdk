/**
 * Steering context provider interface.
 *
 * Providers track agent activity and supply context data to steering handlers
 * for evaluation decisions.
 */

import type { LocalAgent } from '../../../types/agent.js'
import type { LifecycleObserver } from '../../../types/lifecycle-observer.js'
import type { JSONValue } from '../../../types/json.js'

/**
 * Context data returned by a SteeringContextProvider.
 * The type field identifies which provider produced the data.
 */
export interface SteeringContextData {
  /** Discriminator identifying the context provider. */
  readonly type: string
  /** Additional context fields. */
  [key: string]: JSONValue
}

/**
 * A passive observer that accumulates data from agent lifecycle events.
 *
 * Providers self-register hook callbacks via {@link LifecycleObserver.observeAgent},
 * which the owning {@link SteeringHandler} invokes once at registration time.
 *
 * Providers expose accumulated state through the `context` getter, which the
 * handler reads when making steering decisions.
 *
 * @example
 * ```typescript
 * class CostTracker implements SteeringContextProvider {
 *   readonly name = 'costTracker'
 *   private _toolCalls = 0
 *
 *   observeAgent(agent: LocalAgent): void {
 *     agent.addHook(AfterToolCallEvent, () => {
 *       this._toolCalls += 1
 *     })
 *   }
 *
 *   get context(): SteeringContextData {
 *     return { type: 'costTracker', toolCalls: this._toolCalls }
 *   }
 * }
 * ```
 */
export interface SteeringContextProvider extends LifecycleObserver {
  /** Identifier for this provider instance. */
  readonly name: string

  /** Subscribe to hooks on the owning agent. Required for providers. */
  observeAgent(agent: LocalAgent): void | Promise<void>

  /** Return the current context snapshot for steering evaluation. */
  get context(): SteeringContextData
}
