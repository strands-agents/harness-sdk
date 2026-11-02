/**
 * Unified storage module.
 *
 * Provides the {@link Storage} interface and shipped implementations for persisting
 * raw bytes under string keys. All SDK subsystems that need persistence — sessions,
 * memory, context offloading, transcripts — consume this interface.
 *
 * @example
 * ```typescript
 * import { LocalFileStorage, InMemoryStorage } from '@strands-agents/sdk/storage'
 * ```
 *
 * @packageDocumentation
 */

export type { Storage } from './storage.js'
export { InMemoryStorage } from './in-memory-storage.js'
export type { InMemoryStorageConfig } from './in-memory-storage.js'
export { LocalFileStorage } from './local-file-storage.js'
export type { LocalFileStorageConfig } from './local-file-storage.js'
export { S3Storage } from './s3-storage.js'
export type { S3StorageConfig } from './s3-storage.js'
