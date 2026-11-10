import type { LocalAgent } from './agent.js'

/**
 * Implementors are given the agent at registration time so they can subscribe
 * to hook events of their choice via {@link LocalAgent.addHook}. This is the
 * extension point for components that need to observe arbitrary lifecycle
 * events. Each observer method is optional — implementors define only the
 * surfaces they care about, and the agent probes for each at registration.
 */
export interface LifecycleObserver {
  /** Stable identifier for this observer. Used for logging and duplicate detection. */
  readonly name: string

  /**
   * Called once when the observer is registered with an agent. Implementations
   * typically subscribe to one or more events via `agent.addHook`.
   */
  observeAgent?(agent: LocalAgent): void | Promise<void>
}
