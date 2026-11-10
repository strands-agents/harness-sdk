/**
 * Plugin interface and registry for extending multi-agent orchestrator functionality.
 *
 * This module defines the MultiAgentPlugin interface and MultiAgentPluginRegistry,
 * which provide a composable way to add behavior to multi-agent orchestrators (e.g. Swarm, Graph)
 * through hook registration and custom initialization.
 */

import type { MultiAgent } from './multiagent.js'

/**
 * Interface for objects that implement multi-agent orchestrator plugin functionality.
 *
 * MultiAgentPlugins provide a composable way to add behavior to orchestrators
 * by registering hook callbacks in their `initMultiAgent` method.
 *
 * @example
 * ```typescript
 * class LoggingPlugin implements MultiAgentPlugin {
 *   get name(): string {
 *     return 'logging-plugin'
 *   }
 *
 *   initMultiAgent(orchestrator: MultiAgent): void {
 *     orchestrator.addHook(BeforeNodeCallEvent, (event) => {
 *       console.log(`Node ${event.nodeId} starting`)
 *     })
 *   }
 * }
 *
 * const swarm = new Swarm({
 *   nodes: [agentA, agentB],
 *   start: 'agentA',
 *   plugins: [new LoggingPlugin()],
 * })
 * ```
 */
export interface MultiAgentPlugin {
  /**
   * A stable string identifier for the plugin.
   * Used for logging, duplicate detection, and plugin management.
   */
  readonly name: string

  /**
   * Initialize the plugin with the orchestrator instance.
   *
   * Implement this method to register hooks and perform custom initialization.
   *
   * @param orchestrator - The orchestrator this plugin is being attached to
   */
  initMultiAgent(orchestrator: MultiAgent): void | Promise<void>
}

/**
 * Registry for managing plugins attached to a multi-agent orchestrator.
 *
 * Holds pending plugins and initializes them on first use.
 * Handles duplicate detection and calls each plugin's initMultiAgent method.
 */
export class MultiAgentPluginRegistry {
  private readonly _plugins: Map<string, MultiAgentPlugin>
  private readonly _pending: MultiAgentPlugin[]
  private _initializationPromise?: Promise<void>

  constructor(plugins: MultiAgentPlugin[] = []) {
    this._plugins = new Map()
    this._pending = [...plugins]
  }

  /**
   * Initialize all pending plugins with the orchestrator.
   * Safe to call multiple times — subsequent calls share the first initialization result, including failures.
   *
   * @param orchestrator - The orchestrator instance to initialize plugins with
   */
  async initialize(orchestrator: MultiAgent): Promise<void> {
    this._initializationPromise ??= this._initialize(orchestrator)
    return this._initializationPromise
  }

  private async _initialize(orchestrator: MultiAgent): Promise<void> {
    while (this._pending.length > 0) {
      const plugin = this._pending.shift()!
      await this._addAndInit(plugin, orchestrator)
    }
  }

  private async _addAndInit(plugin: MultiAgentPlugin, orchestrator: MultiAgent): Promise<void> {
    if (this._plugins.has(plugin.name)) {
      throw new Error(`plugin_name=<${plugin.name}> | plugin already registered`)
    }
    this._plugins.set(plugin.name, plugin)
    await plugin.initMultiAgent(orchestrator)
  }
}
