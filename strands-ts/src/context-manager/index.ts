/**
 * Context management module.
 *
 * Provides the {@link ContextManager} agent component and the {@link Offload} strategy
 * builders it runs. Pass a manager, a config, or a preset name to the Agent's
 * `contextManager` parameter; the Agent registers it and it owns overflow recovery
 * and proactive compression.
 *
 * @example
 * ```typescript
 * import { ContextManager, Offload } from '@strands-agents/sdk/context-manager'
 * ```
 *
 * @packageDocumentation
 */

export { ContextManager } from './context-manager.js'
export type { ContextManagerStrategy } from './context-manager.js'
export type { ContextManagerConfig, ContextStrategy, ContextState, ArchiveConfig } from './types.js'
export { Offload } from './strategies/offload/index.js'
export type {
  OffloadTarget,
  OffloadConditions,
  OffloadStrategy,
  /** @experimental Deferred tool loading may change in future versions. */
  DeferTarget,
  /** @experimental Deferred tool loading may change in future versions. */
  DeferConditions,
  /** @experimental Deferred tool loading may change in future versions. */
  DeferConfig,
  /** @experimental Deferred tool loading may change in future versions. */
  DeferStrategy,
  /** @experimental Deferred tool loading may change in future versions. */
  ToolSearch,
} from './strategies/offload/index.js'
export {
  /** @experimental Deferred tool loading may change in future versions. */
  KeywordToolSearcher,
} from '../tools/search-tools.js'
export type {
  /** @experimental Deferred tool loading may change in future versions. */
  ToolSearcher,
  /** @experimental Deferred tool loading may change in future versions. */
  ToolSearchContext,
} from '../tools/search-tools.js'
export type { TruncateConfig } from './methods/truncate.js'
export type { SummarizeConfig } from './strategies/offload/summarize.js'
export type { StrategyPresetName } from './presets.js'
