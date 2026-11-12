import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { DevWorkspace } from '../workspace.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
  temporaryLanguageArguments,
  temporaryReportsFolder,
  temporaryRunName,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import { resolveTemporaryExperiment, temporaryCaseCount } from './experiment-files.js'

export interface TemporaryTestRequest {
  workspace: DevWorkspace
  experiment?: string
  forkArguments?: readonly string[]
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onProgress?: (line: string) => void
  prepare?: () => Promise<void>
  now?: () => Date
  onStart?: (files: { report: string; cases: string }) => void
  background?: boolean
}

export interface TemporaryTestOutcome {
  experiment: string
  name: string
  report: string
  passed: number
  checks: number
  overall: number
}

export interface TemporaryTestDependencies {
  run?: TemporaryCommandRunner
  spawnTests?: TemporaryEvalsSpawner
}

const TEST_OWNED_FLAGS = [
  '--agent',
  '--task',
  '-o',
  '--output',
  '--json',
  '--rich',
  '--typescript-runner',
  '--fail-on',
  '--exit-zero',
  '--display',
  '--interactive',
  '--data-store',
]

interface ReportScores {
  overall_score?: number
  test_passes?: boolean[]
}

const readScores = async (report: string): Promise<{ passed: number; checks: number; overall: number }> => {
  const { overall_score: overall = 0, test_passes: passes = [] } = JSON.parse(
    await readFile(report, 'utf8')
  ) as ReportScores
  return { passed: passes.filter(Boolean).length, checks: passes.length, overall }
}

const testNextStep = (code: number, log: string): string =>
  code === 2
    ? 'Fix the cause above (it is in the agent file, the experiment file, or the flags after --), then run the ' +
      `test again. The full output is in ${log}.`
    : `Fix the error above, then run the test again. The full output is in ${log}.`

const assertCases = (experiment: string, cases: number): void => {
  if (cases === 0)
    throw new Error(
      `${experiment} has no cases, so there is nothing to test. Add cases to it, or draft cases with ` +
        '/experiment, then run the test again.'
    )
}

const assertChecked = (experiment: string, report: string, checks: number): void => {
  if (checks === 0)
    throw new Error(
      `strands-evals run checked nothing: ${report} has no results. Check that ${experiment} lists evaluators, ` +
        'then run the test again.'
    )
}

export const runTemporaryTest = async (
  request: TemporaryTestRequest,
  dependencies: TemporaryTestDependencies = {}
): Promise<TemporaryTestOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  assertTemporaryForkArguments(forkArguments, TEST_OWNED_FLAGS, 'strands dev')
  const experiment = await resolveTemporaryExperiment(temporaryExperimentsFolder(directory), request.experiment, 'test')
  const cases = await temporaryCaseCount(experiment)
  assertCases(experiment, cases)
  await request.prepare?.()
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const folder = temporaryReportsFolder(directory)
  const name = temporaryRunName(experiment, request.now?.() ?? new Date())
  const report = join(folder, `${name}.json`)
  const log = join(folder, `${name}.log`)
  const caseStore = join(folder, `${name}.cases`)
  if (existsSync(report)) throw new Error(`The report ${report} already exists. Wait a second, then try again.`)
  await mkdir(folder, { recursive: true })
  onProgress(`Testing ${workspace.entrypoint} on the ${cases} cases of ${experiment}`)
  onProgress(`Report: ${report}`)
  onProgress('Running the cases. The summary appears when every case has finished.')
  request.onStart?.({ report, cases: caseStore })
  const exit = await (dependencies.spawnTests ?? spawnTemporaryEvals)({
    command: python,
    args: [
      '-m',
      'strands_evals.cli',
      'run',
      experiment,
      '--agent',
      workspace.entrypoint,
      ...temporaryLanguageArguments(workspace),
      '--output',
      report,
      '--fail-on',
      'none',
      '--data-store',
      caseStore,
      ...forkArguments,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    log,
    onLine: onProgress,
  })
  if (exit.code !== 0) throw temporaryEvalsFailure('strands-evals run', exit, environment, testNextStep(exit.code, log))
  if (!existsSync(report))
    throw new Error(`strands-evals run finished without writing ${report}. The full output is in ${log}.`)
  const scores = await readScores(report)
  assertChecked(experiment, report, scores.checks)
  const inFolder = dirname(experiment) === temporaryExperimentsFolder(directory)
  return { experiment, name: inFolder ? basename(experiment, '.json') : experiment, report, ...scores }
}
