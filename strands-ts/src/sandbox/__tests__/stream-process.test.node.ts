import { describe, it, expect, vi } from 'vitest'
import * as childProcess from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SandboxAbortError, SandboxTimeoutError } from '../errors.js'
import { streamProcess } from '../stream-process.js'
import type { ExecutionResult } from '../types.js'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

async function run(
  command: string,
  args: string[],
  options?: Parameters<typeof streamProcess>[2]
): Promise<ExecutionResult> {
  for await (const event of streamProcess(command, args, options)) {
    if (event.type === 'executionResult') return event
  }
  throw new Error('no result')
}

describe.skipIf(process.platform === 'win32')('streamProcess options', () => {
  it('runs the child in cwd', async () => {
    const result = await run('sh', ['-c', 'pwd'], { cwd: os.tmpdir() })
    // macOS's temp dir is a symlink (/var -> /private/var); compare resolved paths.
    expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(os.tmpdir()))
  })

  it('replaces the environment with env', async () => {
    const result = await run('sh', ['-c', 'echo "$GREETING:$HOME"'], {
      env: { GREETING: 'hi', PATH: process.env.PATH },
    })
    expect(result.stdout).toBe('hi:\n')
  })

  it('feeds input to stdin and closes it', async () => {
    const result = await run('cat', [], { input: 'hello from stdin' })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'hello from stdin' })
  })

  it('does not fail when the child exits without reading its input', async () => {
    const result = await run('sh', ['-c', 'exit 0'], { input: 'x'.repeat(1_000_000) })
    expect(result.exitCode).toBe(0)
  })

  it('leaves stdin open when no input is given', async () => {
    await expect(run('cat', [], { timeout: 1 })).rejects.toThrow(/timed out/i)
  })
})

describe.skipIf(process.platform === 'win32')('streamProcess termination', () => {
  /** A command whose backgrounded child creates `marker` after 0.5s, unless the child is killed first. */
  const backgroundedChild = (): { command: string; marker: string } => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-process-')), 'ran')
    return { command: `(sleep 0.5; touch ${marker}) & echo started; wait`, marker }
  }

  const expectChildWasKilled = async (marker: string): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(fs.existsSync(marker)).toBe(false)
  }

  it('kills the whole process tree on abort', async () => {
    const { command, marker } = backgroundedChild()
    const controller = new AbortController()

    const consume = async (): Promise<void> => {
      for await (const _ of streamProcess('sh', ['-c', command], { signal: controller.signal })) controller.abort()
    }

    await expect(consume()).rejects.toBeInstanceOf(SandboxAbortError)
    await expectChildWasKilled(marker)
  })

  it('kills the whole process tree on timeout', async () => {
    const { command, marker } = backgroundedChild()
    await expect(run('sh', ['-c', command], { timeout: 0.1 })).rejects.toBeInstanceOf(SandboxTimeoutError)
    await expectChildWasKilled(marker)
  })

  it('kills the whole process tree when the consumer stops early', async () => {
    const { command, marker } = backgroundedChild()
    for await (const _ of streamProcess('sh', ['-c', command])) break
    await expectChildWasKilled(marker)
  })

  it('kills a command that ignores SIGTERM', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stream-process-')), 'ran')
    const command = `trap '' TERM; sleep 1.5; touch ${marker}`
    await expect(run('sh', ['-c', command], { timeout: 0.1 })).rejects.toBeInstanceOf(SandboxTimeoutError)

    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('does not spawn when the signal is already aborted', async () => {
    vi.mocked(childProcess.spawn).mockClear()
    await expect(run('sh', ['-c', 'echo hi'], { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      SandboxAbortError
    )
    expect(childProcess.spawn).not.toHaveBeenCalled()
  })
})
