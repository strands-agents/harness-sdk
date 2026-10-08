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
 * An abstract class (rather than a structural interface) so the agent can distinguish a provider
 * from a plain tool with `instanceof`. Subclass with `extends`; a class that only `implements`
 * `ToolProvider` type-checks, but produces an object that is not `instanceof ToolProvider`, so
 * {@link isToolProvider} falls back to a structural check to still recognize it rather than
 * silently treating it as a plain tool.
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
   * Must stay synchronous: it runs on the registry's synchronous {@link ToolRegistry.addProvider}
   * path (typically from an agent's constructor), so there is nothing to `await` here. Record the
   * consumer id only; defer any async setup work to {@link ToolProvider.loadTools} instead.
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
 * Reports whether `value` behaves like a {@link ToolProvider}.
 *
 * Prefers `instanceof`, which covers the common case of subclassing with `extends`. Falls back to
 * a structural check so a class that uses `implements ToolProvider` — which type-checks but is not
 * `instanceof ToolProvider` — is still recognized as a provider instead of silently falling through
 * to plain-tool handling, where it would fail with a confusing tool-name validation error.
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
