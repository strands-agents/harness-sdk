/**
 * Todos plugin for Strands Agents.
 *
 * Provides the {@link Todos} plugin, which gives the agent a `todo_write` tool and re-surfaces the
 * current task list before each model call so a multi-step plan stays in view.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { Todos } from '@strands-agents/sdk/vended-plugins/todos'
 *
 * const agent = new Agent({ model, plugins: [new Todos()] })
 * ```
 */

export { Todos } from './plugin.js'
export type { TodoItem, TodosConfig } from './plugin.js'
