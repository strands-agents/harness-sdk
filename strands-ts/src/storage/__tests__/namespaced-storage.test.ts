import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryStorage } from '../in-memory-storage.js'
import { NAMESPACED, namespace } from '../storage.js'
import type { Storage, StorageSearchOptions } from '../storage.js'

describe('namespace', () => {
  let backend: InMemoryStorage
  let namespaced: Storage

  beforeEach(() => {
    backend = new InMemoryStorage()
    namespaced = namespace(backend, 'prefix')
  })

  it('prepends namespace to write keys', async () => {
    await namespaced.write('key', new Uint8Array([1, 2, 3]))

    const result = await backend.read('prefix/key')
    expect(result).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('prepends namespace to read keys', async () => {
    await backend.write('prefix/key', new Uint8Array([4, 5]))

    const result = await namespaced.read('key')
    expect(result).toEqual(new Uint8Array([4, 5]))
  })

  it('returns null for missing keys', async () => {
    const result = await namespaced.read('nonexistent')
    expect(result).toBeNull()
  })

  it('prepends namespace to delete keys', async () => {
    await backend.write('prefix/key', new Uint8Array([1]))

    await namespaced.delete('key')

    expect(await backend.read('prefix/key')).toBeNull()
  })

  it('lists keys with namespace stripped', async () => {
    await backend.write('prefix/a', new Uint8Array([1]))
    await backend.write('prefix/b', new Uint8Array([2]))
    await backend.write('other/c', new Uint8Array([3]))

    const keys = await namespaced.list('')
    expect(keys).toEqual(['a', 'b'])
  })

  it('lists keys with sub-prefix', async () => {
    await backend.write('prefix/session/abc', new Uint8Array([1]))
    await backend.write('prefix/session/def', new Uint8Array([2]))
    await backend.write('prefix/offloader/xyz', new Uint8Array([3]))

    const keys = await namespaced.list('session/')
    expect(keys).toEqual(['session/abc', 'session/def'])
  })

  it('composes nested namespaces', async () => {
    const nested = namespace(namespace(backend, 'prefix'), 'sub')
    await nested.write('key', new Uint8Array([9]))

    const result = await backend.read('prefix/sub/key')
    expect(result).toEqual(new Uint8Array([9]))
  })

  it('handles empty namespace as no-op prefix', async () => {
    const empty = namespace(backend, '')
    await empty.write('key', new Uint8Array([7]))

    const result = await backend.read('key')
    expect(result).toEqual(new Uint8Array([7]))
  })

  describe('search', () => {
    const searching = (): { storage: Storage; calls: Array<[string, StorageSearchOptions | undefined]> } => {
      const calls: Array<[string, StorageSearchOptions | undefined]> = []
      const storage: Storage = {
        ...backend,
        write: (key, data) => backend.write(key, data),
        read: (key) => backend.read(key),
        delete: (key) => backend.delete(key),
        list: (query: string) => backend.list(query),
        search: async (query: string, options?: StorageSearchOptions) => {
          calls.push([query, options])
          return [{ key: 'prefix/hit.md', score: 1 }]
        },
      }
      return { storage, calls }
    }

    it('pushes the namespace down as a prefix rather than filtering the results', async () => {
      const { storage, calls } = searching()

      const results = await namespace(storage, 'prefix').search!('query')

      expect(calls).toStrictEqual([['query', { prefix: 'prefix/' }]])
      expect(results).toStrictEqual([{ key: 'hit.md', score: 1 }])
    })

    it('appends a caller prefix to the namespace', async () => {
      const { storage, calls } = searching()

      await namespace(storage, 'prefix').search!('query', { prefix: 'notes/', limit: 3 })

      expect(calls).toStrictEqual([['query', { prefix: 'prefix/notes/', limit: 3 }]])
    })

    it('omits search when the underlying storage has none', () => {
      const { search, ...withoutSearch } = backend as unknown as Record<string, unknown>
      expect(search).toBeTypeOf('function')
      expect(namespace(withoutSearch as unknown as Storage, 'prefix').search).toBeUndefined()
    })
  })

  it('sets NAMESPACED symbol on returned view', () => {
    expect(NAMESPACED in namespaced).toBe(true)
  })

  it('does not have NAMESPACED symbol on raw storage', () => {
    expect(NAMESPACED in backend).toBe(false)
  })
})
