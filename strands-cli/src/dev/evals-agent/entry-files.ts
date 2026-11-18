import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface EvalsRunEntry {
  readonly agentFile: string
  readonly experimentFile: string
  readonly customEvaluators: readonly string[]
  readonly temporaryTypescriptRunner?: string
}

export interface EvalsOptimizeEntry extends EvalsRunEntry {
  readonly spaceFile?: string
  readonly settings: readonly string[]
  readonly baselineOnly: boolean
}

const PACKAGE_FOLDER = dirname(fileURLToPath(import.meta.url))
const OPTIMIZE_TASK = '_task'
const OPTIMIZE_EXPORTS = ['agent', 'rollout', 'search'] as const
const RUN_TASK = 'task'

const pythonText = (value: string): string => JSON.stringify(value)

const pythonTuple = (values: readonly string[]): string =>
  values.length === 0 ? '()' : `(${values.map(pythonText).join(', ')},)`

const pythonBoolean = (value: boolean): string => (value ? 'True' : 'False')

const importLines = (module: string, entry: string): string[] => [
  'import sys',
  '',
  `sys.path.insert(0, ${pythonText(PACKAGE_FOLDER)})`,
  '',
  `from strands_dev_evals.${module} import ${entry}`,
  '',
]

const callLines = (target: string, entry: string, args: readonly string[]): string[] => [
  `${target} = ${entry}(`,
  ...args.map((argument) => `    ${argument},`),
  ')',
]

const harnessArguments = ({
  agentFile,
  experimentFile,
  customEvaluators,
  temporaryTypescriptRunner,
}: EvalsRunEntry): string[] => [
  pythonText(agentFile),
  `experiment_file=${pythonText(experimentFile)}`,
  ...(customEvaluators.length > 0 ? [`custom_evaluators=${pythonTuple(customEvaluators)}`] : []),
  ...(temporaryTypescriptRunner ? [`temporary_typescript_runner=${pythonText(temporaryTypescriptRunner)}`] : []),
]

const writeEntry = async (file: string, lines: readonly string[]): Promise<string> => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${lines.join('\n')}\n`)
  return resolve(file)
}

export const writeEvalsOptimizeEntry = async (file: string, entry: EvalsOptimizeEntry): Promise<string[]> => {
  const written = await writeEntry(file, [
    ...importLines('optimize', 'optimize_task'),
    ...callLines(OPTIMIZE_TASK, 'optimize_task', [
      ...harnessArguments(entry),
      ...(entry.spaceFile ? [`space_file=${pythonText(entry.spaceFile)}`] : []),
      `settings=${pythonTuple(entry.settings)}`,
      `baseline_only=${pythonBoolean(entry.baselineOnly)}`,
    ]),
    ...OPTIMIZE_EXPORTS.map((name) => `${name} = ${OPTIMIZE_TASK}.${name}`),
  ])
  return [
    '--agent',
    `${written}:agent`,
    '--rollout',
    `${written}:rollout`,
    ...(entry.baselineOnly ? ['--search', `${written}:search`] : []),
  ]
}

export const writeEvalsRunEntry = async (file: string, entry: EvalsRunEntry): Promise<string[]> => {
  const written = await writeEntry(file, [
    ...importLines('run', 'run_task'),
    ...callLines(RUN_TASK, 'run_task', harnessArguments(entry)),
  ])
  return ['--task', `${written}:${RUN_TASK}`]
}
