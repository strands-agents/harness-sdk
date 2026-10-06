/**
 * The harness's factory plumbing for the CLI and other first-party tooling. Import from
 * `@strands-agents/harness/internal` only when building on the harness's internals.
 *
 * @internal
 */

export { HARNESS_AGENT_CONFIG_KEYS, normalizeHarnessAgentConfig } from './config.js'
export { EFFORT_LEVELS, resolveModel } from './models.js'
export {
  DEFAULT_BUILTIN_PLUGINS,
  DEFAULT_CONTEXT_MANAGER,
  DEFAULT_EFFORT,
  DEFAULT_MEMORY_DIR,
  DEFAULT_MODEL,
  DEFAULT_SKILLS_DIR,
} from './defaults.js'
export { resolveMemory, type ResolveMemoryOptions } from './memory.js'
export { resolveInterventions, type InterventionAsk, type InterventionValue } from './interventions.js'
export {
  builtinToolConfig,
  enabledBuiltinTools,
  resolveBuiltinTools,
  webSearchExplicit,
  webSearchMode,
  type ResolvedBuiltinTools,
} from './builtin-tools.js'
export type { BuildAgent } from './builtin-tools.js'
