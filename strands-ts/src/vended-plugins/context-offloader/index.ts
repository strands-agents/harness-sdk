/**
 * Context offloading plugin for Strands Agents.
 *
 * This module provides the ContextOffloader plugin and Storage backends for
 * automatically offloading oversized tool results to external storage, replacing
 * them with truncated previews and actionable storage references.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { ContextOffloader, InMemoryStorage } from '@strands-agents/sdk/vended-plugins/context-offloader'
 *
 * const agent = new Agent({
 *   model,
 *   plugins: [new ContextOffloader({ storage: new InMemoryStorage() })],
 * })
 * ```
 */

export { ContextOffloader } from './plugin.js'
export type { ContextOffloaderConfig } from './plugin.js'
export type { Storage, FileStorageOptions } from './storage.js'
export { InMemoryStorage, FileStorage, S3Storage } from './storage.js'
