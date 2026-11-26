/**
 * Realistic key-value store — paginated list, verbose responses, optional
 * unreliability (transient read-after-write inconsistency).
 *
 * Compared to makeKvStore():
 * - list is paginated (max PAGE_SIZE keys per call)
 * - get/set return wrapped JSON with metadata
 * - optional CAS (compare-and-swap) semantics on set
 * - unreliability flag: ~10% of reads immediately after a write return stale value
 */

import { tool } from '../../../../strands-ts/src/tools/tool-factory.js'
import { z } from 'zod'

export interface KvStoreOptions {
  pageSize?: number
  unreliable?: boolean
}

export function makeKvStore(options: KvStoreOptions = {}) {
  const PAGE_SIZE = options.pageSize ?? 10
  const UNRELIABLE = options.unreliable ?? false

  const store = new Map<string, { value: string; version: number; updatedAt: number }>()
  let globalVersion = 0
  const recentWrites = new Map<string, number>()

  function isStaleRead(key: string): boolean {
    if (!UNRELIABLE) return false
    const writeTime = recentWrites.get(key)
    if (!writeTime) return false
    if (Date.now() - writeTime < 200) {
      return Math.random() < 0.15
    }
    recentWrites.delete(key)
    return false
  }

  const get = tool({
    name: 'kv_get',
    description: 'Get a value by key. Returns the value, its version number, and metadata. Returns null with found=false if key does not exist.',
    inputSchema: z.object({
      key: z.string().describe('The key to retrieve'),
    }),
    callback: (input) => {
      const entry = store.get(input.key)
      if (!entry) {
        return JSON.stringify({ found: false, key: input.key, value: null, version: null })
      }
      if (isStaleRead(input.key)) {
        return JSON.stringify({
          found: true,
          key: input.key,
          value: null,
          version: entry.version - 1,
          warning: 'STALE_READ: value may not reflect most recent write. Retry.',
        })
      }
      return JSON.stringify({
        found: true,
        key: input.key,
        value: entry.value,
        version: entry.version,
        sizeBytes: entry.value.length,
      })
    },
  })

  const set = tool({
    name: 'kv_set',
    description: 'Set a value for a key. Returns the new version number. Optionally provide expectedVersion for compare-and-swap (fails if current version differs).',
    inputSchema: z.object({
      key: z.string().describe('The key to set'),
      value: z.string().describe('The value to store'),
      expectedVersion: z.number().optional().describe('If provided, set only succeeds if current version matches (CAS)'),
    }),
    callback: (input) => {
      const existing = store.get(input.key)

      if (input.expectedVersion !== undefined) {
        const currentVersion = existing?.version ?? 0
        if (currentVersion !== input.expectedVersion) {
          return JSON.stringify({
            success: false,
            error: 'VERSION_CONFLICT',
            message: `Expected version ${input.expectedVersion} but current is ${currentVersion}. Re-read and retry.`,
            currentVersion,
          })
        }
      }

      globalVersion++
      store.set(input.key, { value: input.value, version: globalVersion, updatedAt: Date.now() })
      if (UNRELIABLE) recentWrites.set(input.key, Date.now())

      return JSON.stringify({
        success: true,
        key: input.key,
        version: globalVersion,
        sizeBytes: input.value.length,
      })
    },
  })

  const list = tool({
    name: 'kv_list',
    description: 'List keys in the store. Returns paginated results (max 10 per page). Use cursor for next page. Optionally filter by prefix.',
    inputSchema: z.object({
      prefix: z.string().optional().describe('Filter keys by prefix'),
      cursor: z.number().optional().describe('Pagination cursor (offset). Omit for first page.'),
    }),
    callback: (input) => {
      let keys = [...store.keys()]
      if (input.prefix) {
        keys = keys.filter(k => k.startsWith(input.prefix!))
      }
      keys.sort()

      const offset = input.cursor ?? 0
      const page = keys.slice(offset, offset + PAGE_SIZE)
      const hasMore = offset + PAGE_SIZE < keys.length
      const nextCursor = hasMore ? offset + PAGE_SIZE : null

      return JSON.stringify({
        keys: page,
        totalKeys: keys.length,
        ...(nextCursor !== null && { nextCursor }),
        hasMore,
      })
    },
  })

  const del = tool({
    name: 'kv_delete',
    description: 'Delete a key. Returns whether the key existed.',
    inputSchema: z.object({
      key: z.string().describe('The key to delete'),
    }),
    callback: (input) => {
      const existed = store.has(input.key)
      store.delete(input.key)
      return JSON.stringify({ deleted: existed, key: input.key })
    },
  })

  return {
    get, set, list, delete: del,
    tools: [get, set, list, del],
    /** Direct access for seeding */
    seed: (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) {
        globalVersion++
        store.set(k, { value: v, version: globalVersion, updatedAt: Date.now() })
      }
    },
    /** Direct access for scoring */
    getAll: (): Record<string, string> => {
      const result: Record<string, string> = {}
      for (const [k, v] of store) result[k] = v.value
      return result
    },
  }
}
