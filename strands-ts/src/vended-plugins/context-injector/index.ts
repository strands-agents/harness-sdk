/**
 * Context-injection plugin for Strands Agents.
 *
 * Provides the {@link ContextInjector} plugin, which writes just-in-time text into the latest user
 * message before each model call, as an `InjectedBlock` that stays in the conversation.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [
 *     new ContextInjector({
 *       renderContent: async ({ messages }) => `<context>${derive(messages)}</context>`,
 *     }),
 *   ],
 * })
 * ```
 */

export { ContextInjector } from './plugin.js'
export type { ContextInjectorConfig } from './plugin.js'
export type { InjectionTrigger, InjectionContext } from '../../injection/types.js'
