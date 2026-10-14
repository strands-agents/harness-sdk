import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  makePythonRepl,
  pythonRepl,
  PYTHON_REPL_DESCRIPTION,
  PythonReplError,
  type PythonReplOutput,
} from '../index.js'
import * as vendedTools from '../../index.js'
import { NotASandboxLocalEnvironment } from '../../../sandbox/not-a-sandbox-local-environment.js'
import { SandboxAbortError, SandboxTimeoutError } from '../../../sandbox/errors.js'
import type { Sandbox } from '../../../sandbox/base.js'
import type { ToolContext } from '../../../index.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'

const toolContext = (
  sandbox: Sandbox = new NotASandboxLocalEnvironment(),
  cancelSignal = new AbortController().signal
): ToolContext => {
  const agent = createMockAgent({ extra: { sandbox } })
  return {
    toolUse: { name: 'python_repl', toolUseId: 'id', input: {} },
    agent,
    invocationState: {},
    cancelSignal,
    interrupt: () => {
      throw new Error('interrupt not available in mock context')
    },
  }
}

const mockSandbox = (
  impl: () => Promise<unknown> = async () => ({ type: 'executionResult', exitCode: 0, stdout: 'hi\n', stderr: '' })
) => {
  const sandbox = new NotASandboxLocalEnvironment()
  const executeCode = vi.spyOn(sandbox, 'executeCode').mockImplementation(impl as Sandbox['executeCode'])
  return { sandbox, executeCode }
}

const run = (input: { code: string; timeout?: number }, context: ToolContext, tool = pythonRepl) =>
  tool.invoke(input, context) as Promise<PythonReplOutput>

describe('python_repl shim', () => {
  it('uses the agent sandbox and defaults', async () => {
    const { sandbox, executeCode } = mockSandbox()
    const context = toolContext(sandbox)
    const result = await run({ code: "print('hi')" }, context)
    expect(executeCode).toHaveBeenCalledExactlyOnceWith("print('hi')", 'python3', {
      timeout: 120,
      signal: context.cancelSignal,
    })
    expect(result).toStrictEqual({ output: 'hi\n', error: '', exit_code: 0 })
  })

  it('prefers a bound sandbox and forwards language and timeout', async () => {
    const bound = mockSandbox()
    const agentSandbox = mockSandbox()
    const tool = makePythonRepl(bound.sandbox, { language: 'python3.12' })
    await run({ code: 'pass', timeout: 7 }, toolContext(agentSandbox.sandbox), tool)
    expect(bound.executeCode).toHaveBeenCalledExactlyOnceWith(
      'pass',
      'python3.12',
      expect.objectContaining({ timeout: 7 })
    )
    expect(agentSandbox.executeCode).not.toHaveBeenCalled()
  })

  it('rejects a non-positive timeout', async () => {
    const { sandbox, executeCode } = mockSandbox()
    await expect(run({ code: 'pass', timeout: 0 }, toolContext(sandbox))).rejects.toThrow(
      /timeout must be a positive number of seconds, got 0/
    )
    expect(executeCode).not.toHaveBeenCalled()
  })

  it.each([
    [new Error('container gone'), 'container gone'],
    ['container gone', 'container gone'],
  ])('wraps sandbox error %o as PythonReplError', async (boom, message) => {
    const { sandbox } = mockSandbox(async () => {
      throw boom
    })
    const error = await run({ code: 'pass' }, toolContext(sandbox)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PythonReplError)
    expect(error).toMatchObject({ message, cause: boom })
  })

  it('requires a tool context', async () => {
    await expect(pythonRepl.invoke({ code: 'pass' })).rejects.toThrow('Tool context is required')
  })
})

describe.skipIf(process.platform === 'win32')('python_repl local execution', () => {
  it.each([
    ["raise ValueError('bad')", 'ValueError: bad'],
    ['input()', 'EOFError'],
  ])('reports failure of %s via error and non-zero exit', async (code, expectedError) => {
    const result = await run({ code }, toolContext())
    expect(result.exit_code).not.toBe(0)
    expect(result.error).toContain(expectedError)
  })

  it('does not persist state across calls but files do', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'python-repl-test-')), 'state.json')
    const ctx = toolContext()
    await run({ code: `import json; x = 42; json.dump({'x': x}, open(${JSON.stringify(path)}, 'w'))` }, ctx)

    const missing = await run({ code: 'print(x)' }, ctx)
    expect(missing.error).toContain('NameError')

    const restored = await run({ code: `import json; print(json.load(open(${JSON.stringify(path)}))['x'])` }, ctx)
    expect(restored).toStrictEqual({ output: '42\n', error: '', exit_code: 0 })
  })

  it('timeout carries partial output with the success field names', async () => {
    const error = await run(
      { code: "print('partial', flush=True)\nimport time; time.sleep(10)", timeout: 0.5 },
      toolContext()
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxTimeoutError)
    const payload = JSON.parse((error as Error).message.split('\n')[1]!)
    expect(payload).toStrictEqual({ output: 'partial\n', error: '', exit_code: 124 })
  })

  it('cancellation stops the call and propagates unwrapped', async () => {
    const controller = new AbortController()
    const pending = run({ code: 'import time; time.sleep(10)' }, toolContext(undefined, controller.signal))
    setTimeout(() => controller.abort(), 100)
    const start = Date.now()
    await expect(pending).rejects.toBeInstanceOf(SandboxAbortError)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('makePythonRepl', () => {
  it.each([
    [{ name: '' }, /name/],
    [{ language: 'python3; rm -rf /' }, /language/],
  ])('rejects invalid arguments %o', (options, match) => {
    expect(() => makePythonRepl(options)).toThrow(match)
  })

  it('has the default tool spec and exports', () => {
    expect(pythonRepl.name).toBe('python_repl')
    expect(pythonRepl.toolSpec.description).toBe(PYTHON_REPL_DESCRIPTION)
    const schema = pythonRepl.toolSpec.inputSchema as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties).sort()).toStrictEqual(['code', 'timeout'])
    expect(schema.required).toStrictEqual(['code'])
    expect(vendedTools.pythonRepl).toBe(pythonRepl)
    expect(vendedTools.makePythonRepl).toBe(makePythonRepl)
  })

  it('resolves both overloads and applies a custom name and description', () => {
    const tool = makePythonRepl(undefined, { name: 'run_python', description: 'custom' })
    expect(tool.name).toBe('run_python')
    expect(tool.toolSpec.description).toBe('custom')
    expect(makePythonRepl(new NotASandboxLocalEnvironment()).name).toBe('python_repl')
  })
})
