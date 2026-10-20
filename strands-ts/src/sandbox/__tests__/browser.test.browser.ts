import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BrowserSandbox } from '../browser.js'
import { SandboxAbortError, SandboxPathNotFoundError, SandboxTimeoutError } from '../errors.js'
import type { ExecutionResult, StreamChunk } from '../types.js'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('BrowserSandbox', () => {
  let opfs: FileSystemDirectoryHandle
  let rootName: string
  let sandbox: BrowserSandbox

  beforeEach(async () => {
    // Each test gets its own OPFS directory so tests cannot see each other's files.
    opfs = await navigator.storage.getDirectory()
    rootName = `browser-sandbox-${globalThis.crypto.randomUUID()}`
    sandbox = new BrowserSandbox({ root: opfs.getDirectoryHandle(rootName, { create: true }) })
  })

  afterEach(async () => {
    await opfs.removeEntry(rootName, { recursive: true })
  })

  describe('files', () => {
    it('round-trips a file, creating parent directories', async () => {
      await sandbox.writeFile('notes/today/todo.txt', encode('buy milk'))

      expect(decode(await sandbox.readFile('notes/today/todo.txt'))).toBe('buy milk')
    })

    it('resolves absolute, relative, and dot segments from the root without escaping it', async () => {
      await sandbox.writeFile('/a/b.txt', encode('x'))

      expect(decode(await sandbox.readFile('a/./b.txt'))).toBe('x')
      expect(decode(await sandbox.readFile('../../a/b.txt'))).toBe('x')
    })

    it('overwrites an existing file', async () => {
      await sandbox.writeFile('f.txt', encode('a much longer first version'))
      await sandbox.writeFile('f.txt', encode('short'))

      expect(decode(await sandbox.readFile('f.txt'))).toBe('short')
    })

    it('lists a directory sorted by name with sizes', async () => {
      await sandbox.writeFile('dir/b.txt', encode('12345'))
      await sandbox.writeFile('dir/a.txt', encode('1'))
      await sandbox.writeFile('dir/sub/c.txt', encode(''))

      expect(await sandbox.listFiles('dir')).toStrictEqual([
        { name: 'a.txt', isDir: false, size: 1 },
        { name: 'b.txt', isDir: false, size: 5 },
        { name: 'sub', isDir: true },
      ])
    })

    it('lists the root', async () => {
      await sandbox.writeFile('top.txt', encode('t'))

      expect(await sandbox.listFiles('/')).toStrictEqual([{ name: 'top.txt', isDir: false, size: 1 }])
    })

    it('removes a file', async () => {
      await sandbox.writeFile('gone.txt', encode('x'))
      await sandbox.removeFile('gone.txt')

      expect(await sandbox.listFiles('.')).toStrictEqual([])
    })

    it.each([
      ['reading a missing file', (s: BrowserSandbox) => s.readFile('missing.txt')],
      ['reading under a missing directory', (s: BrowserSandbox) => s.readFile('nope/missing.txt')],
      [
        'reading a directory as a file',
        async (s: BrowserSandbox) => {
          await s.writeFile('d/x.txt', encode('x'))
          return s.readFile('d')
        },
      ],
      ['listing a missing directory', (s: BrowserSandbox) => s.listFiles('nope')],
      ['removing a missing file', (s: BrowserSandbox) => s.removeFile('missing.txt')],
    ])('throws SandboxPathNotFoundError when %s', async (_name, operation) => {
      await expect(operation(sandbox)).rejects.toThrow(SandboxPathNotFoundError)
    })
  })

  describe('code execution', () => {
    async function collect(iterable: AsyncIterable<StreamChunk | ExecutionResult>): Promise<{
      chunks: StreamChunk[]
      result: ExecutionResult | undefined
    }> {
      const chunks: StreamChunk[] = []
      let result: ExecutionResult | undefined
      for await (const item of iterable) {
        if (item.type === 'streamChunk') chunks.push(item)
        else result = item
      }
      return { chunks, result }
    }

    it('runs JavaScript and streams console output', async () => {
      const { chunks, result } = await collect(
        sandbox.executeCodeStreaming(
          "console.log('hello', 1 + 1)\nconsole.error('oops')\nconsole.log({ a: 1 })",
          'javascript'
        )
      )

      expect(chunks).toStrictEqual([
        { type: 'streamChunk', data: 'hello 2\n', streamType: 'stdout' },
        { type: 'streamChunk', data: 'oops\n', streamType: 'stderr' },
        { type: 'streamChunk', data: '{"a":1}\n', streamType: 'stdout' },
      ])
      expect(result).toStrictEqual({
        type: 'executionResult',
        exitCode: 0,
        stdout: 'hello 2\n{"a":1}\n',
        stderr: 'oops\n',
        outputFiles: [],
      })
    })

    it('supports top-level await', async () => {
      const result = await sandbox.executeCode("await new Promise((r) => setTimeout(r, 10)); console.log('done')", 'js')

      expect(result.stdout).toBe('done\n')
    })

    it('reports a thrown error with exit code 1', async () => {
      const result = await sandbox.executeCode("throw new Error('boom')", 'javascript')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('boom')
    })

    it('reports a syntax error with exit code 1', async () => {
      const result = await sandbox.executeCode('this is not javascript', 'javascript')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('SyntaxError')
    })

    it('terminates the worker on timeout', async () => {
      await expect(
        sandbox.executeCode("console.log('start'); while (true) {}", 'javascript', { timeout: 0.2 })
      ).rejects.toThrow(SandboxTimeoutError)
    })

    it('terminates the worker on abort', async () => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)

      await expect(sandbox.executeCode('while (true) {}', 'javascript', { signal: controller.signal })).rejects.toThrow(
        SandboxAbortError
      )
    })

    it('rejects an already-aborted signal without starting a worker', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(sandbox.executeCode('1', 'javascript', { signal: controller.signal })).rejects.toThrow(
        SandboxAbortError
      )
    })

    it('rejects languages other than JavaScript', async () => {
      await expect(sandbox.executeCode('print(1)', 'python')).rejects.toThrow('runs JavaScript only')
    })

    it('rejects shell commands', async () => {
      await expect(sandbox.execute('ls')).rejects.toThrow('cannot run shell commands')
    })
  })
})
