import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LocalFileStorage } from '../../local-file-storage.js'
import { QmdSearchStrategy } from '../qmd.js'

vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(),
}))

vi.mock('node:path', () => ({
  resolve: (...args: string[]) => args.join('/'),
  dirname: (path: string) => path.split('/').slice(0, -1).join('/') || '/',
  basename: (path: string) => path.split('/').pop() || '',
}))

describe('QmdSearchStrategy', () => {
  const mockQmdStore = {
    update: vi.fn().mockResolvedValue(undefined),
    searchLex: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  }

  const mockStorage = {
    baseDir: '/tmp/test-storage',
    write: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  } as unknown as LocalFileStorage

  beforeEach(async () => {
    vi.clearAllMocks()
    mockQmdStore.searchLex.mockResolvedValue([])
    const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
      createStore: ReturnType<typeof vi.fn>
    }>)
    vi.mocked(createStore).mockResolvedValue(mockQmdStore as never)
  })

  describe('search', () => {
    it('initializes the store from the storage baseDir on first call', async () => {
      const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
        createStore: ReturnType<typeof vi.fn>
      }>)
      const strategy = new QmdSearchStrategy()

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith({
        dbPath: '/tmp/.test-storage-qmd.sqlite',
        config: {
          collections: {
            storage: { path: '/tmp/test-storage', pattern: '**/*' },
          },
        },
      })
    })

    it('calls update and searchLex with space-separated terms', async () => {
      mockQmdStore.searchLex.mockResolvedValue([{ displayPath: 'storage/auth.md', score: -10 }])
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'authentication flow')

      expect(mockQmdStore.update).toHaveBeenCalled()
      expect(mockQmdStore.searchLex).toHaveBeenCalledWith('authentication flow')
      expect(results).toEqual([{ key: 'auth.md', score: 10 / 11 }])
    })

    it('uses custom dbPath', async () => {
      const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
        createStore: ReturnType<typeof vi.fn>
      }>)
      const strategy = new QmdSearchStrategy({ dbPath: '/custom/index.sqlite' })

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath: '/custom/index.sqlite' }))
    })

    it('returns empty array when no matches', async () => {
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'nonexistent')

      expect(results).toEqual([])
    })

    it('strips stop words from queries', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.search(mockStorage, 'What did the charity race raise awareness for?')

      expect(mockQmdStore.searchLex).toHaveBeenCalledWith('charity race raise awareness')
    })

    it('returns empty when query is only stop words', async () => {
      const strategy = new QmdSearchStrategy()

      const results = await strategy.search(mockStorage, 'what is the')

      expect(results).toEqual([])
      expect(mockQmdStore.searchLex).not.toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('re-indexes without searching', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.update(mockStorage)

      expect(mockQmdStore.update).toHaveBeenCalled()
      expect(mockQmdStore.searchLex).not.toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('closes the QMD store', async () => {
      const strategy = new QmdSearchStrategy()
      await strategy.search(mockStorage, 'init query')

      await strategy.close()

      expect(mockQmdStore.close).toHaveBeenCalled()
    })

    it('is safe to call without initialization', async () => {
      const strategy = new QmdSearchStrategy()

      await strategy.close()

      expect(mockQmdStore.close).not.toHaveBeenCalled()
    })
  })
})
