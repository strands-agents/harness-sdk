/**
 * Experimental APIs for the Strands Agents TypeScript SDK.
 *
 * Everything exported here is experimental and subject to change in future
 * revisions without notice.
 */

export { Checkpoint, CHECKPOINT_SCHEMA_VERSION } from './checkpoint.js'
export type { CheckpointPosition, CheckpointData, CheckpointResumeContent } from './checkpoint.js'
export { CheckpointError } from '../errors.js'

// Context management graduated to the main entry point; these aliases are removed in v1.23.0.
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

/** @deprecated `ContextManager` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export const ContextManager = StableContextManager
/** @deprecated `ContextManager` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type ContextManager = StableContextManager
/** @deprecated `ContextManagerConfig` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type ContextManagerConfig = StableContextManagerConfig
/** @deprecated `ContextStrategy` is deprecated and will be removed in v1.23.0. It has no public replacement. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type ContextStrategy = StableContextStrategy
/** @deprecated `ContextState` is deprecated and will be removed in v1.23.0. It has no public replacement. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type ContextState = StableContextState
/** @deprecated `StashConfig` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type StashConfig = StableStashConfig
/** @deprecated `Offload` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export const Offload: typeof StableOffload = StableOffload
/** @deprecated `OffloadTarget` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type OffloadTarget = StableOffloadTarget
/** @deprecated `OffloadConditions` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type OffloadConditions = StableOffloadConditions
/** @deprecated `TruncateConfig` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type TruncateConfig = StableTruncateConfig
/** @deprecated `SummarizeConfig` from `@strands-agents/sdk/experimental` is deprecated and will be removed in v1.23.0. Import it from `@strands-agents/sdk` instead. See migration guide: https://strandsagents.com/docs/user-guide/sdk/context-management/#updating-experimental-imports */
export type SummarizeConfig = StableSummarizeConfig
