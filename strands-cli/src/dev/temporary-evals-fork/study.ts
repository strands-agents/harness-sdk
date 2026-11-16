import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../../values.js'
import type { CandidateResult, OptimizeProgress } from '../panels/model.js'
import { tailTemporaryLines, type TemporaryTail } from './jobs.js'

export type TemporaryStudyParams = Readonly<Record<string, unknown>>

export type TemporaryStudyEnd = 'finished' | 'stopped' | 'running'

export type TemporaryMeasurement = 'search' | 'validation' | 'test'

export interface TemporaryTestDifference {
  readonly difference: number
  readonly ci?: readonly [number, number]
  readonly cases: number
}

export interface TemporaryStudyBaseline {
  readonly params: TemporaryStudyParams
  readonly score?: number
}

export interface TemporaryStudyBest extends TemporaryStudyBaseline {
  readonly number: number
}

export interface TemporaryStudyOutcome {
  readonly metric: string
  readonly ended: TemporaryStudyEnd
  readonly error?: string
  readonly measuredOn: TemporaryMeasurement
  readonly baseline: TemporaryStudyBaseline
  readonly best?: TemporaryStudyBest
  readonly test?: TemporaryTestDifference
}

export interface TemporaryStudyRun {
  readonly run: string
  readonly record: string
  readonly startedAt: number
  readonly labels?: Readonly<Record<string, string>>
}

export interface TemporaryStudyReader {
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
const FAILED_STOPS = new Set(['setup', 'proposer_error'])
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
  constructor(private readonly labels: Readonly<Record<string, string>> = {}) {}

  private metric = ''
  private textKeys: ReadonlySet<string> = new Set()
  private width = 0
  private iterations = 0
  private baselineId: string | undefined
  private bestAfter: readonly string[] = []
  private champion: string | undefined
  private stopReason: string | undefined
  private stopMessage: string | undefined
  private test: TestReport | undefined
  private readonly candidates = new Map<string, Candidate>()
  private readonly scores = new Map<string, Map<Split, number>>()
  private readonly failures = new Map<string, string>()
  private readonly completed = new Map<string, number>()

  private readonly handlers = new Map<string, (event: Event) => void>([
    ['config', (event): void => this.readConfig(event)],
    ['propose', (event): void => this.readPropose(event)],
    ['trial', (event): void => this.readTrial(event)],
    ['score', (event): void => this.readScore(event)],
    ['iteration_end', (event): void => this.readIterationEnd(event)],
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

  progress({ run, record, startedAt }: TemporaryStudyRun): OptimizeProgress {
    const baseline = this.score(this.baselineId, 'train')
    const leader = this.bestAfter[0]
    const best = this.score(leader, 'train')
    const leading = leader === undefined ? undefined : this.candidates.get(leader)
    return {
      run,
      record,
      metric: this.metric,
      iterations: this.iterations,
      planned: 1 + this.iterations * this.width,
      ...(baseline === undefined ? {} : { baseline }),
      ...(leading && best !== undefined ? { best: { number: leading.number, score: best } } : {}),
      candidates: [...this.candidates.values()]
        .filter(({ id }) => id !== this.baselineId && this.scores.get(id)?.has('train'))
        .map((candidate) => this.candidateResult(candidate, baseline)),
      startedAt,
      stopping: false,
    }
  }

  outcome(): TemporaryStudyOutcome {
    const bestId = this.champion ?? this.bestAfter[0]
    const split = this.measuredSplit(bestId)
    const best = bestId === undefined ? undefined : this.candidates.get(bestId)
    const bestScore = this.score(bestId, split)
    const baselineScore = this.score(this.baselineId, split)
    const failed = this.stopReason !== undefined && FAILED_STOPS.has(this.stopReason)
    const test = this.testDifference()
    return {
      metric: this.metric,
      ended: failed ? 'stopped' : this.champion !== undefined ? 'finished' : 'running',
      ...(failed && this.stopMessage ? { error: this.stopMessage } : {}),
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
    this.metric = (objective ? OBJECTIVE.exec(objective)?.[1] : undefined) ?? objective ?? ''
    this.textKeys = new Set(
      (Array.isArray(config.space) ? config.space : [])
        .filter(isRecord)
        .flatMap(({ key, kind }) => (kind === 'text' && typeof key === 'string' ? [key] : []))
    )
    this.width = finite(config.proposals_per_iteration) ?? this.width
    this.iterations = (isRecord(config.budget) ? finite(config.budget.max_iterations) : undefined) ?? this.iterations
  }

  private readPropose(event: Event): void {
    const id = text(event.candidate_id)
    const number = finite(event.number)
    if (id === undefined || number === undefined) return
    if (texts(event.origin).includes('baseline')) this.baselineId = id
    this.candidates.set(id, {
      id,
      number,
      iteration: finite(event.iteration) ?? 0,
      values: isRecord(event.values) ? event.values : {},
      changed: texts(event.changed_keys),
    })
  }

  private readTrial({ record }: Event): void {
    if (!isRecord(record)) return
    const id = text(record.candidate_id)
    if (id === undefined || record.status === 'completed' || this.failures.has(id)) return
    const reason = text(record.error) ?? text(record.error_type) ?? text(record.status)
    if (reason) this.failures.set(id, reason)
  }

  private readScore({ candidate_id, split, objective_by_run, statuses }: Event): void {
    const id = text(candidate_id)
    if (id === undefined || (split !== 'train' && split !== 'validation' && split !== 'test')) return
    const value = objectiveMean(objective_by_run)
    const byId = this.scores.get(id) ?? new Map<Split, number>()
    if (value !== undefined) byId.set(split, value)
    this.scores.set(id, byId)
    if (split === 'train') this.completed.set(id, isRecord(statuses) ? (finite(statuses.completed) ?? 0) : 0)
  }

  private readIterationEnd({ best_after }: Event): void {
    this.bestAfter = texts(best_after)
  }

  private readStop({ reason, message }: Event): void {
    this.stopReason = text(reason)
    this.stopMessage = text(message)
  }

  private readPicked(report: unknown): void {
    if (isRecord(report)) this.champion = text(report.champion_id) ?? this.champion
  }

  private readTest(report: unknown): void {
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
    return { difference, cases, ...(ci ? { ci } : {}) }
  }

  private candidateResult(candidate: Candidate, baselineScore: number | undefined): CandidateResult {
    const baseline = (this.baselineId === undefined ? undefined : this.candidates.get(this.baselineId)?.values) ?? {}
    const score = this.score(candidate.id, 'train')
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
    }
  }
}

export const temporaryStudyReader = (run: TemporaryStudyRun): TemporaryStudyReader => {
  const state = new RunState(run.labels)
  return { push: (line) => state.push(line), progress: () => state.progress(run), outcome: () => state.outcome() }
}

const runFolder = async (record: string): Promise<string | undefined> => {
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

export const tailTemporaryRun = (record: string, onLine: (line: string) => void): TemporaryTail => {
  let tail: TemporaryTail | undefined
  let stopped = false
  const found = (async (): Promise<void> => {
    while (!stopped) {
      const folder = await runFolder(record).catch(() => undefined)
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

export const readTemporaryStudy = async (record: string): Promise<TemporaryStudyOutcome> => {
  const folder = await runFolder(record)
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
  return state.outcome()
}
