/**
 * Snapshot helpers for agent state capture and restoration.
 *
 * These functions provide the shared implementation for {@link LocalAgent.takeSnapshot}
 * and {@link LocalAgent.loadSnapshot}. Since all `LocalAgent` implementations share the
 * same snapshot logic, these helpers avoid duplication. The canonical public API is
 * `agent.takeSnapshot()` / `agent.loadSnapshot()` — prefer calling those directly.
 */

import type { JSONValue } from '../types/json.js'
import type { MessageData, SystemPromptData } from '../types/messages.js'
import { Message, systemPromptFromData, systemPromptToData } from '../types/messages.js'
import { loadStateSerializable, serializeStateSerializable } from '../types/serializable.js'
import type { LocalAgent } from '../types/agent.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../types/snapshot.js'
import type { Snapshot } from '../types/snapshot.js'
import { InterruptState, type InterruptStateData } from '../interrupt.js'

/**
 * All available fields that can be included in a snapshot.
 */
export const ALL_SNAPSHOT_FIELDS = ['messages', 'state', 'systemPrompt', 'modelState', 'interrupts'] as const

/**
 * Strongly typed preset definitions for snapshot field selection.
 * This object allows easy evolution of presets and type-safe access.
 */
export const SNAPSHOT_PRESETS = {
  session: ['messages', 'state', 'systemPrompt', 'modelState', 'interrupts'] as const,
} as const

/**
 * Preset name for snapshot field selection.
 */
export type SnapshotPreset = keyof typeof SNAPSHOT_PRESETS

/**
 * Valid snapshot field names.
 */
export type SnapshotField = (typeof ALL_SNAPSHOT_FIELDS)[number]

/**
 * Creates an ISO 8601 timestamp string.
 *
 * @returns Current timestamp in ISO 8601 format
 */
export function createTimestamp(): string {
  return new Date().toISOString()
}

/**
 * Options for taking a snapshot of agent state.
 */
export type TakeSnapshotOptions = {
  /**
   * Preset to use as the starting set of fields.
   * If not specified, starts with an empty set (unless include is specified).
   */
  preset?: SnapshotPreset
  /**
   * Fields to add to the snapshot.
   * These are added to the preset fields (if any).
   */
  include?: SnapshotField[]
  /**
   * Fields to exclude from the snapshot.
   * Applied after preset and include to filter out specific fields.
   */
  exclude?: SnapshotField[]
  /**
   * Application-owned data to store in the snapshot.
   * Strands does not read or modify this data.
   */
  appData?: Record<string, JSONValue>
}

/**
 * Shared implementation for {@link LocalAgent.takeSnapshot}.
 * Prefer calling `agent.takeSnapshot(options)` directly.
 *
 * @param agent - The agent to snapshot
 * @param options - Snapshot options
 * @returns A snapshot of the agent's state
 */
export function takeSnapshot(agent: LocalAgent, options: TakeSnapshotOptions): Snapshot {
  const fields = resolveSnapshotFields(options)

  const data: Record<string, JSONValue> = {}

  if (fields.has('messages')) {
    data.messages = agent.messages.map((msg) => msg.toJSON()) as unknown as JSONValue
  }

  if (fields.has('state')) {
    data.state = serializeStateSerializable(agent.appState)
  }

  if (fields.has('systemPrompt')) {
    data.systemPrompt = agent.systemPrompt !== undefined ? (systemPromptToData(agent.systemPrompt) as JSONValue) : null
  }

  if (fields.has('modelState')) {
    data.modelState = serializeStateSerializable(agent.modelState)
  }

  if (fields.has('interrupts')) {
    const interruptState = (agent as unknown as { _interruptState?: InterruptState })._interruptState
    data.interrupts = interruptState ? (interruptState.toJSON() as unknown as JSONValue) : null
  }

  return {
    scope: 'agent',
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    createdAt: createTimestamp(),
    data,
    appData: options.appData ?? {},
  }
}

/**
 * Shared implementation for {@link LocalAgent.loadSnapshot}.
 * Prefer calling `agent.loadSnapshot(snapshot)` directly.
 *
 * @param agent - The agent to restore state into
 * @param snapshot - The snapshot to load
 */
export function loadSnapshot(agent: LocalAgent, snapshot: Snapshot): void {
  if (snapshot.scope !== 'agent') {
    throw new Error(`Expected snapshot scope 'agent', got '${snapshot.scope}'`)
  }
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported snapshot schema version: ${snapshot.schemaVersion}. Current version: ${SNAPSHOT_SCHEMA_VERSION}`
    )
  }

  if ('messages' in snapshot.data) {
    const messages = snapshot.data.messages
    agent.messages.length = 0
    for (const msgData of messages as unknown as MessageData[]) {
      agent.messages.push(Message.fromJSON(msgData))
    }
  }

  if ('state' in snapshot.data) {
    loadStateSerializable(agent.appState, snapshot.data.state)
  }

  // Use key-presence check to distinguish "field absent" (leave unchanged) from
  // "field present as null" (agent had no system prompt — clear it).
  if ('systemPrompt' in snapshot.data) {
    const systemPrompt = snapshot.data.systemPrompt
    if (systemPrompt !== null) {
      agent.systemPrompt = systemPromptFromData(systemPrompt as SystemPromptData)
    } else {
      delete agent.systemPrompt
    }
  }

  if ('modelState' in snapshot.data) {
    loadStateSerializable(agent.modelState, snapshot.data.modelState)
  }

  if ('interrupts' in snapshot.data) {
    const interruptStateData = snapshot.data.interrupts
    if (interruptStateData !== null) {
      const agentRecord = agent as unknown as { _interruptState: InterruptState }
      agentRecord._interruptState = InterruptState.fromJSON(interruptStateData as unknown as InterruptStateData)
    }
  }
}

/**
 * Resolves snapshot fields based on preset/include/exclude parameters.
 *
 * Order of operations:
 * 1. Start with preset fields (if specified)
 * 2. Add include fields
 * 3. Remove exclude fields
 *
 * @param options - Snapshot options containing preset, include, and exclude fields
 * @returns Set of resolved field names
 * @throws Error if no fields would be included
 */
export function resolveSnapshotFields(options: TakeSnapshotOptions = {}): Set<SnapshotField> {
  const { preset, include, exclude } = options
  let fields: Set<SnapshotField>

  // Start with preset fields or empty set
  if (preset !== undefined) {
    if (!(preset in SNAPSHOT_PRESETS)) {
      throw new Error(`Invalid preset: ${preset}. Valid presets are: ${Object.keys(SNAPSHOT_PRESETS).join(', ')}`)
    }
    fields = new Set(SNAPSHOT_PRESETS[preset])
  } else {
    fields = new Set()
  }

  // Add include fields
  if (include !== undefined) {
    validateSnapshotFields(include)
    for (const field of include) {
      fields.add(field)
    }
  }

  // Remove exclude fields (no error if field wasn't included)
  if (exclude !== undefined) {
    validateSnapshotFields(exclude)
    for (const field of exclude) {
      fields.delete(field)
    }
  }

  // Must have at least one field
  if (fields.size === 0) {
    throw new Error('No fields to include in snapshot. Specify a preset or include fields.')
  }

  return fields
}

/**
 * Validates that all field names are valid snapshot fields.
 */
function validateSnapshotFields(fields: string[]): void {
  const validFields = new Set<string>(ALL_SNAPSHOT_FIELDS)
  for (const field of fields) {
    if (!validFields.has(field)) {
      throw new Error(`Invalid snapshot field: ${field}. Valid fields are: ${ALL_SNAPSHOT_FIELDS.join(', ')}`)
    }
  }
}
