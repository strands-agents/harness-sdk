import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import { streamProcess } from '../stream-process.js'
import type { ExecutionResult } from '../types.js'

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
