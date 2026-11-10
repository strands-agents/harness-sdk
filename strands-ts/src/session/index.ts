/**
 * Session management module re-exports.
 * These are exported from the main `@strands-agents/sdk` entry point.
 */

// Core types
export { SessionManager } from './session-manager.js'
export type { SessionManagerConfig, SaveLatestStrategy, MultiAgentSaveLatestStrategy } from './session-manager.js'
export type { SnapshotManifest, SnapshotTriggerCallback, SnapshotTriggerParams } from './types.js'

// Storage layer
export type { SessionStorage, SnapshotStorage, SnapshotLocation } from './storage.js'

// Storage implementations
export { FileStorage } from './file-storage.js'

export type { Scope, Snapshot } from '../types/snapshot.js'
