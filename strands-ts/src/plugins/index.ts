/**
 * Plugin system for extending agent functionality.
 *
 * This module provides the Plugin base class for extending agent behavior
 * through hook callbacks and tool registration.
 *
 * @example
 * ```typescript
 * import { Plugin, BeforeInvocationEvent } from '@strands-agents/sdk'
 *
 * class MyPlugin extends Plugin {
 *   get name(): string {
 *     return 'my-plugin'
 *   }
 *
 *   override initAgent(agent: LocalAgent): void {
 *     agent.addHook(BeforeInvocationEvent, (event) => {
 *       console.log('Before invocation')
 *     })
 *   }
 * }
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [new MyPlugin()],
 * })
 * ```
 */

export type { Plugin } from './plugin.js'
