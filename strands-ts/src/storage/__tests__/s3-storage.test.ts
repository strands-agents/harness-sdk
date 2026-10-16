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
import { NAMESPACED } from '../storage.js'

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

  describe('namespace', () => {
    it('returns a scoped S3Storage that writes under the combined prefix', async () => {
      mockSend.mockResolvedValue({})
      const scoped = new S3Storage('my-bucket', { prefix: 'agents/' }).namespace('memory/agent')
      const data = new TextEncoder().encode('payload')

      await scoped.write('notes.md', data)

      expect(scoped).toBeInstanceOf(S3Storage)
      expect(NAMESPACED in scoped).toBe(true)
      expect(mockPutObjectCommand).toHaveBeenCalledWith({
        Bucket: 'my-bucket',
        Key: 'agents/memory/agent/notes.md',
        Body: data,
      })
    })

    it('lists only under the combined prefix and strips it', async () => {
      mockSend.mockResolvedValue({ Contents: [{ Key: 'agents/memory/agent/notes.md' }], IsTruncated: false })
      const scoped = new S3Storage('my-bucket', { prefix: 'agents' }).namespace('memory/agent/')

      const keys = await scoped.list('')

      expect(mockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: 'my-bucket', Prefix: 'agents/memory/agent/' })
      )
      expect(keys).toEqual(['notes.md'])
    })

    it('shares the parent S3 client', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket')
      const scoped = storage.namespace('a').namespace('b')

      await scoped.write('k', new Uint8Array([1]))
      await storage.write('k', new Uint8Array([1]))

      expect(mockS3Client).toHaveBeenCalledTimes(1)
      expect(mockPutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({ Key: 'a/b/k' }))
    })

    it('passes the scoped instance and relative keys to the search strategy', async () => {
      mockSend.mockResolvedValue({})
      const strategy = { index: vi.fn(), search: vi.fn().mockResolvedValue([]) }
      const scoped = new S3Storage('my-bucket', { searchStrategy: strategy }).namespace('memory')

      await scoped.write('deploy.md', new Uint8Array([1]))
      await scoped.search('query')

      expect(strategy.index).toHaveBeenCalledWith(scoped, 'deploy.md', expect.any(Uint8Array))
      expect(strategy.search).toHaveBeenCalledWith(scoped, 'query')
    })
  })
})
