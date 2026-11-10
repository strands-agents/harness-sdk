/**
 * Plugin interface for extending agent functionality.
 *
 * This module defines the Plugin interface, which provides a composable way to
 * add behavior changes to agents through hook registration and custom initialization.
 */

import type { Tool } from '../tools/tool.js'
import type { LocalAgent } from '../types/agent.js'

/**
 * Interface for objects that extend agent functionality.
 *
 * Plugins provide a composable way to add behavior changes to agents by registering
 * hook callbacks in their `initAgent` method. Each plugin must have a unique name
 * for identification, logging, and duplicate prevention.
 *
 * @example
 * ```typescript
 * class LoggingPlugin implements Plugin {
 *   get name(): string {
 *     return 'logging-plugin'
 *   }
 *
 *   initAgent(agent: LocalAgent): void {
 *     agent.addHook(BeforeInvocationEvent, (event) => {
 *       console.log('Agent invocation started')
 *     })
 *   }
 * }
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [new LoggingPlugin()],
 * })
 * ```
 *
 * @example With tools
 * ```typescript
 * class MyToolPlugin implements Plugin {
 *   get name(): string {
 *     return 'my-tool-plugin'
 *   }
 *
 *   getTools(): Tool[] {
 *     return [myTool]
 *   }
 * }
 * ```
 */
export interface Plugin {
  /**
   * A stable string identifier for the plugin.
   * Used for logging, duplicate detection, and plugin management.
   *
   * For strands-vended plugins, names should be prefixed with `strands:`.
   */
  readonly name: string

  /**
   * Initialize the plugin with the agent instance.
   *
   * Implement this method to register hooks and perform custom initialization.
   * Tool registration from {@link getTools} is handled automatically by the PluginRegistry.
   *
   * @param agent - The agent instance this plugin is being attached to
   */
  initAgent(agent: LocalAgent): void | Promise<void>

  /**
   * Returns tools provided by this plugin for auto-registration.
   * Called after {@link initAgent} resolves; may depend on state set there.
   *
   * @returns Array of tools to register with the agent
   */
  getTools?(): Tool[]
}
