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
 * from a plain tool with `instanceof`, without relying on duck-typed method names.
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
