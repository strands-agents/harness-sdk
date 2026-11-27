import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { writeEvalsOptimizeEntry, writeEvalsRunEntry } from '../../../src/dev/evals/python/entry-files.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const PYTHON = process.env.STRANDS_TEST_EVALS_PYTHON ?? ''
const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PYTEST_ARGUMENTS = ['-m', 'pytest', 'test/dev/evals/python', '-q', '-p', 'no:cacheprovider']
const PYTEST_TIMEOUT_MS = 600_000
const ENTRY_TIMEOUT_MS = 60_000
const RUN_ENTRY_FILE = "import runpy, sys; runpy.run_path(sys.argv[1].rpartition(':')[0])"

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

  it.each([
    {
      entry: 'RunEntryFile',
      write: (folder: string) =>
        writeEvalsRunEntry(join(folder, 'task.py'), {
          agentFile: join(folder, 'missing-agent.py'),
          experimentFile: join(folder, 'experiment.json'),
          customEvaluators: [],
        }),
    },
    {
      entry: 'OptimizeEntryFile',
      write: (folder: string) =>
        writeEvalsOptimizeEntry(join(folder, 'task.py'), {
          agentFile: join(folder, 'missing-agent.py'),
          experimentFile: join(folder, 'experiment.json'),
          customEvaluators: [],
          settings: ['instructions'],
          baselineOnly: false,
        }),
    },
  ])(
    'shouldImportThePackageFromItsFolderWhenPythonRunsThe$entry',
    async ({ write }) => {
      const folder = await temporaryDirectory()
      const flags = await write(folder)

      const { code, output } = await runPython(['-c', RUN_ENTRY_FILE, flags[1]!])

      expect(code).not.toBe(0)
      expect(output).toContain(`StrandsDevEvalsError: cannot find the agent file ${join(folder, 'missing-agent.py')}`)
    },
    ENTRY_TIMEOUT_MS
  )
})
