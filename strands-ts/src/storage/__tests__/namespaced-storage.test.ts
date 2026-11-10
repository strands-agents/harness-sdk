import { describe, expect, it, beforeEach } from 'vitest'
import { InMemoryStorage } from '../in-memory-storage.js'
import { NAMESPACED, namespace } from '../storage.js'
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
