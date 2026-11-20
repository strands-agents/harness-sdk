import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isRecord } from '../../values.js'
import { writeEvalsOptimizeEntry, type EvalsFinalPick, type EvalsOptimizeEntry } from '../evals-agent/entry-files.js'
import type { OptimizeDecision, OptimizeObjective } from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryModelDiscovery } from './knobs.js'
import { hasTemporaryRunResult, temporaryRunFolder } from './study.js'
import { resolveTemporaryExperiment, temporaryRunnableExperiment } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment } from './environment.js'
import type { TemporaryCommandRunner } from './environment.js'
import {
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryEvalsHeadline,
  temporaryTypescriptRunnerOf,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsExit,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import {
  temporaryExperimentHome,
  temporaryExperimentsFolder,
  temporaryOptimizationFiles,
  temporaryOptimizationOf,
  temporaryRunStamp,
  type TemporaryOptimizationFiles,
} from './layout.js'
import { temporaryObjectiveArguments } from './objective.js'
import { readTemporaryOptimizeFlags, type TemporaryOptimizeFlags } from './optimize-flags.js'
import {
  TEMPORARY_DECISION_DEFAULTS,
  TEMPORARY_OPTIMIZE_DEFAULTS,
  TEMPORARY_PICK_QUANTILES,
  type TemporaryOptimizeSettings,
} from './plan.js'

export interface TemporaryOptimizationRequest {
  workspace: DevWorkspace
  experiment?: string
  settings?: Partial<TemporaryOptimizeSettings>
  objective?: OptimizeObjective
  space?: string
  forkArguments?: readonly string[]
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onProgress?: (line: string) => void
  prepare?: () => Promise<void>
  now?: () => Date
  onStart?: (record: string) => void
  background?: boolean
  detached?: boolean
  onSpawn?: (pid: number) => void
  continuing?: string
}

export interface TemporaryOptimizationOutcome {
  experiment: string
  record: string
  summary: string[]
  proposerFailed: boolean
}

export interface TemporaryOptimizationDependencies {
  run?: TemporaryCommandRunner
  spawnOptimizer?: TemporaryEvalsSpawner
  discoverModels?: (provider: string) => Promise<TemporaryModelDiscovery>
}

const TUNED_BY_DEFAULT: readonly string[] = ['instructions']
const TEXT_SETTINGS: readonly string[] = ['instructions']
const SEARCH_STOPPED_EXIT = 3
const STARTING = 'Measuring the baseline. The optimizer reports each iteration when it finishes.'
const CONTINUING = 'Continuing the run from where it stopped.'
const BASELINE_NEXT_STEP =
  'If the agent failed, check that it answers one of the cases in a strands dev chat. ' +
  'If a judge or the model service failed, check its credentials. Then try again.'
const NEW_RUN_NEXT_STEP = 'Ask for a new run in the chat.'
const NEXT_STEPS: readonly (readonly [marker: string, nextStep: string])[] = [
  [
    'at least 1 is needed',
    'Add more cases to the experiment, or choose a split that gives train and validation one case each at least.',
  ],
  ['share above 0', 'Give train and validation a share above 0 in the split.'],
  ['sums to', 'Change the split so that the three shares sum to 1.'],
  ['case names must be unique', 'Give every case in the experiment file a unique name, then try again.'],
  ['every case needs a name', 'Give every case in the experiment file a unique name, then try again.'],
  ['nothing to optimize: give an objective', 'Add an evaluator to the experiment file, or give the run an objective.'],
  [
    'have no bounded range',
    'Give each usage metric of the WeightedSum or Pareto a scale=, such as Minimize(tokens, scale=1000).',
  ],
  ["can't cover the baseline", 'Pass a larger --max-rollouts, or use an experiment with fewer cases.'],
  ['unmeasured for the baseline', BASELINE_NEXT_STEP],
  ['trial of the baseline failed', BASELINE_NEXT_STEP],
  ['nothing to resume', NEW_RUN_NEXT_STEP],
  ['changed:', NEW_RUN_NEXT_STEP],
  ['has no cli.json', NEW_RUN_NEXT_STEP],
]

const summaryLines = ({ stdout }: TemporaryEvalsExit): string[] =>
  stdout.split('\n').filter((line) => line.trim().length > 0)

const isBaselineOnly = ({ iterations }: TemporaryOptimizeSettings): boolean => iterations === 0

const decisionArguments = ({ feasibility, crashScore, pickRule, finalists }: OptimizeDecision): string[] => {
  const defaults = TEMPORARY_DECISION_DEFAULTS
  return [
    ...(feasibility === defaults.feasibility ? [] : ['--feasibility-threshold', String(feasibility)]),
    ...(crashScore === defaults.crashScore ? [] : ['--agent-failure-score', crashScore]),
    ...(pickRule !== 'mean' || finalists === defaults.finalists ? [] : ['--n-finalists', String(finalists)]),
  ]
}

const finalPickOf = ({ pickRule, finalists }: OptimizeDecision): EvalsFinalPick | undefined =>
  pickRule === 'mean' ? undefined : { finalists, lowerBound: TEMPORARY_PICK_QUANTILES[pickRule] }

const settingArguments = (settings: TemporaryOptimizeSettings): string[] => [
  '--split',
  settings.split.join(','),
  ...(isBaselineOnly(settings) ? [] : ['--max-iterations', String(settings.iterations)]),
  '--proposals-per-iteration',
  String(settings.width),
  '--runs-per-candidate',
  String(settings.repetitions),
  '--max-workers',
  String(settings.concurrency),
  '--max-rollouts',
  String(settings.maxRollouts),
  '--seed',
  String(settings.seed),
  ...decisionArguments(settings.decision),
]

const tunesText = async (space: string | undefined, tuned: readonly string[]): Promise<boolean> => {
  if (space === undefined) return tuned.some((setting) => TEXT_SETTINGS.includes(setting))
  const document: unknown = JSON.parse(await readFile(space, 'utf8'))
  return (
    isRecord(document) &&
    Array.isArray(document.variables) &&
    document.variables.some((variable) => isRecord(variable) && variable.kind === 'text')
  )
}

const reflectionArguments = async (
  reflectionModel: string | undefined,
  space: string | undefined,
  tuned: readonly string[]
): Promise<string[]> =>
  reflectionModel !== undefined && (await tunesText(space, tuned)) ? ['--reflection-model', reflectionModel] : []

const runSettings = (
  request: TemporaryOptimizationRequest,
  passed: TemporaryOptimizeFlags
): TemporaryOptimizeSettings => ({
  ...TEMPORARY_OPTIMIZE_DEFAULTS,
  ...request.settings,
  ...(passed.iterations === undefined ? {} : { iterations: passed.iterations }),
})

const entryOf = (
  { workspace, space }: TemporaryOptimizationRequest,
  runnable: string,
  passed: TemporaryOptimizeFlags,
  settings: TemporaryOptimizeSettings
): EvalsOptimizeEntry => {
  const finalPick = finalPickOf(settings.decision)
  return {
    agentFile: resolve(workspace.entrypoint),
    experimentFile: resolve(runnable),
    customEvaluators: passed.customEvaluators,
    ...temporaryTypescriptRunnerOf(workspace),
    ...(space ? { spaceFile: resolve(space) } : {}),
    settings: passed.tuned ?? TUNED_BY_DEFAULT,
    baselineOnly: isBaselineOnly(settings),
    ...(finalPick ? { finalPick } : {}),
  }
}

const newRunArguments = async (
  request: TemporaryOptimizationRequest,
  experiment: string,
  files: TemporaryOptimizationFiles,
  passed: TemporaryOptimizeFlags
): Promise<string[]> => {
  const settings = runSettings(request, passed)
  const baselineOnly = isBaselineOnly(settings)
  const runnable = await temporaryRunnableExperiment(experiment, files.copy)
  const entry = entryOf(request, runnable, passed, settings)
  return [
    'run',
    runnable,
    ...(await writeEvalsOptimizeEntry(files.task, entry)),
    '--base-dir',
    files.record,
    '--rich',
    ...settingArguments(settings),
    ...(request.objective ? temporaryObjectiveArguments(request.objective) : []),
    ...passed.flags,
    ...(baselineOnly ? [] : await reflectionArguments(passed.reflectionModel, request.space, entry.settings)),
  ]
}

const resumeArguments = async (
  request: TemporaryOptimizationRequest,
  experiment: string,
  files: TemporaryOptimizationFiles,
  passed: TemporaryOptimizeFlags,
  runFolder: string
): Promise<string[]> => {
  const runnable = await temporaryRunnableExperiment(experiment, files.copy)
  await writeEvalsOptimizeEntry(files.task, entryOf(request, runnable, passed, runSettings(request, passed)))
  const workers = request.settings?.concurrency
  return ['resume', runFolder, '--rich', ...(workers === undefined ? [] : ['--max-workers', String(workers)])]
}

const optimizationFiles = (
  request: TemporaryOptimizationRequest,
  directory: string,
  experiment: string
): TemporaryOptimizationFiles => {
  if (request.continuing) return temporaryOptimizationOf(request.continuing)
  const files = temporaryOptimizationFiles(
    temporaryExperimentHome(directory, experiment),
    temporaryRunStamp(request.now?.() ?? new Date())
  )
  if (existsSync(files.record))
    throw new Error(`The optimization record ${files.record} already exists. Wait a second, then try again.`)
  return files
}

const failureNextStep = (exit: TemporaryEvalsExit, log: string): string => {
  const headline = temporaryEvalsHeadline(exit)
  const advice = NEXT_STEPS.find(([marker]) => headline.includes(marker))?.[1]
  return [advice, `The full optimizer output is in ${log}.`].filter(Boolean).join(' ')
}

const hasFinished = async ({ code }: TemporaryEvalsExit, record: string): Promise<boolean> =>
  code === 0 || (code === SEARCH_STOPPED_EXIT && (await hasTemporaryRunResult(record)))

const spawnOptimizer = (
  request: TemporaryOptimizationRequest,
  dependencies: TemporaryOptimizationDependencies,
  { python, args, log }: { python: string; args: readonly string[]; log: string }
): Promise<TemporaryEvalsExit> => {
  const { workspace, environment = process.env, signal, onProgress = ignoreProgress } = request
  return (dependencies.spawnOptimizer ?? spawnTemporaryEvals)({
    command: python,
    args: ['-m', 'strands_evals.cli', 'optimize', ...args],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    ...(request.detached ? { detached: true } : {}),
    ...(request.onSpawn ? { onSpawn: request.onSpawn } : {}),
    log,
    onLine: onProgress,
  })
}

export const runTemporaryOptimization = async (
  request: TemporaryOptimizationRequest,
  dependencies: TemporaryOptimizationDependencies = {}
): Promise<TemporaryOptimizationOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  const passed = readTemporaryOptimizeFlags(forkArguments)
  const experiment = await resolveTemporaryExperiment(
    temporaryExperimentsFolder(directory),
    request.experiment,
    'optimize'
  )
  await request.prepare?.()
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const files = optimizationFiles(request, directory, experiment)
  const { record, log } = files
  const runFolder = request.continuing === undefined ? undefined : await temporaryRunFolder(record)
  await mkdir(files.folder, { recursive: true })
  const args = runFolder
    ? await resumeArguments(request, experiment, files, passed, runFolder)
    : await newRunArguments(request, experiment, files, passed)
  onProgress(`Optimizing ${workspace.entrypoint} against ${experiment}`)
  onProgress(`Record: ${record}`)
  onProgress(runFolder ? CONTINUING : STARTING)
  request.onStart?.(record)
  const exit = await spawnOptimizer(request, dependencies, { python, args, log })
  if (!(await hasFinished(exit, record)))
    throw temporaryEvalsFailure(
      `strands-evals optimize ${runFolder ? 'resume' : 'run'}`,
      exit,
      environment,
      failureNextStep(exit, log)
    )
  return { experiment, record, summary: summaryLines(exit), proposerFailed: exit.code === SEARCH_STOPPED_EXIT }
}
