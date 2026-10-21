import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NotASandboxLocalEnvironment } from '../not-a-sandbox-local-environment.js'
import { SandboxPathNotFoundError } from '../errors.js'

const WINDOWS = process.platform === 'win32'
const TEST_DIR = path.join(os.tmpdir(), 'strands-test-not-a-sandbox')
// Written relative (resolved against process.cwd()) to exercise _resolvePath; cleaned up below.
const REL_NAME = 'strands-not-a-sandbox-rel-probe.txt'
const REL_ABS = path.join(process.cwd(), REL_NAME)
// Commands run in `sh` on POSIX and in PowerShell on Windows; each pair means the same thing.
const PRINT_CWD = WINDOWS ? '(Get-Location).Path' : 'pwd'
const FAIL_WITH_STDERR = WINDOWS ? "[Console]::Error.WriteLine('oops'); exit 3" : 'echo oops >&2; exit 3'
const PRINT_GREETING = WINDOWS ? 'echo $env:GREETING' : 'echo "$GREETING"'
const PYTHON = WINDOWS ? 'python' : 'python3'
// PowerShell and Windows Python end lines with \r\n.
const EOL = WINDOWS ? '\r\n' : '\n'

describe('NotASandboxLocalEnvironment', () => {
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
      expect(result.stdout).toBe(`hello${EOL}`)
    })

    it('respects the cwd option', async () => {
      const result = await sandbox.execute(PRINT_CWD, { cwd: TEST_DIR })
      // `.native` expands Windows 8.3 short names (RUNNER~1), which os.tmpdir() may return.
      expect(fs.realpathSync.native(result.stdout.trim())).toBe(fs.realpathSync.native(TEST_DIR))
    })

    it('reports a non-zero exit code and stderr from a failing command', async () => {
      const result = await sandbox.execute(FAIL_WITH_STDERR)
      expect(result.exitCode).toBe(3)
      expect(result.stderr).toBe(`oops${EOL}`)
    })

    it('applies the env option', async () => {
      const result = await sandbox.execute(PRINT_GREETING, { env: { GREETING: 'hi' } })
      expect(result.stdout).toBe(`hi${EOL}`)
    })
  })

  describe('executeCode', () => {
    it('runs code through the named interpreter', async () => {
      const result = await sandbox.executeCode('print(2 + 2)', PYTHON, { cwd: TEST_DIR })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`4${EOL}`)
    })

    it('rejects a language with invalid characters', async () => {
      await expect(sandbox.executeCode('x', '../../bin/sh')).rejects.toThrow('invalid characters')
    })

    it('applies the env option', async () => {
      const result = await sandbox.executeCode('import os; print(os.environ["GREETING"])', PYTHON, {
        env: { GREETING: 'hi' },
      })
      expect(result.stdout).toBe(`hi${EOL}`)
    })

    it('reports a missing interpreter as exit 127', async () => {
      // `sh` says "command not found"; the direct spawn on Windows says "Language interpreter not found".
      const result = await sandbox.executeCode('x', 'strands-definitely-not-an-interpreter')
      expect(result.exitCode).toBe(127)
      expect(result.stderr).toMatch(/not found/)
    })
  })

  // PowerShell semantics the model relies on: native exit codes propagate, stderr output alone is not a
  // failure, a failing cmdlet is, a multi-KB command runs, and UTF-8 survives.
  describe.runIf(WINDOWS)('execute on Windows (PowerShell)', () => {
    it('propagates a native command exit code', async () => {
      expect((await sandbox.execute('cmd /c "exit 3"')).exitCode).toBe(3)
    })

    it('does not treat stderr output from a successful native command as failure', async () => {
      const result = await sandbox.execute('cmd /c "echo warn 1>&2"')
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toContain('warn')
    })

    it('reports a failing cmdlet as exit 1 and keeps going after it', async () => {
      const failed = await sandbox.execute('Get-Item C:\\strands-definitely-missing')
      expect(failed.exitCode).toBe(1)
      expect(failed.stderr).not.toBe('')
      const continued = await sandbox.execute('Get-Item C:\\strands-definitely-missing; Write-Output after')
      expect(continued.exitCode).toBe(0)
      expect(continued.stdout).toContain('after')
    })

    it('runs an 8 KB command', async () => {
      const result = await sandbox.execute(`Write-Output '${'x'.repeat(8_000)}'`)
      expect(result.stdout.trim()).toHaveLength(8_000)
    })

    it('round-trips UTF-8 output', async () => {
      expect((await sandbox.execute('Write-Output "€"')).stdout).toContain('€')
    })

    it('overrides a host variable whose name differs only by case', async () => {
      process.env.Strands_Case_Probe = 'host'
      try {
        const result = await sandbox.execute('echo $env:STRANDS_CASE_PROBE', {
          env: { STRANDS_CASE_PROBE: 'override' },
        })
        expect(result.stdout.trim()).toBe('override')
      } finally {
        delete process.env.Strands_Case_Probe
      }
    })
  })

  // The POSIX path is unchanged: stdin stays an open pipe, so a command that reads it waits rather than seeing EOF.
  describe.skipIf(WINDOWS)('execute on POSIX', () => {
    it('keeps stdin open when no input is given', async () => {
      await expect(sandbox.execute('cat', { timeout: 1 })).rejects.toThrow(/timed out/i)
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
