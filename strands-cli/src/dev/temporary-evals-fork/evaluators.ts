import { isRecord } from '../../values.js'
import type { EvaluatorChoice } from '../panels/model.js'
import type { DevWorkspace, DevWorkspaceConfig } from '../workspace.js'
import { ignoreProgress, prepareTemporaryOptimizerEnvironment, type TemporaryCommandRunner } from './environment.js'
import {
  spawnTemporaryEvals,
  temporaryEvalsEnvironment,
  temporaryEvalsFailure,
  temporaryWorkspaceDirectory,
  type TemporaryEvalsSpawner,
} from './evals-process.js'

export type TemporaryEvaluatorKind = 'rubric' | 'judge' | 'multimodal' | 'check' | 'chaos'

export type TemporaryEvaluatorSettingType = 'string' | 'boolean' | 'any'

export interface TemporaryEvaluatorSetting {
  readonly name: string
  readonly type: TemporaryEvaluatorSettingType
  readonly required: boolean
  readonly description: string
}

export interface TemporaryEvaluator {
  readonly name: string
  readonly kind: TemporaryEvaluatorKind
  readonly description: string
  readonly settings: readonly TemporaryEvaluatorSetting[]
  readonly available: boolean
  readonly limit?: string
}

export interface TemporaryEvaluatorsOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly signal?: AbortSignal
  readonly onStatus?: (line: string) => void
}

export interface TemporaryEvaluatorsDependencies {
  run?: TemporaryCommandRunner
  spawnEvals?: TemporaryEvalsSpawner
}

const KINDS: readonly TemporaryEvaluatorKind[] = ['rubric', 'judge', 'multimodal', 'check', 'chaos']
const SETTING_TYPES: readonly TemporaryEvaluatorSettingType[] = ['string', 'boolean', 'any']
const CATALOG_ARGUMENTS = ['-m', 'strands_evals.cli', 'evaluators', '--json']
const CATALOG_NEXT_STEP = 'Restart strands dev so that it installs the TEMPORARY evals fork again, then try again.'

const unreadableCatalog = (): Error =>
  new Error(`strands-evals evaluators printed a list that strands dev cannot read. ${CATALOG_NEXT_STEP}`)

const oneOf = <Value extends string>(values: readonly Value[], value: unknown): Value | undefined =>
  values.find((candidate) => candidate === value)

const settingOf = (value: unknown): TemporaryEvaluatorSetting => {
  const type = isRecord(value) ? oneOf(SETTING_TYPES, value.type) : undefined
  if (!isRecord(value) || !type || typeof value.name !== 'string' || typeof value.description !== 'string')
    throw unreadableCatalog()
  return { name: value.name, type, required: value.required === true, description: value.description }
}

const evaluatorOf = (value: unknown, language: DevWorkspaceConfig['language']): TemporaryEvaluator => {
  const kind = isRecord(value) ? oneOf(KINDS, value.kind) : undefined
  if (
    !isRecord(value) ||
    !kind ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.settings) ||
    !Array.isArray(value.agents)
  )
    throw unreadableCatalog()
  const available = value.agents.includes(language)
  return {
    name: value.name,
    kind,
    description: value.description,
    settings: value.settings.map(settingOf),
    available,
    ...(!available && typeof value.limit === 'string' ? { limit: value.limit } : {}),
  }
}

const catalogOf = (stdout: string, language: DevWorkspaceConfig['language']): readonly TemporaryEvaluator[] => {
  let listed: unknown
  try {
    listed = JSON.parse(stdout)
  } catch {
    throw unreadableCatalog()
  }
  if (!Array.isArray(listed)) throw unreadableCatalog()
  return listed.map((value) => evaluatorOf(value, language))
}

export const readTemporaryEvaluators = async (
  workspace: DevWorkspace,
  { environment = process.env, signal, onStatus = ignoreProgress }: TemporaryEvaluatorsOptions = {},
  dependencies: TemporaryEvaluatorsDependencies = {}
): Promise<readonly TemporaryEvaluator[]> => {
  const python = await prepareTemporaryOptimizerEnvironment(
    {
      workspaceDirectory: temporaryWorkspaceDirectory(workspace),
      projectRoot: workspace.root,
      language: workspace.config.language,
    },
    { ...(dependencies.run ? { run: dependencies.run } : {}), ...(signal ? { signal } : {}), onProgress: onStatus }
  )
  const exit = await (dependencies.spawnEvals ?? spawnTemporaryEvals)({
    command: python,
    args: CATALOG_ARGUMENTS,
    cwd: workspace.root,
    env: temporaryEvalsEnvironment(python, environment),
    ...(signal ? { signal } : {}),
    onLine: ignoreProgress,
  })
  if (exit.code !== 0) throw temporaryEvalsFailure('strands-evals evaluators', exit, environment, CATALOG_NEXT_STEP)
  return catalogOf(exit.stdout, workspace.config.language)
}

export const temporaryEvaluatorArguments = (choices: readonly EvaluatorChoice[]): string[] =>
  choices.flatMap(({ name, settings }) => [
    '--evaluator',
    settings && Object.keys(settings).length > 0 ? JSON.stringify({ ...settings, evaluator_type: name }) : name,
  ])
