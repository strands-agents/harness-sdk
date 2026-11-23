import type { GenerationSettings, KnobKey } from '../panels/model.js'
import { TEMPORARY_KNOB_NAMES } from './knobs.js'

/** The strands-evals commands that strands dev runs in the background. */
export const BACKGROUND_COMMANDS = ['run', 'optimize run', 'generate'] as const

export type BackgroundCommand = (typeof BACKGROUND_COMMANDS)[number]

export interface OptimizeFlagSettings {
  readonly tune: readonly KnobKey[]
  readonly models: readonly string[]
  readonly objective?: string
  readonly constraints?: readonly string[]
  readonly iterations?: number
  readonly width?: number
  readonly repetitions?: number
  readonly finalists?: number
  readonly workers?: number
  readonly feasibility?: number
  readonly crashScore?: string
  readonly ignored: readonly string[]
}

interface Flag {
  readonly name: string
  readonly value?: string
}

// strands dev writes these itself, so a skill's command may carry them and they change nothing.
const SET_BY_STRANDS_DEV: Readonly<Record<string, string>> = {
  '--agent': 'strands dev passes the agent of this workspace',
  '--base-dir': 'strands dev keeps the run under strands-dev/experiments/<name>/optimizations/',
  '--rich': 'strands dev reads the run itself',
  '--json': 'strands dev reads the run itself',
  '--seed': 'strands dev sets the seed',
  '--name': 'strands dev names the run',
  '--max-rollouts': 'strands dev applies its own cap and says when a run needs more',
  '--reflection-model': 'strands dev sets the proposer model',
  '--split': 'strands dev picks the split, which cannot be changed here',
  '--final-pick': 'a cautious pick needs hooks.py, which strands dev does not run',
  '--search': 'strands dev runs the default search',
  '-o': 'strands dev writes the report itself',
  '--output': 'strands dev writes the report itself',
}

const VALUE_FREE = new Set(['--rich', '--json', '--pareto', '--no-tune-instructions', '--tune-instructions'])

const OPTION_KEYS: Readonly<Record<string, KnobKey>> = {
  system_prompt: 'systemPrompt',
  context_manager: 'contextManager',
  background_tasks: 'backgroundTasks',
  builtin_tools: 'builtinTools',
  mcp_servers: 'mcpServers',
  builtin_plugins: 'builtinPlugins',
}

const flagsOf = (args: readonly string[]): Flag[] => {
  const flags: Flag[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith('-')) throw new Error(`${argument} is not a flag. Pass the flags of the command only.`)
    const equals = argument.indexOf('=')
    if (equals > 0) flags.push({ name: argument.slice(0, equals), value: argument.slice(equals + 1) })
    else if (VALUE_FREE.has(argument)) flags.push({ name: argument })
    else {
      const value = args[index + 1]
      if (value === undefined) throw new Error(`${argument} needs a value.`)
      flags.push({ name: argument, value })
      index += 1
    }
  }
  return flags
}

const wholeOf = ({ name, value = '' }: Flag): number => {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a whole number, not ${value || 'nothing'}.`)
  return Number(value)
}

const numberOf = ({ name, value = '' }: Flag): number => {
  const parsed = Number(value)
  if (!value.trim() || Number.isNaN(parsed)) throw new Error(`${name} must be a number, not ${value || 'nothing'}.`)
  return parsed
}

const goalOf = (spec: string): string => {
  const [direction, metric, ...settings] = spec.split(':')
  if ((direction !== 'maximize' && direction !== 'minimize') || !metric)
    throw new Error(`--objective ${spec} must look like maximize:METRIC or minimize:METRIC:scale=1000.`)
  const name = direction === 'maximize' ? 'Maximize' : 'Minimize'
  return `${name}(${[metric, ...settings].join(', ')})`
}

const tuneOf = (value: string): { key: KnobKey; models?: string[] } => {
  const equals = value.indexOf('=')
  const option = equals < 0 ? value : value.slice(0, equals)
  const key = OPTION_KEYS[option] ?? option
  if (!TEMPORARY_KNOB_NAMES.includes(key))
    throw new Error(
      `--tune ${option} is not a knob that strands dev tunes. It tunes ${TEMPORARY_KNOB_NAMES.join(', ')}.`
    )
  if (key !== 'model' || equals < 0) return { key }
  const list = JSON.parse(value.slice(equals + 1)) as unknown
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))
    throw new Error('--tune model=[...] must list model ids as a JSON list of strings.')
  return { key, models: list as string[] }
}

/** The settings of an optimize run, read from the flags of strands-evals optimize run. */
export const optimizeFlagSettings = (args: readonly string[]): OptimizeFlagSettings => {
  const tune = new Set<KnobKey>(['instructions'])
  const models: string[] = []
  const goals: string[] = []
  const constraints: string[] = []
  const ignored: string[] = []
  let pareto = false
  const settings: Record<string, number | string> = {}
  for (const flag of flagsOf(args)) {
    const reason = SET_BY_STRANDS_DEV[flag.name]
    if (reason) ignored.push(`${flag.name}: ${reason}`)
    else if (flag.name === '--tune') {
      const tuned = tuneOf(flag.value ?? '')
      tune.add(tuned.key)
      models.push(...(tuned.models ?? []))
    } else if (flag.name === '--no-tune-instructions') tune.delete('instructions')
    else if (flag.name === '--tune-instructions') tune.add('instructions')
    else if (flag.name === '--objective') goals.push(goalOf(flag.value ?? ''))
    else if (flag.name === '--pareto') pareto = true
    else if (flag.name === '--constraint') constraints.push((flag.value ?? '').replace(/\s*(<=|>=)\s*/u, ' $1 '))
    else if (flag.name === '--max-iterations') settings.iterations = wholeOf(flag)
    else if (flag.name === '--proposals-per-iteration') settings.width = wholeOf(flag)
    else if (flag.name === '--runs-per-candidate') settings.repetitions = wholeOf(flag)
    else if (flag.name === '--n-finalists') settings.finalists = wholeOf(flag)
    else if (flag.name === '--max-workers') settings.workers = wholeOf(flag)
    else if (flag.name === '--feasibility-threshold') settings.feasibility = numberOf(flag)
    else if (flag.name === '--agent-failure-score') settings.crashScore = flag.value ?? ''
    else throw new Error(`strands dev cannot pass ${flag.name} to strands-evals optimize run.`)
  }
  if (tune.size === 0) throw new Error('Tune at least one knob: --no-tune-instructions leaves nothing to tune.')
  if (tune.has('model') && models.length === 0)
    throw new Error('Tuning the model needs --tune \'model=["<id>", ...]\' with the models to try.')
  const objective =
    goals.length === 0
      ? undefined
      : goals.length === 1 && !pareto
        ? goals[0]
        : `${pareto ? 'Pareto' : 'WeightedSum'}(${goals.join(', ')})`
  return {
    tune: [...tune],
    models,
    ...(objective === undefined ? {} : { objective }),
    ...(constraints.length === 0 ? {} : { constraints }),
    ...settings,
    ignored,
  }
}

const GENERATE_FLAGS = ['--task-description', '--context', '--num-cases']

/** The task and case count of a generation; strands dev keeps its defaults for every other flag of strands-evals generate. */
export const generateFlagSettings = (
  name: string,
  args: readonly string[],
  suggested: GenerationSettings
): { settings: GenerationSettings; ignored: string[] } => {
  const ignored: string[] = []
  let settings: GenerationSettings = { ...suggested, name }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (!argument.startsWith('-')) throw new Error(`${argument} is not a flag. Pass the flags of the command only.`)
    const equals = argument.indexOf('=')
    const flagName = equals > 0 ? argument.slice(0, equals) : argument
    const next = args[index + 1]
    const takesNext = equals < 0 && next !== undefined && !next.startsWith('-')
    const value = equals > 0 ? argument.slice(equals + 1) : takesNext ? next : undefined
    if (takesNext) index += 1
    if (!GENERATE_FLAGS.includes(flagName)) {
      ignored.push(`${flagName}: strands dev uses its default`)
      continue
    }
    if (value === undefined) throw new Error(`${flagName} needs a value.`)
    if (flagName === '--num-cases') settings = { ...settings, cases: wholeOf({ name: flagName, value }) }
    else settings = { ...settings, [flagName === '--context' ? 'context' : 'task']: value }
  }
  if (!settings.task.trim()) settings = { ...settings, task: settings.context }
  return { settings, ignored }
}

/** The case names of strands-evals run --case, the only flag strands dev passes on. */
export const runFlagCases = (args: readonly string[]): { cases: string[]; ignored: string[] } => {
  const cases: string[] = []
  const ignored: string[] = []
  for (const flag of flagsOf(args)) {
    if (flag.name === '--case') cases.push(flag.value ?? '')
    else if (['--agent', '--task', '-o', '--output', '--rich', '--json', '--max-workers'].includes(flag.name))
      ignored.push(`${flag.name}: strands dev sets it`)
    else throw new Error(`strands dev cannot pass ${flag.name} to strands-evals run; it passes --case only.`)
  }
  return { cases, ignored }
}
