import { spawn } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

const PYTHON = process.env.STRANDS_TEST_EVALS_PYTHON ?? ''
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PYTEST_ARGUMENTS = ['-m', 'pytest', 'test/python', '-q', '-p', 'no:cacheprovider']
const PYTEST_TIMEOUT_MS = 600_000

interface PythonExit {
  readonly code: number | null
  readonly output: string
}

const runPython = (args: readonly string[]): Promise<PythonExit> =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(PYTHON, args, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk))
    child.once('error', rejectExit)
    child.once('close', (code) => resolveExit({ code, output: output.join('') }))
  })

describe.skipIf(!PYTHON)('strands_dev_evals in strands-evals', () => {
  it(
    'shouldPassThePythonTestsWhenStrandsTestEvalsPythonNamesAnEvalsPython',
    async () => {
      const { code, output } = await runPython(PYTEST_ARGUMENTS)

      expect(code, output).toBe(0)
    },
    PYTEST_TIMEOUT_MS
  )
})
