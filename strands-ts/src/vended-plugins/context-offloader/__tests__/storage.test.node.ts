import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FileStorage } from '../storage.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

describe('FileStorage', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-offloader-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('stores and retrieves text content', async () => {
    const storage = new FileStorage(tmpDir)
    const content = new TextEncoder().encode('hello world')
    const ref = await storage.store('key1', content, 'text/plain')

    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('hello world')
    expect(result.contentType).toBe('text/plain')
  })

  it('stores and retrieves binary content', async () => {
    const storage = new FileStorage(tmpDir)
    const content = new Uint8Array([1, 2, 3, 4, 5])
    const ref = await storage.store('key1', content, 'image/png')

    const result = await storage.retrieve(ref)
    expect(result.content).toEqual(content)
    expect(result.contentType).toBe('image/png')
  })

  it('returns a portable filename as reference', async () => {
    const storage = new FileStorage(tmpDir)
    const content = new TextEncoder().encode('test')
    const ref = await storage.store('k1', content, 'text/plain')

    expect(ref).toBe(path.basename(ref))
    expect(ref).not.toContain(tmpDir)
    expect(ref).toMatch(/\.txt$/)
  })

  it('retrieves older full paths and bare filename stems', async () => {
    const storage = new FileStorage(tmpDir)
    const ref = await storage.store('legacy', new TextEncoder().encode('saved'), 'text/plain')
    for (const reference of [path.join(tmpDir, ref), path.parse(ref).name]) {
      const result = await storage.retrieve(reference)
      expect(new TextDecoder().decode(result.content)).toBe('saved')
      expect(result.contentType).toBe('text/plain')
    }
  })

  it('retrieves legacy paths when the artifact directory is relative', async () => {
    const cwdTmpDir = await fs.mkdtemp(path.join(process.cwd(), 'context-offloader-relative-'))
    try {
      const relativeDir = path.relative(process.cwd(), path.join(cwdTmpDir, 'artifacts'))
      const storage = new FileStorage(`./${relativeDir}`)
      const ref = await storage.store('legacy', new TextEncoder().encode('saved'), 'text/plain')

      for (const reference of [`./${relativeDir}/${ref}`, `${relativeDir}/${ref}`]) {
        const result = await storage.retrieve(reference)
        expect(new TextDecoder().decode(result.content)).toBe('saved')
      }
      await expect(storage.retrieve(`${relativeDir}/../${path.basename(relativeDir)}/${ref}`)).rejects.toThrow(
        'Reference not found'
      )
    } finally {
      await fs.rm(cwdTmpDir, { recursive: true, force: true })
    }
  })

  it('retrieves a stored key ending in a dot without allowing traversal', async () => {
    const storage = new FileStorage(tmpDir)
    const ref = await storage.store('Summary of results.', new TextEncoder().encode('saved'), 'text/plain')
    expect(ref).toContain('..txt')
    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('saved')
    await expect(storage.retrieve(`${tmpDir}/../${path.basename(tmpDir)}/${ref}`)).rejects.toThrow(
      'Reference not found'
    )
  })

  it('retrieves full paths without metadata and refuses unknown stems', async () => {
    const storage = new FileStorage(tmpDir)
    const ref = await storage.store('legacy', new TextEncoder().encode('saved'), 'text/plain')
    await fs.rm(path.join(tmpDir, '.metadata.json'))
    const reopened = new FileStorage(tmpDir)
    expect(new TextDecoder().decode((await reopened.retrieve(path.join(tmpDir, ref))).content)).toBe('saved')
    await expect(reopened.retrieve(path.parse(ref).name)).rejects.toThrow('Reference not found')
  })

  it('uses correct file extensions', async () => {
    const storage = new FileStorage(tmpDir)
    const content = new TextEncoder().encode('test')

    const txtRef = await storage.store('k1', content, 'text/plain')
    expect(txtRef).toMatch(/\.txt$/)

    const jsonRef = await storage.store('k2', content, 'application/json')
    expect(jsonRef).toMatch(/\.json$/)

    const pngRef = await storage.store('k3', content, 'image/png')
    expect(pngRef).toMatch(/\.png$/)
  })

  it('throws on missing reference', async () => {
    const storage = new FileStorage(tmpDir)
    await expect(storage.retrieve(path.join(tmpDir, 'nonexistent.txt'))).rejects.toThrow('Reference not found')
  })

  it('sanitizes keys for safe filenames', async () => {
    const storage = new FileStorage(tmpDir)
    const content = new TextEncoder().encode('test')
    const ref = await storage.store('../../../etc/passwd', content, 'text/plain')
    expect(ref).not.toContain('..')
  })

  it('prevents path traversal on retrieve', async () => {
    const storage = new FileStorage(tmpDir)
    await expect(storage.retrieve('../../etc/passwd')).rejects.toThrow('Reference not found')
  })

  it('confines retrieval to the artifact directory and rejects sibling prefixes', async () => {
    const storage = new FileStorage(tmpDir)

    // A sibling whose path shares the artifact directory prefix must not be retrievable.
    const sibling = `${tmpDir}_secret.txt`
    await fs.writeFile(sibling, 'top secret')
    try {
      await expect(storage.retrieve(sibling)).rejects.toThrow('Reference not found')
    } finally {
      await fs.rm(sibling, { force: true })
    }

    // A genuine file stored inside the artifact directory is still retrievable.
    const ref = await storage.store('inside', new TextEncoder().encode('ok'), 'text/plain')
    const result = await storage.retrieve(ref)
    expect(new TextDecoder().decode(result.content)).toBe('ok')
  })

  it('creates artifact directory if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir')
    const storage = new FileStorage(nestedDir)
    const content = new TextEncoder().encode('test')
    await storage.store('key1', content, 'text/plain')

    const stat = await fs.stat(nestedDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('persists metadata across instances', async () => {
    const storage1 = new FileStorage(tmpDir)
    const content = new TextEncoder().encode('test')
    const ref = await storage1.store('key1', content, 'application/json')

    const storage2 = new FileStorage(tmpDir)
    const result = await storage2.retrieve(ref)
    expect(result.contentType).toBe('application/json')
  })
})
