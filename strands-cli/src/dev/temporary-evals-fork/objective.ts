import type { ObjectivePreset, OptimizeObjective } from '../panels/model.js'

export const TEMPORARY_USAGE_METRICS: readonly string[] = [
  'tokens',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'seconds',
  'model_calls',
]

export interface TemporaryObjectiveCheck {
  readonly problem?: string
  readonly warning?: string
}

type Direction = 'Maximize' | 'Minimize'
type Combination = 'WeightedSum' | 'Pareto'

interface Goal {
  readonly direction: Direction
  readonly metric: string
  readonly settings: ReadonlyMap<string, number>
}

interface Goals {
  readonly combination?: Combination
  readonly goals: readonly Goal[]
}

interface Constraint {
  readonly metric: string
  readonly bound: 'at-most' | 'at-least'
  readonly value: number
}

type Token =
  | { readonly kind: 'name'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'number'; readonly value: number; readonly text: string }
  | { readonly kind: 'symbol'; readonly text: string }

class ObjectiveProblem extends Error {}

const DIRECTIONS: readonly string[] = ['Maximize', 'Minimize']
const COMBINATIONS: readonly string[] = ['WeightedSum', 'Pareto']
const SETTINGS: readonly string[] = ['weight', 'scale']
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const TOKEN =
  /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([(),=]))/uy
const CONSTRAINT = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_][A-Za-z0-9_]*)\s*(<=|>=)\s*(-?\d+(?:\.\d+)?)\s*$/u
const DEFAULT_FLOOR = 0.8
const TOKEN_SCALE = 1000
const SECONDS_SCALE = 10
const SHORT_SUFFIX = 'Evaluator'
const SPEC_SEPARATOR = ':'
const CONSTRAINT_OPERATORS = /[<>=]/u

const USAGE =
  'The objective must look like Maximize(Helpfulness), Minimize(tokens), or ' +
  'WeightedSum(Maximize(Helpfulness), Minimize(tokens, scale=1000)).'

const misfit = (part: string): ObjectiveProblem => new ObjectiveProblem(`${USAGE} '${part}' does not fit.`)

const unquote = (text: string): string =>
  text.startsWith('"') ? JSON.parse(text) : text.slice(1, -1).replace(/\\(.)/gu, '$1')

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < text.length) {
    const start = TOKEN.lastIndex
    const match = TOKEN.exec(text)
    if (!match) {
      if (!text.slice(start).trim()) break
      throw misfit(text.slice(start).trim())
    }
    const [, name, quoted, number, symbol] = match
    if (name !== undefined) tokens.push({ kind: 'name', text: name })
    else if (quoted !== undefined) tokens.push({ kind: 'string', text: unquote(quoted) })
    else if (number !== undefined) tokens.push({ kind: 'number', value: Number(number), text: number })
    else if (symbol !== undefined) tokens.push({ kind: 'symbol', text: symbol })
  }
  return tokens
}

class Reader {
  private position = 0

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.position]
  }

  next(): Token {
    const token = this.tokens[this.position]
    if (!token) throw misfit(this.source)
    this.position += 1
    return token
  }

  expect(symbol: string): void {
    const token = this.next()
    if (token.kind !== 'symbol' || token.text !== symbol) throw misfit(token.text)
  }

  accept(symbol: string): boolean {
    const token = this.peek()
    if (token?.kind !== 'symbol' || token.text !== symbol) return false
    this.position += 1
    return true
  }

  done(): boolean {
    return this.position >= this.tokens.length
  }
}

const readSetting = (reader: Reader, settings: Map<string, number>): void => {
  const name = reader.next()
  if (name.kind !== 'name' || !SETTINGS.includes(name.text)) throw misfit(name.text)
  reader.expect('=')
  const value = reader.next()
  if (value.kind !== 'number' || !(value.value > 0) || !Number.isFinite(value.value)) throw misfit(value.text)
  settings.set(name.text, value.value)
}

const readGoal = (reader: Reader): Goal => {
  const direction = reader.next()
  if (direction.kind !== 'name' || !DIRECTIONS.includes(direction.text)) throw misfit(direction.text)
  reader.expect('(')
  const metric = reader.next()
  if (metric.kind !== 'name' && metric.kind !== 'string') throw misfit(metric.text)
  if (metric.text.includes(SPEC_SEPARATOR))
    throw new ObjectiveProblem(
      `The optimizer cannot take ${metricText(metric.text)} in an objective, because the name has a colon. ` +
        'Give the evaluator a name without a colon, or choose another objective.'
    )
  const settings = new Map<string, number>()
  while (reader.accept(',')) readSetting(reader, settings)
  reader.expect(')')
  return { direction: direction.text as Direction, metric: metric.text, settings }
}

const readGoals = (expression: string): Goals => {
  const reader = new Reader(tokenize(expression), expression.trim())
  const first = reader.peek()
  if (first?.kind === 'name' && COMBINATIONS.includes(first.text)) {
    reader.next()
    reader.expect('(')
    const goals = [readGoal(reader)]
    while (reader.accept(',')) goals.push(readGoal(reader))
    reader.expect(')')
    if (!reader.done()) throw misfit(reader.next().text)
    return { combination: first.text as Combination, goals }
  }
  const goal = readGoal(reader)
  if (!reader.done()) throw misfit(reader.next().text)
  return { goals: [goal] }
}

const readConstraints = (constraints: string): Constraint[] =>
  constraints
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = CONSTRAINT.exec(part)
      if (!match)
        throw new ObjectiveProblem(
          `Each constraint must look like tokens <= 4000 or Correctness >= 0.8. '${part}' does not fit.`
        )
      const [, quoted = '', bound, value = '0'] = match
      const metric = quoted.startsWith('"') || quoted.startsWith("'") ? unquote(quoted) : quoted
      if (CONSTRAINT_OPERATORS.test(metric))
        throw new ObjectiveProblem(
          `The optimizer cannot take ${metricText(metric)} in a constraint, because the name has <, >, or =. ` +
            'Give the evaluator another name, or remove the constraint.'
        )
      return { metric, bound: bound === '<=' ? 'at-most' : 'at-least', value: Number(value) }
    })

const resolve = (metric: string, evaluators: readonly string[]): string => {
  if (evaluators.includes(metric) || TEMPORARY_USAGE_METRICS.includes(metric)) return metric
  if (evaluators.includes(`${metric}${SHORT_SUFFIX}`)) return `${metric}${SHORT_SUFFIX}`
  throw new ObjectiveProblem(
    `${metric} is not an evaluator of this experiment or a usage number. Use one of: ${[...evaluators, ...TEMPORARY_USAGE_METRICS].join(', ')}.`
  )
}

const checkGoals = ({ combination, goals }: Goals, evaluators: readonly string[]): string[] => {
  const metrics = goals.map(({ metric }) => resolve(metric, evaluators))
  const twice = metrics.find((metric, index) => metrics.indexOf(metric) !== index)
  if (twice) throw new ObjectiveProblem(`${twice} is in the objective twice.`)
  if (!combination && goals[0]?.settings.size)
    throw new ObjectiveProblem(
      'weight= and scale= count only inside WeightedSum or Pareto. Remove them from a single goal.'
    )
  if (combination) {
    const unscaled = metrics.find(
      (metric, index) => TEMPORARY_USAGE_METRICS.includes(metric) && !goals[index]?.settings.has('scale')
    )
    if (unscaled)
      throw new ObjectiveProblem(
        `${unscaled} needs a scale= inside ${combination}, such as Minimize(${unscaled}, scale=${TOKEN_SCALE}).`
      )
  }
  return metrics
}

const usageOnlyWarning = (
  goalMetrics: readonly string[],
  constraints: readonly Constraint[],
  evaluators: readonly string[]
): string | undefined => {
  if (goalMetrics.length === 0 || !goalMetrics.every((metric) => TEMPORARY_USAGE_METRICS.includes(metric)))
    return undefined
  const floored = constraints.some(
    ({ metric, bound }) => bound === 'at-least' && !TEMPORARY_USAGE_METRICS.includes(metric)
  )
  if (floored) return undefined
  const example = evaluators[0] ? `${metricText(evaluators[0])} >= ${DEFAULT_FLOOR}` : 'Correctness >= 0.8'
  return `Every goal is a usage number, so a broken agent can look best. Add an evaluator to the objective, or a constraint such as ${example}.`
}

export const checkTemporaryObjective = (
  { expression, constraints }: OptimizeObjective,
  evaluators: readonly string[]
): TemporaryObjectiveCheck => {
  try {
    const goals = expression.trim() ? checkGoals(readGoals(expression), evaluators) : []
    const bounds = readConstraints(constraints)
    bounds.forEach(({ metric }) => resolve(metric, evaluators))
    if (goals.length === 0 && evaluators.length === 0)
      return {
        problem: 'The experiment has no evaluator, so give the objective a usage goal, such as Minimize(tokens).',
      }
    const warning = usageOnlyWarning(goals, bounds, evaluators)
    return warning ? { warning } : {}
  } catch (error) {
    if (error instanceof ObjectiveProblem) return { problem: error.message }
    throw error
  }
}

const goalSpec = ({ direction, metric, settings }: Goal, combined: boolean): string =>
  [direction.toLowerCase(), metric, ...(combined ? [...settings].map(([name, value]) => `${name}=${value}`) : [])].join(
    SPEC_SEPARATOR
  )

const objectiveSpecs = ({ combination, goals }: Goals): string[] => {
  const combined = goals.length > 1
  return [
    ...goals.flatMap((goal) => ['--objective', goalSpec(goal, combined)]),
    ...(combined && combination === 'Pareto' ? ['--pareto'] : []),
  ]
}

const constraintSpec = ({ metric, bound, value }: Constraint): string =>
  `${metric}${bound === 'at-most' ? '<=' : '>='}${value}`

export const isTemporaryPareto = ({ expression }: OptimizeObjective): boolean => {
  try {
    const { combination, goals } = readGoals(expression)
    return combination === 'Pareto' && goals.length > 1
  } catch (error) {
    if (error instanceof ObjectiveProblem) return false
    throw error
  }
}

export const temporaryObjectiveArguments = ({ expression, constraints }: OptimizeObjective): string[] => [
  ...(expression.trim() ? objectiveSpecs(readGoals(expression)) : []),
  ...readConstraints(constraints).flatMap((constraint) => ['--constraint', constraintSpec(constraint)]),
]

const metricText = (metric: string): string => (PLAIN_NAME.test(metric) ? metric : JSON.stringify(metric))

const floors = (evaluators: readonly string[]): string =>
  evaluators.map((evaluator) => `${metricText(evaluator)} >= ${DEFAULT_FLOOR}`).join(', ')

const maximized = (evaluators: readonly string[]): string[] =>
  evaluators.map((evaluator) => `Maximize(${metricText(evaluator)})`)

const FEWER_TOKENS = `Minimize(tokens, scale=${TOKEN_SCALE})`
const LESS_TIME = `Minimize(seconds, scale=${SECONDS_SCALE})`

const evaluatorTradeOff = (
  label: string,
  combination: Combination,
  evaluators: readonly string[],
  usageGoals: readonly string[]
): ObjectivePreset => ({
  label,
  objective: { expression: `${combination}(${[...maximized(evaluators), ...usageGoals].join(', ')})`, constraints: '' },
})

export const temporaryObjectivePresets = (evaluators: readonly string[]): ObjectivePreset[] => {
  const names = [...new Set(evaluators)]
  const floor = names.length > 0 ? `, each evaluator at least ${DEFAULT_FLOOR}` : ''
  return [
    ...(names.length > 0
      ? [{ label: 'the mean of every evaluator', objective: { expression: '', constraints: '' } }]
      : []),
    ...(names.length > 1
      ? names.map((name) => ({
          label: `${name} only`,
          objective: { expression: `Maximize(${metricText(name)})`, constraints: '' },
        }))
      : []),
    { label: `fewer tokens${floor}`, objective: { expression: 'Minimize(tokens)', constraints: floors(names) } },
    { label: `less time${floor}`, objective: { expression: 'Minimize(seconds)', constraints: floors(names) } },
    ...(names.length > 0
      ? [
          evaluatorTradeOff('the evaluators and fewer tokens', 'WeightedSum', names, [FEWER_TOKENS]),
          evaluatorTradeOff('the evaluators and less time', 'WeightedSum', names, [LESS_TIME]),
          evaluatorTradeOff('the evaluators, fewer tokens, and less time', 'WeightedSum', names, [
            FEWER_TOKENS,
            LESS_TIME,
          ]),
          evaluatorTradeOff('the best trade-offs of the evaluators and tokens', 'Pareto', names, [FEWER_TOKENS]),
        ]
      : []),
  ]
}

const bareGoal = (word: string, evaluators: readonly string[]): string => {
  if (TEMPORARY_USAGE_METRICS.includes(word)) return `Minimize(${word})`
  const wanted = word.toLowerCase()
  const evaluator =
    evaluators.find((name) => name.toLowerCase() === wanted) ??
    evaluators.find((name) => name.toLowerCase() === `${wanted}${SHORT_SUFFIX.toLowerCase()}`)
  return `Maximize(${metricText(evaluator ?? word)})`
}

export const temporaryObjectiveFromRequest = (
  objective: string | undefined,
  constraints: readonly string[] | undefined,
  evaluators: readonly string[]
): OptimizeObjective => {
  const text = objective?.trim() ?? ''
  return {
    expression: text && !text.includes('(') ? bareGoal(text, evaluators) : text,
    constraints: (constraints ?? [])
      .map((constraint) => constraint.trim())
      .filter(Boolean)
      .join(', '),
  }
}
