/**
 * Shared snapshot types for agent and multi-agent snapshots.
 */

import type { JSONValue } from './json.js'

/**
 * Current schema version of the snapshot format.
 */
export const SNAPSHOT_SCHEMA_VERSION = '1.0'

/**
 * Scope defines the context for snapshot data.
 */
export type Scope = 'agent' | 'multiAgent'

/**
 * Point-in-time capture of agent or orchestrator state.
 */
export interface Snapshot {
  /** Scope identifying the snapshot context (agent or multi-agent). */
  scope: Scope
  /** Schema version string for forward compatibility. */
  schemaVersion: string
  /** ISO 8601 timestamp of when snapshot was created. */
  createdAt: string
  /** Framework-owned state data. */
  data: Record<string, JSONValue>
  /** Application-owned data. Strands does not read or modify this. */
  appData: Record<string, JSONValue>
}
