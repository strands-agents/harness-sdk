import type {
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  BeforeModelCallEvent,
  AfterModelCallEvent,
} from '../hooks/events.js'
import type { Proceed, Deny, Guide, Confirm, Transform } from './actions.js'

export type Awaitable<T> = T | Promise<T>

/**
 * What to do when a handler throws during evaluation.
 *
 * - `'throw'` — rethrow the error (default, safest: a broken policy check blocks execution)
 * - `'proceed'` — continue as if the handler returned Proceed.
 *   **This mode is fail-open**: a broken handler silently stops enforcing its policy.
 *   Use only when availability matters more than enforcement.
 * - `'deny'` — log the error and treat it as a Deny (fail-closed)
 */
export type OnError = 'throw' | 'proceed' | 'deny'

/**
 * Base class for intervention handlers.
 *
 * Handlers override the lifecycle methods they care about. Default implementations
 * return Proceed. The framework detects which methods are overridden and only
 * registers hook callbacks for those.
 *
 * @example
 * ```typescript
 * class CedarAuth extends InterventionHandler {
 *   readonly name = 'cedar-auth'
 *
 *   override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
 *     if (!this.isAuthorized(event)) {
 *       return deny('User not authorized for this tool')
 *     }
 *     return proceed()
 *   }
 * }
 * ```
 */
export abstract class InterventionHandler {
  abstract readonly name: string

  /** What to do when this handler throws. Defaults to 'throw'. */
  readonly onError: OnError = 'throw'

  beforeInvocation(_event: BeforeInvocationEvent): Awaitable<Proceed | Deny | Guide | Transform> {
    return { type: 'proceed' }
  }

  beforeToolCall(_event: BeforeToolCallEvent): Awaitable<Proceed | Deny | Guide | Confirm | Transform> {
    return { type: 'proceed' }
  }

  afterToolCall(_event: AfterToolCallEvent): Awaitable<Proceed | Transform> {
    return { type: 'proceed' }
  }

  beforeModelCall(_event: BeforeModelCallEvent): Awaitable<Proceed | Deny | Guide | Transform> {
    return { type: 'proceed' }
  }

  afterModelCall(_event: AfterModelCallEvent): Awaitable<Proceed | Guide | Transform> {
    return { type: 'proceed' }
  }
}
