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

const { defaultEmbed, MockBedrockEmbedder } = vi.hoisted(() => {
  const defaultEmbed = vi.fn()
  const MockBedrockEmbedder = vi.fn(function (this: { embed: typeof defaultEmbed }) {
    this.embed = defaultEmbed
  } as unknown as () => void)
  return { defaultEmbed, MockBedrockEmbedder }
})
vi.mock('../../embeddings/bedrock.js', () => ({ BedrockEmbedder: MockBedrockEmbedder }))

import type { SearchStrategy } from '../types.js'
import type { LocalFileStorage } from '../../local-file-storage.js'
import type { InMemoryStorage } from '../../in-memory-storage.js'
import { S3VectorSearchStrategy } from '../s3-vector.js'
import { Embedder } from '../../embeddings/embedder.js'
import { S3Storage } from '../../s3-storage.js'

describe('S3VectorSearchStrategy', () => {
  const fakeEmbed = vi.fn()
  const fakeEmbedder = new (class extends Embedder {
    embed(text: string): Promise<number[]> {
      return fakeEmbed(text)
    }
  })()
  const target = { vectorBucketName: 'my-vectors', indexName: 'memory-index' }
  const storage = new S3Storage('my-bucket')

  beforeEach(() => {
    vi.clearAllMocks()
    fakeEmbed.mockResolvedValue([0.1, 0.2, 0.3])
    defaultEmbed.mockResolvedValue([0.9, 0.8])
  })

  describe('index', () => {
    it('embeds content and puts a vector', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await strategy.index(storage, 'notes/meeting.md', new TextEncoder().encode('discuss roadmap'))

      expect(fakeEmbed).toHaveBeenCalledWith('discuss roadmap')
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
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      const results = await strategy.search(storage, 'roadmap planning')

      expect(fakeEmbed).toHaveBeenCalledWith('roadmap planning')
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
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder, maxResults: 5 })

      await strategy.search(storage, 'test')

      expect(mockQueryVectorsCommand).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }))
    })

    it('returns empty array when no vectors match', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      const results = await strategy.search(storage, 'nothing')

      expect(results).toEqual([])
    })
  })

  describe('remove', () => {
    it('deletes the vector for the key without embedding', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await strategy.remove(storage, 'notes/meeting.md')

      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith({
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        keys: ['notes/meeting.md'],
      })
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(fakeEmbed).not.toHaveBeenCalled()
    })
  })

  describe('default embedder and client', () => {
    it('uses the Bedrock embedder in the storage region when none is given', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy(target)

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q')
      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q2')

      expect(MockBedrockEmbedder).toHaveBeenCalledTimes(1)
      expect(MockBedrockEmbedder).toHaveBeenCalledWith({ region: 'eu-west-1' })
      expect(defaultEmbed).toHaveBeenCalledWith('q')
      expect(mockQueryVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ queryVector: { float32: [0.9, 0.8] } })
      )
    })

    it('creates one default embedder for concurrent first calls', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy(target)

      await Promise.all([strategy.search(storage, 'a'), strategy.search(storage, 'b')])

      expect(MockBedrockEmbedder).toHaveBeenCalledTimes(1)
    })

    it('uses the default region chain for the embedder when the storage has no region', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy(target)

      await strategy.search(storage, 'q')

      expect(MockBedrockEmbedder).toHaveBeenCalledWith(undefined)
      expect(mockS3VectorsClient).toHaveBeenCalledWith({})
    })

    it('creates the S3 Vectors client in the storage region', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await strategy.search(new S3Storage('my-bucket', { region: 'eu-west-1' }), 'q')

      expect(mockS3VectorsClient).toHaveBeenCalledWith({ region: 'eu-west-1' })
    })
  })

  describe('client', () => {
    it('accepts a pre-configured client', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({
        ...target,
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
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })
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
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      const results = await strategy.search(new S3Storage('b', { prefix: 'tenant-a/' }), 'q')

      expect(results).toEqual([{ key: 'doc.md', score: 1 / 1.5 }])
    })

    it('keys vectors by the namespace prefix and strips it on search', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })
      const scoped = new S3Storage('b', { prefix: 'agents', searchStrategy: strategy })
        .namespace('memory')
        .namespace('a')

      await strategy.index(scoped, 'x.md', new TextEncoder().encode('hi'))
      await strategy.remove(scoped, 'x.md')
      expect(mockPutVectorsCommand).toHaveBeenCalledWith(
        expect.objectContaining({ vectors: [expect.objectContaining({ key: 'agents/memory/a/x.md' })] })
      )
      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith(expect.objectContaining({ keys: ['agents/memory/a/x.md'] }))

      mockSend.mockResolvedValue({
        vectors: [
          { key: 'agents/memory/a/x.md', distance: 0 },
          { key: 'agents/memory/b/y.md', distance: 0 },
        ],
      })
      expect(await strategy.search(scoped, 'q')).toEqual([{ key: 'x.md', score: 1 }])
    })

    it('drops results with no key', async () => {
      mockSend.mockResolvedValue({ vectors: [{ distance: 0.1 }, { key: 'a.md', distance: 0.1 }] })
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      const results = await strategy.search(storage, 'q')

      expect(results).toEqual([{ key: 'a.md', score: 1 / 1.1 }])
    })
  })

  describe('non-text values', () => {
    it.each([
      ['empty', new Uint8Array()],
      ['binary', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe])],
    ])('does not embed %s values and removes any previous vector for the key', async (_label, data) => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await strategy.index(storage, 'notes.md', new TextEncoder().encode('old text'))
      await strategy.index(storage, 'notes.md', data)

      expect(fakeEmbed).toHaveBeenCalledTimes(1)
      expect(mockPutVectorsCommand).toHaveBeenCalledTimes(1)
      expect(mockDeleteVectorsCommand).toHaveBeenCalledWith({ ...target, keys: ['notes.md'] })
    })
  })

  describe('failures', () => {
    it('propagates embedder errors from index without calling PutVectors', async () => {
      fakeEmbed.mockRejectedValue(new Error('ThrottlingException'))
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await expect(strategy.index(storage, 'a.md', new TextEncoder().encode('hi'))).rejects.toThrow(
        'ThrottlingException'
      )
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('propagates PutVectors errors', async () => {
      mockSend.mockRejectedValue(new Error('NotFoundException'))
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await expect(strategy.index(storage, 'a.md', new TextEncoder().encode('hi'))).rejects.toThrow('NotFoundException')
    })

    it('propagates QueryVectors errors', async () => {
      mockSend.mockRejectedValue(new Error('NotFoundException'))
      const strategy = new S3VectorSearchStrategy({ ...target, embedder: fakeEmbedder })

      await expect(strategy.search(storage, 'q')).rejects.toThrow('NotFoundException')
    })
  })

  describe('types', () => {
    it('only attaches to S3Storage', () => {
      const strategy = new S3VectorSearchStrategy(target)
      const forS3: SearchStrategy<S3Storage> = strategy
      // @ts-expect-error -- S3VectorSearchStrategy is S3Storage-only
      const forLocal: SearchStrategy<LocalFileStorage> = strategy
      // @ts-expect-error -- S3VectorSearchStrategy is S3Storage-only
      const forMemory: SearchStrategy<InMemoryStorage> = strategy
      expect([forS3, forLocal, forMemory]).toHaveLength(3)
    })
  })
})
