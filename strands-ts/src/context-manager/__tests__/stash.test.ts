import { describe, it, expect } from 'vitest'
import { Stash, formatStashKey, parseStashKey } from '../stash.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'

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

  describe('caller-scoped root', () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

    it('uses the view as the exact root', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage.namespace('tenants/t1/research'), 'sess-1', 'agent-a', {
        customStashNamespace: true,
      })
      await stash.store('tool-1', 0, bytes({ text: 'test' }))

      expect(await storage.list('')).toStrictEqual(['tenants/t1/research/tool-1_0'])
    })

    it('uses the per-agent root under a view unless allowed', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage.namespace('tenant'), 'sess-1', 'agent-a')
      await stash.store('tool-1', 0, bytes({ text: 'test' }))

      expect(await storage.list('')).toStrictEqual(['tenant/context/sess-1/scopes/agent/agent-a/tool-1_0'])
    })

    it('lets agents in different sessions sharing a view read each other entries', async () => {
      const storage = new InMemoryStorage()
      const stashA = new Stash(storage.namespace('team'), 'sess-1', 'agent-a', { customStashNamespace: true })
      const stashB = new Stash(storage.namespace('team'), 'sess-2', 'agent-b', { customStashNamespace: true })
      await stashA.store('tool-1', 0, bytes({ text: 'from a' }))

      expect(await stashB.retrieve('tool-1_0')).toStrictEqual({ data: { text: 'from a' } })
    })

    it('keeps a shared view on clearSession', async () => {
      const storage = new InMemoryStorage()
      const stash = new Stash(storage.namespace('team'), 'sess-1', 'agent-a', { customStashNamespace: true })
      await stash.store('tool-1', 0, bytes({ text: 'shared' }))

      await stash.clearSession()

      expect(await storage.list('')).toStrictEqual(['team/tool-1_0'])
    })
  })

  describe('stash keys', () => {
    it.each([
      { id: 'tu-1', index: 0 },
      { id: 'call_12', index: 3 },
      { id: 'removed-0199-abc', index: 0 },
    ])('round-trips $id_$index', (key) => {
      expect(parseStashKey(formatStashKey(key))).toEqual(key)
    })

    it.each(['tu-1', 'tu-1_', '_0', 'tu-1_x', 'tu-1_1a'])('rejects %j', (key) => {
      expect(parseStashKey(key)).toBeNull()
    })
  })

  describe('offload placeholders', () => {
    it('ensureStashed references a tool result by its toolUseId and any other block by its position', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const toolResult = new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('a')] })
      const message = new Message({ role: 'user', content: [new TextBlock('t'), toolResult], trackingId: 'track-1' })

      expect(await stash.ensureStashed(toolResult, message, 1)).toBe('tu-1')
      expect(await stash.ensureStashed(message.content[0]!, message, 0)).toBe('track-1_0')
      expect(await stash.takeSnapshot()).toStrictEqual({ 'tu-1_0': { text: 'a' }, 'track-1_0': { text: 't' } })
    })

    it('ensureStashed leaves an entry already stored under the reference untouched', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      await stash.store('track-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'original' })))
      const message = new Message({ role: 'user', content: [new TextBlock('edited')], trackingId: 'track-1' })

      expect(await stash.ensureStashed(message.content[0]!, message, 0)).toBe('track-1_0')
      expect(await stash.retrieve('track-1_0')).toStrictEqual({ data: { text: 'original' } })
    })

    it('skips a placeholder and a tool result that holds one, keeping other blocks', async () => {
      const stash = new Stash(new InMemoryStorage(), 'test-session', 'test-agent')
      const message = new Message({
        role: 'user',
        content: [
          new TextBlock('[Dropped] [ref: track-0_0]', {
            metadata: { offloaded: { method: 'drop', ref: 'track-0_0', preview: '[Dropped]' } },
          }),
          new ToolResultBlock({
            toolUseId: 'tu-1',
            status: 'success',
            content: [
              new TextBlock('[Truncated: 1 block, ~10,973 tokens]\n\nrow-1 [ref: tu-1]', {
                metadata: {
                  offloaded: {
                    method: 'truncate',
                    ref: 'tu-1',
                    preview: '[Truncated: 1 block, ~10,973 tokens]\n\nrow-1',
                  },
                },
              }),
              new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
            ],
          }),
          new TextBlock('kept'),
        ],
        trackingId: 'track-1',
      })

      await stash.storeMessage(message)

      expect(await stash.takeSnapshot()).toStrictEqual({ 'track-1_2': { text: 'kept' } })
    })
  })
})
