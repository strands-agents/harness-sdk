import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { InMemoryStorage } from '../in-memory-storage.js'
import { StorageError } from '../../errors.js'
import type { SearchStrategy } from '../search/types.js'

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

  describe('constructor', () => {
    const fakeStrategy = (): SearchStrategy<InMemoryStorage> & { index: Mock; search: Mock } => ({
      index: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([{ key: 'hit', score: 1 }]),
    })

    it('indexes writes and delegates search to a searchStrategy from config', async () => {
      const strategy = fakeStrategy()
      const configured = new InMemoryStorage({ searchStrategy: strategy })

      await configured.write('a', new Uint8Array([1]))
      expect(strategy.index).toHaveBeenCalledWith(configured, 'a', new Uint8Array([1]))
      expect(await configured.search('query')).toEqual([{ key: 'hit', score: 1 }])
    })

    it('accepts a positional search strategy', async () => {
      const strategy = fakeStrategy()
      const positional = new InMemoryStorage(strategy)

      await positional.write('a', new Uint8Array([1]))
      expect(strategy.index).toHaveBeenCalledTimes(1)
      await positional.search('query')
      expect(strategy.search).toHaveBeenCalledTimes(1)
    })

    it('uses the default keyword scan with an empty config', async () => {
      const configured = new InMemoryStorage({})
      await configured.write('notes', new TextEncoder().encode('dark mode'))
      expect((await configured.search('dark')).map((result) => result.key)).toEqual(['notes'])
    })
  })
})
