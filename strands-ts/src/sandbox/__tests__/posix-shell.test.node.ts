import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { TestSandbox } from '../../__fixtures__/test-sandbox.node.js'
import { buildShellEnvPrefix } from '../posix-shell.js'
import { SandboxPathNotFoundError } from '../errors.js'
import { streamProcess } from '../stream-process.js'
import type { ExecutionResult, StreamChunk } from '../types.js'

const TEST_DIR = '/tmp/strands-test-shell-sandbox'

describe.skipIf(process.platform === 'win32')('PosixShellSandbox', () => {
  let sandbox: TestSandbox

  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_DIR, { recursive: true })
    sandbox = new TestSandbox(TEST_DIR)
  })

  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe('execute (via shell commands)', () => {
    it('runs a command', async () => {
      const result = await sandbox.execute('echo hello')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
    })

    it('runs in workingDir', async () => {
      const result = await sandbox.execute('pwd')
      expect(result.stdout.trim()).toContain('strands-test-shell-sandbox')
    })

    it('respects cwd option', async () => {
      const result = await sandbox.execute('pwd', { cwd: '/tmp' })
      expect(result.stdout.trim()).toMatch(/\/tmp$/)
    })
  })

  describe('env option (via buildEnvPrefix)', () => {
    it('passes env vars to the command', async () => {
      const result = await sandbox.execute('printenv FOO', { env: { FOO: 'hello', BAR: 'world' } })
      expect(result.stdout.trim()).toBe('hello')
    })

    it('shell-quotes env values so they are not evaluated', async () => {
      const result = await sandbox.execute('printenv FOO', { env: { FOO: '$(whoami)' } })
      expect(result.stdout.trim()).toBe('$(whoami)')
    })

    it('rejects invalid env var names', async () => {
      await expect(sandbox.execute('echo hi', { env: { 'BAD-KEY': 'v' } })).rejects.toThrow(
        'Invalid environment variable name'
      )
    })
  })

  describe('buildShellEnvPrefix', () => {
    it('returns an empty string when there are no env vars', () => {
      expect(buildShellEnvPrefix()).toBe('')
      expect(buildShellEnvPrefix({})).toBe('')
    })

    it('uses export so vars are inherited across a pipeline, with a fail-fast && separator', () => {
      // `export ... &&` (not `env ... `) is what lets env reach the right side of the
      // `base64 ... | <interpreter>` pipe in executeCode. Locking the exact format.
      expect(buildShellEnvPrefix({ FOO: 'bar', BAZ: 'qux' })).toBe("export FOO='bar' BAZ='qux' && ")
    })

    it('shell-quotes values so they are not evaluated', () => {
      expect(buildShellEnvPrefix({ FOO: '$(whoami)' })).toBe("export FOO='$(whoami)' && ")
    })

    it('throws on invalid env var names', () => {
      expect(() => buildShellEnvPrefix({ 'BAD-KEY': 'v' })).toThrow('Invalid environment variable name')
    })
  })

  describe('executeCode (via shell quoting)', () => {
    it('runs python code through shell', async () => {
      const result = await sandbox.executeCode('print(2 + 2)', 'python3')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('4\n')
    })

    it('handles code with special characters', async () => {
      const result = await sandbox.executeCode('print(\'hello "world"\')', 'python3')
      expect(result.stdout).toBe('hello "world"\n')
    })

    it('handles code with single quotes', async () => {
      const result = await sandbox.executeCode('print("it\'s working")', 'python3')
      expect(result.stdout).toBe("it's working\n")
    })

    it('passes env vars through to the interpreter', async () => {
      const result = await sandbox.executeCode('import os; print(os.environ["FOO"])', 'python3', {
        env: { FOO: 'from-env' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('from-env')
    })

    it('passes env values to the interpreter literally, without shell evaluation', async () => {
      const result = await sandbox.executeCode('import os; print(os.environ["FOO"])', 'python3', {
        env: { FOO: '$(whoami)' },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe('$(whoami)')
    })
  })

  describe('language validation', () => {
    it('rejects path traversal', async () => {
      await expect(sandbox.executeCode('x', '../../../bin/sh')).rejects.toThrow('invalid characters')
    })

    it('rejects shell metacharacters', async () => {
      await expect(sandbox.executeCode('x', 'python;rm -rf /')).rejects.toThrow('invalid characters')
    })

    it('rejects spaces', async () => {
      await expect(sandbox.executeCode('x', 'python -c')).rejects.toThrow('invalid characters')
    })

    it('allows valid interpreters', async () => {
      const result = await sandbox.executeCode('print("safe")', 'python3')
      expect(result.exitCode).toBe(0)
    })

    it('allows dots and hyphens', async () => {
      const result = await sandbox.executeCode('x', 'fake-lang.99')
      expect(result.exitCode).toBe(127)
    })
  })

  describe('read/write (via base64 encoding over shell)', () => {
    it('text file roundtrip', async () => {
      await sandbox.writeText('test.txt', 'hello shell')
      const text = await sandbox.readText('test.txt')
      expect(text).toBe('hello shell')
    })

    it('binary file roundtrip', async () => {
      const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
      await sandbox.writeFile('binary.bin', bytes)
      const read = await sandbox.readFile('binary.bin')
      expect(Array.from(read)).toStrictEqual(Array.from(bytes))
    })

    it('all 256 byte values roundtrip', async () => {
      const bytes = new Uint8Array(256)
      for (let i = 0; i < 256; i++) bytes[i] = i
      await sandbox.writeFile('all-bytes.bin', bytes)
      const read = await sandbox.readFile('all-bytes.bin')
      expect(Array.from(read)).toStrictEqual(Array.from(bytes))
    })

    it('creates parent directories', async () => {
      await sandbox.writeText('deep/nested/file.txt', 'deep')
      const text = await sandbox.readText('deep/nested/file.txt')
      expect(text).toBe('deep')
    })

    it('handles unicode content', async () => {
      const content = '日本語 🚀 émojis'
      await sandbox.writeText('unicode.txt', content)
      const text = await sandbox.readText('unicode.txt')
      expect(text).toBe(content)
    })

    it('handles shell metacharacters in content', async () => {
      const content = '$(rm -rf /) `whoami` && || $HOME'
      await sandbox.writeText('meta.txt', content)
      const text = await sandbox.readText('meta.txt')
      expect(text).toBe(content)
    })

    it('throws on nonexistent file', async () => {
      await expect(sandbox.readFile('nope.txt')).rejects.toThrow()
    })
  })

  describe('remove', () => {
    it('removes a file', async () => {
      await sandbox.writeText('delete-me.txt', 'bye')
      await sandbox.removeFile('delete-me.txt')
      await expect(sandbox.readFile('delete-me.txt')).rejects.toThrow()
    })

    it('throws on nonexistent file', async () => {
      await expect(sandbox.removeFile('nope.txt')).rejects.toThrow()
    })
  })

  describe('list (via ls -1ap parsing)', () => {
    it('lists directory contents', async () => {
      await sandbox.writeText('a.txt', 'a')
      await sandbox.writeText('b.txt', 'b')
      const files = await sandbox.listFiles('.')
      const names = files.map((f) => f.name)
      expect(names).toContain('a.txt')
      expect(names).toContain('b.txt')
    })

    it('identifies directories', async () => {
      await sandbox.execute('mkdir -p subdir')
      const files = await sandbox.listFiles('.')
      const subdir = files.find((f) => f.name === 'subdir')
      expect(subdir?.isDir).toBe(true)
    })

    it('excludes . and .. entries', async () => {
      await sandbox.writeText('file.txt', '')
      const files = await sandbox.listFiles('.')
      const names = files.map((f) => f.name)
      expect(names).not.toContain('.')
      expect(names).not.toContain('..')
    })

    it('throws SandboxPathNotFoundError on nonexistent directory', async () => {
      await expect(sandbox.listFiles('/tmp/nonexistent-dir-xyz')).rejects.toBeInstanceOf(SandboxPathNotFoundError)
    })

    it('throws SandboxPathNotFoundError when path is a file, not a directory', async () => {
      await sandbox.writeText('not-a-dir.txt', 'hello')
      await expect(sandbox.listFiles('not-a-dir.txt')).rejects.toBeInstanceOf(SandboxPathNotFoundError)
    })
  })

  describe('shellQuote', () => {
    it('handles paths with spaces', async () => {
      await sandbox.execute('mkdir -p "with spaces"')
      await sandbox.writeText('with spaces/file.txt', 'spaced')
      const text = await sandbox.readText('with spaces/file.txt')
      expect(text).toBe('spaced')
    })

    it('handles paths with single quotes', async () => {
      await sandbox.execute('mkdir -p "it\'s"')
      await sandbox.writeText("it's/file.txt", 'quoted')
      const text = await sandbox.readText("it's/file.txt")
      expect(text).toBe('quoted')
    })
  })

  describe('timeout', () => {
    it('kills process on timeout', async () => {
      const start = Date.now()
      await expect(sandbox.execute('sleep 60', { timeout: 0.2 })).rejects.toThrow('timed out')
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2000)
    })

    it('does not timeout fast commands', async () => {
      const result = await sandbox.execute('echo fast', { timeout: 5 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('fast\n')
    })
  })

  describe('abort signal', () => {
    it('kills process when signal is aborted', async () => {
      const controller = new AbortController()
      const promise = sandbox.execute('sleep 60', { signal: controller.signal })
      setTimeout(() => controller.abort(), 100)
      await expect(promise).rejects.toThrow('aborted')
    })

    it('rejects immediately if signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(sandbox.execute('sleep 60', { signal: controller.signal })).rejects.toThrow('aborted')
    })
  })

  describe('concurrent execution', () => {
    it('handles multiple concurrent commands', async () => {
      const results = await Promise.all([
        sandbox.execute('echo one'),
        sandbox.execute('echo two'),
        sandbox.execute('echo three'),
      ])
      expect(results.map((r) => r.stdout.trim()).sort()).toStrictEqual(['one', 'three', 'two'])
    })

    it('handles concurrent file writes to different files', async () => {
      await Promise.all([
        sandbox.writeText('a.txt', 'aaa'),
        sandbox.writeText('b.txt', 'bbb'),
        sandbox.writeText('c.txt', 'ccc'),
      ])
      const [a, b, c] = await Promise.all([
        sandbox.readText('a.txt'),
        sandbox.readText('b.txt'),
        sandbox.readText('c.txt'),
      ])
      expect(a).toBe('aaa')
      expect(b).toBe('bbb')
      expect(c).toBe('ccc')
    })
  })

  describe('streaming', () => {
    it('yields StreamChunks then ExecutionResult', async () => {
      const chunks: Array<{ type: string }> = []
      for await (const chunk of sandbox.executeStreaming('echo hello')) {
        chunks.push(chunk)
      }
      const streamChunks = chunks.filter((c) => c.type === 'streamChunk')
      const results = chunks.filter((c) => c.type === 'executionResult')
      expect(streamChunks.length).toBeGreaterThan(0)
      expect(results).toHaveLength(1)
    })
  })

  describe('streamProcess edge cases', () => {
    it('returns exit code 127 when command is not found', async () => {
      const result = await sandbox.execute('nonexistent_binary_xyz_12345')
      expect(result.exitCode).toBe(127)
      expect(result.stderr).toContain('not found')
    })

    it('maps signal termination to 128 + signal number', async () => {
      // sh -c 'kill -9 $$' sends SIGKILL to itself → exit code 128 + 9 = 137
      const result = await sandbox.execute("sh -c 'kill -9 $$'")
      expect(result.exitCode).toBe(137)
    })

    it('decodes multibyte UTF-8 sequences split across chunk boundaries', async () => {
      // Regression guard for #4156. A UTF-8 character straddling a pipe read
      // boundary must not be decoded as two invalid halves. The helper writes
      // 'café☕' as two Buffers split mid-'é' (byte 4 of 5), so a per-chunk decode
      // would yield U+FFFD replacements.
      const script =
        "const b=Buffer.from('café☕','utf8');" +
        'process.stdout.write(b.subarray(0,4));' +
        'setTimeout(()=>process.stdout.write(b.subarray(4)),20)'
      const chunks: (StreamChunk | ExecutionResult)[] = []
      for await (const chunk of streamProcess('node', ['-e', script])) {
        chunks.push(chunk)
      }
      const result = chunks.find((c): c is ExecutionResult => c.type === 'executionResult')
      expect(result?.stdout).toBe('café☕')
      const streamed = chunks
        .filter((c): c is StreamChunk => c.type === 'streamChunk' && c.streamType === 'stdout')
        .map((c) => c.data)
        .join('')
      expect(streamed).toBe('café☕')
    })

    it('returns enoentMessage when spawned binary does not exist', async () => {
      const chunks: (StreamChunk | ExecutionResult)[] = []
      for await (const chunk of streamProcess('nonexistent_binary_xyz_12345', [], {
        enoentMessage: 'binary not found',
      })) {
        chunks.push(chunk)
      }
      const result = chunks.find((c): c is ExecutionResult => c.type === 'executionResult')
      expect(result).toStrictEqual({
        type: 'executionResult',
        exitCode: 127,
        stdout: '',
        stderr: 'binary not found',
        outputFiles: [],
      })
    })
  })
})
