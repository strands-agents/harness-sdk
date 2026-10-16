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
      await sandbox.writeText('out/novel.json', '{"a":1}')
      await expect(readFile(join(directory, 'out', 'novel.json'), 'utf8')).resolves.toBe('{"a":1}')
      await sandbox.removeFile('out/novel.json')
      await expect(stat(join(directory, 'out', 'novel.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('describes the local environment without shell probes', () => {
    expect(new WorkspaceSandbox('/work', { platform: 'linux' }).environment).toMatchObject({
      platform: 'Linux',
      cwd: resolve('/work'),
      shell: 'sh',
    })
    expect(new WorkspaceSandbox('/work', { platform: 'win32' }).environment).toMatchObject({
      platform: 'Windows',
      shell: 'PowerShell',
    })
  })

  it('uses sh on POSIX and PowerShell on Windows', () => {
    expect(new WorkspaceSandbox('/work', { platform: 'linux' }).shellInvocation('echo hi')).toEqual({
      command: 'sh',
      args: ['-c', 'echo hi'],
    })
    const windows = new WorkspaceSandbox('/work', { platform: 'win32' }).shellInvocation('Get-ChildItem "a b"')
    expect(windows.command).toBe('powershell.exe')
    expect(windows.args).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    expect(windows.script).toContain('Get-ChildItem "a b"')
    expect(windows.script).toContain('exit $LASTEXITCODE')
  })

  it('feeds code directly to the interpreter', async () => {
    const sandbox = new WorkspaceSandbox(process.cwd())
    sandbox.shellInvocation = () => {
      throw new Error('executeCode must not use a shell')
    }
    await expect(sandbox.executeCode('process.stdout.write("ok")', 'node')).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'ok',
    })
    await expect(sandbox.executeCode('x', 'python; rm -rf /')).rejects.toThrow('invalid characters')
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
    const command =
      process.platform === 'win32'
        ? `& '${process.execPath.replaceAll("'", "''")}' -e '${script.replaceAll("'", "''")}'`
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
