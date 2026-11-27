/**
 * Experimental APIs for the Strands Agents TypeScript SDK.
 *
 * Everything exported here is experimental and subject to change in future
 * revisions without notice.
 */

export { Checkpoint, CHECKPOINT_SCHEMA_VERSION } from './checkpoint.js'
export type { CheckpointPosition, CheckpointData, CheckpointResumeContent } from './checkpoint.js'
export { CheckpointError } from '../errors.js'

// Context management lives at `@strands-agents/sdk/context-manager`. These re-exports resolve to
// the same symbols and are removed in the next minor release.
export {
  /** @deprecated Import `ContextManager` from `@strands-agents/sdk/context-manager`. */
  ContextManager,
} from '../context-manager/context-manager.js'
export type {
  /** @deprecated Import `ContextManagerConfig` from `@strands-agents/sdk/context-manager`. */
  ContextManagerConfig,
  /** @deprecated Import `ContextStrategy` from `@strands-agents/sdk/context-manager`. */
  ContextStrategy,
  /** @deprecated Import `ContextState` from `@strands-agents/sdk/context-manager`. */
  ContextState,
  /** @deprecated Renamed to `ArchiveConfig`; import it from `@strands-agents/sdk/context-manager`. */
  ArchiveConfig as StashConfig,
} from '../context-manager/types.js'
export {
  /** @deprecated Import `Offload` from `@strands-agents/sdk/context-manager`. */
  Offload,
} from '../context-manager/strategies/offload/index.js'
export type {
  /** @deprecated Import `OffloadStrategy` from `@strands-agents/sdk/context-manager`. */
  OffloadStrategy,
} from '../context-manager/strategies/offload/base.js'
export type {
  /** @deprecated Import `OffloadConditions` from `@strands-agents/sdk/context-manager`. */
  OffloadConditions,
} from '../context-manager/strategies/offload/conditions.js'
export type {
  /** @deprecated Import `OffloadTarget` from `@strands-agents/sdk/context-manager`. */
  OffloadTarget,
} from '../context-manager/strategies/offload/target.js'
export type {
  /** @deprecated Import `TruncateConfig` from `@strands-agents/sdk/context-manager`. */
  TruncateConfig,
} from '../context-manager/methods/truncate.js'
export type {
  /** @deprecated Import `SummarizeConfig` from `@strands-agents/sdk/context-manager`. */
  SummarizeConfig,
} from '../context-manager/strategies/offload/summarize.js'
