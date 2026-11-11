import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { DevWorkspace } from '../workspace.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  assertTemporaryForkArguments,
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'

export interface TemporaryExperimentRequest {
  workspace: DevWorkspace
  name: string
  description: string
  forkArguments?: readonly string[]
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onProgress?: (line: string) => void
}

export interface TemporaryExperimentOutcome {
  path: string
  cases: number
}

export interface TemporaryExperimentDependencies {
  run?: TemporaryCommandRunner
  spawnGenerator?: TemporaryEvalsSpawner
}

export const TEMPORARY_EXPERIMENT_USAGE = '/experiment <name> <what the agent does> [-- strands-evals generate flags]'
export const TEMPORARY_EXPERIMENT_EXAMPLE = '/experiment refunds Answers refund questions for an online shoe store'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GENERATOR_TAIL_LINES = 3

const generating = new Set<string>()

export const isTemporaryExperimentName = (name: string): boolean => NAME.test(name)
const GENERATE_OWNED_FLAGS = ['--context', '--experiment', '-o', '--output', '--json', '--rich']

const assertRequest = ({ name, description }: TemporaryExperimentRequest): void => {
  if (!name || !description.trim())
    throw new Error(
      `Give the experiment a name and say what the agent does. Usage: ${TEMPORARY_EXPERIMENT_USAGE}. ` +
        `Example: ${TEMPORARY_EXPERIMENT_EXAMPLE}`
    )
  if (!NAME.test(name))
    throw new Error(
      `${name} is not a usable experiment name. Use letters, numbers, dots, dashes, and underscores, ` +
        'for example refunds-v1.'
    )
}

const caseCount = async (path: string): Promise<number> => {
  const experiment = JSON.parse(await readFile(path, 'utf8')) as { cases?: unknown[] }
  return experiment.cases?.length ?? 0
}

export const createTemporaryExperiment = async (
  request: TemporaryExperimentRequest,
  dependencies: TemporaryExperimentDependencies = {}
): Promise<TemporaryExperimentOutcome> => {
  const { workspace, name, forkArguments = [] } = request
  const directory = temporaryWorkspaceDirectory(workspace)
  assertRequest(request)
  assertTemporaryForkArguments(forkArguments, GENERATE_OWNED_FLAGS, '/experiment')
  const folder = temporaryExperimentsFolder(directory)
  const path = join(folder, `${name}.json`)
  if (existsSync(path) || generating.has(path))
    throw new Error(
      `An experiment named ${name} already exists at ${path}, or is being generated. Pick another name, or delete ` +
        'that file to replace it.'
    )
  generating.add(path)
  try {
    return await generate(request, dependencies, { directory, folder, path })
  } finally {
    generating.delete(path)
  }
}

const generatorNextStep = (code: number): string =>
  code === 2
    ? 'Fix the flags after --; strands-evals generate --help in strands-dev/tmp/optimization/.venv lists them.'
    : 'Check that your AWS credentials can call the generator model, or pick another model with -- --model MODEL_ID.'

const generate = async (
  request: TemporaryExperimentRequest,
  dependencies: TemporaryExperimentDependencies,
  { directory, folder, path }: { directory: string; folder: string; path: string }
): Promise<TemporaryExperimentOutcome> => {
  const { workspace, name, description, forkArguments = [], environment = process.env, signal } = request
  const onProgress = request.onProgress ?? ignoreProgress
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  await mkdir(folder, { recursive: true })
  onProgress(`Generating cases for ${name}. The generator asks a model, so this can take a minute.`)
  const exit = await (dependencies.spawnGenerator ?? spawnTemporaryEvals)({
    command: python,
    args: [
      '-m',
      'strands_evals.cli',
      'generate',
      '--context',
      description,
      '--evaluator',
      'OutputEvaluator',
      ...forkArguments,
      '--output',
      path,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    onLine: onProgress,
  })
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals generate', exit, environment, generatorNextStep(exit.code))
  const said = exit.stderrTail.slice(-GENERATOR_TAIL_LINES).join('\n') || 'nothing'
  if (!existsSync(path))
    throw new Error(
      `strands-evals generate finished without writing ${path}. The generator said:\n${said}\nRun /experiment again.`
    )
  const cases = await caseCount(path)
  if (cases === 0) {
    await rm(path, { force: true })
    throw new Error(
      `strands-evals generate wrote no cases for ${name}, so the empty file was removed. The generator said:\n${said}\n` +
        'Describe the agent in more detail, or pick another model with -- --model MODEL_ID, then try again.'
    )
  }
  return { path, cases }
}
