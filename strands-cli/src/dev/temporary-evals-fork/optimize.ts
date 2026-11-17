import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'

import type { DevWorkspace } from '../workspace.js'
import type { TemporaryModelDiscovery } from './knobs.js'
import { temporaryRunFolder } from './study.js'
import { resolveTemporaryExperiment, temporaryRunnableExperiment } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment } from './environment.js'
import type { TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryLanguageArguments,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'
import {
  temporaryExperimentHome,
  temporaryExperimentsFolder,
  temporaryOptimizationFiles,
  temporaryOptimizationOf,
  temporaryRunStamp,
} from './layout.js'

export interface TemporaryOptimizationRequest {
  workspace: DevWorkspace
  experiment?: string
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
}

export interface TemporaryOptimizationDependencies {
  run?: TemporaryCommandRunner
  spawnOptimizer?: TemporaryEvalsSpawner
  discoverModels?: (provider: string) => Promise<TemporaryModelDiscovery>
}

const WRAPPER_OWNED_FLAGS = ['--agent', '--record', '--resume', '--json', '--rich', '--typescript-runner']

export const runTemporaryOptimization = async (
  request: TemporaryOptimizationRequest,
  dependencies: TemporaryOptimizationDependencies = {}
): Promise<TemporaryOptimizationOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  assertTemporaryForkArguments(forkArguments, WRAPPER_OWNED_FLAGS, 'strands dev')
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
  const files = request.continuing
    ? temporaryOptimizationOf(request.continuing)
    : temporaryOptimizationFiles(
        temporaryExperimentHome(directory, experiment),
        temporaryRunStamp(request.now?.() ?? new Date())
      )
  const { record, log } = files
  if (!request.continuing && existsSync(record))
    throw new Error(`The optimization record ${record} already exists. Wait a second, then try again.`)
  const resumed = request.continuing !== undefined && (await temporaryRunFolder(record)) !== undefined
  await mkdir(files.folder, { recursive: true })
  const runnable = await temporaryRunnableExperiment(experiment, files.copy)
  onProgress(`Optimizing ${workspace.entrypoint} against ${experiment}`)
  onProgress(`Record: ${record}`)
  onProgress('Measuring the baseline. The optimizer reports each candidate when it finishes.')
  request.onStart?.(record)
  const exit = await (dependencies.spawnOptimizer ?? spawnTemporaryEvals)({
    command: python,
    args: [
      '-m',
      'strands_evals.cli',
      'optimize',
      runnable,
      '--agent',
      workspace.entrypoint,
      resumed ? '--resume' : '--record',
      record,
      '--rich',
      ...temporaryLanguageArguments(workspace),
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
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals optimize', exit, environment, `The full optimizer output is in ${log}.`)
  return { experiment, record, summary: exit.stdout.split('\n').filter((line) => line.trim().length > 0) }
}
