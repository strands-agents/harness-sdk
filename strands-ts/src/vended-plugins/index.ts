/**
 * Barrel export for all vended plugins.
 *
 * Provides a single import path for consumers who want all built-in plugins:
 * ```typescript
 * import { AgentSkills, ContextOffloader, ContextInjector, GoalLoop, InMemoryStorage } from '@strands-agents/sdk/vended-plugins'
 * ```
 */

export * from './skills/index.js'
export * from './context-offloader/index.js'
export * from './context-injector/index.js'
export * from './goal/index.js'
