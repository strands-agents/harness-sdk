import { describe, it, expect } from 'vitest'
import { Stash } from '../stash.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'

describe('Stash', () => {
  describe('store and retrieve', () => {
    it('round-trips text content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { type: 'text', text: 'hello world' }
      const ref = await stash.store('tool-123', 0, new TextEncoder().encode(JSON.stringify(data)))

      expect(ref).toContain('tool-123')

      const result = await stash.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('round-trips JSON content', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { key: 'value', count: 42 }
      const ref = await stash.store('tool-456', 1, new TextEncoder().encode(JSON.stringify(data)))

      const result = await stash.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('returns null for unknown references', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const result = await stash.retrieve('nonexistent')
      expect(result).toBeNull()
    })

    it('produces deterministic keys from the same id and blockIndex', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-1', 0, content)
      const ref2 = await stash.store('tool-1', 0, content)

      expect(ref1).toBe(ref2)
    })

    it('produces different keys for different id or blockIndex', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-1', 0, content)
      const ref2 = await stash.store('tool-1', 1, content)
      const ref3 = await stash.store('tool-2', 0, content)

      expect(ref1).not.toBe(ref2)
      expect(ref1).not.toBe(ref3)
    })
  })

  describe('list', () => {
    it('lists all stored references', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await stash.store('tool-a', 0, content)
      const ref2 = await stash.store('tool-b', 0, content)

      const keys = await stash.list()
      expect(keys).toContain(ref1)
      expect(keys).toContain(ref2)
    })
  })

  describe('delete', () => {
    it('removes a stashed entry', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref = await stash.store('tool-x', 0, content)

      await stash.delete(ref)
      const result = await stash.retrieve(ref)
      expect(result).toBeNull()
    })
  })

  describe('namespacing', () => {
    it('does not conflict with other storage users', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage, 'test-session', 'test-agent')

      const content = new TextEncoder().encode(JSON.stringify('stash data'))
      await stash.store('tool-1', 0, content)

      await storage.write('other-key', new TextEncoder().encode('other'))

      const topKeys = await storage.list('')
      expect(topKeys.some((key) => key.startsWith('context/'))).toBe(true)
      expect(topKeys).toContain('other-key')
    })
  })
})
