/**
 * Base hide strategy and shared infrastructure.
 *
 * Hide strategies operate on the per-call model input (`InvokeModelContext`), not on
 * `ContextState.messages`. They register an `InvokeModelStage.Input` handler from `init()`
 * and are a no-op in the message pipeline.
 *
 * Not exported from the package barrel while the API is experimental.
 *
 * @internal
 */

import { AfterInvocationEvent, BeforeInvocationEvent } from '../../../hooks/events.js'
import { HookOrder } from '../../../hooks/types.js'
import { InvokeModelStage } from '../../../middleware/stages.js'
import type { InvokeModelContext } from '../../../middleware/stages.js'
import type { InvocationState, LocalAgent } from '../../../types/agent.js'
import type { ContextState, ContextStrategy } from '../../types.js'

/**
 * Conditions that determine when a hide strategy fires.
 *
 * Hide strategies fire on catalog size, not on token utilization. Message conditions
 * (`threshold`, `utilization`, `preserveRecent`) do not apply.
 *
 * @internal
 */
export interface HideConditions {
  /** Fire only when at least this many eligible items are on the call. */
  count?: number
}

/**
 * Intermediate builder result that allows chaining `.when()` conditions.
 * Also implements `ContextStrategy` directly so it can be used without `.when()`.
 *
 * @internal
 */
export interface HideStrategyBuilder extends ContextStrategy {
  /** Add conditions that determine when this strategy fires. */
  when(conditions: HideConditions): ContextStrategy
}

/**
 * Shared hide logic: middleware registration, per-invocation state, and the `count` gate.
 * Subclasses implement `_transform` to filter one field of the model input.
 *
 * @internal
 */
export abstract class BaseHideStrategy<TState extends object> implements ContextStrategy {
  abstract readonly name: string

  protected readonly _count: number | undefined
  /**
   * Per-invocation state, keyed by the invocation's state object. Callers may reuse one
   * `invocationState` object across invocations, so the boundary hooks still clear it.
   */
  private readonly _state = new WeakMap<InvocationState, TState>()

  constructor(conditions?: HideConditions) {
    if (conditions?.count !== undefined && (!Number.isInteger(conditions.count) || conditions.count < 0)) {
      throw new Error(`count must be a non-negative integer, got ${conditions.count}`)
    }
    this._count = conditions?.count
  }

  init(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage.Input, (context) => this._transform(context))
    agent.addHook(AfterInvocationEvent, (event) => this._clearState(event.invocationState), {
      order: HookOrder.SDK_LAST,
    })
    agent.addHook(BeforeInvocationEvent, (event) => this._clearState(event.invocationState), {
      order: HookOrder.SDK_FIRST,
    })
  }

  /** Hide strategies do not touch the message pipeline. */
  async apply(_context: ContextState): Promise<boolean> {
    return false
  }

  /** Filter the model input for one call. */
  protected abstract _transform(context: InvokeModelContext): Promise<InvokeModelContext>

  protected _getState(invocationState: InvocationState): TState | undefined {
    return this._state.get(invocationState)
  }

  protected _setState(invocationState: InvocationState, state: TState): void {
    this._state.set(invocationState, state)
  }

  private _clearState(invocationState: InvocationState): void {
    this._state.delete(invocationState)
  }
}
