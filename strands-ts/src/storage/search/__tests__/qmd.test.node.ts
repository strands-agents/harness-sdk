import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QmdSearchStrategy } from '../qmd.js'
import type { LocalFileStorage } from '../../local-file-storage.js'

vi.mock('@tobilu/qmd', () => ({
  createStore: vi.fn(),
}))

describe('QmdSearchStrategy', () => {
  let tempDir: string
  let mockStorage: LocalFileStorage
  const mockQmdStore = {
    update: vi.fn().mockResolvedValue(undefined),
    searchLex: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'strands-qmd-test-'))
    mockStorage = {
      baseDir: join(tempDir, 'storage'),
      write: vi.fn(),
      read: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    } as unknown as LocalFileStorage
    vi.clearAllMocks()
    mockQmdStore.searchLex.mockResolvedValue([])
    const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
      createStore: ReturnType<typeof vi.fn>
    }>)
    vi.mocked(createStore).mockResolvedValue(mockQmdStore as never)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('search', () => {
    it('initializes the store from the storage baseDir on first call', async () => {
      const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
        createStore: ReturnType<typeof vi.fn>
      }>)
      const strategy = new QmdSearchStrategy()

      await strategy.search(mockStorage, 'test query')

      expect((await stat(mockStorage.baseDir)).isDirectory()).toBe(true)
      expect(createStore).toHaveBeenCalledWith({
        dbPath: join(tempDir, '.storage-qmd.sqlite'),
        config: {
          collections: {
            storage: { path: mockStorage.baseDir, pattern: '**/*' },
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
      const dbPath = join(tempDir, 'custom.sqlite')
      const strategy = new QmdSearchStrategy({ dbPath })

      await strategy.search(mockStorage, 'test query')

      expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ dbPath }))
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

    it('reopens the index on the next search after close', async () => {
      const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
        createStore: ReturnType<typeof vi.fn>
      }>)
      const strategy = new QmdSearchStrategy()
      await strategy.search(mockStorage, 'first query')
      await strategy.close()

      await strategy.search(mockStorage, 'second query')

      expect(createStore).toHaveBeenCalledTimes(2)
    })
  })

  describe('multiple storage directories', () => {
    function storageAt(baseDir: string): LocalFileStorage {
      return { ...mockStorage, baseDir } as unknown as LocalFileStorage
    }

    function newQmdStore(): typeof mockQmdStore {
      return {
        update: vi.fn().mockResolvedValue(undefined),
        searchLex: vi.fn().mockResolvedValue([]),
        close: vi.fn().mockResolvedValue(undefined),
      }
    }

    async function mockedCreateStore(): Promise<ReturnType<typeof vi.fn>> {
      const { createStore } = await (import('@tobilu/qmd' as string) as Promise<{
        createStore: ReturnType<typeof vi.fn>
      }>)
      return vi.mocked(createStore)
    }

    it('keeps one open index per directory when searches alternate', async () => {
      const createStore = await mockedCreateStore()
      const storeA = newQmdStore()
      const storeB = newQmdStore()
      createStore.mockResolvedValueOnce(storeA).mockResolvedValueOnce(storeB)
      const strategy = new QmdSearchStrategy()
      const storageA = storageAt(join(tempDir, 'memory', 'a'))
      const storageB = storageAt(join(tempDir, 'memory', 'b'))

      await strategy.search(storageA, 'query one')
      await strategy.search(storageB, 'query two')
      await strategy.search(storageA, 'query three')
      await strategy.search(storageB, 'query four')

      expect(createStore).toHaveBeenCalledTimes(2)
      expect(createStore).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: join(tempDir, 'memory', '.a-qmd.sqlite') })
      )
      expect(createStore).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath: join(tempDir, 'memory', '.b-qmd.sqlite') })
      )
      expect(storeA.close).not.toHaveBeenCalled()
      expect(storeB.close).not.toHaveBeenCalled()
      expect(storeA.searchLex).toHaveBeenCalledTimes(2)
      expect(storeB.searchLex).toHaveBeenCalledTimes(2)
    })

    it('does not close one directory index while another directory is searched', async () => {
      const createStore = await mockedCreateStore()
      const storeA = newQmdStore()
      const storeB = newQmdStore()
      let finishUpdateA!: () => void
      storeA.update.mockReturnValue(new Promise<void>((resolve) => (finishUpdateA = resolve)))
      createStore.mockResolvedValueOnce(storeA).mockResolvedValueOnce(storeB)
      const strategy = new QmdSearchStrategy()

      const searchA = strategy.search(storageAt(join(tempDir, 'memory', 'a')), 'query one')
      await vi.waitFor(() => expect(storeA.update).toHaveBeenCalled())
      await strategy.search(storageAt(join(tempDir, 'memory', 'b')), 'query two')
      finishUpdateA()
      await searchA

      expect(storeA.close).not.toHaveBeenCalled()
      expect(storeA.searchLex).toHaveBeenCalledWith('query one')
    })

    it('opens a directory once when a second search arrives while the first open is in flight', async () => {
      const createStore = await mockedCreateStore()
      let finishOpen!: (store: typeof mockQmdStore) => void
      createStore.mockReturnValueOnce(new Promise((resolve) => (finishOpen = resolve)))
      const strategy = new QmdSearchStrategy()
      const storage = storageAt(join(tempDir, 'memory', 'a'))

      const first = strategy.search(storage, 'one')
      // Start the second search while the first createStore call is pending.
      await vi.waitFor(() => expect(createStore).toHaveBeenCalled())
      const second = strategy.search(storage, 'two')
      finishOpen(newQmdStore())
      await Promise.all([first, second])

      expect(createStore).toHaveBeenCalledTimes(1)
    })

    it('closes every open index', async () => {
      const createStore = await mockedCreateStore()
      const storeA = newQmdStore()
      const storeB = newQmdStore()
      createStore.mockResolvedValueOnce(storeA).mockResolvedValueOnce(storeB)
      const strategy = new QmdSearchStrategy()
      await strategy.search(storageAt(join(tempDir, 'memory', 'a')), 'query')
      await strategy.search(storageAt(join(tempDir, 'memory', 'b')), 'query')

      await strategy.close()

      expect(storeA.close).toHaveBeenCalledTimes(1)
      expect(storeB.close).toHaveBeenCalledTimes(1)
    })

    it('retries opening a directory after a failed open', async () => {
      const createStore = await mockedCreateStore()
      createStore.mockRejectedValueOnce(new Error('disk full'))
      const strategy = new QmdSearchStrategy()
      const storage = storageAt(join(tempDir, 'memory', 'a'))

      await expect(strategy.search(storage, 'query')).rejects.toThrow('disk full')
      await strategy.search(storage, 'query')

      expect(createStore).toHaveBeenCalledTimes(2)
    })

    it('throws when an explicit dbPath is used with a second directory', async () => {
      const createStore = await mockedCreateStore()
      const dbPath = join(tempDir, 'index.sqlite')
      const storageA = storageAt(join(tempDir, 'memory', 'a'))
      const storageB = storageAt(join(tempDir, 'memory', 'b'))
      const strategy = new QmdSearchStrategy({ dbPath })
      await strategy.search(storageA, 'query')

      await expect(strategy.search(storageB, 'query')).rejects.toThrow(
        `QmdSearchStrategy dbPath '${dbPath}' already indexes '${storageA.baseDir}' and cannot also index '${storageB.baseDir}'`
      )
      await strategy.search(storageA, 'query')
      expect(createStore).toHaveBeenCalledTimes(1)
    })
  })
})
