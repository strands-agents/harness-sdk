import { describe, expect, it } from 'vitest'
import type { ExecutionResult, Sandbox } from '@strands-agents/sdk'

import { SHELL_PROBE, shellOf } from '../src/sandbox-shell.js'

function sandboxAnswering(
  ...results: Array<Pick<ExecutionResult, 'exitCode' | 'stdout'>>
): Sandbox & { probes: number } {
  const queue = [...results]
  return {
    probes: 0,
    execute(command: string): Promise<ExecutionResult> {
      if (command !== SHELL_PROBE) throw new Error(`unexpected command ${command}`)
      this.probes++
      const next = queue.shift() ?? results.at(-1)!
      return Promise.resolve({ type: 'executionResult', stderr: '', outputFiles: [], ...next })
    },
  } as unknown as Sandbox & { probes: number }
}

describe('shellOf', () => {
  it('recognises PowerShell by its edition and caches the answer per sandbox', async () => {
    const sandbox = sandboxAnswering({ exitCode: 0, stdout: 'Core\r\n' })
    expect(await shellOf(sandbox)).toBe('powershell')
    expect(await shellOf(sandbox)).toBe('powershell')
    expect(sandbox.probes).toBe(1)
  })

  it('treats an empty expansion as sh', async () => {
    expect(await shellOf(sandboxAnswering({ exitCode: 0, stdout: '\n' }))).toBe('sh')
  })

  it('does not cache a failed probe', async () => {
    const sandbox = sandboxAnswering({ exitCode: 1, stdout: '' }, { exitCode: 0, stdout: 'Desktop\n' })
    expect(await shellOf(sandbox)).toBe('sh')
    expect(await shellOf(sandbox)).toBe('powershell')
    expect(sandbox.probes).toBe(2)
  })
})
