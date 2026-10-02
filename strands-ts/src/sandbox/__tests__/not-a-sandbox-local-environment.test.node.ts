import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { NotASandboxLocalEnvironment } from '../not-a-sandbox-local-environment.js'
import { SandboxPathNotFoundError } from '../errors.js'

const TEST_DIR = path.join(tmpdir(), 'strands-test-not-a-sandbox')
// Written relative (resolved against process.cwd()) to exercise _resolvePath; cleaned up below.
const REL_NAME = 'strands-not-a-sandbox-rel-probe.txt'
const REL_ABS = path.join(process.cwd(), REL_NAME)

describe.skipIf(process.platform === 'win32')('NotASandboxLocalEnvironment', () => {
  let sandbox: NotASandboxLocalEnvironment

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_DIR, { recursive: true })
    sandbox = new NotASandboxLocalEnvironment()
  })

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.rmSync(REL_ABS, { force: true })
  })

  describe('execute', () => {
    it('runs a command on the host', async () => {
      const result = await sandbox.execute('echo hello')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
    })

    it('respects the cwd option', async () => {
      const result = await sandbox.execute('pwd', { cwd: TEST_DIR })
      expect(result.stdout.trim()).toBe(TEST_DIR)
    })

    it('reports a non-zero exit code and stderr from a failing command', async () => {
      const result = await sandbox.execute('echo oops >&2; exit 3')
      expect(result.exitCode).toBe(3)
      expect(result.stderr).toBe('oops\n')
    })

    it('applies the env option', async () => {
      const result = await sandbox.execute('echo "$GREETING"', { env: { GREETING: 'hi' } })
      expect(result.stdout).toBe('hi\n')
    })
  })

  describe('executeCode', () => {
    it('runs code through the named interpreter', async () => {
      const result = await sandbox.executeCode('print(2 + 2)', 'python3', { cwd: TEST_DIR })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('4\n')
    })

    it('rejects a language with invalid characters', async () => {
      await expect(sandbox.executeCode('x', '../../bin/sh')).rejects.toThrow('invalid characters')
    })

    it('applies the env option', async () => {
      const result = await sandbox.executeCode('import os; print(os.environ["GREETING"])', 'python3', {
        env: { GREETING: 'hi' },
      })
      expect(result.stdout).toBe('hi\n')
    })
  })

  describe('read/write (native fs)', () => {
    it('text file roundtrip via absolute path', async () => {
      const file = path.join(TEST_DIR, 'note.txt')
      await sandbox.writeText(file, 'hello host')
      expect(await sandbox.readText(file)).toBe('hello host')
    })

    it('binary roundtrip preserves all byte values', async () => {
      const file = path.join(TEST_DIR, 'all-bytes.bin')
      const bytes = new Uint8Array(256)
      for (let i = 0; i < 256; i++) bytes[i] = i
      await sandbox.writeFile(file, bytes)
      expect(Array.from(await sandbox.readFile(file))).toStrictEqual(Array.from(bytes))
    })

    it('creates missing parent directories on write', async () => {
      const file = path.join(TEST_DIR, 'deep/nested/file.txt')
      await sandbox.writeText(file, 'deep')
      expect(await sandbox.readText(file)).toBe('deep')
    })

    it('throws when reading a nonexistent file', async () => {
      await expect(sandbox.readFile(path.join(TEST_DIR, 'nope.txt'))).rejects.toThrow()
    })
  })

  describe('removeFile', () => {
    it('removes a file', async () => {
      const file = path.join(TEST_DIR, 'delete-me.txt')
      await sandbox.writeText(file, 'bye')
      await sandbox.removeFile(file)
      await expect(sandbox.readFile(file)).rejects.toThrow()
    })

    it('throws on a nonexistent file', async () => {
      await expect(sandbox.removeFile(path.join(TEST_DIR, 'nope.txt'))).rejects.toThrow()
    })
  })

  describe('listFiles', () => {
    it('returns entries sorted by name with isDir and size metadata', async () => {
      await sandbox.writeText(path.join(TEST_DIR, 'c.txt'), 'cc')
      await sandbox.writeText(path.join(TEST_DIR, 'a.txt'), 'a')
      await sandbox.writeText(path.join(TEST_DIR, 'b.txt'), 'bbb')
      fs.mkdirSync(path.join(TEST_DIR, 'sub'))

      const files = await sandbox.listFiles(TEST_DIR)
      expect(files.map((f) => f.name)).toStrictEqual(['a.txt', 'b.txt', 'c.txt', 'sub'])

      const a = files.find((f) => f.name === 'a.txt')
      expect(a?.isDir).toBe(false)
      expect(a?.size).toBe(1)
      expect(files.find((f) => f.name === 'sub')?.isDir).toBe(true)
    })

    it('throws SandboxPathNotFoundError on a nonexistent directory', async () => {
      await expect(sandbox.listFiles(path.join(TEST_DIR, 'no-such-dir'))).rejects.toBeInstanceOf(
        SandboxPathNotFoundError
      )
    })

    it('throws SandboxPathNotFoundError when a path component is a file', async () => {
      await sandbox.writeText(path.join(TEST_DIR, 'file.txt'), 'x')
      await expect(sandbox.listFiles(path.join(TEST_DIR, 'file.txt', 'nested'))).rejects.toBeInstanceOf(
        SandboxPathNotFoundError
      )
    })
  })

  describe('_resolvePath (relative vs absolute)', () => {
    it('writes absolute paths as-is', async () => {
      const file = path.join(TEST_DIR, 'abs.txt')
      await sandbox.writeText(file, 'absolute')
      expect(fs.readFileSync(file, 'utf8')).toBe('absolute')
    })

    it('resolves relative paths against process.cwd()', async () => {
      await sandbox.writeText(REL_NAME, 'relative')
      expect(fs.readFileSync(REL_ABS, 'utf8')).toBe('relative')
    })
  })
})
