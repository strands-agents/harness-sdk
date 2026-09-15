import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StorageError } from '../../errors.js'

const mockSend = vi.fn()
const mockS3Client = vi.fn(function (this: { send: typeof mockSend }) {
  this.send = mockSend
} as unknown as () => void)
const mockPutObjectCommand = vi.fn()
const mockGetObjectCommand = vi.fn()
const mockDeleteObjectCommand = vi.fn()
const mockListObjectsV2Command = vi.fn()

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: mockS3Client,
  PutObjectCommand: mockPutObjectCommand,
  GetObjectCommand: mockGetObjectCommand,
  DeleteObjectCommand: mockDeleteObjectCommand,
  ListObjectsV2Command: mockListObjectsV2Command,
}))

import { S3Storage } from '../s3-storage.js'

describe('S3Storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('throws when both s3Client and region are provided', () => {
      const client = { send: vi.fn() } as never
      expect(() => new S3Storage('bucket', { s3Client: client, region: 'us-west-2' })).toThrow(StorageError)
    })

    it('accepts just a bucket name', () => {
      expect(() => new S3Storage('my-bucket')).not.toThrow()
    })
  })

  describe('write', () => {
    it('sends a PutObjectCommand with the correct params', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket', { prefix: 'agents/' })
      const data = new TextEncoder().encode('payload')

      await storage.write('sessions/abc/data.json', data)

      expect(mockPutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'agents/sessions/abc/data.json',
        Body: data,
      })
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it('wraps SDK errors in StorageError', async () => {
      mockSend.mockRejectedValue(new Error('AccessDenied'))
      const storage = new S3Storage('my-bucket')

      await expect(storage.write('key', new Uint8Array([1]))).rejects.toThrow(StorageError)
    })
  })

  describe('read', () => {
    it('returns bytes when the object exists', async () => {
      const bytes = new Uint8Array([1, 2, 3])
      mockSend.mockResolvedValue({ Body: { transformToByteArray: () => Promise.resolve(bytes) } })
      const storage = new S3Storage('my-bucket')

      const result = await storage.read('some/key')
      expect(result).toEqual(bytes)
    })

    it('returns null for NoSuchKey', async () => {
      const error = new Error('NoSuchKey')
      error.name = 'NoSuchKey'
      mockSend.mockRejectedValue(error)
      const storage = new S3Storage('my-bucket')

      const result = await storage.read('missing')
      expect(result).toBeNull()
    })

    it('returns null for NotFound', async () => {
      const error = new Error('NotFound')
      error.name = 'NotFound'
      mockSend.mockRejectedValue(error)
      const storage = new S3Storage('my-bucket')

      const result = await storage.read('missing')
      expect(result).toBeNull()
    })

    it('wraps other errors in StorageError', async () => {
      mockSend.mockRejectedValue(new Error('NetworkFailure'))
      const storage = new S3Storage('my-bucket')

      await expect(storage.read('key')).rejects.toThrow(StorageError)
    })
  })

  describe('delete', () => {
    it('sends a DeleteObjectCommand', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket', { prefix: 'p/' })

      await storage.delete('key')

      expect(mockDeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'p/key',
      })
    })

    it('wraps errors in StorageError', async () => {
      mockSend.mockRejectedValue(new Error('InternalError'))
      const storage = new S3Storage('my-bucket')

      await expect(storage.delete('key')).rejects.toThrow(StorageError)
    })
  })

  describe('searchStrategy', () => {
    it('delegates search to the configured strategy', async () => {
      const mockStrategy = {
        search: vi.fn().mockResolvedValue([{ key: 'found.md', score: 1 }]),
      }
      const storage = new S3Storage('my-bucket', { searchStrategy: mockStrategy })

      const results = await storage.search!('hello')

      expect(mockStrategy.search).toHaveBeenCalledWith(storage, 'hello')
      expect(results).toEqual([{ key: 'found.md', score: 1 }])
    })

    it('calls strategy.index on write when present', async () => {
      mockSend.mockResolvedValue({})
      const mockStrategy = {
        search: vi.fn().mockResolvedValue([]),
        index: vi.fn().mockResolvedValue(undefined),
      }
      const storage = new S3Storage('my-bucket', { searchStrategy: mockStrategy })
      const data = new TextEncoder().encode('content')

      await storage.write('doc.md', data)

      expect(mockStrategy.index).toHaveBeenCalledWith(storage, 'doc.md', data)
    })

    it('wires up S3VectorSearchStrategy from embeddings config', () => {
      const embedder = vi.fn().mockResolvedValue([0.1, 0.2])
      const storage = new S3Storage('my-bucket', {
        embeddings: { embedder, vectorBucketName: 'vecs', indexName: 'idx' },
      })
      expect(storage).toBeDefined()
      expect(storage.search).toBeDefined()
    })

    it('defaults vectorBucketName and indexName from bucket', () => {
      const embedder = vi.fn().mockResolvedValue([0.1, 0.2])
      const storage = new S3Storage('my-bucket', { embeddings: { embedder } })
      expect(storage).toBeDefined()
    })

    it('searchStrategy takes precedence over embeddings', async () => {
      const mockStrategy = {
        search: vi.fn().mockResolvedValue([{ key: 'x', score: 1 }]),
      }
      const embedder = vi.fn()
      const storage = new S3Storage('my-bucket', {
        searchStrategy: mockStrategy,
        embeddings: { embedder },
      })

      await storage.search!('test')

      expect(mockStrategy.search).toHaveBeenCalled()
      expect(embedder).not.toHaveBeenCalled()
    })
  })

  describe('list', () => {
    it('returns keys with prefix stripped', async () => {
      mockSend.mockResolvedValue({
        Contents: [{ Key: 'prefix/a' }, { Key: 'prefix/b/c' }],
        IsTruncated: false,
      })
      const storage = new S3Storage('my-bucket', { prefix: 'prefix/' })

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b/c'])
    })

    it('paginates until IsTruncated is false', async () => {
      mockSend
        .mockResolvedValueOnce({
          Contents: [{ Key: 'a' }],
          IsTruncated: true,
          NextContinuationToken: 'token1',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'b' }],
          IsTruncated: false,
        })
      const storage = new S3Storage('my-bucket')

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b'])
      expect(mockSend).toHaveBeenCalledTimes(2)
    })

    it('wraps errors in StorageError', async () => {
      mockSend.mockRejectedValue(new Error('BucketNotFound'))
      const storage = new S3Storage('my-bucket')

      await expect(storage.list('prefix/')).rejects.toThrow(StorageError)
    })
  })
})
