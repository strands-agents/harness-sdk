/**
 * Harness-authored plugins.
 *
 * Plugins bundle a tool with a loop-level behavior (a hook or context injection). Each is a
 * candidate to port into the core SDK later; keep them minimal and SDK-idiomatic.
 */

export { Todos } from './todos.js'
export type { TodoItem } from './todos.js'
export { EnvironmentContext } from './environment.js'
export type { EnvironmentContextConfig } from './environment.js'
