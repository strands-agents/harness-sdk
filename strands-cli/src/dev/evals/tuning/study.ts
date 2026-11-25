import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../../../values.js'
import type { OptimizePhase, OptimizeProgress, TrialProgress } from '../model.js'
import { tailEvalsLines, type EvalsTail } from '../jobs.js'
import { listEvalsOptimizations, evalsOptimizationFiles } from '../layout.js'

type EvalsStudyParams = Readonly<Record<string, unknown>>

type EvalsStudyEnd = 'finished' | 'stopped' | 'running'

export type EvalsMeasurement = 'search' | 'validation' | 'test'

export interface EvalsTestDifference {
  readonly difference: number
  readonly ci?: readonly [number, number]
  readonly cases: number
  readonly confidence: number
}

interface EvalsStudyBaseline {
  readonly params: EvalsStudyParams
  readonly score?: number
}

export interface EvalsStudyOutcome {
  readonly ended: EvalsStudyEnd
  readonly error?: string
  readonly measuredOn: EvalsMeasurement
  readonly baseline: EvalsStudyBaseline
  readonly best?: EvalsStudyBaseline & { readonly number: number }
  readonly test?: EvalsTestDifference
}

/** The case runs a plan allows in each part of a run. */
export interface EvalsRolloutPhases {
  readonly search: number
  readonly validation: number
  readonly test: number
}

interface EvalsStudyRun {
  readonly run: string
  readonly record: string
  /** What the plan allows, to count the run's rollouts against. */
  readonly planned: EvalsRolloutPhases
}

/** The progress that the events of a run give. The plan gives the count of planned versions. */
type StudyProgress = Omit<OptimizeProgress, 'planned'>

interface EvalsStudyReader {
  push(line: string): void
  progress(): StudyProgress
  outcome(): EvalsStudyOutcome
}

type Event = Record<string, unknown>

type Split = 'train' | 'validation' | 'test'

interface Candidate {
  readonly number: number
  readonly values: EvalsStudyParams
}

/** Where a run is. The check of the finalists and the test carry the trials that the rollout count needs. */
type Step =
  | { readonly kind: Exclude<OptimizePhase, 'validating' | 'testing'> }
  | { readonly kind: 'validating'; readonly versions: number; readonly trials: TrialProgress }
  | { readonly kind: 'testing'; readonly trials: TrialProgress }

const SPLITS: readonly Split[] = ['train', 'validation', 'test']

const isSplit = (value: unknown): value is Split => SPLITS.includes(value as Split)

interface TestReport {
  readonly difference: number | undefined
  readonly ci: readonly [number, number] | undefined
  readonly cases: number | undefined
}

const EVENTS = 'events.jsonl'
const RESULT = 'result.json'
const LINE_BREAK = /\r?\n/u
const FAILED_STOPS = new Set(['setup', 'proposer_error'])
const PROPOSER_STOP = 'proposer_error'
const CREDENTIAL_ERRORS =
  /ProfileNotFound|NoCredentials|CredentialRetrieval|ExpiredToken|UnrecognizedClient|InvalidClientTokenId|AccessDenied|SSOToken|TokenRetrieval/u
const PROPOSER_CREDENTIALS =
  "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell that " +
  'started strands dev, not the chat provider. Set AWS_PROFILE or AWS credentials that can call Bedrock, then start the run again.'
const TEST_INTERVAL_CONFIDENCE = 0.9
const SPLIT_MEASUREMENT: Record<Split, EvalsMeasurement> = {
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
    difference: finite(objective.mean_diff),
    ci: low === undefined || high === undefined ? undefined : [low, high],
    cases: finite(objective.n_cases),
  }
}

class RunState {
  private baselineId: string | undefined
  private bestAfter: readonly string[] = []
  private champion: string | undefined
  private stopReason: string | undefined
  private stopMessage: string | undefined
  private proposerError: string | undefined
  private test: TestReport | undefined
  private readonly candidates = new Map<string, Candidate>()
  private readonly scores = new Map<string, Map<Split, number>>()
  /** The split of each finished trial of a candidate. A case that ran again has one entry. */
  private readonly trials = new Map<string, Map<string, Split>>()
  private splitCases: Readonly<Record<Split, readonly string[]>> = { train: [], validation: [], test: [] }
  private runs = 1
  private finalists: readonly string[] | undefined
  private tested = false

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

  progress({ run, record, planned }: EvalsStudyRun): StudyProgress {
    const baseline = this.score(this.baselineId, 'train')
    const leader = this.bestAfter[0]
    const best = leader !== undefined && this.candidates.has(leader) ? this.score(leader, 'train') : undefined
    const step = this.step()
    return {
      run,
      record,
      ...(baseline === undefined ? {} : { baseline }),
      ...(best === undefined ? {} : { best }),
      tried: [...this.candidates.keys()].filter((id) => id !== this.baselineId && this.isScored(id)).length,
      ...(step ? { phase: step.kind } : {}),
      rollouts: this.rollouts(step, planned),
    }
  }

  /** The rollouts done and still to come: the current part by what it needs, the later parts by the plan. */
  private rollouts(step: Step | undefined, planned: EvalsRolloutPhases): TrialProgress {
    const everyone = [...this.trials.keys()]
    const train = this.finishedIn(everyone, 'train')
    const done = train + this.finishedIn(everyone, 'validation') + this.finishedIn(everyone, 'test')
    return { done, total: done + this.rolloutsLeft(step, train, planned) }
  }

  private rolloutsLeft(step: Step | undefined, train: number, planned: EvalsRolloutPhases): number {
    if (!step) return 0
    const rest = ({ done, total }: TrialProgress): number => Math.max(0, total - done)
    if (step.kind === 'testing') return rest(step.trials)
    // The search can be over before the finalists are named; until then the plan says what their check takes.
    if (step.kind === 'validating') return (step.versions > 0 ? rest(step.trials) : planned.validation) + planned.test
    return Math.max(0, planned.search - train) + planned.validation + planned.test
  }

  private finishedIn(ids: readonly string[], split: Split): number {
    return ids.reduce(
      (sum, id) => sum + [...(this.trials.get(id)?.values() ?? [])].filter((done) => done === split).length,
      0
    )
  }

  private trialProgress(ids: readonly string[], split: Split): TrialProgress {
    return { done: this.finishedIn(ids, split), total: ids.length * this.splitCases[split].length * this.runs }
  }

  private isScored(id: string): boolean {
    return this.scores.get(id)?.has('train') === true
  }

  private step(): Step | undefined {
    if (this.tested || (this.stopReason !== undefined && FAILED_STOPS.has(this.stopReason))) return undefined
    const baseline = this.baselineId
    if (baseline === undefined || !this.isScored(baseline)) return { kind: 'baseline' }
    if (this.champion !== undefined)
      return { kind: 'testing', trials: this.trialProgress([...new Set([this.champion, baseline])], 'test') }
    if (this.finalists !== undefined) {
      const measured = [...new Set([...this.finalists, baseline])]
      return { kind: 'validating', versions: measured.length, trials: this.trialProgress(measured, 'validation') }
    }
    if ([...this.candidates.keys()].some((id) => id !== baseline && !this.isScored(id))) return { kind: 'scoring' }
    if (this.stopReason !== undefined) return { kind: 'validating', versions: 0, trials: { done: 0, total: 0 } }
    return { kind: 'proposing' }
  }

  outcome(): EvalsStudyOutcome {
    const bestId = this.champion ?? this.bestAfter[0]
    const split = this.measuredSplit(bestId)
    const best = bestId === undefined ? undefined : this.candidates.get(bestId)
    const bestScore = this.score(bestId, split)
    const baselineScore = this.score(this.baselineId, split)
    const failed = this.stopReason !== undefined && FAILED_STOPS.has(this.stopReason)
    const error = failed ? this.stopError() : undefined
    const test = this.testDifference()
    return {
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
    this.candidates.set(id, { number, values: isRecord(event.values) ? event.values : {} })
  }

  private readTrial({ record }: Event): void {
    if (!isRecord(record)) return
    const id = text(record.candidate_id)
    const caseName = text(record.case_name)
    if (id === undefined || caseName === undefined || !isSplit(record.split)) return
    const byKey = this.trials.get(id) ?? new Map<string, Split>()
    byKey.set(`${record.split}\u0000${caseName}\u0000${finite(record.run_index) ?? 0}`, record.split)
    this.trials.set(id, byKey)
  }

  private readScore({ candidate_id, split, objective_by_run }: Event): void {
    const id = text(candidate_id)
    if (id === undefined || !isSplit(split)) return
    const value = objectiveMean(objective_by_run)
    const byId = this.scores.get(id) ?? new Map<Split, number>()
    if (value !== undefined) byId.set(split, value)
    this.scores.set(id, byId)
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

  private testDifference(): EvalsTestDifference | undefined {
    const { difference, cases, ci } = this.test ?? {}
    if (difference === undefined || cases === undefined) return undefined
    return { difference, cases, confidence: TEST_INTERVAL_CONFIDENCE, ...(ci ? { ci } : {}) }
  }
}

export const evalsStudyReader = (run: EvalsStudyRun): EvalsStudyReader => {
  const state = new RunState()
  return { push: (line) => state.push(line), progress: () => state.progress(run), outcome: () => state.outcome() }
}

export const evalsRunFolder = async (record: string): Promise<string | undefined> => {
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

export const hasEvalsRunResult = async (record: string): Promise<boolean> => {
  const folder = await evalsRunFolder(record)
  return folder !== undefined && existsSync(join(folder, RESULT))
}

export const tailEvalsRun = (record: string, onLine: (line: string) => void): EvalsTail => {
  let tail: EvalsTail | undefined
  let stopped = false
  const found = (async (): Promise<void> => {
    while (!stopped) {
      const folder = await evalsRunFolder(record).catch(() => undefined)
      if (folder) {
        tail = tailEvalsLines(join(folder, EVENTS), onLine)
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
  const folder = await evalsRunFolder(record)
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

export const readEvalsStudy = async (record: string): Promise<EvalsStudyOutcome> =>
  (await readRunState(record)).outcome()

export const readEvalsProposerFailure = async (record: string): Promise<string | undefined> =>
  (await readRunState(record)).proposerFailure()

interface EvalsRunUsage {
  readonly rollouts: number
  readonly tokens: number
  readonly seconds: number
}

export interface EvalsUsageProfile {
  readonly experiment: string
  readonly runs: readonly EvalsRunUsage[]
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

const runUsage = (events: readonly Event[]): EvalsRunUsage | undefined => {
  const rollouts = events.filter(({ event, record }) => event === 'trial' && isRecord(record)).length
  const times = events.flatMap(eventTime)
  if (rollouts === 0 || times.length < 2) return undefined
  return {
    rollouts,
    tokens: events.reduce((sum, event) => sum + eventTokens(event), 0),
    seconds: (times.at(-1)! - times[0]!) / MILLISECONDS_PER_SECOND,
  }
}

const readRunUsage = async (record: string): Promise<EvalsRunUsage | undefined> => {
  const folder = await evalsRunFolder(record).catch(() => undefined)
  if (!folder) return undefined
  const lines = (await readFile(join(folder, EVENTS), 'utf8').catch(() => '')).split(LINE_BREAK)
  return runUsage(lines.map(parseEvent).filter((event) => event !== undefined))
}

export const readEvalsUsageProfile = async (
  workspaceDirectory: string,
  experiment: string
): Promise<EvalsUsageProfile | undefined> => {
  const records = (await listEvalsOptimizations(workspaceDirectory).catch(() => []))
    .map(({ home, name, stamp }) => ({ record: evalsOptimizationFiles(home, stamp).record, experiment: name }))
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
