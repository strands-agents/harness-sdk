import type { LocalAgent } from '../types/agent.js'

// Re-export Snapshot and Scope from the canonical location
export type { Snapshot, Scope } from '../types/snapshot.js'

/**
 * Manifest tracks snapshot metadata.
 * Stored alongside snapshots to support versioning and future multi-agent patterns.
 */
export interface SnapshotManifest {
  /** Schema version for forward/backward compatibility */
  schemaVersion: string
  /** ISO 8601 timestamp of last manifest update */
  updatedAt: string
}

/**
 * Parameters passed to SnapshotTriggerCallback to determine when to create snapshots.
 */
export interface SnapshotTriggerParams {
  /** Current agent data including messages and state */
  agentData: LocalAgent
}

/**
 * Callback function to determine when to create immutable snapshots.
 * Called after each agent invocation to decide if a snapshot should be saved.
 *
 * @param params - Snapshot trigger parameters
 * @returns true to create a snapshot, false to skip
 *
 * @example
 * ```ts
 * // Snapshot every 10 messages
 * const trigger: SnapshotTriggerCallback = ({ agentData }) => agentData.messages.length % 10 === 0
 *
 * // Snapshot when conversation exceeds 20 messages
 * const trigger: SnapshotTriggerCallback = ({ agentData }) => agentData.messages.length > 20
 * ```
 */
export type SnapshotTriggerCallback = (params: SnapshotTriggerParams) => boolean
