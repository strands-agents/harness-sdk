import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../../values.js'
import type {
  CandidateResult,
  CaseResult,
  EvalCase,
  EvaluatorVerdict,
  ObjectiveMeasure,
  OptimizeProgress,
  OptimizeStep,
  ScoringProgress,
  TrialProgress,
} from '../panels/model.js'
import { tailTemporaryLines, type TemporaryTail } from './jobs.js'
import { listTemporaryOptimizations, temporaryOptimizationFiles } from './layout.js'
import { TEMPORARY_USAGE_METRICS } from './objective.js'

type TemporaryStudyParams = Readonly<Record<string, unknown>>

type TemporaryStudyEnd = 'finished' | 'stopped' | 'running'

export type TemporaryMeasurement = 'search' | 'validation' | 'test'

export interface TemporaryTestDifference {
  readonly difference: number
  readonly ci?: readonly [number, number]
  readonly cases: number
  readonly confidence: number
}

interface TemporaryStudyBaseline {
  readonly params: TemporaryStudyParams
  readonly score?: number
}

export interface TemporaryStudyOutcome {
  readonly metric: string
  readonly measure?: ObjectiveMeasure
  readonly ended: TemporaryStudyEnd
  readonly error?: string
  readonly measuredOn: TemporaryMeasurement
  readonly baseline: TemporaryStudyBaseline
  readonly best?: TemporaryStudyBaseline & { readonly number: number }
  readonly test?: TemporaryTestDifference
}

/** The case runs a plan allows in each part of a run. */
export interface TemporaryRolloutPhases {
  readonly search: number
  readonly validation: number
  readonly test: number
}

interface TemporaryStudyRun {
  readonly run: string
  readonly record: string
  readonly startedAt: number
  readonly labels?: Readonly<Record<string, string>>
  readonly cases?: readonly EvalCase[]
  /** What the plan allows, to count the run's rollouts against. Without it the progress carries no such count. */
  readonly planned?: TemporaryRolloutPhases
}

interface TemporaryStudyReader {
  push(line: string): void
  progress(): OptimizeProgress
  outcome(): TemporaryStudyOutcome
}

type Event = Record<string, unknown>

type Split = 'train' | 'validation' | 'test'

interface Candidate {
  readonly id: string
  readonly number: number
  readonly iteration: number
  readonly values: TemporaryStudyParams
  readonly changed: readonly string[]
  readonly rationale?: string
}

interface Trial {
  readonly split: Split
  readonly value?: number
  readonly result: CaseResult
}

const SPLITS: readonly Split[] = ['train', 'validation', 'test']

const isSplit = (value: unknown): value is Split => SPLITS.includes(value as Split)

const trialName = (caseName: string, split: Split, run: number): string =>
  [caseName, ...(split === 'train' ? [] : [split]), ...(run > 0 ? [`run ${run + 1}`] : [])].join(' · ')

const trialOutput = (output: unknown): string | undefined =>
  output === undefined || output === null ? undefined : typeof output === 'string' ? output : shown(output)

const trialVerdicts = (record: Event): EvaluatorVerdict[] => {
  if (record.status !== 'completed') {
    const error = [text(record.error_type), text(record.error)].filter(Boolean).join(': ')
    return [
      { evaluator: text(record.status) ?? 'failed', score: 0, passed: false, reason: error || 'the trial failed' },
    ]
  }
  return Object.entries(isRecord(record.evaluations) ? record.evaluations : {}).flatMap(([evaluator, output]) =>
    isRecord(output)
      ? [
          {
            evaluator,
            score: finite(output.score) ?? 0,
            passed: output.test_pass === true,
            reason: text(output.reason) ?? '',
          },
        ]
      : []
  )
}

interface TestReport {
  readonly champion: string | undefined
  readonly baseline: string | undefined
  readonly difference: number | undefined
  readonly ci: readonly [number, number] | undefined
  readonly cases: number | undefined
}

const EVENTS = 'events.jsonl'
const RESULT = 'result.json'
const SUMMARY_LIMIT = 80
const LINE_BREAK = /\r?\n/u
const OBJECTIVE = /^(?:Maximize|Minimize)\((.+)\)$/u
const MEAN_OBJECTIVE = /^WeightedSum\(((?:Maximize\([^(),]+\)(?:, )?)+)\)$/u
const MAXIMIZED = /Maximize\(([^(),]+)\)/gu

const objectiveMetrics = (objective: string): string[] => {
  const single = OBJECTIVE.exec(objective)?.[1]
  if (single) return [single]
  const terms = MEAN_OBJECTIVE.exec(objective)?.[1]
  return terms ? [...terms.matchAll(MAXIMIZED)].flatMap(([, metric]) => (metric ? [metric] : [])) : []
}

const LONE_OBJECTIVE = /^(Maximize|Minimize)\(([^(),]+)\)$/u

const measureOf = (objective: string): ObjectiveMeasure => {
  const [, direction, metric] = LONE_OBJECTIVE.exec(objective) ?? []
  if (metric)
    return { kind: 'metric', metric, usage: TEMPORARY_USAGE_METRICS.includes(metric), lower: direction === 'Minimize' }
  return MEAN_OBJECTIVE.test(objective) ? { kind: 'score' } : { kind: 'combined' }
}

const objectiveName = (objective: string): string => {
  const [, direction, metric] = LONE_OBJECTIVE.exec(objective) ?? []
  if (metric) {
    if (direction === 'Maximize') return metric
    const words = metric.replaceAll('_', ' ')
    return TEMPORARY_USAGE_METRICS.includes(metric)
      ? metric === 'seconds'
        ? 'less time'
        : `fewer ${words}`
      : `lower ${words}`
  }
  const terms = MEAN_OBJECTIVE.exec(objective)?.[1]
  return terms ? `mean of ${[...terms.matchAll(MAXIMIZED)].map(([, name]) => name).join(', ')}` : objective
}
const FAILED_STOPS = new Set(['setup', 'proposer_error'])
const PROPOSER_STOP = 'proposer_error'
const CREDENTIAL_ERRORS =
  /ProfileNotFound|NoCredentials|CredentialRetrieval|ExpiredToken|UnrecognizedClient|InvalidClientTokenId|AccessDenied|SSOToken|TokenRetrieval/u
const PROPOSER_CREDENTIALS =
  "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell that " +
  'started strands dev, not the chat provider. Set AWS_PROFILE or AWS credentials that can call Bedrock, then start the run again.'
const TEST_INTERVAL_CONFIDENCE = 0.9
const SPLIT_MEASUREMENT: Record<Split, TemporaryMeasurement> = {
  train: 'search',
  validation: 'validation',
  test: 'test',
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const mean = (values: readonly number[]): number | undefined =>
  values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length

const objectiveMean = (byRun: unknown): number | undefined =>
  mean(
    Object.values(isRecord(byRun) ? byRun : {}).flatMap((runs) => {
      const perCase = mean((Array.isArray(runs) ? runs : []).map(finite).filter((value) => value !== undefined))
      return perCase === undefined ? [] : [perCase]
    })
  )

const parseEvent = (line: string): Event | undefined => {
  if (!line.trim()) return undefined
  try {
    const event: unknown = JSON.parse(line)
    return isRecord(event) && typeof event.event === 'string' ? event : undefined
  } catch {
    return undefined
  }
}

const parseTest = (report: unknown): TestReport | undefined => {
  if (!isRecord(report)) return undefined
  const objective = isRecord(report.objective) ? report.objective : {}
  const low = finite(objective.ci_low)
  const high = finite(objective.ci_high)
  return {
    champion: text(report.champion_id),
    baseline: text(report.baseline_id),
    difference: finite(objective.mean_diff),
    ci: low === undefined || high === undefined ? undefined : [low, high],
    cases: finite(objective.n_cases),
  }
}

const clip = (value: string): string => {
  const characters = Array.from(value)
  return characters.length > SUMMARY_LIMIT ? `${characters.slice(0, SUMMARY_LIMIT - 1).join('')}…` : value
}

const shown = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)))

const firstNewLine = (key: string, value: string, baseline: string): string => {
  const known = new Set(baseline.split(LINE_BREAK).map((line) => line.trim()))
  const fresh = value
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .find((line) => line && !known.has(line))
  return fresh === undefined ? `${key}: removed or moved lines` : clip(fresh)
}

const describeChange = (key: string, value: unknown, baseline: unknown, isText: boolean): string =>
  isText && typeof value === 'string'
    ? firstNewLine(key, value, typeof baseline === 'string' ? baseline : '')
    : `${key} → ${typeof value === 'boolean' ? (value ? 'on' : 'off') : clip(shown(value))}`

class RunState {
  private readonly cases: ReadonlyMap<string, EvalCase>

  constructor(
    private readonly labels: Readonly<Record<string, string>> = {},
    cases: readonly EvalCase[] = []
  ) {
    this.cases = new Map(cases.map((testCase) => [testCase.name, testCase]))
  }

  private metric = ''
  private textKeys: ReadonlySet<string> = new Set()
  private width = 0
  private iterations = 0
  private baselineId: string | undefined
  private bestAfter: readonly string[] = []
  private champion: string | undefined
  private stopReason: string | undefined
  private stopMessage: string | undefined
  private proposerError: string | undefined
  private test: TestReport | undefined
  private readonly candidates = new Map<string, Candidate>()
  private readonly scores = new Map<string, Map<Split, number>>()
  private readonly failures = new Map<string, string>()
  private readonly completed = new Map<string, number>()
  private readonly trials = new Map<string, Map<string, Trial>>()
  private splitCases: Readonly<Record<Split, readonly string[]>> = { train: [], validation: [], test: [] }
  private runs = 1
  private finalists: readonly string[] | undefined
  private tested = false
  private goals: readonly string[] = []
  private measure: ObjectiveMeasure = { kind: 'score' }

  private readonly handlers = new Map<string, (event: Event) => void>([
    ['config', (event): void => this.readConfig(event)],
    ['propose', (event): void => this.readPropose(event)],
    ['trial', (event): void => this.readTrial(event)],
    ['score', (event): void => this.readScore(event)],
    ['iteration_end', ({ best_after }): void => void (this.bestAfter = texts(best_after))],
    ['finalists', ({ candidate_ids }): void => void (this.finalists = texts(candidate_ids))],
    ['proposer_error', (event): void => this.readProposerError(event)],
    ['resume', (): void => this.readResume()],
    ['stop', (event): void => this.readStop(event)],
    ['picked', ({ report }): void => this.readPicked(report)],
    ['test', ({ report }): void => this.readTest(report)],
  ])

  push(line: string): void {
    const event = parseEvent(line)
    if (event) this.handlers.get(String(event.event))?.(event)
  }

  absorbResult({ baseline_id, validation, test }: Event): void {
    this.baselineId ??= text(baseline_id)
    if (isRecord(validation)) this.readPicked(validation)
    if (!this.test) this.readTest(test)
  }

  progress({ run, record, startedAt, planned }: TemporaryStudyRun): OptimizeProgress {
    const baseline = this.score(this.baselineId, 'train')
    const leader = this.bestAfter[0]
    const best = this.score(leader, 'train')
    const leading = leader === undefined ? undefined : this.candidates.get(leader)
    const step = this.step()
    const rollouts = planned ? this.rollouts(step, planned) : undefined
    return {
      run,
      record,
      metric: this.metric,
      measure: this.measure,
      iterations: this.iterations,
      planned: 1 + this.iterations * this.width,
      ...(baseline === undefined ? {} : { baseline }),
      ...(leading && best !== undefined ? { best: { number: leading.number, score: best } } : {}),
      candidates: [...this.candidates.values()]
        .filter(({ id }) => id !== this.baselineId)
        .map((candidate) => this.candidateResult(candidate, baseline)),
      ...(this.baselineId === undefined ? {} : { baselineCandidate: this.baselineResult(this.baselineId, baseline) }),
      ...(step ? { step } : {}),
      ...(rollouts ? { rollouts } : {}),
      startedAt,
      stopping: false,
    }
  }

  /** The rollouts done and still to come: the current part by what it needs, the later parts by the plan. */
  private rollouts(step: OptimizeStep | undefined, planned: TemporaryRolloutPhases): TrialProgress {
    const everyone = [...this.trials.keys()]
    const train = this.finishedIn(everyone, 'train')
    const done = train + this.finishedIn(everyone, 'validation') + this.finishedIn(everyone, 'test')
    return { done, total: done + this.rolloutsLeft(step, train, planned) }
  }

  private rolloutsLeft(step: OptimizeStep | undefined, train: number, planned: TemporaryRolloutPhases): number {
    if (!step) return 0
    const rest = ({ done, total }: TrialProgress): number => Math.max(0, total - done)
    if (step.kind === 'testing') return rest(step.trials)
    // The search can be over before the finalists are named; until then the plan says what their check takes.
    if (step.kind === 'validating') return (step.versions > 0 ? rest(step.trials) : planned.validation) + planned.test
    return Math.max(0, planned.search - train) + planned.validation + planned.test
  }

  private trialsOf(id: string | undefined): CaseResult[] {
    return id === undefined ? [] : [...(this.trials.get(id)?.values() ?? [])].map(({ result }) => result)
  }

  private baselineResult(id: string, score: number | undefined): CandidateResult {
    const scoring = this.scoring(id)
    return {
      number: 0,
      changed: [],
      summary: 'your agent as it is',
      ...(score === undefined ? {} : { score }),
      kept: this.bestAfter.includes(id),
      trials: this.trialsOf(id),
      ...(scoring ? { scoring } : {}),
    }
  }

  private scoring(id: string): ScoringProgress | undefined {
    if (this.isScored(id)) return undefined
    const values = [...(this.trials.get(id)?.values() ?? [])]
      .filter(({ split }) => split === 'train')
      .flatMap(({ value }) => (value === undefined ? [] : [value]))
    const score = this.measure.kind === 'combined' ? undefined : mean(values)
    return { ...this.trialProgress([id], 'train'), ...(score === undefined ? {} : { score }) }
  }

  private trialValue(record: Event, verdicts: readonly EvaluatorVerdict[]): number | undefined {
    const { measure } = this
    if (measure.kind === 'combined') return undefined
    if (measure.kind === 'metric' && measure.usage) {
      const used = isRecord(record.usage) ? finite(record.usage[measure.metric]) : undefined
      return used === undefined ? undefined : measure.lower ? -used : used
    }
    if (record.status !== 'completed') return 0
    const counted =
      this.goals.length > 0 ? verdicts.filter(({ evaluator }) => this.goals.includes(evaluator)) : verdicts
    const value = mean(counted.map(({ score }) => score)) ?? 0
    return measure.kind === 'metric' && measure.lower ? -value : value
  }

  private finishedIn(ids: readonly string[], split: Split): number {
    return ids.reduce(
      (sum, id) => sum + [...(this.trials.get(id)?.values() ?? [])].filter((trial) => trial.split === split).length,
      0
    )
  }

  private trialProgress(ids: readonly string[], split: Split): TrialProgress {
    return { done: this.finishedIn(ids, split), total: ids.length * this.splitCases[split].length * this.runs }
  }

  private isScored(id: string): boolean {
    return this.scores.get(id)?.has('train') === true
  }

  private step(): OptimizeStep | undefined {
    if (this.tested || (this.stopReason !== undefined && FAILED_STOPS.has(this.stopReason))) return undefined
    const baseline = this.baselineId
    if (baseline === undefined || !this.isScored(baseline))
      return { kind: 'baseline', trials: this.trialProgress(baseline === undefined ? [] : [baseline], 'train') }
    if (this.champion !== undefined) {
      const tested = [...new Set([this.champion, baseline])]
      return { kind: 'testing', versions: tested.length, trials: this.trialProgress(tested, 'test') }
    }
    if (this.finalists !== undefined) {
      const measured = [...new Set([...this.finalists, baseline])]
      return { kind: 'validating', versions: measured.length, trials: this.trialProgress(measured, 'validation') }
    }
    const versions = [...this.candidates.values()].filter(({ id }) => id !== baseline)
    const pending = versions.filter(({ id }) => !this.isScored(id)).map(({ id }) => id)
    const iteration = Math.max(0, ...versions.map((candidate) => candidate.iteration))
    if (pending.length > 0)
      return { kind: 'scoring', iteration, versions: pending.length, trials: this.trialProgress(pending, 'train') }
    if (this.stopReason !== undefined) return { kind: 'validating', versions: 0, trials: { done: 0, total: 0 } }
    return { kind: 'proposing', iteration: iteration + 1 }
  }

  outcome(): TemporaryStudyOutcome {
    const bestId = this.champion ?? this.bestAfter[0]
    const split = this.measuredSplit(bestId)
    const best = bestId === undefined ? undefined : this.candidates.get(bestId)
    const bestScore = this.score(bestId, split)
    const baselineScore = this.score(this.baselineId, split)
    const failed = this.stopReason !== undefined && FAILED_STOPS.has(this.stopReason)
    const error = failed ? this.stopError() : undefined
    const test = this.testDifference()
    return {
      metric: this.metric,
      measure: this.measure,
      ended: failed ? 'stopped' : this.champion !== undefined ? 'finished' : 'running',
      ...(error ? { error } : {}),
      measuredOn: SPLIT_MEASUREMENT[split],
      baseline: {
        params: (this.baselineId === undefined ? undefined : this.candidates.get(this.baselineId)?.values) ?? {},
        ...(baselineScore === undefined ? {} : { score: baselineScore }),
      },
      ...(best
        ? {
            best: {
              number: best.number,
              params: best.values,
              ...(bestScore === undefined ? {} : { score: bestScore }),
            },
          }
        : {}),
      ...(test ? { test } : {}),
    }
  }

  private readConfig({ config }: Event): void {
    if (!isRecord(config)) return
    const objective = text(config.objective)
    this.metric = objective ? objectiveName(objective) : ''
    this.goals = objective ? objectiveMetrics(objective) : []
    this.measure = objective ? measureOf(objective) : { kind: 'score' }
    this.textKeys = new Set(
      (Array.isArray(config.space) ? config.space : [])
        .filter(isRecord)
        .flatMap(({ key, kind }) => (kind === 'text' && typeof key === 'string' ? [key] : []))
    )
    this.width = finite(config.proposals_per_iteration) ?? this.width
    this.iterations = (isRecord(config.budget) ? finite(config.budget.max_iterations) : undefined) ?? this.iterations
    this.runs = finite(config.runs_per_candidate) ?? this.runs
    const split = isRecord(config.split) && isRecord(config.split.cases) ? config.split.cases : undefined
    if (split)
      this.splitCases = { train: texts(split.train), validation: texts(split.validation), test: texts(split.test) }
  }

  private readPropose(event: Event): void {
    const id = text(event.candidate_id)
    const number = finite(event.number)
    if (id === undefined || number === undefined) return
    if (texts(event.origin).includes('baseline')) this.baselineId = id
    const rationale = text(event.rationale)
    this.candidates.set(id, {
      id,
      number,
      iteration: finite(event.iteration) ?? 0,
      values: isRecord(event.values) ? event.values : {},
      changed: texts(event.changed_keys),
      ...(rationale ? { rationale } : {}),
    })
  }

  private readTrial({ record }: Event): void {
    if (!isRecord(record)) return
    const id = text(record.candidate_id)
    if (id === undefined) return
    this.keepTrial(id, record)
    if (record.status === 'completed' || this.failures.has(id)) return
    const reason = text(record.error) ?? text(record.error_type) ?? text(record.status)
    if (reason) this.failures.set(id, reason)
  }

  private keepTrial(id: string, record: Event): void {
    const caseName = text(record.case_name)
    if (caseName === undefined || !isSplit(record.split)) return
    const run = finite(record.run_index) ?? 0
    const verdicts = trialVerdicts(record)
    const known = this.cases.get(caseName)
    const actual = trialOutput(record.output)
    const result: CaseResult = {
      name: trialName(caseName, record.split, run),
      input: known?.input ?? '',
      ...(known?.expected === undefined ? {} : { expected: known.expected }),
      ...(actual === undefined ? {} : { actual }),
      passed: record.status === 'completed' && verdicts.every((verdict) => verdict.passed),
      verdicts,
    }
    const byKey = this.trials.get(id) ?? new Map<string, Trial>()
    const value = this.trialValue(record, verdicts)
    byKey.set(`${record.split}\u0000${caseName}\u0000${run}`, {
      split: record.split,
      ...(value === undefined ? {} : { value }),
      result,
    })
    this.trials.set(id, byKey)
  }

  private readScore({ candidate_id, split, objective_by_run, statuses }: Event): void {
    const id = text(candidate_id)
    if (id === undefined || !isSplit(split)) return
    const value = objectiveMean(objective_by_run)
    const byId = this.scores.get(id) ?? new Map<Split, number>()
    if (value !== undefined) byId.set(split, value)
    this.scores.set(id, byId)
    if (split === 'train') this.completed.set(id, isRecord(statuses) ? (finite(statuses.completed) ?? 0) : 0)
  }

  private readStop({ reason, message }: Event): void {
    this.stopReason = text(reason)
    this.stopMessage = text(message)
  }

  private readProposerError({ error_type: type, error }: Event): void {
    this.proposerError = [text(type), text(error)].filter(Boolean).join(': ') || undefined
    this.stopReason = PROPOSER_STOP
  }

  private readResume(): void {
    if (this.stopReason !== PROPOSER_STOP) return
    this.stopReason = undefined
    this.proposerError = undefined
  }

  proposerFailure(): string | undefined {
    return this.stopReason === PROPOSER_STOP ? this.stopError() : undefined
  }

  private stopError(): string | undefined {
    const detail = this.proposerError
    if (this.stopReason !== PROPOSER_STOP || !detail) return this.stopMessage
    const failure = `The proposer failed with ${detail}${/[.!?]$/u.test(detail) ? '' : '.'}`
    return CREDENTIAL_ERRORS.test(detail) ? `${failure} ${PROPOSER_CREDENTIALS}` : failure
  }

  private readPicked(report: unknown): void {
    if (isRecord(report)) this.champion = text(report.champion_id) ?? this.champion
  }

  private readTest(report: unknown): void {
    this.tested = true
    this.test = parseTest(report) ?? this.test
  }

  private score(id: string | undefined, split: Split): number | undefined {
    return id === undefined ? undefined : this.scores.get(id)?.get(split)
  }

  private measuredSplit(bestId: string | undefined): Split {
    const both = (split: Split): boolean =>
      this.score(this.baselineId, split) !== undefined && this.score(bestId, split) !== undefined
    return both('test') ? 'test' : both('validation') ? 'validation' : 'train'
  }

  private testDifference(): TemporaryTestDifference | undefined {
    const { difference, cases, ci } = this.test ?? {}
    if (difference === undefined || cases === undefined) return undefined
    return { difference, cases, confidence: TEST_INTERVAL_CONFIDENCE, ...(ci ? { ci } : {}) }
  }

  private candidateResult(candidate: Candidate, baselineScore: number | undefined): CandidateResult {
    const baseline = (this.baselineId === undefined ? undefined : this.candidates.get(this.baselineId)?.values) ?? {}
    const score = this.score(candidate.id, 'train')
    const scoring = this.scoring(candidate.id)
    const failure =
      this.completed.get(candidate.id) === 0 ? (this.failures.get(candidate.id) ?? 'every trial failed') : undefined
    const summary =
      candidate.changed
        .map((key) =>
          describeChange(this.labels[key] ?? key, candidate.values[key], baseline[key], this.textKeys.has(key))
        )
        .join('; ') || 'no change from the baseline'
    return {
      number: candidate.number,
      step: candidate.iteration,
      changed: candidate.changed,
      summary: failure ?? summary,
      ...(score === undefined ? {} : { score }),
      ...(score === undefined || baselineScore === undefined ? {} : { delta: score - baselineScore }),
      kept: this.bestAfter.includes(candidate.id),
      ...(failure === undefined ? {} : { failed: failure }),
      ...(candidate.rationale ? { rationale: candidate.rationale } : {}),
      trials: this.trialsOf(candidate.id),
      ...(scoring ? { scoring } : {}),
    }
  }
}

export const temporaryStudyReader = (run: TemporaryStudyRun): TemporaryStudyReader => {
  const state = new RunState(run.labels, run.cases)
  return { push: (line) => state.push(line), progress: () => state.progress(run), outcome: () => state.outcome() }
}

export const temporaryRunFolder = async (record: string): Promise<string | undefined> => {
  let entries: string[]
  try {
    entries = await readdir(record)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  if (entries.includes(EVENTS)) return record
  const runs = entries.filter((entry) => /^\d{8}-\d{6}-[0-9a-f]+$/u.test(entry)).sort()
  return runs.length > 0 ? join(record, runs.at(-1)!) : undefined
}

export const hasTemporaryRunResult = async (record: string): Promise<boolean> => {
  const folder = await temporaryRunFolder(record)
  return folder !== undefined && existsSync(join(folder, RESULT))
}

export const tailTemporaryRun = (record: string, onLine: (line: string) => void): TemporaryTail => {
  let tail: TemporaryTail | undefined
  let stopped = false
  const found = (async (): Promise<void> => {
    while (!stopped) {
      const folder = await temporaryRunFolder(record).catch(() => undefined)
      if (folder) {
        tail = tailTemporaryLines(join(folder, EVENTS), onLine)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250).unref())
    }
  })()
  return {
    stop: async (): Promise<void> => {
      stopped = true
      await found
      await tail?.stop()
    },
  }
}

const readJson = async (path: string): Promise<unknown> => {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

const readRunState = async (record: string): Promise<RunState> => {
  const folder = await temporaryRunFolder(record)
  if (!folder)
    throw new Error(
      `${record} has no optimization run with ${EVENTS}, so the optimizer stopped before it started. ` +
        'Run the optimization again.'
    )
  const state = new RunState()
  const events = await readFile(join(folder, EVENTS), 'utf8')
  events.split('\n').forEach((line) => state.push(line))
  const result = await readJson(join(folder, RESULT))
  if (isRecord(result)) state.absorbResult(result)
  return state
}

export const readTemporaryStudy = async (record: string): Promise<TemporaryStudyOutcome> =>
  (await readRunState(record)).outcome()

export const readTemporaryProposerFailure = async (record: string): Promise<string | undefined> =>
  (await readRunState(record)).proposerFailure()

interface TemporaryRunUsage {
  readonly rollouts: number
  readonly tokens: number
  readonly seconds: number
}

export interface TemporaryUsageProfile {
  readonly experiment: string
  readonly runs: readonly TemporaryRunUsage[]
}

const USAGE_RUNS = 3
const MILLISECONDS_PER_SECOND = 1000

const usedTokens = (usage: unknown): number => (isRecord(usage) ? (finite(usage.tokens) ?? 0) : 0)

const eventTokens = ({ event, usage, record }: Event): number => {
  if (event === 'proposer_usage') return usedTokens(usage)
  if (event !== 'trial' || !isRecord(record)) return 0
  const judges = isRecord(record.judge_usage) ? Object.values(record.judge_usage) : []
  return judges.reduce<number>((sum, judge) => sum + usedTokens(judge), usedTokens(record.usage))
}

const eventTime = ({ time }: Event): number[] => {
  const at = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return Number.isFinite(at) ? [at] : []
}

const runUsage = (events: readonly Event[]): TemporaryRunUsage | undefined => {
  const rollouts = events.filter(({ event, record }) => event === 'trial' && isRecord(record)).length
  const times = events.flatMap(eventTime)
  if (rollouts === 0 || times.length < 2) return undefined
  return {
    rollouts,
    tokens: events.reduce((sum, event) => sum + eventTokens(event), 0),
    seconds: (times.at(-1)! - times[0]!) / MILLISECONDS_PER_SECOND,
  }
}

const readRunUsage = async (record: string): Promise<TemporaryRunUsage | undefined> => {
  const folder = await temporaryRunFolder(record).catch(() => undefined)
  if (!folder) return undefined
  const lines = (await readFile(join(folder, EVENTS), 'utf8').catch(() => '')).split(LINE_BREAK)
  return runUsage(lines.map(parseEvent).filter((event) => event !== undefined))
}

export const readTemporaryUsageProfile = async (
  workspaceDirectory: string,
  experiment: string
): Promise<TemporaryUsageProfile | undefined> => {
  const records = (await listTemporaryOptimizations(workspaceDirectory).catch(() => []))
    .map(({ home, name, stamp }) => ({ record: temporaryOptimizationFiles(home, stamp).record, experiment: name }))
    .reverse()
  const same = records.filter((run) => run.experiment === experiment).slice(0, USAGE_RUNS)
  const runs = (await Promise.all(same.map(({ record }) => readRunUsage(record)))).filter((run) => run !== undefined)
  if (runs.length > 0) return { experiment, runs }
  for (const other of records.filter((run) => run.experiment !== experiment)) {
    const usage = await readRunUsage(other.record)
    if (usage) return { experiment: other.experiment, runs: [usage] }
  }
  return undefined
}
