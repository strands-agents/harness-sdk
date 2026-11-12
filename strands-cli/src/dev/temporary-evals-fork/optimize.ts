import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { DevWorkspace } from '../workspace.js'
import { resolveTemporaryExperiment } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, temporaryOptimizationFolder } from './environment.js'
import type { TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
  temporaryLanguageArguments,
  temporaryRunName,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'

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
}

export interface TemporaryOptimizationOutcome {
  experiment: string
  record: string
  summary: string[]
}

export interface TemporaryOptimizationDependencies {
  run?: TemporaryCommandRunner
  spawnOptimizer?: TemporaryEvalsSpawner
}

const WRAPPER_OWNED_FLAGS = ['--agent', '--record', '--json', '--rich', '--typescript-runner']

const recordFolder = (workspaceDirectory: string, experiment: string, now: Date): string =>
  join(temporaryOptimizationFolder(workspaceDirectory), temporaryRunName(experiment, now))

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
  const record = recordFolder(directory, experiment, request.now?.() ?? new Date())
  if (existsSync(record))
    throw new Error(`The optimization record ${record} already exists. Wait a second, then try again.`)
  const log = `${record}.log`
  await mkdir(temporaryOptimizationFolder(directory), { recursive: true })
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
      experiment,
      '--agent',
      workspace.entrypoint,
      '--record',
      record,
      '--rich',
      ...temporaryLanguageArguments(workspace),
      ...forkArguments,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    log,
    onLine: onProgress,
  })
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals optimize', exit, environment, `The full optimizer output is in ${log}.`)
  return { experiment, record, summary: exit.stdout.split('\n').filter((line) => line.trim().length > 0) }
}
