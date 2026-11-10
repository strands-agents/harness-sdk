/**
 * Checkpoint system for durable agent execution.
 *
 * **Experimental** — this module is experimental and subject to change in future
 * revisions without notice.
 *
 * A {@link Checkpoint} is a pause-point marker emitted at agent cycle boundaries.
 * It captures the position (which boundary fired) and the cycle index. It does
 * **not** capture conversation state — pair with a `SessionManager` for
 * cross-process state continuity.
 *
 * Positions per ReAct cycle:
 * - `afterModel`: model returned tool use; tools have not run yet.
 * - `afterTools`: tools finished; the next model call has not happened yet.
 *
 * Per-tool granularity within a cycle is the tool executor's responsibility.
 *
 * Usage (mirrors interrupts):
 * - Pause: `AgentResult` with `stopReason === 'checkpoint'` and `checkpoint` populated.
 * - Resume: pass back `{ checkpointResume: { checkpoint: ckpt.toJSON() } }`.
 *
 * Precedence:
 * - Interrupt takes precedence over checkpoint: an interrupt during a
 *   checkpointing cycle returns `stopReason === 'interrupt'` and skips `afterTools`.
 * - Cancel takes precedence over checkpoint: a cancel signal at either boundary
 *   returns `stopReason === 'cancelled'`.
 *
 * Notes:
 * - Checkpoints are only emitted on tool-use cycles. A turn with no tool calls
 *   emits no checkpoint; use a `SessionManager` for durability of every turn.
 * - Metrics reset per invocation; aggregate yourself if needed.
 * - `BeforeInvocationEvent` / `AfterInvocationEvent` fire on every resume,
 *   same as interrupts.
 * - Resuming from `afterModel` re-invokes the model. The agent loop defers
 *   appending the assistant tool-use message until after tools run (so history
 *   never holds a dangling tool-use), which means the tool-use message is not
 *   persisted at `afterModel`; on resume the model runs again to regenerate it.
 *   Completed tools are still never re-run — they execute once and their results
 *   persist at `afterTools`, which is the deterministic boundary. (In the Python
 *   SDK the assistant message is appended eagerly, so its `afterModel` resume
 *   reuses the persisted message instead of re-invoking the model.)
 */

import { logger } from '../logging/logger.js'
import { CheckpointError } from '../errors.js'

/**
 * Current checkpoint schema version. Bumped when the serialized shape changes
 * in a way that is not backward compatible; {@link Checkpoint.fromJSON} rejects
 * checkpoints carrying any other version.
 *
 * @experimental
 */
export const CHECKPOINT_SCHEMA_VERSION = '1.0'

/**
 * Which cycle boundary a checkpoint was emitted at.
 * - `afterModel`: model returned tool use; tools have not run yet.
 * - `afterTools`: tools finished; the next model call has not happened yet.
 *
 * @experimental
 */
export type CheckpointPosition = 'afterModel' | 'afterTools'

/**
 * Serialized form of a {@link Checkpoint}, as produced by {@link Checkpoint.toJSON}
 * and accepted by {@link Checkpoint.fromJSON}.
 *
 * @experimental
 */
export interface CheckpointData {
  position: CheckpointPosition
  cycleIndex?: number
  /** Populated by {@link Checkpoint.toJSON}. {@link Checkpoint.fromJSON} requires it to match the current version. */
  schemaVersion?: string
}

/**
 * Resume payload passed back to a checkpointing agent to continue a durable run.
 * The whole invocation argument is this object; the agent consumes it, restores
 * its cycle position, and continues without appending any new input messages.
 * Resume with `{ checkpointResume: { checkpoint: ckpt.toJSON() } }`.
 *
 * @experimental
 */
export interface CheckpointResumeContent {
  checkpointResume: { checkpoint: CheckpointData }
}

/**
 * Pause-point marker. Treat as opaque — pass it back to resume.
 *
 * @experimental
 */
export class Checkpoint {
  /** Which boundary fired (`afterModel` or `afterTools`). */
  readonly position: CheckpointPosition

  /** ReAct loop cycle (0-based). */
  readonly cycleIndex: number

  /**
   * Schema version. Always set to {@link CHECKPOINT_SCHEMA_VERSION}; not accepted
   * from the constructor so it cannot be forged. Rejects incompatible checkpoints
   * on {@link Checkpoint.fromJSON}.
   */
  readonly schemaVersion: string = CHECKPOINT_SCHEMA_VERSION

  constructor(data: { position: CheckpointPosition; cycleIndex?: number }) {
    this.position = data.position
    this.cycleIndex = data.cycleIndex ?? 0
  }

  /**
   * Serializes the checkpoint for persistence.
   */
  toJSON(): Required<CheckpointData> {
    return {
      position: this.position,
      cycleIndex: this.cycleIndex,
      schemaVersion: this.schemaVersion,
    }
  }

  /**
   * Reconstructs a checkpoint from a value produced by {@link Checkpoint.toJSON}.
   * Round-trips cleanly: `Checkpoint.fromJSON(ckpt.toJSON())` type-checks and
   * returns an equivalent checkpoint.
   *
   * @param data - Serialized checkpoint data.
   * @throws CheckpointError If `schemaVersion` does not match the current version.
   */
  static fromJSON(data: CheckpointData): Checkpoint {
    const version = data.schemaVersion ?? ''
    if (version !== CHECKPOINT_SCHEMA_VERSION) {
      throw new CheckpointError(
        `Checkpoints with schema version ${JSON.stringify(version)} are not compatible ` +
          `with current version ${CHECKPOINT_SCHEMA_VERSION}.`
      )
    }

    const knownKeys = new Set(['position', 'cycleIndex', 'schemaVersion'])
    const unknownKeys = Object.keys(data).filter((key) => !knownKeys.has(key))
    if (unknownKeys.length > 0) {
      logger.warn(`unknown_keys=<${unknownKeys.join(', ')}> | ignoring unknown fields in checkpoint data`)
    }

    return new Checkpoint({
      position: data.position,
      ...(data.cycleIndex !== undefined && { cycleIndex: data.cycleIndex }),
    })
  }
}
