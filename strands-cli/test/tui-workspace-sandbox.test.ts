import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxAbortError, SandboxPathNotFoundError } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { WorkspaceSandbox } from '../src/tui/workspace/sandbox.js'

describe('WorkspaceSandbox', () => {
  it('uses native filesystem operations for local reads and directory listings', async () => {
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
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
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
