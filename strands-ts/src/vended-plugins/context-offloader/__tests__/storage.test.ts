import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryStorage, S3Storage } from '../storage.js'

describe('InMemoryStorage', () => {
  it('stores and retrieves text content', async () => {
    const storage = new InMemoryStorage()
    const content = new TextEncoder().encode('hello world')
    const ref = await storage.store('key1', content, 'text/plain')

    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('hello world')
    expect(result.contentType).toBe('text/plain')
  })

  it('stores and retrieves binary content', async () => {
    const storage = new InMemoryStorage()
    const content = new Uint8Array([1, 2, 3, 4, 5])
    const ref = await storage.store('key1', content, 'image/png')

    const result = await storage.retrieve(ref)
    expect(result.content).toEqual(content)
    expect(result.contentType).toBe('image/png')
  })

  it('generates unique references', async () => {
    const storage = new InMemoryStorage()
    const content = new TextEncoder().encode('test')
    const ref1 = await storage.store('key1', content)
    const ref2 = await storage.store('key2', content)
    expect(ref1).not.toBe(ref2)
  })

  it('uses mem_ prefix in references', async () => {
    const storage = new InMemoryStorage()
    const ref = await storage.store('mykey', new TextEncoder().encode('test'))
    expect(ref).toMatch(/^mem_\d+_mykey$/)
  })

  it('throws on missing reference', async () => {
    const storage = new InMemoryStorage()
    await expect(storage.retrieve('nonexistent')).rejects.toThrow('Reference not found: nonexistent')
  })

  it('clears all stored content', async () => {
    const storage = new InMemoryStorage()
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    storage.clear()
    await expect(storage.retrieve(ref)).rejects.toThrow('Reference not found')
  })

  it('defaults content type to text/plain', async () => {
    const storage = new InMemoryStorage()
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    const result = await storage.retrieve(ref)
    expect(result.contentType).toBe('text/plain')
  })
})

describe('InMemoryStorage eviction', () => {
  it('eviction enabled by default (20 cycles)', async () => {
    const storage = new InMemoryStorage()
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    storage._evict(21)
    await expect(storage.retrieve(ref)).rejects.toThrow('Reference not found')
  })

  it('eviction disabled with null', async () => {
    const storage = new InMemoryStorage(null)
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    storage._evict(100)
    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('test')
  })

  it('throws on invalid evictAfterTurns', () => {
    expect(() => new InMemoryStorage(0)).toThrow('evictAfterTurns must be a positive integer')
    expect(() => new InMemoryStorage(-1)).toThrow('evictAfterTurns must be a positive integer')
  })

  it('entry survives within TTL', async () => {
    const storage = new InMemoryStorage(3)
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    // stored at cycle 0, evict at cycle 3: threshold = 3 - 3 = 0, 0 < 0 is false
    storage._evict(3)
    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('test')
  })

  it('entry evicted past TTL', async () => {
    const storage = new InMemoryStorage(2)
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    // stored at cycle 0, evict at cycle 3: threshold = 3 - 2 = 1, 0 < 1 → evicted
    storage._evict(3)
    await expect(storage.retrieve(ref)).rejects.toThrow('Reference not found')
  })

  it('retrieve refreshes last accessed cycle', async () => {
    const storage = new InMemoryStorage(2)
    const ref = await storage.store('key1', new TextEncoder().encode('test'))
    storage._evict(1)
    await storage.retrieve(ref) // refreshes to cycle 1
    // threshold at cycle 3 = 3 - 2 = 1, last_accessed = 1, 1 < 1 is false
    storage._evict(3)
    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('test')
  })

  it('multiple entries evicted independently', async () => {
    const storage = new InMemoryStorage(2)
    const ref1 = await storage.store('key1', new TextEncoder().encode('first'))
    storage._evict(1)
    const ref2 = await storage.store('key2', new TextEncoder().encode('second'))
    // threshold at cycle 3 = 3 - 2 = 1. ref1 at 0 (evicted), ref2 at 1 (survives)
    storage._evict(3)
    await expect(storage.retrieve(ref1)).rejects.toThrow('Reference not found')
    const result = await storage.retrieve(ref2)
    expect(new TextDecoder().decode(result.content)).toBe('second')
  })

  it('rejects shared storage across agents', () => {
    const storage = new InMemoryStorage()
    const agentA = {}
    const agentB = {}
    storage._bind(agentA)
    expect(() => storage._bind(agentB)).toThrow('cannot be shared')
  })

  it('allows same agent repeated bind', () => {
    const storage = new InMemoryStorage()
    const agent = {}
    storage._bind(agent)
    storage._bind(agent)
  })
})

describe('S3Storage', () => {
  let mockSend: ReturnType<typeof vi.fn>
  let mockS3Client: { send: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockSend = vi.fn()
    mockS3Client = { send: mockSend }
  })

  describe('store', () => {
    it('returns s3:// URI as reference', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket', { s3Client: mockS3Client as never })

      const ref = await storage.store('key1', new TextEncoder().encode('test'), 'text/plain')

      expect(ref).toMatch(/^s3:\/\/my-bucket\//)
      expect(ref).toContain('key1')
    })

    it('includes prefix in s3 key', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket', { prefix: 'artifacts', s3Client: mockS3Client as never })

      const ref = await storage.store('key1', new TextEncoder().encode('test'))

      expect(ref).toMatch(/^s3:\/\/my-bucket\/artifacts\//)
    })

    it('normalizes trailing slashes on prefix', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('b', { prefix: 'p///', s3Client: mockS3Client as never })

      const ref = await storage.store('k', new TextEncoder().encode('x'))

      expect(ref).toMatch(/^s3:\/\/b\/p\//)
      // Check no double slashes in the path portion (after s3://)
      const pathPortion = ref.replace('s3://', '')
      expect(pathPortion).not.toContain('//')
    })

    it('sends correct PutObject params', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('my-bucket', { s3Client: mockS3Client as never })
      const content = new TextEncoder().encode('hello')

      await storage.store('key1', content, 'application/json')

      expect(mockSend).toHaveBeenCalledOnce()
      const command = mockSend.mock.calls[0]![0]
      expect(command.input.Bucket).toBe('my-bucket')
      expect(command.input.Body).toBe(content)
      expect(command.input.ContentType).toBe('application/json')
    })

    it('sanitizes keys', async () => {
      mockSend.mockResolvedValue({})
      const storage = new S3Storage('b', { s3Client: mockS3Client as never })

      const ref = await storage.store('../../etc/passwd', new TextEncoder().encode('x'))

      expect(ref).not.toContain('..')
      expect(ref).not.toContain('etc/passwd')
    })
  })

  describe('retrieve', () => {
    it('retrieves content by s3:// URI', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3])) },
        ContentType: 'image/png',
      })

      const storage = new S3Storage('my-bucket', { s3Client: mockS3Client as never })
      const ref = await storage.store('key1', new Uint8Array([1, 2, 3]), 'image/png')
      const result = await storage.retrieve(ref)

      expect(result.content).toEqual(new Uint8Array([1, 2, 3]))
      expect(result.contentType).toBe('image/png')
    })

    it('retrieves content by raw key', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('hello')) },
        ContentType: 'text/plain',
      })

      const storage = new S3Storage('b', { s3Client: mockS3Client as never })
      const result = await storage.retrieve('some/raw/key')

      expect(new TextDecoder().decode(result.content)).toBe('hello')
      const command = mockSend.mock.calls[0]![0]
      expect(command.input.Key).toBe('some/raw/key')
    })

    it('round-trips a stored reference under a configured prefix', async () => {
      mockSend.mockResolvedValueOnce({}).mockResolvedValueOnce({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('hello')) },
        ContentType: 'text/plain',
      })

      const storage = new S3Storage('b', { prefix: 'artifacts', s3Client: mockS3Client as never })
      const ref = await storage.store('key1', new TextEncoder().encode('hello'))
      const result = await storage.retrieve(ref)

      expect(new TextDecoder().decode(result.content)).toBe('hello')
    })

    it('throws on bucket mismatch', async () => {
      const storage = new S3Storage('my-bucket', { s3Client: mockS3Client as never })

      await expect(storage.retrieve('s3://wrong-bucket/key')).rejects.toThrow('bucket mismatch')
    })

    it('rejects a raw key outside the configured prefix', async () => {
      const storage = new S3Storage('b', { prefix: 'artifacts', s3Client: mockS3Client as never })

      await expect(storage.retrieve('private/secret.txt')).rejects.toThrow('Reference not found')
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('rejects a same-bucket s3:// URI outside the configured prefix', async () => {
      const storage = new S3Storage('b', { prefix: 'artifacts', s3Client: mockS3Client as never })

      await expect(storage.retrieve('s3://b/private/secret.txt')).rejects.toThrow('Reference not found')
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('rejects a sibling-prefix key that shares a string prefix but not a path segment', async () => {
      const storage = new S3Storage('b', { prefix: 'artifacts', s3Client: mockS3Client as never })

      await expect(storage.retrieve('artifactsX/secret.txt')).rejects.toThrow('Reference not found')
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('preserves a leading-slash prefix so legacy references remain retrievable', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('hello')) },
        ContentType: 'text/plain',
      })
      const storage = new S3Storage('b', { prefix: '/artifacts', s3Client: mockS3Client as never })
      const result = await storage.retrieve('s3://b//artifacts/foo')

      expect(new TextDecoder().decode(result.content)).toBe('hello')
      const command = mockSend.mock.calls[0]![0]
      expect(command.input.Key).toBe('/artifacts/foo')
    })

    it('throws on NoSuchKey error', async () => {
      const noSuchKey = new Error('not found')
      noSuchKey.name = 'NoSuchKey'
      mockSend.mockRejectedValue(noSuchKey)

      const storage = new S3Storage('b', { s3Client: mockS3Client as never })

      await expect(storage.retrieve('missing-key')).rejects.toThrow('Reference not found')
    })

    it('defaults contentType to application/octet-stream when missing', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([0])) },
      })

      const storage = new S3Storage('b', { s3Client: mockS3Client as never })
      const result = await storage.retrieve('key')

      expect(result.contentType).toBe('application/octet-stream')
    })

    it('rethrows non-NoSuchKey errors', async () => {
      const networkError = new Error('network timeout')
      mockSend.mockRejectedValue(networkError)

      const storage = new S3Storage('b', { s3Client: mockS3Client as never })

      await expect(storage.retrieve('key')).rejects.toThrow('network timeout')
    })
  })
})
