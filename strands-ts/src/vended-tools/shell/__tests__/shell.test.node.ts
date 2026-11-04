import { describe, it, expect } from 'vitest'
import { makeBash, makeShell, ShellTimeoutError, ShellExecutionError, type ShellOutput } from '../index.js'
import { BashTimeoutError, BashSessionError } from '../../bash/types.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { TestSandbox } from '../../../__fixtures__/test-sandbox.node.js'
import type { ExecuteOptions } from '../../../sandbox/base.js'
import type { ExecutionResult } from '../../../sandbox/types.js'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe.skipIf(process.platform === 'win32')('makeShell', () => {
  const createSandboxShell = (): { sandboxShell: ReturnType<typeof makeShell>; context: ToolContext } => {
    const workDir = mkdtempSync(join(tmpdir(), 'shell-sandbox-test-'))
    const sandbox = new TestSandbox(workDir)
    const sandboxShell = makeShell(sandbox)
    const agent = createMockAgent()
    const context: ToolContext = {
      toolUse: { name: 'shell', toolUseId: 'test-id', input: {} },
      agent,
      invocationState: {},
      cancelSignal: agent.cancelSignal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }
    return { sandboxShell, context }
  }

  it('executes command via sandbox', async () => {
    const { sandboxShell, context } = createSandboxShell()
    const result = await sandboxShell.invoke({ command: 'echo "hello sandbox"' }, context)

    expect((result as ShellOutput).output).toContain('hello sandbox')
    expect((result as ShellOutput).error).toBe('')
    expect((result as ShellOutput).exit_code).toBe(0)
  })

  it('reports a non-zero exit code', async () => {
    const { sandboxShell, context } = createSandboxShell()
    const result = await sandboxShell.invoke({ command: 'exit 42' }, context)

    expect((result as ShellOutput).exit_code).toBe(42)
  })

  it('captures stderr via sandbox', async () => {
    const { sandboxShell, context } = createSandboxShell()
    const result = await sandboxShell.invoke({ command: 'echo "oops" >&2' }, context)

    expect((result as ShellOutput).error).toContain('oops')
    expect((result as ShellOutput).exit_code).toBe(0)
  })

  it('does not persist state between calls (stateless)', async () => {
    const { sandboxShell, context } = createSandboxShell()
    await sandboxShell.invoke({ command: 'export MY_VAR=hello' }, context)
    const result = await sandboxShell.invoke({ command: 'echo "${MY_VAR:-empty}"' }, context)

    expect((result as ShellOutput).output.trim()).toBe('empty')
  })

  it('respects timeout', async () => {
    const { sandboxShell, context } = createSandboxShell()
    await expect(sandboxShell.invoke({ command: 'sleep 10', timeout: 0.1 }, context)).rejects.toThrow()
  })

  it('throws ShellTimeoutError on timeout', async () => {
    const { sandboxShell, context } = createSandboxShell()
    await expect(sandboxShell.invoke({ command: 'sleep 10', timeout: 0.1 }, context)).rejects.toThrow(ShellTimeoutError)
  })

  it('timeout error carries the partial output with the same field names as a success result', async () => {
    const { sandboxShell, context } = createSandboxShell()
    const error = await sandboxShell
      .invoke({ command: 'echo partial; echo warn >&2; sleep 5', timeout: 0.3 }, context)
      .catch((e) => e)

    expect(error).toBeInstanceOf(ShellTimeoutError)
    expect(error.partial).toStrictEqual({ output: 'partial\n', error: 'warn\n', exit_code: 124 })
    expect(error.message).toBe(`Execution timed out after 0.3 seconds\n${JSON.stringify(error.partial)}`)
  })

  it('timeout surfaces as a failed tool result that still includes the partial output', async () => {
    const { sandboxShell, context } = createSandboxShell()
    const toolContext = {
      ...context,
      toolUse: { name: 'shell', toolUseId: 'test-id', input: { command: 'echo partial; sleep 5', timeout: 0.3 } },
    }
    const generator = sandboxShell.stream(toolContext)
    let next = await generator.next()
    while (!next.done) next = await generator.next()

    const result = next.value
    expect(result.status).toBe('error')
    const text = (result.content[0] as { text: string }).text
    expect(text).toMatch(/^Error: Execution timed out after 0.3 seconds\n/)
    expect(JSON.parse(text.split('\n')[1]!)).toStrictEqual({ output: 'partial\n', error: '', exit_code: 124 })
  })

  it('timeout error still matches the pre-rename BashTimeoutError', async () => {
    const { sandboxShell, context } = createSandboxShell()
    await expect(sandboxShell.invoke({ command: 'sleep 10', timeout: 0.1 }, context)).rejects.toThrow(BashTimeoutError)
  })

  it('ShellExecutionError still matches the pre-rename BashSessionError', () => {
    expect(new ShellExecutionError('boom')).toBeInstanceOf(BashSessionError)
  })

  describe('defaultTimeout', () => {
    class RecordingSandbox extends TestSandbox {
      timeouts: (number | undefined)[] = []

      override execute(command: string, options?: ExecuteOptions): Promise<ExecutionResult> {
        this.timeouts.push(options?.timeout)
        return super.execute(command, options)
      }
    }

    it('does not hard-code a default in the schema the model sees', () => {
      expect(makeShell({ defaultTimeout: 300 }).toolSpec.inputSchema).toMatchObject({
        properties: { timeout: { description: 'Optional per-execution timeout in seconds.' } },
      })
    })

    it('reaches the sandbox when the model omits timeout', async () => {
      const sandbox = new RecordingSandbox(mkdtempSync(join(tmpdir(), 'shell-sandbox-test-')))
      const { context } = createSandboxShell()
      await makeShell(sandbox, { defaultTimeout: 300 }).invoke({ command: 'true' }, context)
      expect(sandbox.timeouts).toEqual([300])
    })

    it('loses to an explicit timeout from the model', async () => {
      const sandbox = new RecordingSandbox(mkdtempSync(join(tmpdir(), 'shell-sandbox-test-')))
      const { context } = createSandboxShell()
      await makeShell(sandbox, { defaultTimeout: 300 }).invoke({ command: 'true', timeout: 7 }, context)
      expect(sandbox.timeouts).toEqual([7])
    })

    // Infinity would reach setTimeout, which clamps the overflow to 1 ms and times out every call.
    it.each([0, -1, Infinity, NaN])('rejects a non-positive or non-finite default (%s) at construction', (value) => {
      expect(() => makeShell({ defaultTimeout: value })).toThrow('defaultTimeout must be a positive finite number')
    })
  })
})

describe('deprecated makeBash alias', () => {
  // Consumers key registries, hooks, and defaults lists on the runtime name, so an
  // alias that returned a tool named 'shell' would still break them.
  it('keeps the pre-rename tool name', () => {
    expect(makeBash().name).toBe('bash')
  })

  it('matches makeShell apart from the name', () => {
    expect(makeBash().toolSpec).toEqual({ ...makeShell().toolSpec, name: 'bash' })
  })

  it('an explicit name still wins', () => {
    expect(makeBash({ name: 'sandbox_bash' }).name).toBe('sandbox_bash')
  })
})

describe('pre-rename bash import path (kept until v2.0.0)', () => {
  // The bash barrel re-exports the shell names so imports written before the
  // rename keep working. Nothing else exercises that path, so assert it here.
  it('still exposes every shell name', async () => {
    const barrel = await import('../../bash/index.js')
    expect(barrel.makeShell).toBe(makeShell)
    expect(barrel.makeBash).toBe(makeBash)
    expect(barrel.ShellTimeoutError).toBe(ShellTimeoutError)
    expect(barrel.ShellExecutionError).toBe(ShellExecutionError)
    expect(barrel.SANDBOX_SHELL_DESCRIPTION).toBeDefined()
    expect(barrel.SANDBOX_BASH_DESCRIPTION).toBe(barrel.SANDBOX_SHELL_DESCRIPTION)
  })
})
