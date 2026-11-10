import { describe, expect, it, beforeEach, vi, type MockedFunction } from 'vitest'
import { S3Storage } from '../s3-storage.js'
import { SessionError } from '../../errors.js'
import { createTestSnapshot, createTestManifest, createTestScope } from '../../__fixtures__/mock-storage-provider.js'
import type { SnapshotLocation } from '../storage.js'

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(function () {
    return {
      send: vi.fn(),
      config: {},
    }
  }),
  PutObjectCommand: vi.fn().mockImplementation(function (input) {
    return { input }
  }),
  GetObjectCommand: vi.fn().mockImplementation(function (input) {
    return { input }
  }),
  ListObjectsV2Command: vi.fn().mockImplementation(function (input) {
    return { input }
  }),
  DeleteObjectsCommand: vi.fn().mockImplementation(function (input) {
    return { input }
  }),
}))

const SCOPE_ID = 'test-agent'

describe('S3Storage', () => {
  let storage: S3Storage
  let mockS3Client: { send: MockedFunction<any> }

  beforeEach(() => {
    vi.clearAllMocks()
    storage = new S3Storage({ bucket: 'test-bucket', region: 'us-east-1' })
    mockS3Client = (storage as any)._s3
  })

  describe('constructor', () => {
    describe('S3SnapshotStorage_When_ValidConfig_Then_CreatesInstance', () => {
      it('stores bucket and region configuration', () => {
        const instance = new S3Storage({ bucket: 'test-bucket', region: 'us-west-2' })
        expect((instance as any)._bucket).toBe('test-bucket')
        expect((instance as any)._s3).toBeDefined()
      })

      it('stores prefix when provided', () => {
        const instance = new S3Storage({ bucket: 'test-bucket', prefix: 'my-prefix', region: 'us-east-1' })
        expect((instance as any)._prefix).toBe('my-prefix')
      })

      it('uses provided S3 client instead of creating new one', () => {
        const customClient = { send: vi.fn() }
        const instance = new S3Storage({ bucket: 'test-bucket', s3Client: customClient as any })
        expect((instance as any)._s3).toBe(customClient)
      })

      it('throws error when both s3Client and region are provided', () => {
        const config = { bucket: 'test-bucket', region: 'us-west-2', s3Client: { send: vi.fn() } as any }
        expect(() => new S3Storage(config)).toThrow(SessionError)
        expect(() => new S3Storage(config)).toThrow('Cannot specify both s3Client and region')
      })
    })
  })

  describe('saveSnapshot', () => {
    describe('S3SnapshotStorage_When_saveSnapshot_Then_PutsObjects', () => {
      it('saves snapshot to S3 history', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockS3Client.send.mockResolvedValue({})

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })

        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              Bucket: 'test-bucket',
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_1.json`,
              Body: JSON.stringify(snapshot, null, 2),
              ContentType: 'application/json',
            },
          })
        )
      })

      it('saves snapshot as latest when isLatest is true', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: createTestScope(), scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockS3Client.send.mockResolvedValue({})

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/snapshot_latest.json`,
            }),
          })
        )
      })

      it('uses prefix when configured', async () => {
        const storageWithPrefix = new S3Storage({ bucket: 'test-bucket', prefix: 'my-app', region: 'us-east-1' })
        const mockPrefixS3Client = (storageWithPrefix as any)._s3
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockPrefixS3Client.send.mockResolvedValue({})

        await storageWithPrefix.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })

        expect(mockPrefixS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: `my-app/test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_1.json`,
            }),
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_saveSnapshotFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when S3 put fails', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockS3Client.send.mockRejectedValue(new Error('S3 error'))

        await expect(storage.saveSnapshot({ location, snapshotId: '1', isLatest: false, snapshot })).rejects.toThrow(
          'Failed to write S3 object'
        )
      })
    })

    describe('S3SnapshotStorage_When_InvalidScope_Then_RejectsKey', () => {
      it('rejects a scope containing path traversal', async () => {
        const location = {
          sessionId: 'test-session',
          scope: '../../../../outside',
          scopeId: SCOPE_ID,
        } as unknown as SnapshotLocation

        await expect(
          storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot: createTestSnapshot() })
        ).rejects.toThrow("Invalid scope '../../../../outside': must be 'agent' or 'multiAgent'")
        expect(mockS3Client.send).not.toHaveBeenCalled()
      })
    })

    describe('S3SnapshotStorage_When_MultiAgentScope_Then_SavesCorrectly', () => {
      it('saves multi-agent snapshot to correct S3 key', async () => {
        const location: SnapshotLocation = { sessionId: 'multi-session', scope: 'multiAgent', scopeId: 'graph-1' }
        const snapshot = createTestSnapshot({ scope: 'multiAgent' })
        mockS3Client.send.mockResolvedValue({})

        await storage.saveSnapshot({ location, snapshotId: '1', isLatest: true, snapshot })

        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: 'multi-session/scopes/multiAgent/graph-1/snapshots/snapshot_latest.json',
            }),
          })
        )
      })
    })
  })

  describe('loadSnapshot', () => {
    describe('S3SnapshotStorage_When_LoadLatestSnapshot_Then_ReturnsSnapshot', () => {
      it('loads latest snapshot when snapshotId is undefined', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockS3Client.send.mockResolvedValue({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(snapshot)) },
        })

        const result = await storage.loadSnapshot({ location })

        expect(result).toEqual(snapshot)
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              Bucket: 'test-bucket',
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/snapshot_latest.json`,
            },
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_LoadSpecificSnapshot_Then_ReturnsSnapshot', () => {
      it('loads specific snapshot by ID', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const snapshot = createTestSnapshot()
        mockS3Client.send.mockResolvedValue({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(snapshot)) },
        })

        const result = await storage.loadSnapshot({ location, snapshotId: '5' })

        expect(result).toEqual(snapshot)
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_5.json`,
            }),
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_SnapshotNotFound_Then_ReturnsNull', () => {
      it('returns null when S3 object does not exist', async () => {
        const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        mockS3Client.send.mockRejectedValue(noSuchKeyError)

        const result = await storage.loadSnapshot({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toBeNull()
      })

      it('returns null when S3 response has no body', async () => {
        mockS3Client.send.mockResolvedValue({ Body: null })
        const result = await storage.loadSnapshot({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toBeNull()
      })

      it('returns null when S3 response body is empty', async () => {
        mockS3Client.send.mockResolvedValue({ Body: { transformToString: () => Promise.resolve('') } })
        const result = await storage.loadSnapshot({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toBeNull()
      })
    })

    describe('S3SnapshotStorage_When_InvalidJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when JSON is invalid', async () => {
        mockS3Client.send.mockResolvedValue({
          Body: { transformToString: () => Promise.resolve('invalid json') },
        })
        await expect(
          storage.loadSnapshot({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow('Invalid JSON in S3 object')
      })
    })

    describe('S3SnapshotStorage_When_S3Error_Then_ThrowsSessionError', () => {
      it('throws SessionError when S3 get fails', async () => {
        mockS3Client.send.mockRejectedValue(new Error('S3 error'))
        await expect(
          storage.loadSnapshot({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow('S3 error reading')
      })
    })
  })

  describe('listSnapshotIds', () => {
    describe('S3SnapshotStorage_When_listSnapshots_Then_ReturnsOrderedIds', () => {
      it('returns sorted snapshot IDs', async () => {
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        // S3 returns objects in lexicographic key order — mock reflects that contract
        mockS3Client.send.mockResolvedValue({
          Contents: [
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${ids[0]}.json` },
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${ids[1]}.json` },
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${ids[2]}.json` },
          ],
        })

        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
        })

        expect(result).toEqual(ids)
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Bucket: 'test-bucket',
              Prefix: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/`,
              MaxKeys: 1000,
            }),
          })
        )
      })

      it('returns empty array when no objects exist', async () => {
        mockS3Client.send.mockResolvedValue({ Contents: [] })
        const result = await storage.listSnapshotIds({
          location: { sessionId: 'empty-session', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual([])
      })

      it('ignores non-snapshot objects', async () => {
        const id1 = '019c9bf1-14e5-7eef-96fb-cc07ae54210f'
        const id2 = '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd'
        mockS3Client.send.mockResolvedValue({
          Contents: [
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id1}.json` },
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/other-file.txt` },
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id2}.json` },
          ],
        })
        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual([id1, id2])
      })

      it('handles objects without Key property', async () => {
        const id1 = '019c9bf1-14e5-7eef-96fb-cc07ae54210f'
        const id2 = '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd'
        mockS3Client.send.mockResolvedValue({
          Contents: [
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id1}.json` },
            {},
            { Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id2}.json` },
          ],
        })
        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual([id1, id2])
      })

      it('filters by startAfter for pagination', async () => {
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        // Simulate S3 server-side StartAfter: only return objects after ids[0]
        mockS3Client.send.mockResolvedValue({
          Contents: [ids[1], ids[2]].map((id) => ({
            Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id}.json`,
          })),
        })

        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
          startAfter: ids[0]!,
        })

        expect(result).toEqual([ids[1], ids[2]])
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              StartAfter: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${ids[0]}.json`,
            }),
          })
        )
      })

      it('limits results when limit is provided', async () => {
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        mockS3Client.send.mockResolvedValue({
          Contents: ids.map((id) => ({
            Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id}.json`,
          })),
        })

        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
          limit: 2,
        })

        expect(result).toEqual([ids[0], ids[1]])
      })

      it('combines startAfter and limit', async () => {
        const ids = [
          '019c9bf1-14e5-7eef-96fb-cc07ae54210f',
          '019c9bf1-1d34-7eef-96fb-d1be20fd7bbd',
          '019c9bf1-24bb-7eef-96fb-ddcc943cd859',
        ]
        // Simulate S3 server-side StartAfter: only return objects after ids[0]
        mockS3Client.send.mockResolvedValue({
          Contents: [ids[1], ids[2]].map((id) => ({
            Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/immutable_history/snapshot_${id}.json`,
          })),
        })

        const result = await storage.listSnapshotIds({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
          startAfter: ids[0]!,
          limit: 1,
        })

        expect(result).toEqual([ids[1]])
      })
    })

    describe('S3SnapshotStorage_When_ListObjectsFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when S3 list fails', async () => {
        mockS3Client.send.mockRejectedValue(new Error('S3 list error'))
        await expect(
          storage.listSnapshotIds({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow('Failed to list snapshots for session test-session')
      })
    })
  })

  describe('deleteSession', () => {
    describe('S3SnapshotStorage_When_DeleteSession_Then_DeletesAllObjects', () => {
      it('deletes all objects under the session prefix', async () => {
        mockS3Client.send
          .mockResolvedValueOnce({
            Contents: [
              { Key: 'test-session/scopes/agent/agent-1/snapshots/snapshot_latest.json' },
              { Key: 'test-session/scopes/agent/agent-1/snapshots/immutable_history/snapshot_abc.json' },
            ],
            IsTruncated: false,
          })
          .mockResolvedValueOnce({})

        await storage.deleteSession({ sessionId: 'test-session' })

        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Bucket: 'test-bucket',
              Prefix: 'test-session/',
            }),
          })
        )
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              Bucket: 'test-bucket',
              Delete: {
                Objects: [
                  { Key: 'test-session/scopes/agent/agent-1/snapshots/snapshot_latest.json' },
                  { Key: 'test-session/scopes/agent/agent-1/snapshots/immutable_history/snapshot_abc.json' },
                ],
              },
            },
          })
        )
      })

      it('paginates when session has more than 1000 objects', async () => {
        mockS3Client.send
          .mockResolvedValueOnce({
            Contents: [{ Key: 'test-session/page-1-object.json' }],
            IsTruncated: true,
            NextContinuationToken: 'token-1',
          })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({
            Contents: [{ Key: 'test-session/page-2-object.json' }],
            IsTruncated: false,
          })
          .mockResolvedValueOnce({})

        await storage.deleteSession({ sessionId: 'test-session' })

        expect(mockS3Client.send).toHaveBeenCalledTimes(4)
      })

      it('no-ops when session has no objects', async () => {
        mockS3Client.send.mockResolvedValueOnce({ Contents: [], IsTruncated: false })

        await storage.deleteSession({ sessionId: 'empty-session' })

        expect(mockS3Client.send).toHaveBeenCalledTimes(1)
      })

      it('uses prefix when configured', async () => {
        const storageWithPrefix = new S3Storage({ bucket: 'test-bucket', prefix: 'my-app', region: 'us-east-1' })
        const mockPrefixS3Client = (storageWithPrefix as any)._s3
        mockPrefixS3Client.send.mockResolvedValueOnce({ Contents: [], IsTruncated: false })

        await storageWithPrefix.deleteSession({ sessionId: 'test-session' })

        expect(mockPrefixS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({ Prefix: 'my-app/test-session/' }),
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_DeleteSessionFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when S3 list fails during delete', async () => {
        mockS3Client.send.mockRejectedValue(new Error('S3 error'))
        await expect(storage.deleteSession({ sessionId: 'test-session' })).rejects.toThrow(
          'Failed to delete session test-session'
        )
      })
    })
  })

  describe('loadManifest', () => {
    describe('S3SnapshotStorage_When_LoadManifest_Then_ReturnsManifest', () => {
      it('loads existing manifest', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()
        mockS3Client.send.mockResolvedValue({
          Body: { transformToString: () => Promise.resolve(JSON.stringify(manifest)) },
        })

        const result = await storage.loadManifest({ location })

        expect(result).toEqual(manifest)
        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: expect.objectContaining({
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/manifest.json`,
            }),
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_ManifestNotFound_Then_ReturnsDefault', () => {
      it('returns default manifest when S3 object does not exist', async () => {
        const noSuchKeyError = Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
        mockS3Client.send.mockRejectedValue(noSuchKeyError)

        const result = await storage.loadManifest({
          location: { sessionId: 'nonexistent', scope: 'agent', scopeId: SCOPE_ID },
        })
        expect(result).toEqual({
          schemaVersion: '1.0',
          updatedAt: expect.any(String),
        })
      })
    })

    describe('S3SnapshotStorage_When_InvalidManifestJSON_Then_ThrowsSessionError', () => {
      it('throws SessionError when manifest JSON is invalid', async () => {
        mockS3Client.send.mockResolvedValue({
          Body: { transformToString: () => Promise.resolve('invalid json') },
        })
        await expect(
          storage.loadManifest({ location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID } })
        ).rejects.toThrow(SessionError)
      })
    })
  })

  describe('saveManifest', () => {
    describe('S3SnapshotStorage_When_SaveManifest_Then_PutsObject', () => {
      it('saves manifest to S3', async () => {
        const location: SnapshotLocation = { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID }
        const manifest = createTestManifest()
        mockS3Client.send.mockResolvedValue({})

        await storage.saveManifest({ location, manifest })

        expect(mockS3Client.send).toHaveBeenCalledWith(
          expect.objectContaining({
            input: {
              Bucket: 'test-bucket',
              Key: `test-session/scopes/agent/${SCOPE_ID}/snapshots/manifest.json`,
              Body: JSON.stringify(manifest, null, 2),
              ContentType: 'application/json',
            },
          })
        )
      })
    })

    describe('S3SnapshotStorage_When_SaveManifestFails_Then_ThrowsSessionError', () => {
      it('throws SessionError when S3 put fails', async () => {
        mockS3Client.send.mockRejectedValue(new Error('S3 error'))
        await expect(
          storage.saveManifest({
            location: { sessionId: 'test-session', scope: 'agent', scopeId: SCOPE_ID },
            manifest: createTestManifest(),
          })
        ).rejects.toThrow(SessionError)
      })
    })
  })
})
