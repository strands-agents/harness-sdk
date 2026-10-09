import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InMemoryStorage } from '../in-memory-storage.js'
import { StorageError } from '../../errors.js'

describe('InMemoryStorage', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = new InMemoryStorage()
  })

  describe('write', () => {
    it('stores data under the given key', async () => {
      const data = new TextEncoder().encode('hello')
      await storage.write('test/key', data)
      const result = await storage.read('test/key')
      expect(result).toEqual(data)
    })

    it('overwrites existing data', async () => {
      await storage.write('key', new TextEncoder().encode('first'))
      await storage.write('key', new TextEncoder().encode('second'))
      const result = await storage.read('key')
      expect(new TextDecoder().decode(result!)).toBe('second')
    })

    it('copies bytes on write to prevent aliasing', async () => {
      const data = new Uint8Array([1, 2, 3])
      await storage.write('key', data)
      data[0] = 99
      const result = await storage.read('key')
      expect(result![0]).toBe(1)
    })
  })

  describe('read', () => {
    it('returns null for missing keys', async () => {
      const result = await storage.read('nonexistent')
      expect(result).toBeNull()
    })

    it('copies bytes on read to prevent aliasing', async () => {
      await storage.write('key', new Uint8Array([1, 2, 3]))
      const first = await storage.read('key')
      first![0] = 99
      const second = await storage.read('key')
      expect(second![0]).toBe(1)
    })
  })

  describe('delete', () => {
    it('removes an existing key', async () => {
      await storage.write('key', new Uint8Array([1]))
      await storage.delete('key')
      const result = await storage.read('key')
      expect(result).toBeNull()
    })

    it('is a no-op for missing keys', async () => {
      await expect(storage.delete('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns keys matching a prefix', async () => {
      await storage.write('sessions/a/data', new Uint8Array([1]))
      await storage.write('sessions/b/data', new Uint8Array([2]))
      await storage.write('memory/notes', new Uint8Array([3]))

      const keys = await storage.list('sessions/')
      expect(keys).toEqual(['sessions/a/data', 'sessions/b/data'])
    })

    it('returns all keys when prefix is empty', async () => {
      await storage.write('a', new Uint8Array([1]))
      await storage.write('b', new Uint8Array([2]))

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b'])
    })

    it('returns keys sorted lexicographically', async () => {
      await storage.write('c', new Uint8Array([3]))
      await storage.write('a', new Uint8Array([1]))
      await storage.write('b', new Uint8Array([2]))

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b', 'c'])
    })

    it('returns empty array when no keys match', async () => {
      await storage.write('other/key', new Uint8Array([1]))
      const keys = await storage.list('sessions/')
      expect(keys).toEqual([])
    })
  })

  describe('clear', () => {
    it('removes all entries', async () => {
      await storage.write('a', new Uint8Array([1]))
      await storage.write('b', new Uint8Array([2]))
      storage.clear()
      const keys = await storage.list('')
      expect(keys).toEqual([])
    })
  })

  describe('searchStrategy', () => {
    it('delegates search to the configured strategy', async () => {
      const mockStrategy = {
        search: vi.fn().mockResolvedValue([{ key: 'found.md', score: 1 }]),
      }
      const custom = new InMemoryStorage({ searchStrategy: mockStrategy })
      await custom.write('found.md', new TextEncoder().encode('hello'))

      const results = await custom.search!('hello')

      expect(mockStrategy.search).toHaveBeenCalledWith(custom, 'hello')
      expect(results).toEqual([{ key: 'found.md', score: 1 }])
    })

    it('calls strategy.index on write when present', async () => {
      const mockStrategy = {
        search: vi.fn().mockResolvedValue([]),
        index: vi.fn().mockResolvedValue(undefined),
      }
      const custom = new InMemoryStorage({ searchStrategy: mockStrategy })
      const data = new TextEncoder().encode('content')

      await custom.write('doc.md', data)

      expect(mockStrategy.index).toHaveBeenCalledWith(custom, 'doc.md', data)
    })

    it('uses keyword search by default', async () => {
      await storage.write('hello-world', new TextEncoder().encode('greeting'))

      const results = await storage.search!('hello')

      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.key).toBe('hello-world')
    })
  })

  describe('key normalization', () => {
    it('normalizes slashes so equivalent keys resolve to the same entry', async () => {
      await storage.write('/a//b/', new Uint8Array([1]))
      const result = await storage.read('a/b')
      expect(result).toEqual(new Uint8Array([1]))
    })

    it('rejects empty keys', async () => {
      await expect(storage.write('', new Uint8Array([1]))).rejects.toThrow(StorageError)
    })

    it('rejects keys with .. segments', async () => {
      await expect(storage.write('a/../b', new Uint8Array([1]))).rejects.toThrow(StorageError)
    })

    it('rejects prefixes with .. segments', async () => {
      await expect(storage.list('../')).rejects.toThrow(StorageError)
    })
  })
})
