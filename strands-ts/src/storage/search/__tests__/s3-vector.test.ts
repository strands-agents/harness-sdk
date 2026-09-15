import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.fn()
const mockS3VectorsClient = vi.fn(function (this: { send: typeof mockSend }) {
  this.send = mockSend
} as unknown as () => void)
const mockPutVectorsCommand = vi.fn()
const mockQueryVectorsCommand = vi.fn()

vi.mock('@aws-sdk/client-s3vectors', () => ({
  S3VectorsClient: mockS3VectorsClient,
  PutVectorsCommand: mockPutVectorsCommand,
  QueryVectorsCommand: mockQueryVectorsCommand,
}))

import { S3VectorSearchStrategy } from '../s3-vector.js'

describe('S3VectorSearchStrategy', () => {
  const fakeEmbedder = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
  const mockStorage = { write: vi.fn(), read: vi.fn(), delete: vi.fn(), list: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    fakeEmbedder.mockResolvedValue([0.1, 0.2, 0.3])
  })

  describe('index', () => {
    it('embeds content and puts a vector', async () => {
      mockSend.mockResolvedValue({})
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
      })

      await strategy.index(mockStorage, 'notes/meeting.md', new TextEncoder().encode('discuss roadmap'))

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

      const results = await strategy.search(mockStorage, 'roadmap planning')

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
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        maxResults: 5,
      })

      await strategy.search(mockStorage, 'test')

      expect(mockQueryVectorsCommand).toHaveBeenCalledWith(expect.objectContaining({ topK: 5 }))
    })

    it('returns empty array when no vectors match', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
      })

      const results = await strategy.search(mockStorage, 'nothing')

      expect(results).toEqual([])
    })
  })

  describe('client', () => {
    it('accepts a pre-configured client', async () => {
      const customClient = { send: mockSend } as never
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        s3VectorsClient: customClient,
      })

      await strategy.search(mockStorage, 'test')

      expect(mockS3VectorsClient).not.toHaveBeenCalled()
      expect(mockSend).toHaveBeenCalled()
    })

    it('creates a client with region when specified', async () => {
      mockSend.mockResolvedValue({ vectors: [] })
      const strategy = new S3VectorSearchStrategy({
        embedder: fakeEmbedder,
        vectorBucketName: 'my-vectors',
        indexName: 'memory-index',
        region: 'us-west-2',
      })

      await strategy.search(mockStorage, 'test')

      expect(mockS3VectorsClient).toHaveBeenCalledWith({ region: 'us-west-2' })
    })
  })
})
