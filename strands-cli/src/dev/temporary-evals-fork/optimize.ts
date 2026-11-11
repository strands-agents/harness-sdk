import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import { redactPreparationOutput } from '../../project/preparation.js'
import { isRecord } from '../../values.js'
import type { DevWorkspace } from '../workspace.js'
import {
  ignoreProgress,
  prepareTemporaryOptimizerEnvironment,
  temporaryOptimizationFolder,
  type TemporaryCommandRunner,
} from './environment.js'

export interface TemporaryOptimizerProcess {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  onLine: (line: string) => void
}

export interface TemporaryOptimizerExit {
  code: number
  stdout: string
  stderrTail: string[]
}

export type TemporaryOptimizerSpawner = (process: TemporaryOptimizerProcess) => Promise<TemporaryOptimizerExit>

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
  spawnOptimizer?: TemporaryOptimizerSpawner
}

const STDERR_TAIL_LINES = 20
const WRAPPER_OWNED_FLAGS = ['--agent', '--record', '--json', '--rich']

export const temporaryExperimentsFolder = (workspaceDirectory: string): string =>
  join(workspaceDirectory, 'tmp', 'experiments')

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

export const resolveTemporaryExperiment = async (folder: string, requested?: string): Promise<string> => {
  if (requested) {
    for (const candidate of [resolve(requested), join(folder, requested), join(folder, `${requested}.json`)]) {
      if (await isFile(candidate)) return candidate
    }
    throw new Error(`No experiment named ${requested} in ${folder}.`)
  }
  const names = await experimentNames(folder)
  if (names.length === 1) return join(folder, names[0]!)
  if (names.length === 0)
    throw new Error(`No experiment in ${folder}. Save an Experiment JSON file there, or pass the path of one.`)
  throw new Error(`${folder} holds several experiments: ${names.join(', ')}. Name the one to optimize.`)
}

const assertForkArguments = (forkArguments: readonly string[]): void => {
  const owned = forkArguments.filter((argument) =>
    WRAPPER_OWNED_FLAGS.some((flag) => argument === flag || argument.startsWith(`${flag}=`))
  )
  if (owned.length > 0)
    throw new Error(`strands dev sets ${owned.join(', ')} for optimization. Remove it from the optimizer flags.`)
}

const pythonWorkspaceDirectory = ({ directory, config }: DevWorkspace): string => {
  if (config.language !== 'python')
    throw new Error('Optimization supports Python agents only. This workspace runs a TypeScript agent.')
  if (!directory) throw new Error('Optimization needs a strands-dev workspace folder. Run strands dev init first.')
  return directory
}

const recordFolder = (workspaceDirectory: string, experiment: string, now: Date): string => {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15)
  return join(temporaryOptimizationFolder(workspaceDirectory), `${stamp}-${basename(experiment, '.json')}`)
}

const spawnOptimizer: TemporaryOptimizerSpawner = ({ command, args, cwd, env, signal, onLine }) =>
  new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout: string[] = []
    const stderrTail: string[] = []
    const abort = (): void => void child.kill('SIGTERM')
    signal?.addEventListener('abort', abort, { once: true })
    process.once('exit', abort)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrTail.push(line)
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift()
      onLine(line)
    })
    child.once('error', rejectExit)
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort)
      process.removeListener('exit', abort)
      resolveExit({ code: code ?? 1, stdout: stdout.join(''), stderrTail })
    })
  })

const optimizerEnvironment = (python: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...environment,
  PATH: [dirname(python), environment.PATH].filter(Boolean).join(delimiter),
  ...(environment.AWS_REGION ? { AWS_DEFAULT_REGION: environment.AWS_REGION } : {}),
})

export const runTemporaryOptimization = async (
  request: TemporaryOptimizationRequest,
  dependencies: TemporaryOptimizationDependencies = {}
): Promise<TemporaryOptimizationOutcome> => {
  const { workspace, forkArguments = [], environment = process.env, signal, onProgress = ignoreProgress } = request
  const directory = pythonWorkspaceDirectory(workspace)
  assertForkArguments(forkArguments)
  const experiment = await resolveTemporaryExperiment(temporaryExperimentsFolder(directory), request.experiment)
  await request.prepare?.()
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  const record = recordFolder(directory, experiment, request.now?.() ?? new Date())
  if (existsSync(record)) throw new Error(`The optimization record ${record} already exists. Try again in a second.`)
  onProgress(`Optimizing ${workspace.entrypoint} against ${experiment}`)
  onProgress(`Record: ${record}`)
  onProgress('Measuring the baseline. The optimizer reports each candidate when it finishes.')
  const exit = await (dependencies.spawnOptimizer ?? spawnOptimizer)({
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
      ...forkArguments,
    ],
    cwd: workspace.root,
    env: optimizerEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    onLine: onProgress,
  })
  if (exit.code !== 0) {
    const detail = redactPreparationOutput(exit.stderrTail.join('\n'), environment)
    throw new Error(`strands-evals optimize exited with code ${exit.code}.\n${detail}`)
  }
  return { experiment, record, summary: exit.stdout.split('\n').filter((line) => line.trim().length > 0) }
}
