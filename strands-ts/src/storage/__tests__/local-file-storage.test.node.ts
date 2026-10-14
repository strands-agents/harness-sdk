import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { LocalFileStorage } from '../local-file-storage.js'
import { QmdSearchStrategy } from '../search/qmd.js'
import type { SearchStrategy } from '../search/types.js'
import { NotASandboxLocalEnvironment } from '../../sandbox/not-a-sandbox-local-environment.js'
import { logger } from '../../logging/logger.js'
import { rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

describe('LocalFileStorage', () => {
  let baseDir: string
  let storage: LocalFileStorage

  beforeEach(() => {
    baseDir = join(tmpdir(), `strands-test-${randomUUID()}`)
    storage = new LocalFileStorage(baseDir)
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  describe('write and read', () => {
    it('round-trips bytes', async () => {
      const data = new TextEncoder().encode('hello world')
      await storage.write('test/file.txt', data)
      const result = await storage.read('test/file.txt')
      expect(result).toEqual(data)
    })

    it('creates nested directories', async () => {
      await storage.write('deep/nested/path/file.bin', new Uint8Array([1, 2, 3]))
      const info = await stat(join(baseDir, 'deep/nested/path/file.bin'))
      expect(info.isFile()).toBe(true)
    })

    it('overwrites existing values', async () => {
      await storage.write('key', new TextEncoder().encode('first'))
      await storage.write('key', new TextEncoder().encode('second'))
      const result = await storage.read('key')
      expect(new TextDecoder().decode(result!)).toBe('second')
    })

    it('returns null for missing keys', async () => {
      const result = await storage.read('nonexistent/key')
      expect(result).toBeNull()
    })

    it('writes atomically via tmp file', async () => {
      await storage.write('atomic/test', new Uint8Array([1]))
      const content = await readFile(join(baseDir, 'atomic/test'))
      expect(new Uint8Array(content)).toEqual(new Uint8Array([1]))
      await expect(stat(join(baseDir, 'atomic/test.tmp'))).rejects.toThrow()
    })

    it.skipIf(process.platform === 'win32')('cleans up tmp file on rename failure', async () => {
      const { mkdir, chmod, readdir } = await import('node:fs/promises')
      const dir = join(baseDir, 'readonly')
      await mkdir(dir, { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'target'), 'original')
      await chmod(dir, 0o555)

      try {
        await expect(storage.write('readonly/target', new Uint8Array([1]))).rejects.toThrow()
        await chmod(dir, 0o755)
        const files = await readdir(dir)
        expect(files.filter((f) => f.includes('.__strands_tmp'))).toHaveLength(0)
      } finally {
        await chmod(dir, 0o755)
      }
    })
  })

  describe('key validation', () => {
    it('rejects keys containing backslashes', async () => {
      await expect(storage.write('foo\\bar', new Uint8Array([1]))).rejects.toThrow('backslashes are not allowed')
    })

    it('rejects backslash path traversal', async () => {
      await expect(storage.read('foo\\..\\..\\etc\\passwd')).rejects.toThrow('backslashes are not allowed')
    })
  })

  describe('delete', () => {
    it('removes an existing key', async () => {
      await storage.write('deleteme', new Uint8Array([1]))
      await storage.delete('deleteme')
      const result = await storage.read('deleteme')
      expect(result).toBeNull()
    })

    it('is a no-op for missing keys', async () => {
      await expect(storage.delete('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('list', () => {
    it('lists keys under a prefix', async () => {
      await storage.write('sessions/a/data.json', new Uint8Array([1]))
      await storage.write('sessions/b/data.json', new Uint8Array([2]))
      await storage.write('memory/notes.json', new Uint8Array([3]))

      const keys = await storage.list('sessions/')
      expect(keys).toEqual(['sessions/a/data.json', 'sessions/b/data.json'])
    })

    it('returns all keys for empty prefix', async () => {
      await storage.write('a', new Uint8Array([1]))
      await storage.write('b', new Uint8Array([2]))

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b'])
    })

    it('returns empty array when base directory does not exist', async () => {
      const fresh = new LocalFileStorage(join(tmpdir(), `nonexistent-${randomUUID()}`))
      const keys = await fresh.list('')
      expect(keys).toEqual([])
    })

    it('excludes scratch files', async () => {
      await storage.write('real', new Uint8Array([1]))
      const { writeFile, mkdir } = await import('node:fs/promises')
      await mkdir(baseDir, { recursive: true })
      await writeFile(join(baseDir, 'leftover.__strands_tmp'), 'garbage')

      const keys = await storage.list('')
      expect(keys).not.toContain('leftover.__strands_tmp')
    })

    it('does not exclude user .tmp files', async () => {
      await storage.write('notes.tmp', new Uint8Array([1]))
      const keys = await storage.list('')
      expect(keys).toContain('notes.tmp')
    })

    it('returns keys sorted lexicographically', async () => {
      await storage.write('c', new Uint8Array([3]))
      await storage.write('a', new Uint8Array([1]))
      await storage.write('b', new Uint8Array([2]))

      const keys = await storage.list('')
      expect(keys).toEqual(['a', 'b', 'c'])
    })
  })

  describe('namespace', () => {
    it('returns a LocalFileStorage instance rooted at the subdirectory', async () => {
      const namespaced = storage.namespace('sub/dir')

      expect(namespaced).toBeInstanceOf(LocalFileStorage)
      await namespaced.write('file.txt', new Uint8Array([1, 2, 3]))
      expect(await namespaced.read('file.txt')).toEqual(new Uint8Array([1, 2, 3]))
      expect(await namespaced.list('')).toEqual(['file.txt'])
    })

    it('isolates keys from the parent storage', async () => {
      const namespaced = storage.namespace('isolated')
      await storage.write('root.txt', new Uint8Array([1]))
      await namespaced.write('child.txt', new Uint8Array([2]))

      expect(await storage.list('')).toContain('root.txt')
      expect(await storage.list('')).not.toContain('child.txt')
      expect(await namespaced.list('')).toEqual(['child.txt'])
    })

    it('exposes baseDir pointing to the subdirectory', () => {
      const namespaced = storage.namespace('nested')
      expect(namespaced.baseDir).toBe(`${baseDir}/nested`)
    })
  })

  describe('constructor config', () => {
    const fakeStrategy = (): SearchStrategy<LocalFileStorage> & { index: Mock; search: Mock } => ({
      index: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue([{ key: 'hit.txt', score: 1 }]),
    })

    it('indexes writes and delegates search to a searchStrategy from config', async () => {
      const strategy = fakeStrategy()
      const configured = new LocalFileStorage(baseDir, { searchStrategy: strategy })

      await configured.write('a.txt', new Uint8Array([1]))
      expect(strategy.index).toHaveBeenCalledWith(configured, 'a.txt', new Uint8Array([1]))
      expect(await configured.search('query')).toEqual([{ key: 'hit.txt', score: 1 }])
      expect(strategy.search).toHaveBeenCalledWith(configured, 'query')
    })

    it('routes I/O through a sandbox from config', async () => {
      const sandbox = new NotASandboxLocalEnvironment()
      const writeFile = vi.spyOn(sandbox, 'writeFile')
      const configured = new LocalFileStorage(baseDir, { sandbox })

      await configured.write('a.txt', new Uint8Array([1]))
      expect(writeFile).toHaveBeenCalledWith(`${baseDir}/a.txt`, new Uint8Array([1]))
    })

    it('accepts a positional sandbox and search strategy', async () => {
      const sandbox = new NotASandboxLocalEnvironment()
      const writeFile = vi.spyOn(sandbox, 'writeFile')
      const strategy = fakeStrategy()
      const positional = new LocalFileStorage(baseDir, sandbox, strategy)

      await positional.write('a.txt', new Uint8Array([1]))
      expect(writeFile).toHaveBeenCalledTimes(1)
      await positional.search('query')
      expect(strategy.search).toHaveBeenCalledTimes(1)
    })

    it('carries a searchStrategy from config through forSandbox and namespace', async () => {
      const strategy = fakeStrategy()
      const configured = new LocalFileStorage(baseDir, { searchStrategy: strategy })

      await configured.forSandbox(new NotASandboxLocalEnvironment()).search('one')
      await configured.namespace('sub').search('two')
      expect(strategy.search.mock.calls.map((call) => call[1])).toEqual(['one', 'two'])
    })
  })

  describe('host filesystem strategies with a sandbox', () => {
    const sandboxSafeStrategy = (): SearchStrategy<LocalFileStorage> & { search: Mock } => ({
      search: vi.fn().mockResolvedValue([]),
    })

    it('marks QmdSearchStrategy as requiring host filesystem access', () => {
      expect(new QmdSearchStrategy().requiresHostFs).toBe(true)
    })

    it('rejects a host filesystem strategy passed with a sandbox', () => {
      const sandbox = new NotASandboxLocalEnvironment()
      // @ts-expect-error the overloads reject this at compile time; the runtime check covers JS callers
      expect(() => new LocalFileStorage(baseDir, sandbox, new QmdSearchStrategy())).toThrow(
        'QmdSearchStrategy requires host filesystem access and cannot be used with a sandbox'
      )
    })

    it('rejects a host filesystem strategy passed with a sandbox in config', () => {
      const config = { sandbox: new NotASandboxLocalEnvironment(), searchStrategy: new QmdSearchStrategy() }
      // @ts-expect-error the overloads reject this at compile time; the runtime check covers JS callers
      expect(() => new LocalFileStorage(baseDir, config)).toThrow(
        'QmdSearchStrategy requires host filesystem access and cannot be used with a sandbox'
      )
    })

    it('accepts a sandbox-safe strategy passed with a sandbox', async () => {
      const strategy = sandboxSafeStrategy()
      const sandboxed = new LocalFileStorage(baseDir, new NotASandboxLocalEnvironment(), strategy)
      await sandboxed.search('query')
      expect(strategy.search).toHaveBeenCalledTimes(1)
    })

    it('rejects at runtime a strategy typed as SearchStrategy that declares requiresHostFs', () => {
      class HostIndexStrategy {
        readonly requiresHostFs = true
        async search(): Promise<[]> {
          return []
        }
      }
      const strategy: SearchStrategy<LocalFileStorage> = new HostIndexStrategy()
      expect(() => new LocalFileStorage(baseDir, new NotASandboxLocalEnvironment(), strategy)).toThrow(
        'HostIndexStrategy requires host filesystem access and cannot be used with a sandbox'
      )
    })

    it('drops a host filesystem strategy in forSandbox and falls back to keyword search', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const bound = new LocalFileStorage(baseDir, undefined, new QmdSearchStrategy()).forSandbox(
        new NotASandboxLocalEnvironment()
      )

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        'strategy=<QmdSearchStrategy> | search strategy requires host filesystem access and is not compatible ' +
          'with sandboxed storage | falling back to keyword search'
      )
      await bound.write('auth.md', new TextEncoder().encode('OAuth2 authentication flow'))
      expect((await bound.search('authentication')).map((result) => result.key)).toEqual(['auth.md'])
      warnSpy.mockRestore()
    })

    it('keeps a sandbox-safe strategy in forSandbox', async () => {
      const strategy = sandboxSafeStrategy()
      const bound = new LocalFileStorage(baseDir, undefined, strategy).forSandbox(new NotASandboxLocalEnvironment())
      await bound.search('query')
      expect(strategy.search).toHaveBeenCalledTimes(1)
    })
  })
})
