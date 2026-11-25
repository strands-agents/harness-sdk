import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isRecord } from '../../values.js'
import { writeEvalsOptimizeEntry, type EvalsFinalPick, type EvalsOptimizeEntry } from '../evals-agent/entry-files.js'
import type { OptimizeDecision, OptimizeObjective } from '../panels/model.js'
import type { EvalsHarnessDefaultsReader } from './knobs.js'
import { readEvalsProposerFailure, evalsRunFolder } from './study.js'
import { resolveEvalsExperiment, evalsRunnableExperiment } from './experiment.js'
import { ignoreProgress, prepareEvalsOptimizerEnvironment } from './environment.js'
import type { EvalsCommandRunner } from './environment.js'
import {
  assertEvalsArguments,
  runEvals,
  evalsFailure,
  evalsHeadline,
  temporaryTypescriptRunnerOf,
  evalsWorkspaceDirectory,
  type EvalsExit,
  type EvalsRequest,
  type EvalsSpawner,
} from './evals-process.js'
import {
  evalsExperimentHome,
  evalsExperimentsFolder,
  evalsOptimizationFiles,
  evalsOptimizationOf,
  evalsRunStamp,
  type EvalsOptimizationFiles,
} from './layout.js'
import { evalsObjectiveArguments } from './objective.js'
import {
  EVALS_DECISION_DEFAULTS,
  EVALS_OPTIMIZE_DEFAULTS,
  EVALS_PICK_QUANTILES,
  type EvalsOptimizeSettings,
} from './plan.js'

interface EvalsOptimizationRequest extends EvalsRequest {
  settings?: Partial<EvalsOptimizeSettings>
  objective?: OptimizeObjective
  space?: string
  onStart?: (record: string) => void
  continuing?: string
}

interface EvalsOptimizationOutcome {
  record: string
  summary: string[]
  proposerFailure?: string
}

export interface EvalsOptimizationDependencies {
  run?: EvalsCommandRunner
  spawnOptimizer?: EvalsSpawner
  harnessDefaults?: EvalsHarnessDefaultsReader
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

interface EvalsOptimizeFlags {
  readonly flags: readonly string[]
  readonly customEvaluators: readonly string[]
  readonly iterations?: number
  readonly tuned?: readonly string[]
  readonly reflectionModel?: string
}

const WRAPPER_OWNED_FLAGS = [
  '--agent',
  '--build-task',
  '--space',
  '--config',
  '--rollout',
  '--search',
  '--base-dir',
  '--name',
  '--json',
  '--rich',
  '--record',
  '--resume',
]
const RENAMED_FLAGS: Readonly<Record<string, string>> = {
  '--width': '--proposals-per-iteration',
  '--repetitions': '--runs-per-candidate',
  '--max-concurrency': '--max-workers',
}
const CONSTRAINT_FLAGS: Readonly<Record<string, string>> = { '--at-most': '<=', '--at-least': '>=' }
const ITERATION_FLAGS: readonly string[] = ['--iterations', '--max-iterations']
const REFLECTION_FLAGS: readonly string[] = ['--reflection-model', '--rewriter-model']
const OBJECTIVE_FLAG = '--objective'
const TUNE_FLAG = '--tune'
const CUSTOM_EVALUATOR_FLAG = '--custom-evaluator'
const READ_FLAGS: ReadonlySet<string> = new Set([
  ...Object.keys(RENAMED_FLAGS),
  ...Object.keys(CONSTRAINT_FLAGS),
  ...ITERATION_FLAGS,
  ...REFLECTION_FLAGS,
  OBJECTIVE_FLAG,
  TUNE_FLAG,
  CUSTOM_EVALUATOR_FLAG,
])

const flagParts = (argument: string): { name: string; inline?: string } => {
  const separator = argument.indexOf('=')
  return argument.startsWith('--') && separator > 0
    ? { name: argument.slice(0, separator), inline: argument.slice(separator + 1) }
    : { name: argument }
}

const iterationCount = (name: string, value: string): number => {
  const count = Number(value)
  if (!value.trim() || !Number.isInteger(count) || count < 0)
    throw new Error(`${name} takes a whole number, such as 4. Give 0 to measure only the baseline.`)
  return count
}

const constraintSpec = (name: string, operator: string, value: string): string => {
  const separator = value.indexOf('=')
  if (separator <= 0) throw new Error(`${name} takes METRIC=NUMBER, such as tokens=4000.`)
  return `${value.slice(0, separator)}${operator}${value.slice(separator + 1)}`
}

const objectiveFlags = (value: string): readonly string[] =>
  value.includes('(') ? evalsObjectiveArguments({ expression: value, constraints: '' }) : [OBJECTIVE_FLAG, value]

const withFlag = (read: EvalsOptimizeFlags, name: string, value: string): EvalsOptimizeFlags => {
  const renamed = RENAMED_FLAGS[name]
  if (renamed) return { ...read, flags: [...read.flags, renamed, value] }
  const operator = CONSTRAINT_FLAGS[name]
  if (operator) return { ...read, flags: [...read.flags, '--constraint', constraintSpec(name, operator, value)] }
  if (ITERATION_FLAGS.includes(name)) return { ...read, iterations: iterationCount(name, value) }
  if (REFLECTION_FLAGS.includes(name)) return { ...read, reflectionModel: value }
  if (name === OBJECTIVE_FLAG) return { ...read, flags: [...read.flags, ...objectiveFlags(value)] }
  if (name === TUNE_FLAG)
    return { ...read, tuned: value.split(',').flatMap((setting) => (setting.trim() ? [setting.trim()] : [])) }
  return { ...read, flags: [...read.flags, name, value], customEvaluators: [...read.customEvaluators, value] }
}

const readEvalsOptimizeFlags = (evalsArguments: readonly string[]): EvalsOptimizeFlags => {
  assertEvalsArguments(evalsArguments, WRAPPER_OWNED_FLAGS, 'strands dev')
  let read: EvalsOptimizeFlags = { flags: [], customEvaluators: [] }
  for (let index = 0; index < evalsArguments.length; index += 1) {
    const argument = evalsArguments[index]!
    const { name, inline } = flagParts(argument)
    if (!READ_FLAGS.has(name)) {
      read = { ...read, flags: [...read.flags, argument] }
      continue
    }
    if (inline === undefined) index += 1
    const value = inline ?? evalsArguments[index]
    if (value === undefined) throw new Error(`${name} needs a value after it.`)
    read = withFlag(read, name, value)
  }
  return read
}

const isBaselineOnly = ({ iterations }: EvalsOptimizeSettings): boolean => iterations === 0

const decisionArguments = ({ feasibility, crashScore, pickRule, finalists }: OptimizeDecision): string[] => {
  const defaults = EVALS_DECISION_DEFAULTS
  return [
    ...(feasibility === defaults.feasibility ? [] : ['--feasibility-threshold', String(feasibility)]),
    ...(crashScore === defaults.crashScore ? [] : ['--agent-failure-score', crashScore]),
    ...(pickRule !== 'mean' || finalists === defaults.finalists ? [] : ['--n-finalists', String(finalists)]),
  ]
}

const finalPickOf = ({ pickRule, finalists }: OptimizeDecision): EvalsFinalPick | undefined =>
  pickRule === 'mean' ? undefined : { finalists, lowerBound: EVALS_PICK_QUANTILES[pickRule] }

const settingArguments = (settings: EvalsOptimizeSettings): string[] => [
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

const runSettings = (request: EvalsOptimizationRequest, passed: EvalsOptimizeFlags): EvalsOptimizeSettings => ({
  ...EVALS_OPTIMIZE_DEFAULTS,
  ...request.settings,
  ...(passed.iterations === undefined ? {} : { iterations: passed.iterations }),
})

const entryOf = (
  { workspace, space }: EvalsOptimizationRequest,
  runnable: string,
  passed: EvalsOptimizeFlags,
  settings: EvalsOptimizeSettings
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
  request: EvalsOptimizationRequest,
  experiment: string,
  files: EvalsOptimizationFiles,
  passed: EvalsOptimizeFlags
): Promise<string[]> => {
  const settings = runSettings(request, passed)
  const baselineOnly = isBaselineOnly(settings)
  const runnable = await evalsRunnableExperiment(experiment, files.copy)
  const entry = entryOf(request, runnable, passed, settings)
  return [
    'run',
    runnable,
    ...(await writeEvalsOptimizeEntry(files.task, entry)),
    '--base-dir',
    files.record,
    '--rich',
    ...settingArguments(settings),
    ...(request.objective ? evalsObjectiveArguments(request.objective) : []),
    ...passed.flags,
    ...(baselineOnly ? [] : await reflectionArguments(passed.reflectionModel, request.space, entry.settings)),
  ]
}

const resumeArguments = async (
  request: EvalsOptimizationRequest,
  experiment: string,
  files: EvalsOptimizationFiles,
  passed: EvalsOptimizeFlags,
  runFolder: string
): Promise<string[]> => {
  const runnable = await evalsRunnableExperiment(experiment, files.copy)
  await writeEvalsOptimizeEntry(files.task, entryOf(request, runnable, passed, runSettings(request, passed)))
  const workers = request.settings?.concurrency
  return ['resume', runFolder, '--rich', ...(workers === undefined ? [] : ['--max-workers', String(workers)])]
}

const optimizationFiles = (
  request: EvalsOptimizationRequest,
  directory: string,
  experiment: string
): EvalsOptimizationFiles => {
  if (request.continuing) return evalsOptimizationOf(request.continuing)
  const files = evalsOptimizationFiles(
    evalsExperimentHome(directory, experiment),
    evalsRunStamp(request.now?.() ?? new Date())
  )
  if (existsSync(files.record))
    throw new Error(`The optimization record ${files.record} already exists. Wait a second, then try again.`)
  return files
}

const failureNextStep = (exit: EvalsExit, log: string): string => {
  const headline = evalsHeadline(exit)
  const advice = NEXT_STEPS.find(([marker]) => headline.includes(marker))?.[1]
  return [advice, `The full optimizer output is in ${log}.`].filter(Boolean).join(' ')
}

export const runEvalsOptimization = async (
  request: EvalsOptimizationRequest,
  dependencies: EvalsOptimizationDependencies = {}
): Promise<EvalsOptimizationOutcome> => {
  const { workspace, evalsArguments = [], signal, onProgress = ignoreProgress } = request
  const directory = evalsWorkspaceDirectory(workspace)
  const passed = readEvalsOptimizeFlags(evalsArguments)
  const experiment = await resolveEvalsExperiment(evalsExperimentsFolder(directory), request.experiment, 'optimize')
  await request.prepare?.()
  const python = await prepareEvalsOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const files = optimizationFiles(request, directory, experiment)
  const { record, log } = files
  const runFolder = request.continuing === undefined ? undefined : await evalsRunFolder(record)
  await mkdir(files.folder, { recursive: true })
  const args = runFolder
    ? await resumeArguments(request, experiment, files, passed, runFolder)
    : await newRunArguments(request, experiment, files, passed)
  onProgress(`Optimizing ${workspace.entrypoint} against ${experiment}`)
  onProgress(`Record: ${record}`)
  onProgress(runFolder ? CONTINUING : STARTING)
  request.onStart?.(record)
  const exit = await runEvals(
    dependencies.spawnOptimizer,
    request,
    { python, args: ['-m', 'strands_evals.cli', 'optimize', ...args], log },
    onProgress
  )
  const proposerFailure =
    exit.code === SEARCH_STOPPED_EXIT ? await readEvalsProposerFailure(record).catch(() => undefined) : undefined
  if (exit.code !== 0 && proposerFailure === undefined)
    throw evalsFailure(
      `strands-evals optimize ${runFolder ? 'resume' : 'run'}`,
      exit,
      process.env,
      failureNextStep(exit, log)
    )
  const summary = exit.stdout.split('\n').filter((line) => line.trim().length > 0)
  return { record, summary, ...(proposerFailure ? { proposerFailure } : {}) }
}
