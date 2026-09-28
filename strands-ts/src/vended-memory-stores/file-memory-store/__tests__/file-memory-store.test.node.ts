import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { FileMemoryStore } from '../store.js'
import { InMemoryStorage } from '../../../storage/in-memory-storage.js'
import { ModelExtractor } from '../../../memory/extraction/model-extractor.js'
import type { Storage } from '../../../storage/storage.js'
import type { ExtractionConfig } from '../../../memory/extraction/types.js'
import type { MessageData } from '../../../types/messages.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('FileMemoryStore', () => {
  let storage: InMemoryStorage
  let scoped: Storage
  let store: FileMemoryStore

  beforeEach(() => {
    storage = new InMemoryStorage()
    scoped = storage.namespace('memory/test-store')
    store = new FileMemoryStore({
      name: 'test-store',
      description: 'A test file memory store',
      storage,
    })
  })

  describe('constructor', () => {
    it('sets name and description from config', () => {
      expect(store.name).toBe('test-store')
      expect(store.description).toBe('A test file memory store')
    })

    it('defaults to writable true', () => {
      expect(store.writable).toBe(true)
    })

    it('respects writable false from config', () => {
      const readOnly = new FileMemoryStore({ name: 'readonly', storage, writable: false })
      expect(readOnly.writable).toBe(false)
    })

    it('uses default maxSearchResults when not configured', async () => {
      for (let index = 0; index < 15; index++) {
        await store.add(`Fact number ${index}`)
      }
      const results = await store.search('fact')
      expect(results).toHaveLength(10)
    })

    it('respects maxSearchResults from config', async () => {
      const customStore = new FileMemoryStore({ name: 'custom', storage, maxSearchResults: 2 })
      for (let index = 0; index < 5; index++) {
        await customStore.add(`Fact number ${index}`)
      }
      const results = await customStore.search('fact')
      expect(results).toHaveLength(2)
    })

    it('resolves extraction: true to an ExtractionConfig with ModelExtractor', () => {
      const storeWithExtraction = new FileMemoryStore({ name: 'ext', storage, extraction: true })
      expect(storeWithExtraction.extraction).toMatchObject({ extractor: expect.objectContaining({}) })
    })

    it('defaults to no description when omitted', () => {
      const minimal = new FileMemoryStore({ name: 'minimal', storage })
      expect(minimal.description).toBeUndefined()
    })

    it('auto-scopes keys under memory/<name>/ on the raw backend', async () => {
      await store.add('User prefers dark mode')
      expect(await storage.read('memory/test-store/user-prefers-dark-mode.md')).not.toBeNull()
      expect(await storage.read('user-prefers-dark-mode.md')).toBeNull()
    })

    it('scopes distinct-named stores so they never collide on a shared backend', async () => {
      const storeA = new FileMemoryStore({ name: 'store-a', storage })
      const storeB = new FileMemoryStore({ name: 'store-b', storage })
      await storeA.add('User prefers dark mode')
      await storeB.add('User prefers light mode')

      expect(decoder.decode((await storage.read('memory/store-a/user-prefers-dark-mode.md'))!)).toContain('dark mode')
      expect(decoder.decode((await storage.read('memory/store-b/user-prefers-light-mode.md'))!)).toContain('light mode')
      expect(await storeA.search('mode')).toHaveLength(1)
      expect(await storeB.search('mode')).toHaveLength(1)
    })

    it('does not re-scope storage that is already namespaced', async () => {
      const preScoped = storage.namespace('memory/scoped')
      const scopedStore = new FileMemoryStore({ name: 'scoped', storage: preScoped })
      await scopedStore.add('User prefers dark mode')
      expect(await storage.read('memory/scoped/user-prefers-dark-mode.md')).not.toBeNull()
      expect(await storage.read('memory/scoped/memory/scoped/user-prefers-dark-mode.md')).toBeNull()
    })
  })

  describe('add', () => {
    it('writes plain markdown content', async () => {
      await store.add('User prefers dark mode')
      const bytes = await scoped.read('user-prefers-dark-mode.md')
      expect(bytes).not.toBeNull()
      expect(decoder.decode(bytes!)).toBe('User prefers dark mode')
    })

    it('derives filename from first line of content', async () => {
      await store.add('The user likes vim keybindings\nMore details here')
      const keys = await scoped.list('')
      expect(keys).toHaveLength(1)
      expect(keys[0]).toBe('the-user-likes-vim-keybindings.md')
    })

    it('truncates derived slug at 50 characters', async () => {
      const longContent =
        'this is a very long sentence that should be truncated when used as a filename slug for storage'
      await store.add(longContent)
      const keys = await scoped.list('')
      const slug = keys[0]!.replace('.md', '')
      expect(slug.length).toBeLessThanOrEqual(50)
    })

    it('appends new facts to an existing entry with the same slug', async () => {
      await store.add('Python is great\nFast prototyping')
      await store.add('Python is great\nBut it has a GIL.')
      const keys = await scoped.list('')
      expect(keys).toHaveLength(1)
      expect(keys[0]).toBe('python-is-great.md')
      expect(decoder.decode((await scoped.read('python-is-great.md'))!)).toBe(
        'Python is great\nFast prototyping\nBut it has a GIL.'
      )
    })

    it('does not duplicate content when new entry has only the heading', async () => {
      await store.add('Python is great\nFast prototyping')
      await store.add('Python is great')
      const content = decoder.decode((await scoped.read('python-is-great.md'))!)
      expect(content).toBe('Python is great\nFast prototyping')
    })

    it('uses Date.now fallback when content produces empty slug', async () => {
      await store.add('!!!???')
      const keys = await scoped.list('')
      expect(keys).toHaveLength(1)
      expect(keys[0]).toMatch(/entry-\d+\.md$/)
    })

    it('slugifies special characters out of the filename', async () => {
      await store.add("User's #1 testing rule!")
      const keys = await scoped.list('')
      expect(keys[0]).toBe('users-1-testing-rule.md')
    })

    it('returns the canonical key', async () => {
      const key = await store.add('User prefers dark mode')
      expect(key).toBe('user-prefers-dark-mode.md')
    })

    it('returns the same key on append', async () => {
      const key1 = await store.add('Python is great\nFirst fact')
      const key2 = await store.add('Python is great\nSecond fact')
      expect(key1).toBe(key2)
    })

    it('strips markdown heading prefix from first line before slugifying', async () => {
      await store.add('# User preferences\nLikes dark mode')
      const keys = await scoped.list('')
      expect(keys[0]).toBe('user-preferences.md')
      expect(decoder.decode((await scoped.read('user-preferences.md'))!)).toBe('# User preferences\nLikes dark mode')
    })

    it('strips multiple heading levels', async () => {
      await store.add('## Project setup\nTypeScript monorepo')
      const keys = await scoped.list('')
      expect(keys[0]).toBe('project-setup.md')
    })

    it('does not produce trailing hyphen when slug truncates at word boundary', async () => {
      const content = 'aaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh iiiii jjjjj'
      const key = await store.add(content)
      expect(key).not.toMatch(/-\.md$/)
    })
  })

  describe('search', () => {
    beforeEach(async () => {
      await store.add('User prefers dark mode for all editors')
      await store.add('Testing philosophy: integration first, mock at boundaries')
      await store.add('Deploy process uses blue-green strategy')
    })

    it('returns matching entries by keyword in content', async () => {
      const results = await store.search('dark mode')
      expect(results[0]!.content).toBe('User prefers dark mode for all editors')
    })

    it('matches against filenames', async () => {
      const results = await store.search('deploy')
      expect(results[0]!.content).toBe('Deploy process uses blue-green strategy')
    })

    it('is case-insensitive', async () => {
      const results = await store.search('DARK MODE')
      expect(results[0]!.content).toBe('User prefers dark mode for all editors')
    })

    it('returns empty array for no matches', async () => {
      expect(await store.search('quantum computing')).toEqual([])
    })

    it('returns empty array for empty query', async () => {
      expect(await store.search('')).toEqual([])
    })

    it('returns empty array for whitespace-only query', async () => {
      expect(await store.search('   ')).toEqual([])
    })

    it('respects maxSearchResults option', async () => {
      const results = await store.search('process', { maxSearchResults: 1 })
      expect(results).toHaveLength(1)
    })

    it('ranks results by number of distinct matching tokens', async () => {
      await store.add('covers deploy, testing, and integration boundaries')
      const results = await store.search('deploy testing integration')
      expect(results[0]!.content).toBe('covers deploy, testing, and integration boundaries')
    })

    it('includes metadata.path on results', async () => {
      const results = await store.search('deploy')
      expect(results[0]!.metadata?.['path']).toBe('deploy-process-uses-blue-green-strategy.md')
    })

    it('skips keys where storage returns null', async () => {
      const nullStorage: Storage = {
        async write(): Promise<void> {},
        async read(): Promise<Uint8Array | null> {
          return null
        },
        async delete(): Promise<void> {},
        async list(): Promise<string[]> {
          return ['memory/null-store/ghost.md']
        },
      }
      const nullStore = new FileMemoryStore({ name: 'null-store', storage: nullStorage })
      expect(await nullStore.search('anything')).toEqual([])
    })

    it('skips keys where storage.read throws and still returns other matches', async () => {
      const throwingStorage: Storage = {
        async write(): Promise<void> {},
        async read(key: string): Promise<Uint8Array | null> {
          if (key.includes('broken')) throw new Error('EACCES: permission denied')
          return encoder.encode('valid content about deploy')
        },
        async delete(): Promise<void> {},
        async list(): Promise<string[]> {
          return ['memory/throwing-store/broken.md', 'memory/throwing-store/good.md']
        },
      }
      const throwingStore = new FileMemoryStore({ name: 'throwing-store', storage: throwingStorage })
      const results = await throwingStore.search('deploy')
      expect(results).toHaveLength(1)
      expect(results[0]!.content).toBe('valid content about deploy')
    })
  })

  describe('extraction (key-aware extractor)', () => {
    const createMockModel = (modelId: string): { modelId: string; streamAggregated: Mock } => ({
      modelId,
      streamAggregated: vi.fn().mockReturnValue({
        next: vi.fn().mockResolvedValue({
          done: true,
          value: { message: { content: [{ text: '[]' }] }, stopReason: 'end_turn', metadata: {} },
        }),
      }),
    })

    it('includes existing topic headings in the system prompt', async () => {
      const extractionStore = new FileMemoryStore({ name: 'ext-test', storage, extraction: true })
      await extractionStore.add('User preferences\nPrefers dark mode\nUses vim')
      await extractionStore.add('Project setup\nTypeScript monorepo')

      const extraction = extractionStore.extraction as ExtractionConfig
      const extractor = extraction.extractor!

      const mockModel = {
        modelId: 'mock',
        streamAggregated: vi.fn().mockReturnValue({
          next: vi.fn().mockResolvedValue({
            done: true,
            value: {
              message: { content: [{ text: '[]' }] },
              stopReason: 'end_turn',
              metadata: {},
            },
          }),
        }),
      }

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'I also prefer light themes' }] }]
      await extractor.extract(messages, { defaultModel: mockModel as never })

      const callArgs = mockModel.streamAggregated.mock.calls[0]!
      const systemPrompt = callArgs[1].systemPrompt as string
      expect(systemPrompt).toContain('Existing topics:')
      expect(systemPrompt).toContain('user preferences')
      expect(systemPrompt).toContain('project setup')
      expect(systemPrompt).toContain('Reuse an existing topic heading')
      expect(systemPrompt).not.toContain('Prefers dark mode')
    })

    it('does not include "Existing topics" section when store is empty', async () => {
      const extractionStore = new FileMemoryStore({ name: 'ext-empty', storage, extraction: true })
      const extraction = extractionStore.extraction as ExtractionConfig
      const extractor = extraction.extractor!

      const mockModel = {
        modelId: 'mock',
        streamAggregated: vi.fn().mockReturnValue({
          next: vi.fn().mockResolvedValue({
            done: true,
            value: {
              message: { content: [{ text: '[]' }] },
              stopReason: 'end_turn',
              metadata: {},
            },
          }),
        }),
      }

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'Hello' }] }]
      await extractor.extract(messages, { defaultModel: mockModel as never })

      const callArgs = mockModel.streamAggregated.mock.calls[0]!
      const systemPrompt = callArgs[1].systemPrompt as string
      expect(systemPrompt).not.toContain('Existing topics:')
    })

    it('uses the configured model over the context default model', async () => {
      const configuredModel = createMockModel('configured')
      const contextDefaultModel = createMockModel('context-default')
      const extractionStore = new FileMemoryStore({
        name: 'ext-model',
        storage,
        extraction: { model: configuredModel as never },
      })
      const extractor = (extractionStore.extraction as ExtractionConfig).extractor!

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'I prefer light themes' }] }]
      await extractor.extract(messages, { defaultModel: contextDefaultModel as never })

      expect(configuredModel.streamAggregated).toHaveBeenCalledTimes(1)
      expect(contextDefaultModel.streamAggregated).not.toHaveBeenCalled()
    })

    it('falls back to the context default model when no model is configured', async () => {
      const contextDefaultModel = createMockModel('context-default')
      const extractionStore = new FileMemoryStore({ name: 'ext-fallback', storage, extraction: true })
      const extractor = (extractionStore.extraction as ExtractionConfig).extractor!

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'I prefer light themes' }] }]
      await extractor.extract(messages, { defaultModel: contextDefaultModel as never })

      expect(contextDefaultModel.streamAggregated).toHaveBeenCalledTimes(1)
    })

    it('builds the system prompt on the key-aware heading instruction', async () => {
      const mockModel = createMockModel('mock')
      const extractionStore = new FileMemoryStore({ name: 'ext-prompt', storage, extraction: true })
      const extractor = (extractionStore.extraction as ExtractionConfig).extractor!

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'Hello' }] }]
      await extractor.extract(messages, { defaultModel: mockModel as never })

      const systemPrompt = mockModel.streamAggregated.mock.calls[0]![1].systemPrompt as string
      expect(systemPrompt).toContain('The first line is a markdown heading')
    })

    it('overrides the framing with a custom systemPrompt but keeps the output contract', async () => {
      const mockModel = createMockModel('mock')
      const extractionStore = new FileMemoryStore({
        name: 'ext-guidance',
        storage,
        extraction: { systemPrompt: 'Extract only trading preferences and risk tolerance.' },
      })
      const extractor = (extractionStore.extraction as ExtractionConfig).extractor!

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'I trade options' }] }]
      await extractor.extract(messages, { defaultModel: mockModel as never })

      const systemPrompt = mockModel.streamAggregated.mock.calls[0]![1].systemPrompt as string
      expect(systemPrompt).toContain('Extract only trading preferences and risk tolerance.')
      expect(systemPrompt).not.toContain('You extract durable facts worth remembering')
      expect(systemPrompt).toContain('The first line is a markdown heading')
      expect(systemPrompt).toContain('Return ONLY a JSON array')
    })

    it('uses a supplied extractor verbatim, ignoring model and systemPrompt', async () => {
      const customModel = createMockModel('custom')
      const customExtractor = new ModelExtractor({ model: customModel as never, systemPrompt: 'Custom prompt.' })
      const extractionStore = new FileMemoryStore({
        name: 'ext-custom',
        storage,
        extraction: { extractor: customExtractor, model: createMockModel('ignored') as never },
      })

      expect((extractionStore.extraction as ExtractionConfig).extractor).toBe(customExtractor)

      const messages: MessageData[] = [{ role: 'user', content: [{ text: 'Hello' }] }]
      await customExtractor.extract(messages, { defaultModel: createMockModel('default') as never })
      expect(customModel.streamAggregated.mock.calls[0]![1].systemPrompt).toBe('Custom prompt.')
    })
  })
})
