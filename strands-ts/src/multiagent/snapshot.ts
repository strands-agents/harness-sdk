/**
 * Snapshot implementation for multi-agent orchestrators (Graph and Swarm).
 *
 * Well-known keys in data:
 * - `orchestratorId` — orchestrator identity for validation on load
 * - `state`          — serialized MultiAgentState (absent for nested orchestrators
 *                      whose execution state is ephemeral)
 */

import type { JSONValue } from '../types/json.js'
import { createTimestamp } from '../agent/snapshot.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../types/snapshot.js'
import type { Snapshot } from '../types/snapshot.js'
import type { MultiAgentState } from './state.js'
import { serializeStateSerializable, loadStateSerializable } from '../types/serializable.js'
import type { Swarm } from './swarm.js'
import type { Graph } from './graph.js'

/**
 * Options for taking a multi-agent snapshot.
 */
export interface TakeMultiAgentSnapshotOptions {
  /** Application-owned data. Strands does not read or modify this. */
  appData?: Record<string, JSONValue>
}

/**
 * Takes a snapshot of a multi-agent orchestrator's current state.
 *
 * NOTE: This is currently an internal implementation detail. We anticipate
 * exposing this as a public method in a future release after API review.
 *
 * @param orchestrator - The Graph or Swarm to snapshot
 * @param state - The current execution state, or undefined for nested orchestrators
 *   whose state is ephemeral and not available from outside
 * @param options - Multi-agent snapshot options
 * @returns A snapshot of the orchestrator's state
 */
export function takeSnapshot(
  orchestrator: Graph | Swarm,
  state?: MultiAgentState,
  options: TakeMultiAgentSnapshotOptions = {}
): Snapshot {
  const data: Record<string, JSONValue> = {
    orchestratorId: orchestrator.id,
  }

  if (state) {
    data.state = serializeStateSerializable(state)
  }

  return {
    scope: 'multiAgent',
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: createTimestamp(),
    data,
    appData: options.appData ?? {},
  }
}

/**
 * Loads a multi-agent snapshot, restoring execution state.
 *
 * Follows the same mutate-in-place pattern as the agent snapshot: if a `state`
 * instance is provided, execution state is loaded into it. Execution state is a
 * separate parameter (rather than a field on the orchestrator) because orchestrators
 * create ephemeral state per `stream()` call — there is no persistent state field
 * to mutate.
 *
 * NOTE: This is currently an internal implementation detail. We anticipate
 * exposing this as a public method in a future release after API review.
 *
 * @param orchestrator - The Graph or Swarm to restore into
 * @param snapshot - The snapshot to load
 * @param state - Optional MultiAgentState to restore execution state into
 */
export function loadSnapshot(orchestrator: Graph | Swarm, snapshot: Snapshot, state?: MultiAgentState): void {
  if (snapshot.scope !== 'multiAgent') {
    throw new Error(`Expected snapshot scope 'multiAgent', got '${snapshot.scope}'`)
  }
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema version: ${snapshot.schemaVersion}. Current version: ${SNAPSHOT_SCHEMA_VERSION}`
    )
  }

  if (snapshot.data.orchestratorId !== orchestrator.id) {
    throw new Error(
      `Snapshot orchestrator ID mismatch: expected '${orchestrator.id}', got '${snapshot.data.orchestratorId}'`
    )
  }

  if (state && 'state' in snapshot.data) {
    loadStateSerializable(state, snapshot.data.state)
  }
}
