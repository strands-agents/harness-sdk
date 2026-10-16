/**
 * Experimental APIs for the Strands Agents TypeScript SDK.
 *
 * Everything exported here is experimental and subject to change in future
 * revisions without notice.
 */

export { Checkpoint, CHECKPOINT_SCHEMA_VERSION } from './checkpoint.js'
export type { CheckpointPosition, CheckpointData, CheckpointResumeContent } from './checkpoint.js'
export { CheckpointError } from '../errors.js'

// Context management graduated to the main entry point; these aliases are removed in the next minor release.
import { ContextManager as StableContextManager } from '../context-manager/context-manager.js'
import type {
  ContextManagerConfig as StableContextManagerConfig,
  ContextStrategy as StableContextStrategy,
  ContextState as StableContextState,
  StashConfig as StableStashConfig,
} from '../context-manager/types.js'
import { Offload as StableOffload } from '../context-manager/strategies/offload/index.js'
import type {
  OffloadTarget as StableOffloadTarget,
  OffloadConditions as StableOffloadConditions,
} from '../context-manager/strategies/offload/base.js'
import type { TruncateConfig as StableTruncateConfig } from '../context-manager/methods/truncate.js'
import type { SummarizeConfig as StableSummarizeConfig } from '../context-manager/methods/summarize.js'

/** @deprecated Import `ContextManager` from `@strands-agents/sdk` instead. */
export const ContextManager = StableContextManager
/** @deprecated Import `ContextManager` from `@strands-agents/sdk` instead. */
export type ContextManager = StableContextManager
/** @deprecated Import `ContextManagerConfig` from `@strands-agents/sdk` instead. */
export type ContextManagerConfig = StableContextManagerConfig
/** @deprecated Import `ContextStrategy` from `@strands-agents/sdk` instead. */
export type ContextStrategy = StableContextStrategy
/** @deprecated Import `ContextState` from `@strands-agents/sdk` instead. */
export type ContextState = StableContextState
/** @deprecated Import `StashConfig` from `@strands-agents/sdk` instead. */
export type StashConfig = StableStashConfig
/** @deprecated Import `Offload` from `@strands-agents/sdk` instead. */
export const Offload: typeof StableOffload = StableOffload
/** @deprecated Import `OffloadTarget` from `@strands-agents/sdk` instead. */
export type OffloadTarget = StableOffloadTarget
/** @deprecated Import `OffloadConditions` from `@strands-agents/sdk` instead. */
export type OffloadConditions = StableOffloadConditions
/** @deprecated Import `TruncateConfig` from `@strands-agents/sdk` instead. */
export type TruncateConfig = StableTruncateConfig
/** @deprecated Import `SummarizeConfig` from `@strands-agents/sdk` instead. */
export type SummarizeConfig = StableSummarizeConfig
