import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileStorage } from '../file-storage.js'
import { SessionError } from '../../errors.js'
import {
  createTestSnapshot,
  createTestManifest,
  createTestScope,
  createTestSnapshots,
} from '../../__fixtures__/mock-storage-provider.js'
import type { SnapshotLocation } from '../storage.js'

const SCOPE_ID = 'test-agent'

describe('FileStorage', () => {
  let storage: FileStorage
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), `file-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await fs.mkdir(testDir, { recursive: true })
    storage = new FileStorage(testDir)
  })

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('saveSnapshot', () => {
    describe('FileSnapshotStorage_When_saveSnapshot_Then_CreatesFiles', () => {
      it('saves snapshot to history file', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })

        const historyPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'immutable_history',
          'snapshot_1.json'
        )
        const content = await fs.readFile(historyPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })

      it('saves snapshot as latest when isLatest is true', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const latestPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'snapshot_latest.json'
        )
        const content = await fs.readFile(latestPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })

      it('creates directories recursively', async () => {
        const location: SnapshotLocation = {
          sessionId: 'new-session',
          scope: createTestScope('agent'),
          scopeId: 'new-agent',
        }
        const snapshot = createTestSnapshot()

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const expectedDir = join(testDir, location.sessionId, 'scopes', 'agent', location.scopeId, 'snapshots')
        const stats = await fs.stat(expectedDir)
        expect(stats.isDirectory()).toBe(true)
      })
    })

    describe('FileSnapshotStorage_When_saveSnapshotFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when write fails', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()

        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Write failed'))

        await expect(storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })).rejects.toThrow(
          SessionError
        )
      })
    })

    describe('FileSnapshotStorage_When_InvalidScope_Then_RejectsPath', () => {
      it('rejects a scope containing path traversal', async () => {
        const location = {
          sessionId: 'test-session',
          scope: '../../../../outside',
          scopeId: SCOPE_ID,
        } as unknown as SnapshotLocation

        await expect(
          storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })
        ).rejects.toThrow("Invalid scope '../../../../outside': must be 'agent' or 'multiAgent'")
        await expect(fs.readdir(testDir)).resolves.toEqual([])
      })
    })

    describe('FileSnapshotStorage_When_MultiAgentScope_Then_SavesCorrectly', () => {
      it('saves multi-agent snapshot to correct path', async () => {
        const location: SnapshotLocation = {
          sessionId: 'multi-session',
          scope: createTestScope('multiAgent'),
          scopeId: 'graph-1',
        }
        const snapshot = createTestSnapshot({ scope: 'multiAgent' })

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const expectedPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'multiAgent',
          location.scopeId,
          'snapshots',
          'snapshot_latest.json'
        )
        const content = await fs.readFile(expectedPath, 'utf8')
        expect(JSON.parse(content)).toEqual(snapshot)
      })
    })
  })

  describe('loadSnapshot', () => {
    describe('FileSnapshotStorage_When_LoadLatestSnapshot_Then_ReturnsSnapshot', () => {
      it('loads latest snapshot when snapshotId is undefined', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        const result = await storage.loadSnapshot({ location })

        expect(result).toEqual(snapshot)
      })
    })

    describe('FileSnapshotStorage_When_LoadSpecificSnapshot_Then_ReturnsSnapshot', () => {
      it('loads specific snapshot by ID', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        await storage.saveSnapshot({ location, snapshotId: '5', isLatest: false, snapshot })

        const result = await storage.loadSnapshot({ location, snapshotId: '5' })

        expect(result).toEqual(snapshot)
      })
    })

    describe('FileSnapshotStorage_When_SnapshotNotFound_Then_ReturnsNull', () => {
      it('returns null when snapshot file does not exist', async () => {
        const result = await storage.loadSnapshot({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toBeNull()
      })
    })

    describe('FileSnapshotStorage_When_InvalidJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when JSON is invalid', async () => {
        const sessionId = 'test-session'
        const filePath = join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots', 'snapshot_latest.json')

        await fs.mkdir(join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots'), { recursive: true })
        await fs.writeFile(filePath, 'invalid json', 'utf8')

        await expect(
          storage.loadSnapshot({ location: { sessionId, scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })

    describe('FileSnapshotStorage_When_ReadError_Then_ThrowsSessionError', () => {
      it('throws SessionError when file read fails', async () => {
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(
          storage.loadSnapshot({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('listSnapshotIds', () => {
    describe('FileSnapshotStorage_When_listSnapshots_Then_ReturnsOrderedIds', () => {
      it('returns sorted snapshot IDs', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]

        await storage.saveSnapshot({ location, snapshotId: ids[2]!, isLatest: false, snapshot: snapshots[2]! })
        await storage.saveSnapshot({ location, snapshotId: ids[0]!, isLatest: false, snapshot: snapshots[0]! })
        await storage.saveSnapshot({ location, snapshotId: ids[1]!, isLatest: false, snapshot: snapshots[1]! })

        const result = await storage.listSnapshotIds({ location })

        expect(result).toEqual(ids)
      })

      it('ignores non-snapshot files', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        const id = '019c9bf1-14e5-7eef-96fb-cc07ae54210f'
        await storage.saveSnapshot({ location, snapshotId: id, isLatest: false, snapshot })

        const historyDir = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'immutable_history'
        )
        await fs.writeFile(join(historyDir, 'other-file.txt'), 'not a snapshot', 'utf8')

        const result = await storage.listSnapshotIds({ location })
        expect(result).toEqual([id])
      })

      it('filters by startAfter for pagination', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, startAfter: ids[0]! })

        expect(result).toEqual([ids[1], ids[2]])
      })

      it('limits results when limit is provided', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, limit: 2 })

        expect(result).toEqual([ids[0], ids[1]])
      })

      it('combines startAfter and limit', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshots = createTestSnapshots(3)
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        for (let i = 0; i < ids.length; i++) {
          await storage.saveSnapshot({ location, snapshotId: ids[i]!, isLatest: false, snapshot: snapshots[i]! })
        }

        const result = await storage.listSnapshotIds({ location, startAfter: ids[0]!, limit: 1 })

        expect(result).toEqual([ids[1]])
      })
    })

    describe('FileSnapshotStorage_When_DirectoryNotFound_Then_ReturnsEmptyArray', () => {
      it('returns empty array when directory does not exist', async () => {
        const result = await storage.listSnapshotIds({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual([])
      })
    })

    describe('FileSnapshotStorage_When_ReadDirFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when readdir fails with non-ENOENT error', async () => {
        vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(
          storage.listSnapshotIds({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('deleteSession', () => {
    describe('FileSnapshotStorage_When_DeleteSession_Then_RemovesDirectory', () => {
      it('removes the entire session directory', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })

        await storage.deleteSession({ sessionId: 'test-session' })

        await expect(fs.stat(join(testDir, 'test-session'))).rejects.toMatchObject({ code: 'ENOENT' })
      })

      it('no-ops when session directory does not exist', async () => {
        await expect(storage.deleteSession({ sessionId: 'nonexistent-session' })).resolves.toBeUndefined()
      })
    })

    describe('FileSnapshotStorage_When_DeleteSessionFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when rm fails', async () => {
        vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Permission denied'))
        await expect(storage.deleteSession({ sessionId: 'test-session' })).rejects.toThrow(SessionError)
      })
    })
  })

  describe('saveManifest', () => {
    describe('FileSnapshotStorage_When_SaveManifest_Then_CreatesFile', () => {
      it('saves manifest to correct path', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()

        await storage.saveManifest({ location, manifest })

        const manifestPath = join(
          testDir,
          location.sessionId,
          'scopes',
          'agent',
          SCOPE_ID,
          'snapshots',
          'manifest.json'
        )
        const content = await fs.readFile(manifestPath, 'utf8')
        expect(JSON.parse(content)).toEqual(manifest)
      })
    })

    describe('FileSnapshotStorage_When_SaveManifestFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when write fails', async () => {
        vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('Write failed'))
        await expect(
          storage.saveManifest({
            location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
            manifest: createTestManifest(),
          })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('loadManifest', () => {
    describe('FileSnapshotStorage_When_LoadManifest_Then_ReturnsManifest', () => {
      it('loads manifest from file', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()
        await storage.saveManifest({ location, manifest })

        const result = await storage.loadManifest({ location })

        expect(result).toEqual(manifest)
      })
    })

    describe('FileSnapshotStorage_When_ManifestNotFound_Then_ReturnsDefault', () => {
      it('returns default manifest when manifest file does not exist', async () => {
        const result = await storage.loadManifest({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual({
          schemaVersion: '1.0',
          updatedAt: expect.any(String),
        })
      })
    })

    describe('FileSnapshotStorage_When_InvalidManifestJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when JSON is invalid', async () => {
        const sessionId = 'test-session'
        const filePath = join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots', 'manifest.json')

        await fs.mkdir(join(testDir, sessionId, 'scopes', 'agent', SCOPE_ID, 'snapshots'), { recursive: true })
        await fs.writeFile(filePath, 'invalid json', 'utf8')

        await expect(
          storage.loadManifest({ location: { sessionId, scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })
})
