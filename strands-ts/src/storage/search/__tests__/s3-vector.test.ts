import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn()
const mockS3VectorsClient = vi.fn(function (this: { send: typeof mockSend }) {
  this.send = mockSend
} as unknown as () => void)
const mockPutVectorsCommand = vi.fn()
const mockQueryVectorsCommand = vi.fn()
const mockDeleteVectorsCommand = vi.fn()

vi.mock('@aws-sdk/client-s3vectors', () => ({
  S3VectorsClient: mockS3VectorsClient,
  PutVectorsCommand: mockPutVectorsCommand,
  QueryVectorsCommand: mockQueryVectorsCommand,
  DeleteVectorsCommand: mockDeleteVectorsCommand,
}))

const { defaultEmbedder, mockBedrockEmbedder } = vi.hoisted(() => {
  const defaultEmbedder = vi.fn()
  return { defaultEmbedder, mockBedrockEmbedder: vi.fn(() => defaultEmbedder) }
})
vi.mock('../../embeddings/bedrock.js', () => ({ bedrockEmbedder: mockBedrockEmbedder }))

import type { SearchStrategy } from '../types.js'
import type { LocalFileStorage } from '../../local-file-storage.js'
import type { InMemoryStorage } from '../../in-memory-storage.js'
import { S3VectorSearchStrategy } from '../s3-vector.js'
import { S3Storage } from '../../s3-storage.js'
import { StorageError } from '../../../errors.js'

describe('S3VectorSearchStrategy', () => {
  const fakeEmbedder = vi.fn()
  const storage = new S3Storage('my-bucket')

  beforeEach(() => {
    vi.clearAllMocks()
    fakeEmbedder.mockResolvedValue([0.1, 0.2, 0.3])
    defaultEmbedder.mockResolvedValue([0.9, 0.8])
  })

  describe('index', () => {
    it('embeds content and puts a vector', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
      })

      await strategy.index(storage, 'notes/meeting.md', new TextEncoder().encode('discuss roadmap'))

      expect(fakeEmbedder).toHaveBeenCalledWith('discuss roadmap')
      expect(mockPutVectorsCommand).toHaveBeenCalledWith({
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        vectors: [{ key: 'notes/meeting.md', data: { float32: [0.1, 0.2, 0.3] } }],
      })
      expect(mockSend).toHaveBeenCalledTimes(1)
    })
  })

  describe('search', () => {
    it('embeds the query and returns ranked results', async () => {
      mockSend.mockResolvedValue({
        vectors: [
          { key: 'notes/a.md', distance: 0.1 },
          { key: 'notes/b.md', distance: 0.5 },
        ],
      })
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
      })

      const results = await strategy.search(storage, 'roadmap planning')

      expect(fakeEmbedder).toHaveBeenCalledWith('roadmap planning')
      expect(mockQueryVectorsCommand).toHaveBeenCalledWith({
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        queryVector: { float32: [0.1, 0.2, 0.3] },
        topK: 10,
        returnDistance: true,
      })
      expect(results).toEqual([
        { key: 'notes/a.md', score: 1 / 1.1 },
        { key: 'notes/b.md', score: 1 / 1.5 },
      ])
    })

    it('uses custom maxResults', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder, maxResults: 5 })

      await strategy.search(storage, 'test')

      expect(mockQueryVectorsCommand).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }))
    })

    it('returns empty array when no vectors match', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      const results = await strategy.search(storage, 'nothing')

      expect(results).toEqual([])
    })
  })

  describe('remove', () => {
    it('deletes the vector for the key without embedding', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
      })

      await strategy.remove(storage, 'notes/meeting.md')

      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith({
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        keys: ['notes/meeting.md'],
      })
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(fakeEmbedder).not.toHaveBeenCalled()
    })
  })

  describe('defaults', () => {
    it('derives the vector bucket and index from the storage', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await strategy.index(storage, 'a.md', new TextEncoder().encode('hi'))
      await strategy.remove(storage, 'a.md')

      expect(mockPutVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ vectorBucketName: 'my-bucket-vectors', indexName: 'default' })
      )
      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ vectorBucketName: 'my-bucket-vectors', indexName: 'default' })
      )
    })

    it('uses the Bedrock embedder in the storage region when none is given', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy()

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q')
      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q2')

      expect(mockBedrockEmbedder).toHaveBeenCalledTimes(1)
      expect(mockBedrockEmbedder).toHaveBeenCalledWith({ region: 'eu-west-1' })
      expect(defaultEmbedder).toHaveBeenCalledWith('q')
      expect(mockQueryVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ queryVector: { float32: [0.9, 0.8] } })
      )
    })

    it('uses the default region chain for the embedder when the storage has no region', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy()

      await strategy.search(storage, 'q')

      expect(mockBedrockEmbedder).toHaveBeenCalledWith(undefined)
      expect(mockS3VectorsClient).toHaveBeenCalledWith({})
    })

    it('creates the S3 Vectors client in the storage region', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q')

      expect(mockS3VectorsClient).toHaveBeenCalledWith({ region: 'eu-west-1' })
    })

    it('prefers an explicit region over the storage region', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ region: 'us-west-2' })

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q')

      expect(mockS3VectorsClient).toHaveBeenCalledWith({ region: 'us-west-2' })
      expect(mockBedrockEmbedder).toHaveBeenCalledWith({ region: 'us-west-2' })
    })
  })

  describe('client', () => {
    it('throws when both s3VectorsClient and region are provided', () => {
      expect(
        () => new S3VectorSearchStrategy({ s3VectorsClient: { send: mockSend } as never, region: 'us-west-2' })
      ).toThrow(StorageError)
    })

    it('accepts a pre-configured client', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        s3VectorsClient: { send: mockSend } as never,
      })

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'test')

      expect(mockS3VectorsClient).not.toHaveBeenCalled()
      expect(mockSend).toHaveBeenCalled()
    })
  })

  describe('prefixes', () => {
    it('keys vectors by the prefixed object key so prefixed storages do not collide', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })
      const tenantA = new S3Storage('b', { prefix: 'tenant-a' })

      await strategy.index(tenantA, 'doc.md', new TextEncoder().encode('hi'))
      await strategy.remove(tenantA, 'doc.md')

      expect(mockPutVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ vectors: [{ key: 'tenant-a/doc.md', data: { float32: [0.1, 0.2, 0.3] } }] })
      )
      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith(expect.objectContaining({ keys: ['tenant-a/doc.md'] }))
    })

    it('returns only keys under the storage prefix, with the prefix stripped', async () => {
      mockSend.mockResolvedValue({
        vectors: [
          { key: 'tenant-b/doc.md', distance: 0 },
          { key: 'tenant-a/doc.md', distance: 0.5 },
        ],
      })
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      const results = await strategy.search(new S3Storage('b', { prefix: 'tenant-a/' }), 'q')

      expect(results).toEqual([{ key: 'doc.md', score: 1 / 1.5 }])
    })

    it('drops results with no key', async () => {
      mockSend.mockResolvedValue({ vectors: [{ distance: 0.1 }, { key: 'a.md', distance: 0.1 }] })
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      const results = await strategy.search(storage, 'q')

      expect(results).toEqual([{ key: 'a.md', score: 1 / 1.1 }])
    })
  })

  describe('non-text values', () => {
    it.each([
      ['empty', new Uint8Array()],
      ['binary', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])],
    ])('skips indexing %s values', async (_label, data) => {
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await strategy.index(storage, 'logo.png', data)

      expect(fakeEmbedder).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('failures', () => {
    it('propagates embedder errors from index without calling PutVectors', async () => {
      fakeEmbedder.mockRejectedValue(new Error('ThrottlingException'))
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await expect(strategy.index(storage, 'a.md', new TextEncoder().encode('hi'))).rejects.toThrow(
        'ThrottlingException'
      )
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('propagates PutVectors errors', async () => {
      mockSend.mockRejectedValue(new Error('NotFoundException'))
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await expect(strategy.index(storage, 'a.md', new TextEncoder().encode('hi'))).rejects.toThrow('NotFoundException')
    })

    it('propagates QueryVectors errors', async () => {
      mockSend.mockRejectedValue(new Error('NotFoundException'))
      const strategy = new S3VectorSearchStrategy({ embedder: fakeEmbedder })

      await expect(strategy.search(storage, 'q')).rejects.toThrow('NotFoundException')
    })
  })

  describe('types', () => {
    it('only attaches to S3Storage', () => {
      const strategy = new S3VectorSearchStrategy()
      const forS3: SearchStrategy<S3Storage> = strategy
      // @ts-expect-error -- S3VectorSearchStrategy is S3Storage-only
      const forLocal: SearchStrategy<LocalFileStorage> = strategy
      // @ts-expect-error -- S3VectorSearchStrategy is S3Storage-only
      const forMemory: SearchStrategy<InMemoryStorage> = strategy
      expect([forS3, forLocal, forMemory]).toHaveLength(3)
    })
  })
})
