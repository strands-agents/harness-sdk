import type { Tool } from './tool.js'

/**
 * Supplies a collection of tools whose lifecycle is managed by the agent, via reference counting.
 *
 * A provider loads its tools lazily and may hold resources (connections, processes, watchers)
 * behind them. The owning {@link ToolRegistry} tracks itself as a single consumer via
 * {@link ToolProvider.addConsumer}; other registries sharing the same provider instance count as
 * additional consumers. A provider is free to release its resources once its last consumer calls
 * {@link ToolProvider.removeConsumer}.
 *
 * Subclass with `extends`; structural implementers (`implements ToolProvider`) are also accepted.
 */
export abstract class ToolProvider {
  /**
   * Loads and returns the tools this provider supplies.
   *
   * @returns The tools that are ready to use.
   */
  abstract loadTools(): Promise<Tool[]>

  /**
   * Registers a consumer that depends on this provider's tools.
   *
   * Called synchronously from {@link ToolRegistry.addProvider} during agent initialization, just
   * before {@link ToolProvider.loadTools}. Record the consumer id only; do async setup in `loadTools`.
   *
   * @param consumerId - Unique identifier for the consumer.
   */
  abstract addConsumer(consumerId: string): void

  /**
   * Removes a consumer from this provider.
   *
   * Must be idempotent — calling this more than once with the same id has no additional effect
   * after the first call. A provider may release its resources once no consumers remain.
   *
   * @param consumerId - Unique identifier for the consumer.
   */
  abstract removeConsumer(consumerId: string): void | Promise<void>
}

/**
 * Reports whether `value` is a {@link ToolProvider}, by `instanceof` or structurally.
 *
 * @internal
 *
 * @param value - The value to test.
 * @returns Whether `value` can be used as a {@link ToolProvider}.
 */
export function isToolProvider(value: unknown): value is ToolProvider {
  if (value instanceof ToolProvider) {
    return true
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<ToolProvider>
  return (
    typeof candidate.loadTools === 'function' &&
    typeof candidate.addConsumer === 'function' &&
    typeof candidate.removeConsumer === 'function'
  )
}
