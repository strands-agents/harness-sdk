import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileStorage } from '../storage.js'
import { TestSandbox } from '../../../__fixtures__/test-sandbox.node.js'

const TEST_DIR = join(tmpdir(), 'strands-test-file-storage-sandbox')

describe.skipIf(process.platform === 'win32')('FileStorage with sandbox', () => {
  let sandbox: TestSandbox
  let storage: FileStorage

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_DIR, { recursive: true })
    sandbox = new TestSandbox(TEST_DIR)
    storage = new FileStorage({ sandbox })
  })

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('stores and retrieves text content', async () => {
    const reference = await storage.store('test-key', new TextEncoder().encode('hello offloaded'), 'text/plain')
    const retrieved = await storage.retrieve(reference)
    expect(new TextDecoder().decode(retrieved.content)).toBe('hello offloaded')
    expect(retrieved.contentType).toBe('text/plain')
  })

  it('stores and retrieves JSON content', async () => {
    const json = JSON.stringify({ key: 'value' })
    const reference = await storage.store('json-key', new TextEncoder().encode(json), 'application/json')
    const retrieved = await storage.retrieve(reference)
    expect(new TextDecoder().decode(retrieved.content)).toBe(json)
    expect(retrieved.contentType).toBe('application/json')
  })

  it('stores and retrieves binary content', async () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
    const reference = await storage.store('binary-key', bytes, 'application/octet-stream')
    const retrieved = await storage.retrieve(reference)
    expect(Array.from(retrieved.content)).toStrictEqual(Array.from(bytes))
  })

  it('creates files under the artifact directory with a type-derived extension', async () => {
    const reference = await storage.store('my-key', new TextEncoder().encode('test'), 'text/plain')
    expect(reference.startsWith('./artifacts/')).toBe(true)
    expect(reference).toContain('my-key')
    expect(reference.endsWith('.txt')).toBe(true)
  })

  it('uses a custom artifact directory', async () => {
    const custom = new FileStorage({ artifactDir: 'custom-artifacts', sandbox })
    const reference = await custom.store('key', new TextEncoder().encode('custom path'), 'text/plain')
    expect(reference.startsWith('custom-artifacts/')).toBe(true)
    expect(new TextDecoder().decode((await custom.retrieve(reference)).content)).toBe('custom path')
  })

  it('persists content types across instances via .metadata.json', async () => {
    const reference = await storage.store('persist', new TextEncoder().encode('{}'), 'application/json')

    const reopened = new FileStorage({ sandbox })
    expect((await reopened.retrieve(reference)).contentType).toBe('application/json')
  })

  it('throws on retrieve with an out-of-bounds reference', async () => {
    await expect(storage.retrieve('nonexistent/path.txt')).rejects.toThrow('Reference not found')
  })

  it('throws on path traversal in a reference', async () => {
    await expect(storage.retrieve('./artifacts/../escape.txt')).rejects.toThrow('Reference not found')
  })

  it('produces unique references for repeated keys', async () => {
    const ref1 = await storage.store('key', new TextEncoder().encode('first'), 'text/plain')
    const ref2 = await storage.store('key', new TextEncoder().encode('second'), 'text/plain')
    expect(ref1).not.toBe(ref2)
    expect(new TextDecoder().decode((await storage.retrieve(ref1)).content)).toBe('first')
    expect(new TextDecoder().decode((await storage.retrieve(ref2)).content)).toBe('second')
  })
})
