import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SandboxAbortError, SandboxPathNotFoundError } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { WorkspaceSandbox } from '../src/tui/workspace/sandbox.js'

describe('WorkspaceSandbox', () => {
  it('uses native filesystem operations for reads, listings, writes, and removes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'strands-workspace-sandbox-'))
    const sandbox = new WorkspaceSandbox(directory)
    sandbox.executeStreaming = async function* () {
      yield* []
      throw new Error('filesystem operations must not execute a shell')
    }

    try {
      await mkdir(join(directory, 'nested'))
      await writeFile(join(directory, 'skill.md'), 'hello')

      await expect(sandbox.readText(join(directory, 'skill.md'))).resolves.toBe('hello')
      await expect(sandbox.listFiles('.')).resolves.toEqual([
        { name: 'nested', isDir: true, size: expect.any(Number) },
        { name: 'skill.md', isDir: false, size: 5 },
      ])
      await expect(sandbox.listFiles('skill.md')).rejects.toBeInstanceOf(SandboxPathNotFoundError)
      await expect(sandbox.listFiles('missing')).rejects.toBeInstanceOf(SandboxPathNotFoundError)

      // Writes and removes must not go through `sh` either: PowerShell has none, so the
      // PosixShellSandbox default fails with `spawn sh ENOENT` on Windows.
      await sandbox.writeText(join(directory, 'out', 'novel.json'), '{"a":1}')
      await expect(readFile(join(directory, 'out', 'novel.json'), 'utf8')).resolves.toBe('{"a":1}')
      await sandbox.writeText('chapter.md', '# One')
      await expect(sandbox.readText(join(directory, 'chapter.md'))).resolves.toBe('# One')
      await sandbox.removeFile('chapter.md')
      await expect(stat(join(directory, 'chapter.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('describes its environment without shelling out', () => {
    expect(new WorkspaceSandbox('/work', { platform: 'linux' }).environment).toEqual({
      platform: 'Linux',
      cwd: resolve('/work'),
      shell: 'sh',
    })
    expect(new WorkspaceSandbox('/work', { platform: 'win32' }).environment).toMatchObject({
      platform: 'Windows',
      shell: 'PowerShell',
    })
  })

  it('runs commands through sh on POSIX and PowerShell on Windows', () => {
    expect(new WorkspaceSandbox('/work', { platform: 'linux' }).shellInvocation('echo hi')).toEqual({
      command: 'sh',
      args: ['-c', 'echo hi'],
    })
    const windows = new WorkspaceSandbox('/work', { platform: 'win32' }).shellInvocation('Get-ChildItem "a b"')
    expect(windows.command).toBe('powershell.exe')
    expect(windows.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    expect(windows.script).toContain('Get-ChildItem "a b"')
    expect(windows.script).toContain('exit $LASTEXITCODE')
    expect(windows.script).not.toContain("$ErrorActionPreference = 'Stop'")
  })

  // PowerShell semantics the model relies on: native exit codes propagate, stderr output alone is not a failure,
  // a failing cmdlet is, and a long command is not capped by the command-line length limit.
  it.runIf(process.platform === 'win32')('mirrors sh exit-code semantics through PowerShell', async () => {
    const sandbox = new WorkspaceSandbox(process.cwd())
    await expect(sandbox.execute('cmd /c "echo warn 1>&2"')).resolves.toMatchObject({ exitCode: 0 })
    expect((await sandbox.execute('cmd /c "echo warn 1>&2"')).stderr).toContain('warn')
    await expect(sandbox.execute('cmd /c "exit 3"')).resolves.toMatchObject({ exitCode: 3 })
    const failedCmdlet = await sandbox.execute('Get-Item C:\\strands-definitely-missing')
    expect(failedCmdlet.exitCode).toBe(1)
    expect(failedCmdlet.stderr).not.toBe('')
    await expect(sandbox.execute('Get-Item C:\\strands-definitely-missing; Write-Output after')).resolves.toMatchObject(
      {
        exitCode: 0,
        stdout: expect.stringContaining('after'),
      }
    )
    const long = `Write-Output '${'x'.repeat(40_000)}'`
    expect((await sandbox.execute(long)).stdout.trim()).toHaveLength(40_000)
    await expect(sandbox.execute('Write-Output "€"')).resolves.toMatchObject({ stdout: expect.stringContaining('€') })
  })

  it('runs code by feeding the interpreter on stdin, without a shell', async () => {
    const sandbox = new WorkspaceSandbox(process.cwd())
    sandbox.shellInvocation = () => {
      throw new Error('executeCode must not go through the shell')
    }
    const result = await sandbox.executeCode('process.stdout.write("ok " + process.cwd())', 'node')
    expect(result).toMatchObject({ exitCode: 0, stdout: `ok ${process.cwd()}` })
    await expect(sandbox.executeCode('x', 'python; rm -rf /')).rejects.toThrow('invalid characters')
    const missing = await sandbox.executeCode('x', 'definitely-not-an-interpreter').catch((error) => error)
    expect(missing).toMatchObject({ code: 'ENOENT' })
  })

  it('decodes UTF-8 characters split across stdout and stderr chunks', async () => {
    const script = [
      'process.stdout.write(Buffer.from([0xe2]))',
      'process.stderr.write(Buffer.from([0xc2]))',
      'setTimeout(() => {',
      '  process.stdout.write(Buffer.from([0x82, 0xac]))',
      '  process.stderr.write(Buffer.from([0xa3]))',
      '}, 20)',
    ].join(';')
    // sh takes JSON-style double quotes; PowerShell needs the call operator and single-quoted literals.
    const command =
      process.platform === 'win32'
        ? `& '${process.execPath}' -e '${script}'`
        : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    const sandbox = new WorkspaceSandbox(process.cwd())
    const streamed = { stdout: '', stderr: '' }
    let result

    for await (const event of sandbox.executeStreaming(command)) {
      if (event.type === 'streamChunk') {
        streamed[event.streamType] += event.data
      } else {
        result = event
      }
    }

    expect(streamed).toEqual({ stdout: '€', stderr: '£' })
    expect(result).toMatchObject({ exitCode: 0, stdout: '€', stderr: '£' })
  })

  it.skipIf(process.platform === 'win32')(
    'terminates descendants that keep output pipes open after cancellation',
    async () => {
      const descendantScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"
      const parentScript = [
        "const { spawn } = require('node:child_process')",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'inherit', 'inherit'] })`,
        "process.stdout.write(String(child.pid) + '\\n')",
        'setInterval(() => {}, 1_000)',
      ].join(';')
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`
      const sandbox = new WorkspaceSandbox(process.cwd())
      const abort = new AbortController()
      let descendantPid: number | undefined
      let cleanup: NodeJS.Timeout | undefined

      try {
        await expect(
          (async () => {
            for await (const event of sandbox.executeStreaming(command, { signal: abort.signal })) {
              if (event.type === 'streamChunk' && event.streamType === 'stdout') {
                const pid = Number(event.data.trim())
                expect(pid).toBeGreaterThan(0)
                descendantPid = pid
                cleanup = setTimeout(() => {
                  try {
                    process.kill(pid, 'SIGKILL')
                  } catch {
                    // The process tree terminator should have already removed it.
                  }
                }, 3_000)
                abort.abort()
              }
            }
          })()
        ).rejects.toBeInstanceOf(SandboxAbortError)
      } finally {
        if (cleanup) {
          clearTimeout(cleanup)
        }
        if (descendantPid) {
          const pid = descendantPid
          expect(() => process.kill(pid, 0)).toThrow()
        }
      }
    },
    6_000
  )
})
