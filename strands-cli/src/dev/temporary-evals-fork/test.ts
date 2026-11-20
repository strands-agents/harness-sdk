import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import { writeEvalsRunEntry } from '../evals-agent/entry-files.js'
import type { DevWorkspace } from '../workspace.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryFlagValues,
  temporaryTypescriptRunnerOf,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import {
  readTemporaryExperimentFile,
  resolveTemporaryExperiment,
  temporaryCaseCount,
  temporaryNamedExperiment,
  temporaryRunnableExperiment,
  writeTemporaryExperimentFile,
} from './experiment-files.js'
import {
  temporaryExperimentHome,
  temporaryExperimentsFolder,
  temporaryFreeStamp,
  temporaryTestRunFiles,
  temporaryTestRunOf,
} from './layout.js'

export interface TemporaryTestFiles {
  readonly cases: string
  readonly report: string
  readonly log: string
  readonly store: string
}

export interface TemporaryTestRequest {
  workspace: DevWorkspace
  experiment?: string
  forkArguments?: readonly string[]
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onProgress?: (line: string) => void
  prepare?: () => Promise<void>
  now?: () => Date
  onStart?: (files: TemporaryTestFiles) => void | Promise<void>
  onSpawn?: (pid: number) => void
  background?: boolean
  detached?: boolean
  resume?: TemporaryTestFiles
  only?: readonly string[]
  startedAt?: number
}

export interface TemporaryTestOutcome {
  experiment: string
  name: string
  home: string
  report: string
  seconds: number
  passed: number
  checks: number
  overall: number
}

export interface TemporaryTestDependencies {
  run?: TemporaryCommandRunner
  spawnTests?: TemporaryEvalsSpawner
}

const TEST_WORKERS = 4
const MILLISECONDS_PER_SECOND = 1000
const CUSTOM_EVALUATOR_FLAG = '--custom-evaluator'

const TEST_OWNED_FLAGS = [
  '--agent',
  '--task',
  '-o',
  '--output',
  '--json',
  '--rich',
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
      `evaluation again. The full output is in ${log}.`
    : `Fix the error above, then run the evaluation again. The full output is in ${log}.`

const assertCases = (experiment: string, cases: number): void => {
  if (cases === 0)
    throw new Error(
      `${experiment} has no cases, so there is nothing to evaluate. Add cases to it, or draft cases with ` +
        '/experiment, then run the evaluation again.'
    )
}

const onlyCases = async (experiment: string, copy: string, names: readonly string[]): Promise<string> => {
  const { raw } = await readTemporaryExperimentFile(experiment)
  await writeTemporaryExperimentFile(copy, temporaryNamedExperiment(raw), names)
  return copy
}

const newTestFiles = async (
  experiment: string,
  home: string,
  now: Date,
  only: readonly string[] | undefined
): Promise<TemporaryTestFiles> => {
  const stamp = temporaryFreeStamp((candidate) => existsSync(temporaryTestRunFiles(home, candidate).folder), now)
  const { folder, report, log, store, copy } = temporaryTestRunFiles(home, stamp)
  await mkdir(folder, { recursive: true })
  return {
    cases: only ? await onlyCases(experiment, copy, only) : await temporaryRunnableExperiment(experiment, copy),
    report,
    log,
    store,
  }
}

const writeRunEntry = (
  workspace: DevWorkspace,
  { cases, report }: TemporaryTestFiles,
  forkArguments: readonly string[]
): Promise<string[]> =>
  writeEvalsRunEntry(temporaryTestRunOf(report).task, {
    agentFile: resolve(workspace.entrypoint),
    experimentFile: resolve(cases),
    customEvaluators: temporaryFlagValues(forkArguments, CUSTOM_EVALUATOR_FLAG),
    ...temporaryTypescriptRunnerOf(workspace),
  })

const assertChecked = (experiment: string, report: string, checks: number): void => {
  if (checks === 0)
    throw new Error(
      `strands-evals run checked nothing: ${report} has no results. Check that ${experiment} lists evaluators, ` +
        'then run the evaluation again.'
    )
}

export const runTemporaryTest = async (
  request: TemporaryTestRequest,
  dependencies: TemporaryTestDependencies = {}
): Promise<TemporaryTestOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  assertTemporaryForkArguments(forkArguments, TEST_OWNED_FLAGS, 'strands dev')
  const experiment = await resolveTemporaryExperiment(
    temporaryExperimentsFolder(directory),
    request.experiment,
    'evaluate'
  )
  const cases = await temporaryCaseCount(experiment)
  assertCases(experiment, cases)
  await request.prepare?.()
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const home = temporaryExperimentHome(directory, experiment)
  const startedAt = request.startedAt ?? Date.now()
  const files = request.resume ?? (await newTestFiles(experiment, home, request.now?.() ?? new Date(), request.only))
  const { report, log } = files
  const task = await writeRunEntry(workspace, files, forkArguments)
  onProgress(`Testing ${workspace.entrypoint} on the ${cases} cases of ${experiment}`)
  onProgress(`Report: ${report}`)
  onProgress('Running the cases. The summary appears when every case has finished.')
  await request.onStart?.(files)
  const exit = await (dependencies.spawnTests ?? spawnTemporaryEvals)({
    command: python,
    args: [
      '-m',
      'strands_evals.cli',
      'run',
      files.cases,
      ...task,
      '--output',
      report,
      '--fail-on',
      'none',
      '--data-store',
      files.store,
      '--max-workers',
      String(TEST_WORKERS),
      ...forkArguments,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    ...(request.detached ? { detached: true } : {}),
    ...(request.onSpawn ? { onSpawn: request.onSpawn } : {}),
    log,
    onLine: onProgress,
  })
  if (exit.code !== 0) throw temporaryEvalsFailure('strands-evals run', exit, environment, testNextStep(exit.code, log))
  if (!existsSync(report))
    throw new Error(`strands-evals run finished without writing ${report}. The full output is in ${log}.`)
  const scores = await readScores(report)
  assertChecked(experiment, report, scores.checks)
  const name = home === dirname(experiment) ? basename(experiment, '.json') : experiment
  return { experiment, name, home, report, seconds: (Date.now() - startedAt) / MILLISECONDS_PER_SECOND, ...scores }
}
