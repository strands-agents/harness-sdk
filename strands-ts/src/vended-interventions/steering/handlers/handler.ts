/**
 * Steering handler base class for providing contextual guidance to agents.
 *
 * Subclass {@link SteeringHandler} and override {@link beforeToolCall} and/or
 * {@link afterModelCall}. These carry a narrowed steering contract
 * (Proceed | Guide | Confirm for tool calls, Proceed | Guide for model output)
 * — the wider intervention vocabulary (Deny, Transform) is excluded by the
 * return type, so out-of-contract actions are caught at compile time.
 *
 * @example
 * ```typescript
 * class MySteeringHandler extends SteeringHandler {
 *   override readonly name = 'my-steering'
 *
 *   override async beforeToolCall(event) {
 *     if (event.toolUse.name === 'dangerous_tool') {
 *       return guide('This tool requires extra caution.')
 *     }
 *     return proceed()
 *   }
 * }
 *
 * const agent = new Agent({ tools: [...], interventions: [new MySteeringHandler()] })
 * ```
 */

import type { AfterModelCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { InterventionHandler, type Awaitable } from '../../../interventions/handler.js'
import type { LifecycleObserver } from '../../../types/lifecycle-observer.js'
import { proceed, type Confirm, type Guide, type Proceed } from '../../../interventions/actions.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { SteeringContextData, SteeringContextProvider } from '../providers/context-provider.js'

/**
 * Configuration shared by all steering handlers.
 */
export interface SteeringHandlerConfig {
  /** Providers that supply evaluation context. */
  contextProviders?: SteeringContextProvider[]
}

/**
 * Base class for steering handlers that provide contextual guidance to agents.
 *
 * Steering handlers accept context providers that observe agent activity, and
 * use the accumulated context to make guidance decisions. The handler is an
 * {@link InterventionHandler} — pass it via `interventions:` on the agent.
 *
 * Subclasses must declare a `name` (inherited as `abstract` from
 * {@link InterventionHandler}). When attaching multiple steering handlers to
 * one agent, ensure their names are distinct — `InterventionRegistry` rejects
 * duplicates.
 */
export abstract class SteeringHandler extends InterventionHandler implements LifecycleObserver {
  abstract override readonly name: string

  private readonly _contextProviders: SteeringContextProvider[]

  constructor(config?: SteeringHandlerConfig) {
    super()
    this._contextProviders = config?.contextProviders ?? []
  }

  // ---------------------------------------------------------------------------
  // Steering moments — narrowed return types reject out-of-contract actions.
  // ---------------------------------------------------------------------------

  override beforeToolCall(_event: BeforeToolCallEvent): Awaitable<Proceed | Guide | Confirm> {
    return proceed()
  }

  override afterModelCall(_event: AfterModelCallEvent): Awaitable<Proceed | Guide> {
    return proceed()
  }

  // ---------------------------------------------------------------------------
  // Lifecycle observer — forward to providers so they can self-register hooks.
  // ---------------------------------------------------------------------------

  async observeAgent(agent: LocalAgent): Promise<void> {
    for (const provider of this._contextProviders) {
      await provider.observeAgent(agent)
    }
  }

  /**
   * Collect context from all registered providers. Subclasses (and tests)
   * may call this to inspect the accumulated provider snapshots.
   */
  getSteeringContext(): SteeringContextData[] {
    return this._contextProviders.map((provider) => provider.context)
  }
}
