import { describe, it, expect } from 'vitest'
import { Archive, formatArchiveKey, parseArchiveKey } from '../archive.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { Message, TextBlock, ToolResultBlock, OffloadedBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'

describe('Archive', () => {
  describe('store and retrieve', () => {
    it('round-trips text content', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { type: 'text', text: 'hello world' }
      const ref = await archive.store('tool-123', 0, new TextEncoder().encode(JSON.stringify(data)))

      expect(ref).toContain('tool-123')

      const result = await archive.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('round-trips JSON content', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const data = { key: 'value', count: 42 }
      const ref = await archive.store('tool-456', 1, new TextEncoder().encode(JSON.stringify(data)))

      const result = await archive.retrieve(ref)
      expect(result).not.toBeNull()
      expect(result!.data).toEqual(data)
    })

    it('returns null for unknown references', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const result = await archive.retrieve('nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('list', () => {
    it('lists all stored references', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref1 = await archive.store('tool-a', 0, content)
      const ref2 = await archive.store('tool-b', 0, content)

      const keys = await archive.list()
      expect(keys).toContain(ref1)
      expect(keys).toContain(ref2)
    })
  })

  describe('delete', () => {
    it('removes an archived entry', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const content = new TextEncoder().encode(JSON.stringify('data'))
      const ref = await archive.store('tool-x', 0, content)

      await archive.delete(ref)
      const result = await archive.retrieve(ref)
      expect(result).toBeNull()
    })
  })

  describe('namespacing', () => {
    it('does not conflict with other storage users', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')

      const content = new TextEncoder().encode(JSON.stringify('archive data'))
      await archive.store('tool-1', 0, content)

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
      const archive = new Archive(storage.namespace('tenants/t1/research'), 'sess-1', 'agent-a', {
        customArchiveNamespace: true,
      })
      await archive.store('tool-1', 0, bytes({ text: 'test' }))

      expect(await storage.list('')).toStrictEqual(['tenants/t1/research/tool-1_0'])
    })

    it('uses the per-agent root under a view unless allowed', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage.namespace('tenant'), 'sess-1', 'agent-a')
      await archive.store('tool-1', 0, bytes({ text: 'test' }))

      expect(await storage.list('')).toStrictEqual(['tenant/context/sess-1/scopes/agent/agent-a/tool-1_0'])
    })

    it('lets agents in different sessions sharing a view read each other entries', async () => {
      const storage = new InMemoryStorage()
      const archiveA = new Archive(storage.namespace('team'), 'sess-1', 'agent-a', { customArchiveNamespace: true })
      const archiveB = new Archive(storage.namespace('team'), 'sess-2', 'agent-b', { customArchiveNamespace: true })
      await archiveA.store('tool-1', 0, bytes({ text: 'from a' }))

      expect(await archiveB.retrieve('tool-1_0')).toStrictEqual({ data: { text: 'from a' } })
    })

    it('keeps a shared view on clearSession', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage.namespace('team'), 'sess-1', 'agent-a', { customArchiveNamespace: true })
      await archive.store('tool-1', 0, bytes({ text: 'shared' }))

      await archive.clearSession()

      expect(await storage.list('')).toStrictEqual(['team/tool-1_0'])
    })
  })

  describe('text framing', () => {
    const ROOT = 'context/test-session/scopes/agent/test-agent'
    /** Reads the stored bytes at an exact storage key, so a test names the framing it expects. */
    const storedAt = async (storage: InMemoryStorage, key: string): Promise<string> =>
      new TextDecoder().decode((await storage.read(`${ROOT}/${key}`))!)

    it('stores a text block as its own bytes, so what reads them sees the lines the text had', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')
      const text = 'first line\nsecond line\nthird line'
      const message = new Message({ role: 'user', content: [new TextBlock(text)], trackingId: 'track-1' })

      await archive.storeMessage(message)

      expect(await storage.list('')).toStrictEqual([`${ROOT}/track-1_0.txt`])
      expect(await storedAt(storage, 'track-1_0.txt')).toBe(text)
    })

    it.each([
      ['multi-line', 'alpha\nbeta\ngamma'],
      ['empty', ''],
      ['trailing newline', 'alpha\n'],
      ['text that is itself a JSON object', '{"status":"degraded"}'],
      ['text that is itself a JSON array', '[{"role":"user"}]'],
      ['multi-byte', '\u{1F600} \u03C9\nsecond'],
    ])('round-trips %s text unchanged', async (_name, text) => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const message = new Message({ role: 'user', content: [new TextBlock(text)], trackingId: 'track-1' })

      await archive.storeMessage(message)

      expect(await archive.retrieve('track-1_0')).toStrictEqual({ data: { text } })
    })

    it('keeps a block that carries more than text as JSON under the bare key', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')
      const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })
      const message = new Message({ role: 'user', content: [image], trackingId: 'track-1' })

      await archive.storeMessage(message)

      expect(await storage.list('')).toStrictEqual([`${ROOT}/track-1_0`])
      expect((await storedAt(storage, 'track-1_0')).startsWith('{')).toBe(true)
      expect((await archive.retrieve('track-1_0'))!.data).toStrictEqual(image.toJSON())
    })

    it('stores removed messages as JSON, since they are a list rather than one text', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')
      const message = new Message({ role: 'user', content: [new TextBlock('alpha')], trackingId: 'track-1' })

      const reference = await archive.storeRemoved([message])

      expect((await storedAt(storage, `${reference}_0`)).startsWith('[')).toBe(true)
    })

    it('reports references without the suffix, so they parse and resolve either way', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const toolResult = new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('a')] })
      const message = new Message({ role: 'user', content: [new TextBlock('t'), toolResult], trackingId: 'track-1' })

      await archive.storeMessage(message)

      expect(await archive.list()).toStrictEqual(['track-1_0', 'tu-1_0'])
      expect(await archive.keysOf('tu-1')).toStrictEqual(['tu-1_0'])
      expect(Object.keys(await archive.takeSnapshot())).toStrictEqual(['track-1_0', 'tu-1_0'])
    })

    it('deletes a text entry by its reference', async () => {
      const storage = new InMemoryStorage()
      const archive = new Archive(storage, 'test-session', 'test-agent')
      const message = new Message({ role: 'user', content: [new TextBlock('alpha')], trackingId: 'track-1' })
      await archive.storeMessage(message)

      await archive.delete('track-1_0')

      expect(await storage.list('')).toStrictEqual([])
      expect(await archive.retrieve('track-1_0')).toBeNull()
    })

    it('reads an entry written as JSON under the bare key', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const text = 'alpha\nbeta'

      await archive.store('track-1', 0, new TextEncoder().encode(JSON.stringify({ text })))

      expect(await archive.list()).toStrictEqual(['track-1_0'])
      expect(await archive.retrieve('track-1_0')).toStrictEqual({ data: { text } })
    })

    it('prefers the text entry when both framings exist for one reference', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('track-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'stale' })))
      const message = new Message({ role: 'user', content: [new TextBlock('current')], trackingId: 'track-1' })

      await archive.storeMessage(message)

      expect(await archive.list()).toStrictEqual(['track-1_0'])
      expect(await archive.retrieve('track-1_0')).toStrictEqual({ data: { text: 'current' } })
    })

    it('restores a snapshot of JSON-framed entries as text, leaving the snapshot shape alone', async () => {
      const storage = new InMemoryStorage()
      const source = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await source.store('track-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'alpha\nbeta' })))
      const snapshot = await source.takeSnapshot()
      expect(snapshot).toStrictEqual({ 'track-1_0': { text: 'alpha\nbeta' } })

      const restored = new Archive(storage, 'test-session', 'test-agent')
      await restored.loadSnapshot(snapshot)

      expect(await storedAt(storage, 'track-1_0.txt')).toBe('alpha\nbeta')
      expect(await restored.takeSnapshot()).toStrictEqual(snapshot)
    })
  })

  describe('archive keys', () => {
    it.each([
      { id: 'tu-1', index: 0 },
      { id: 'call_12', index: 3 },
      { id: 'removed-0199-abc', index: 0 },
    ])('round-trips $id_$index', (key) => {
      expect(parseArchiveKey(formatArchiveKey(key))).toEqual(key)
    })

    it.each(['tu-1', 'tu-1_', '_0', 'tu-1_x', 'tu-1_1a'])('rejects %j', (key) => {
      expect(parseArchiveKey(key)).toBeNull()
    })
  })

  describe('offload placeholders', () => {
    it('ensureArchived references a tool result by its toolUseId and any other block by its position', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const toolResult = new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [new TextBlock('a')] })
      const message = new Message({ role: 'user', content: [new TextBlock('t'), toolResult], trackingId: 'track-1' })

      expect(await archive.ensureArchived(toolResult, message, 1)).toBe('tu-1')
      expect(await archive.ensureArchived(message.content[0]!, message, 0)).toBe('track-1_0')
      expect(await archive.takeSnapshot()).toStrictEqual({ 'tu-1_0': { text: 'a' }, 'track-1_0': { text: 't' } })
    })

    it('ensureArchived leaves an entry already stored under the reference untouched', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      await archive.store('track-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'original' })))
      const message = new Message({ role: 'user', content: [new TextBlock('edited')], trackingId: 'track-1' })

      expect(await archive.ensureArchived(message.content[0]!, message, 0)).toBe('track-1_0')
      expect(await archive.retrieve('track-1_0')).toStrictEqual({ data: { text: 'original' } })
    })

    it('archives text that only looks like a placeholder', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const message = new Message({
        role: 'user',
        content: [new TextBlock('[Dropped] [ref: tu-1]')],
        trackingId: 'track-1',
      })

      await archive.storeMessage(message)

      expect(await archive.takeSnapshot()).toStrictEqual({ 'track-1_0': { text: '[Dropped] [ref: tu-1]' } })
    })

    it('skips a placeholder and a tool result that holds one, keeping other blocks', async () => {
      const archive = new Archive(new InMemoryStorage(), 'test-session', 'test-agent')
      const message = new Message({
        role: 'user',
        content: [
          new OffloadedBlock({ text: '[Dropped] [ref: track-0_0]', method: 'drop', ref: 'track-0_0' }),
          new ToolResultBlock({
            toolUseId: 'tu-1',
            status: 'success',
            content: [
              new OffloadedBlock({
                text: '[Truncated: 1 block, ~10,973 tokens]\n\nrow-1 [ref: tu-1]',
                method: 'truncate',
                ref: 'tu-1',
              }),
              new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
            ],
          }),
          new TextBlock('kept'),
        ],
        trackingId: 'track-1',
      })

      await archive.storeMessage(message)

      expect(await archive.takeSnapshot()).toStrictEqual({ 'track-1_2': { text: 'kept' } })
    })
  })
})
