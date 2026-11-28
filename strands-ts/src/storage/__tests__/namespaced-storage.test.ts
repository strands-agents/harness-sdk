import { describe, expect, it, beforeEach } from 'vitest'
import { StorageError } from '../../errors.js'
import { InMemoryStorage } from '../in-memory-storage.js'
import { NAMESPACED, namespace, resolveNamespace } from '../storage.js'
import type { Storage } from '../storage.js'

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

  it('sets NAMESPACED symbol on returned view', () => {
    expect(NAMESPACED in namespaced).toBe(true)
  })

  it('does not have NAMESPACED symbol on raw storage', () => {
    expect(NAMESPACED in backend).toBe(false)
  })
})

describe('namespace key validation', () => {
  const wrapWithoutNamespace = (base: InMemoryStorage): Storage => ({
    write: (key, data) => base.write(key, data),
    read: (key) => base.read(key),
    delete: (key) => base.delete(key),
    list: (query) => base.list(query),
  })

  it.each(['', '/', '///'])('rejects empty key %j on read, write, and delete without touching parent', async (key) => {
    const base = new InMemoryStorage()
    await base.write('prefix', new Uint8Array([1]))
    const view = resolveNamespace(wrapWithoutNamespace(base), 'prefix')

    await expect(view.read(key)).rejects.toThrow(StorageError)
    await expect(view.read(key)).rejects.toThrow('Storage key must not be empty')
    await expect(view.write(key, new Uint8Array([9]))).rejects.toThrow(StorageError)
    await expect(view.write(key, new Uint8Array([9]))).rejects.toThrow('Storage key must not be empty')
    await expect(view.delete(key)).rejects.toThrow(StorageError)
    await expect(view.delete(key)).rejects.toThrow('Storage key must not be empty')

    expect(await base.read('prefix')).toEqual(new Uint8Array([1]))
  })

  it('supports valid keys, empty list prefix, and nested namespaces on custom storage', async () => {
    const base = new InMemoryStorage()
    await base.write('prefix', new Uint8Array([1]))
    await base.write('prefix/sub', new Uint8Array([2]))
    const view = resolveNamespace(wrapWithoutNamespace(base), 'prefix')

    await view.write('child', new Uint8Array([3]))
    expect(await view.read('child')).toEqual(new Uint8Array([3]))
    expect(await view.list('')).toEqual(['child', 'sub'])
    expect(await view.list('/')).toEqual(['child', 'sub'])
    await view.delete('child')
    expect(await view.read('child')).toBeNull()

    const nested = view.namespace!('sub')
    for (const key of ['', '/', '///']) {
      await expect(nested.read(key)).rejects.toThrow('Storage key must not be empty')
      await expect(nested.write(key, new Uint8Array([9]))).rejects.toThrow('Storage key must not be empty')
      await expect(nested.delete(key)).rejects.toThrow('Storage key must not be empty')
    }

    expect(await base.read('prefix')).toEqual(new Uint8Array([1]))
    expect(await base.read('prefix/sub')).toEqual(new Uint8Array([2]))
  })

  it('rejects traversal and backslash keys', async () => {
    const base = new InMemoryStorage()
    const view = namespace(wrapWithoutNamespace(base), 'prefix')

    await expect(view.read('../secret')).rejects.toThrow(StorageError)
    await expect(view.write('../secret', new Uint8Array([1]))).rejects.toThrow(StorageError)
    await expect(view.delete('../secret')).rejects.toThrow(StorageError)
    await expect(view.list('../')).rejects.toThrow(StorageError)
    await expect(view.read('a\\b')).rejects.toThrow(StorageError)
  })
})
