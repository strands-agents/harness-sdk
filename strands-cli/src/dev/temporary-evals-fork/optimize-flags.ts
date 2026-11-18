import { assertTemporaryForkArguments } from './evals-process.js'
import { temporaryObjectiveArguments } from './objective.js'

export interface TemporaryOptimizeFlags {
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
  '--typescript-runner',
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
  value.includes('(') ? temporaryObjectiveArguments({ expression: value, constraints: '' }) : [OBJECTIVE_FLAG, value]

const withFlag = (read: TemporaryOptimizeFlags, name: string, value: string): TemporaryOptimizeFlags => {
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

export const readTemporaryOptimizeFlags = (forkArguments: readonly string[]): TemporaryOptimizeFlags => {
  assertTemporaryForkArguments(forkArguments, WRAPPER_OWNED_FLAGS, 'strands dev')
  let read: TemporaryOptimizeFlags = { flags: [], customEvaluators: [] }
  for (let index = 0; index < forkArguments.length; index += 1) {
    const argument = forkArguments[index]!
    const { name, inline } = flagParts(argument)
    if (!READ_FLAGS.has(name)) {
      read = { ...read, flags: [...read.flags, argument] }
      continue
    }
    if (inline === undefined) index += 1
    const value = inline ?? forkArguments[index]
    if (value === undefined) throw new Error(`${name} needs a value after it.`)
    read = withFlag(read, name, value)
  }
  return read
}
