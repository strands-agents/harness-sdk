import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { DevWorkspace } from '../workspace.js'
import { temporaryCaseCount } from './experiment-files.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryExperimentsFolder,
  temporaryRunName,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'

export interface TemporaryDraftRequest {
  workspace: DevWorkspace
  context: string
  count: number
  environment?: NodeJS.ProcessEnv
  signal?: AbortSignal
  onProgress?: (line: string) => void
  now?: () => Date
  background?: boolean
}

export interface TemporaryDraftOutcome {
  path: string
  cases: number
}

export interface TemporaryExperimentDependencies {
  run?: TemporaryCommandRunner
  spawnGenerator?: TemporaryEvalsSpawner
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GENERATOR_TAIL_LINES = 3
const DRAFTS_FOLDER = 'drafts'

export const isTemporaryExperimentName = (name: string): boolean => NAME.test(name)

export const temporaryDraftsFolder = (workspaceDirectory: string): string =>
  join(temporaryExperimentsFolder(workspaceDirectory), DRAFTS_FOLDER)

const generatorNextStep = (code: number): string =>
  code === 2
    ? 'The strands-evals generate command rejected its flags. Update the TEMPORARY evals fork, then try again.'
    : 'Check that your AWS credentials can call the generator model, then press Enter to try again.'

export const draftTemporaryExperiment = async (
  request: TemporaryDraftRequest,
  dependencies: TemporaryExperimentDependencies = {}
): Promise<TemporaryDraftOutcome> => {
  const { workspace, context, count, environment = process.env, signal } = request
  const onProgress = request.onProgress ?? ignoreProgress
  const directory = temporaryWorkspaceDirectory(workspace)
  const folder = temporaryDraftsFolder(directory)
  const path = join(folder, `${temporaryRunName('draft', request.now?.() ?? new Date())}.json`)
  const python = await prepareTemporaryOptimizerEnvironment(
    { workspaceDirectory: directory, projectRoot: workspace.root, language: workspace.config.language },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress }
  )
  await mkdir(folder, { recursive: true })
  const exit = await (dependencies.spawnGenerator ?? spawnTemporaryEvals)({
    command: python,
    args: [
      '-m',
      'strands_evals.cli',
      'generate',
      '--context',
      context,
      '--num-cases',
      String(count),
      '--evaluator',
      'OutputEvaluator',
      '--output',
      path,
    ],
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    ...(request.background ? { background: true } : {}),
    onLine: onProgress,
  })
  if (exit.code !== 0)
    throw temporaryEvalsFailure('strands-evals generate', exit, environment, generatorNextStep(exit.code))
  const said = exit.stderrTail.slice(-GENERATOR_TAIL_LINES).join('\n') || 'nothing'
  if (!existsSync(path))
    throw new Error(
      `strands-evals generate finished without writing ${path}. It said:\n${said}\nPress Enter to try again.`
    )
  const cases = await temporaryCaseCount(path)
  if (cases === 0) {
    await rm(path, { force: true })
    throw new Error(
      `strands-evals generate wrote no cases. It said:\n${said}\n` +
        'Give your agent clearer instructions or tool descriptions, then press Enter to try again.'
    )
  }
  return { path, cases }
}
