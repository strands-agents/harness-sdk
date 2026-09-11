import { describe, expect, it, beforeEach } from 'vitest'
import { SnapshotStorageAdapter } from '../snapshot-storage-adapter.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { namespace } from '../../storage/storage.js'
import { SessionError } from '../../errors.js'
import { createTestSnapshot, createTestManifest, createTestScope } from '../../__fixtures__/mock-storage-provider.js'
import type { SnapshotLocation } from '../storage.js'

const SCOPE_ID = 'test-agent'

function createLocation(overrides: Partial<SnapshotLocation> = {}): SnapshotLocation {
  return {
    sessionId: 'test-session',
    scope: createTestScope(),
    scopeId: SCOPE_ID,
    ...overrides,
  }
}

function uuidV7(index: number): string {
  const hex = index.toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`
}

describe('SnapshotStorageAdapter', () => {
  let backend: InMemoryStorage
  let adapter: SnapshotStorageAdapter

  beforeEach(() => {
    backend = new InMemoryStorage()
    adapter = new SnapshotStorageAdapter(namespace(backend, 'session'))
  })

  describe('saveSnapshot', () => {
    it('saves snapshot as latest', async () => {
      const location = createLocation()
      const snapshot = createTestSnapshot()

      await adapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: true, snapshot })

      const keys = await backend.list('session/')
      expect(keys).toContainEqual(expect.stringContaining('snapshot_latest.json'))
    })

    it('saves snapshot to history', async () => {
      const location = createLocation()
      const snapshot = createTestSnapshot()
      const id = uuidV7(1)

      await adapter.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot })

      const keys = await backend.list('session/')
      expect(keys).toContainEqual(expect.stringContaining(`immutable_history/snapshot_${id}.json`))
    })

    it('round-trips snapshot data through loadSnapshot', async () => {
      const location = createLocation()
      const snapshot = createTestSnapshot({ appData: { custom: 'value' } })
      const id = uuidV7(1)

      await adapter.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot })
      const loaded = await adapter.loadSnapshot({ location, snapshotId: id })

      expect(loaded).toEqual(snapshot)
    })
  })

  describe('loadSnapshot', () => {
    it('returns null when snapshot does not exist', async () => {
      const location = createLocation()

      const result = await adapter.loadSnapshot({ location, snapshotId: uuidV7(99) })

      expect(result).toBeNull()
    })

    it('loads latest snapshot when no snapshotId provided', async () => {
      const location = createLocation()
      const snapshot = createTestSnapshot({ appData: { version: 'latest' } })

      await adapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: true, snapshot })
      const loaded = await adapter.loadSnapshot({ location })

      expect(loaded).toEqual(snapshot)
    })

    it('returns null for latest when no latest exists', async () => {
      const location = createLocation()

      const result = await adapter.loadSnapshot({ location })

      expect(result).toBeNull()
    })
  })

  describe('listSnapshotIds', () => {
    it('returns empty array when no snapshots exist', async () => {
      const location = createLocation()

      const ids = await adapter.listSnapshotIds({ location })

      expect(ids).toEqual([])
    })

    it('lists snapshot IDs sorted chronologically', async () => {
      const location = createLocation()
      const id1 = uuidV7(1)
      const id2 = uuidV7(2)
      const id3 = uuidV7(3)

      await adapter.saveSnapshot({ location, snapshotId: id2, isLatest: false, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: id1, isLatest: false, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: id3, isLatest: false, snapshot: createTestSnapshot() })

      const ids = await adapter.listSnapshotIds({ location })

      expect(ids).toEqual([id1, id2, id3])
    })

    it('does not include latest in listing', async () => {
      const location = createLocation()
      const id = uuidV7(1)

      await adapter.saveSnapshot({ location, snapshotId: id, isLatest: true, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot: createTestSnapshot() })

      const ids = await adapter.listSnapshotIds({ location })

      expect(ids).toEqual([id])
    })

    it('respects limit parameter', async () => {
      const location = createLocation()
      for (let i = 1; i <= 5; i++) {
        await adapter.saveSnapshot({ location, snapshotId: uuidV7(i), isLatest: false, snapshot: createTestSnapshot() })
      }

      const ids = await adapter.listSnapshotIds({ location, limit: 2 })

      expect(ids).toHaveLength(2)
      expect(ids).toEqual([uuidV7(1), uuidV7(2)])
    })

    it('returns empty array when limit is 0', async () => {
      const location = createLocation()
      await adapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: false, snapshot: createTestSnapshot() })

      const ids = await adapter.listSnapshotIds({ location, limit: 0 })

      expect(ids).toEqual([])
    })

    it('respects startAfter cursor', async () => {
      const location = createLocation()
      const id1 = uuidV7(1)
      const id2 = uuidV7(2)
      const id3 = uuidV7(3)

      await adapter.saveSnapshot({ location, snapshotId: id1, isLatest: false, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: id2, isLatest: false, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: id3, isLatest: false, snapshot: createTestSnapshot() })

      const ids = await adapter.listSnapshotIds({ location, startAfter: id1 })

      expect(ids).toEqual([id2, id3])
    })

    it('combines limit and startAfter', async () => {
      const location = createLocation()
      for (let i = 1; i <= 5; i++) {
        await adapter.saveSnapshot({ location, snapshotId: uuidV7(i), isLatest: false, snapshot: createTestSnapshot() })
      }

      const ids = await adapter.listSnapshotIds({ location, startAfter: uuidV7(2), limit: 2 })

      expect(ids).toEqual([uuidV7(3), uuidV7(4)])
    })
  })

  describe('deleteSession', () => {
    it('deletes all data for the session', async () => {
      const location = createLocation()
      await adapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: false, snapshot: createTestSnapshot() })
      await adapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: true, snapshot: createTestSnapshot() })
      await adapter.saveManifest({ location, manifest: createTestManifest() })

      await adapter.deleteSession({ sessionId: 'test-session' })

      const keys = await backend.list('session/test-session/')
      expect(keys).toHaveLength(0)
    })

    it('does not affect other sessions', async () => {
      const location1 = createLocation({ sessionId: 'session-1' })
      const location2 = createLocation({ sessionId: 'session-2' })

      await adapter.saveSnapshot({
        location: location1,
        snapshotId: uuidV7(1),
        isLatest: false,
        snapshot: createTestSnapshot(),
      })
      await adapter.saveSnapshot({
        location: location2,
        snapshotId: uuidV7(2),
        isLatest: false,
        snapshot: createTestSnapshot(),
      })

      await adapter.deleteSession({ sessionId: 'session-1' })

      const keys1 = await backend.list('session/session-1/')
      const keys2 = await backend.list('session/session-2/')
      expect(keys1).toHaveLength(0)
      expect(keys2.length).toBeGreaterThan(0)
    })

    it('throws on invalid session ID', async () => {
      await expect(adapter.deleteSession({ sessionId: 'INVALID!' })).rejects.toThrow()
    })
  })

  describe('saveManifest / loadManifest', () => {
    it('round-trips manifest data', async () => {
      const location = createLocation()
      const manifest = createTestManifest({ updatedAt: '2025-06-01T00:00:00.000Z' })

      await adapter.saveManifest({ location, manifest })
      const loaded = await adapter.loadManifest({ location })

      expect(loaded).toEqual(manifest)
    })

    it('returns default manifest when none exists', async () => {
      const location = createLocation()

      const manifest = await adapter.loadManifest({ location })

      expect(manifest.schemaVersion).toBe('1.0')
      expect(manifest.updatedAt).toBeDefined()
    })
  })

  describe('path traversal protection', () => {
    it('rejects snapshotId with path traversal characters', async () => {
      const location = createLocation()

      await expect(
        adapter.saveSnapshot({
          location,
          snapshotId: '..\\..\\other-session\\snapshots\\snapshot_latest',
          isLatest: false,
          snapshot: createTestSnapshot(),
        })
      ).rejects.toThrow()
    })

    it('rejects snapshotId with forward-slash traversal', async () => {
      const location = createLocation()

      await expect(adapter.loadSnapshot({ location, snapshotId: '../../other-session' })).rejects.toThrow()
    })
  })

  describe('custom namespace', () => {
    it('uses the namespace provided to the adapter', async () => {
      const customAdapter = new SnapshotStorageAdapter(namespace(backend, 'custom/prefix'))
      const location = createLocation()

      await customAdapter.saveSnapshot({
        location,
        snapshotId: uuidV7(1),
        isLatest: true,
        snapshot: createTestSnapshot(),
      })

      const defaultKeys = await backend.list('session/')
      const customKeys = await backend.list('custom/prefix/')
      expect(defaultKeys).toHaveLength(0)
      expect(customKeys.length).toBeGreaterThan(0)
    })
  })

  describe('error handling', () => {
    it('wraps storage write errors in SessionError', async () => {
      const failingBackend: InMemoryStorage = new InMemoryStorage()
      failingBackend.write = async () => {
        throw new Error('disk full')
      }
      const failAdapter = new SnapshotStorageAdapter(namespace(failingBackend, 'session'))
      const location = createLocation()

      await expect(
        failAdapter.saveSnapshot({ location, snapshotId: uuidV7(1), isLatest: false, snapshot: createTestSnapshot() })
      ).rejects.toThrow(SessionError)
    })

    it('wraps storage read errors in SessionError', async () => {
      const failingBackend: InMemoryStorage = new InMemoryStorage()
      failingBackend.read = async () => {
        throw new Error('network timeout')
      }
      const failAdapter = new SnapshotStorageAdapter(namespace(failingBackend, 'session'))
      const location = createLocation()

      await expect(failAdapter.loadSnapshot({ location, snapshotId: uuidV7(1) })).rejects.toThrow(SessionError)
    })

    it('throws SessionError on corrupted JSON', async () => {
      const location = createLocation()
      const key = 'session/test-session/scopes/agent/test-agent/snapshots/snapshot_latest.json'
      await backend.write(key, new TextEncoder().encode('not valid json{{{'))

      await expect(adapter.loadSnapshot({ location })).rejects.toThrow(SessionError)
      await expect(adapter.loadSnapshot({ location })).rejects.toThrow(/Corrupted JSON/)
    })
  })
})
