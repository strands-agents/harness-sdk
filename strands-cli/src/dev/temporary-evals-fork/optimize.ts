import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import { isRecord } from '../../values.js'
import type { DevWorkspace } from '../workspace.js'
import { isTemporaryExperimentName } from './experiment.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, temporaryOptimizationFolder } from './environment.js'
import type { TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
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

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const experimentNames = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return []
    throw error
  }
}

const listed = (names: readonly string[]): string => names.map((name) => basename(name, '.json')).join(', ')

const missingExperiment = (folder: string, requested: string, names: readonly string[]): Error => {
  if (!isTemporaryExperimentName(requested))
    return new Error(
      `No experiment file at ${resolve(requested)}. Check the path, or name an experiment in ${folder}` +
        (names.length > 0 ? `: ${listed(names)}.` : '.')
    )
  return new Error(
    names.length > 0
      ? `No experiment named ${requested} in ${folder}. Use one of ${listed(names)}, or create it with ` +
          `/experiment ${requested} <what the agent does> in a strands dev chat.`
      : `No experiment named ${requested} yet. Create it with /experiment ${requested} <what the agent does> ` +
          `in a strands dev chat, then run /optimize ${requested}.`
  )
}

export const resolveTemporaryExperiment = async (folder: string, requested?: string): Promise<string> => {
  const names = await experimentNames(folder)
  if (requested) {
    for (const candidate of [resolve(requested), join(folder, requested), join(folder, `${requested}.json`)]) {
      if (await isFile(candidate)) return candidate
    }
    throw missingExperiment(folder, requested, names)
  }
  if (names.length === 1) return join(folder, names[0]!)
  if (names.length === 0)
    throw new Error(
      'There is no experiment to optimize yet. Create one with /experiment <name> <what the agent does> ' +
        `in a strands dev chat, then run /optimize <name>. You can also save an Experiment JSON file in ${folder}.`
    )
  throw new Error(
    `${folder} has more than one experiment: ${listed(names)}. Name the one to use, for example ` +
      `/optimize ${basename(names[0]!, '.json')} in a chat, or strands dev optimize ${basename(names[0]!, '.json')} in a shell.`
  )
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

export const temporaryTypescriptRunnerCommand = (): string => {
  const runner = fileURLToPath(new URL('./typescript-runner-main.js', import.meta.url))
  return `${shellQuote(process.execPath)} ${shellQuote(runner)}`
}

const languageArguments = ({ config }: DevWorkspace): string[] =>
  config.language === 'typescript' ? ['--typescript-runner', temporaryTypescriptRunnerCommand()] : []

const recordFolder = (workspaceDirectory: string, experiment: string, now: Date): string => {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  return join(temporaryOptimizationFolder(workspaceDirectory), `${stamp}-${basename(experiment, '.json')}`)
}

export const runTemporaryOptimization = async (
  request: TemporaryOptimizationRequest,
  dependencies: TemporaryOptimizationDependencies = {}
): Promise<TemporaryOptimizationOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  assertTemporaryForkArguments(forkArguments, WRAPPER_OWNED_FLAGS, 'strands dev')
  const experiment = await resolveTemporaryExperiment(temporaryExperimentsFolder(directory), request.experiment)
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
      ...languageArguments(workspace),
      ...forkArguments,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    log,
    onLine: onProgress,
  })
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals optimize', exit, environment, `The full optimizer output is in ${log}.`)
  return { experiment, record, summary: exit.stdout.split('\n').filter((line) => line.trim().length > 0) }
}
