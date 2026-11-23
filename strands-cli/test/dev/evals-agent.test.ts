import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  evalsCommandArguments,
  writeEvalsOptimizeEntry,
  writeEvalsRunEntry,
} from '../../src/dev/evals-agent/entry-files.js'
import type { GenerationSettings } from '../../src/dev/panels/model.js'
import { temporaryGenerateArguments, temporaryGenerationFiles } from '../../src/dev/temporary-evals-fork/experiment.js'
import { temporaryDirectory } from '../fixtures/tempdir.js'

const PYTHON = process.env.STRANDS_TEST_EVALS_PYTHON ?? ''
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PYTEST_ARGUMENTS = ['-m', 'pytest', 'test/python', '-q', '-p', 'no:cacheprovider']
const PYTEST_TIMEOUT_MS = 600_000
const ENTRY_TIMEOUT_MS = 60_000
const RUN_ENTRY_FILE = "import runpy, sys; runpy.run_path(sys.argv[1].rpartition(':')[0])"
const EVERY_GENERATE_FLAG: GenerationSettings = {
  name: 'refunds',
  task: 'Answer refund questions',
  context: '',
  cases: 2,
  topics: 2,
  evaluators: [{ name: 'Contains', settings: { value: 'refund' } }, { name: 'HelpfulnessEvaluator' }],
  model: 'us.anthropic.claude-sonnet',
  parallel: 2,
  expectedTrajectory: true,
  expectedInteractions: true,
  metadata: true,
}

interface PythonExit {
  readonly code: number | null
  readonly stdout: string
  readonly output: string
}

const runPython = (args: readonly string[]): Promise<PythonExit> =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(PYTHON, args, {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    const output: string[] = []
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout.push(chunk)
      output.push(chunk)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => output.push(chunk))
    child.once('error', rejectExit)
    child.once('close', (code) => resolveExit({ code, stdout: stdout.join(''), output: output.join('') }))
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

  it(
    'shouldPrintTheEvaluatorCatalogWhenPythonRunsTheEvaluatorsCommand',
    async () => {
      const { code, stdout, output } = await runPython(evalsCommandArguments('evaluators'))

      expect(code, output).toBe(0)
      expect((JSON.parse(stdout) as { name: string }[]).map(({ name }) => name)).toContain('OutputEvaluator')
    },
    ENTRY_TIMEOUT_MS
  )

  it(
    'shouldAcceptEveryFlagThatStrandsDevPassesWhenPythonRunsTheGenerateCommand',
    async () => {
      const files = temporaryGenerationFiles(await temporaryDirectory(), 'refunds', new Date())
      const args = temporaryGenerateArguments(EVERY_GENERATE_FLAG, 'A refund agent.', files, 'typescript')

      const { code, output } = await runPython(args)

      expect(code, output).toBe(2)
      expect(output).toContain(
        'strands-evals generate: error: HelpfulnessEvaluator cannot score a TypeScript agent in strands dev.'
      )
      expect(existsSync(files.progress)).toBe(false)
    },
    ENTRY_TIMEOUT_MS
  )
})
