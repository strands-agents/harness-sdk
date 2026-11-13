import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isRecord } from '../../values.js'
import type { CandidateResult, OptimizeProgress } from '../panels/model.js'

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
}

export interface TemporaryStudyReader {
  push(line: string): void
  progress(): OptimizeProgress
  outcome(): TemporaryStudyOutcome
}

type Event = Record<string, unknown>

type Interval = readonly [number, number]

interface Estimate {
  readonly mean: number | undefined
  readonly ci: Interval | undefined
}

type Estimates = ReadonlyMap<string, Estimate>

interface Difference extends Estimate {
  readonly cases: number | undefined
}

interface TestArm {
  readonly means: Estimates
  readonly difference: ReadonlyMap<string, Difference>
}

interface Objective {
  readonly metric: string
  readonly weight: number
}

interface CandidateRecord {
  readonly number: number
  readonly step: number | undefined
  readonly params: TemporaryStudyParams
  readonly failure: string | undefined
  readonly bestAfter: readonly number[]
  readonly estimates: Estimates
}

interface Measured {
  readonly on: TemporaryMeasurement
  readonly baseline: Estimates | undefined
  readonly best: Estimates | undefined
}

const SUMMARY_LIMIT = 80
const FAILED_STATUSES = new Set(['failed', 'invalid'])
const NO_VALUE = 'no trial had a value for every goal metric'
const LINE_BREAK = /\r?\n/u

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : []

const interval = (value: unknown): Interval | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [low, high] = value.map(finite)
  return low === undefined || high === undefined ? undefined : [low, high]
}

const records = (value: unknown): [string, Event][] =>
  isRecord(value) ? Object.entries(value).filter((entry): entry is [string, Event] => isRecord(entry[1])) : []

const parseEstimates = (value: unknown): Estimates =>
  new Map(records(value).map(([metric, { mean, ci }]) => [metric, { mean: finite(mean), ci: interval(ci) }]))

const parseArm = ({ means, difference }: Event): TestArm => ({
  means: new Map(
    Object.entries(isRecord(means) ? means : {}).map(([metric, mean]) => [
      metric,
      { mean: finite(mean), ci: undefined },
    ])
  ),
  difference: new Map(
    records(difference).map(([metric, { mean, ci90, cases }]) => [
      metric,
      { mean: finite(mean), ci: interval(ci90), cases: finite(cases) },
    ])
  ),
})

const parseObjectives = (value: unknown): Objective[] =>
  (Array.isArray(value) ? value : []).filter(isRecord).flatMap(({ metric, weight }) => {
    const name = text(metric)
    return name === undefined ? [] : [{ metric: name, weight: finite(weight) ?? 1 }]
  })

const parseTextKeys = (space: unknown): Set<string> =>
  new Set(
    (Array.isArray(space) ? space : [])
      .filter(isRecord)
      .flatMap(({ key, type }) => (type === 'text' && typeof key === 'string' ? [key] : []))
  )

const firstTrialError = (trials: unknown): string | undefined =>
  (Array.isArray(trials) ? trials : [])
    .filter(isRecord)
    .map(({ error }) => text(error))
    .find(Boolean)

const failureOf = ({ status, reason, trials }: Event): string | undefined =>
  typeof status === 'string' && FAILED_STATUSES.has(status)
    ? (text(reason) ?? firstTrialError(trials) ?? NO_VALUE)
    : undefined

const parseEvent = (line: string): Event | undefined => {
  if (!line.trim()) return undefined
  try {
    const event: unknown = JSON.parse(line)
    return isRecord(event) && typeof event.type === 'string' ? event : undefined
  } catch {
    return undefined
  }
}

const clip = (value: string): string => {
  const characters = Array.from(value)
  return characters.length > SUMMARY_LIMIT ? `${characters.slice(0, SUMMARY_LIMIT - 1).join('')}…` : value
}

const scored = (score: number | undefined): { score?: number } => (score === undefined ? {} : { score })

const shown = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)))

const changedKeys = (params: TemporaryStudyParams, baseline: TemporaryStudyParams): string[] =>
  [...new Set([...Object.keys(params), ...Object.keys(baseline)])].filter(
    (key) => JSON.stringify(params[key]) !== JSON.stringify(baseline[key])
  )

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
    : `${key} → ${clip(shown(value))}`

class StudyState {
  private objectives: readonly Objective[] = []
  private textKeys: ReadonlySet<string> = new Set()
  private width = 0
  private iterations = 0
  private best: number | undefined
  private ended: TemporaryStudyEnd = 'running'
  private error: string | undefined
  private testBaseline: Estimates | undefined
  private testSelected: TestArm | undefined
  private readonly candidates = new Map<number, CandidateRecord>()
  private readonly validated = new Map<number, Estimates>()

  private readonly handlers = new Map<string, (event: Event) => void>([
    ['study', (event): void => this.readHeader(event)],
    ['run', (event): void => this.readRun(event)],
    ['candidate', (event): void => this.readCandidate(event)],
    ['remeasured', (event): void => this.readRemeasured(event)],
    ['validated', (event): void => this.readValidated(event)],
    ['selected', (event): void => this.readSelection(event)],
    ['finished', (event): void => this.readFinished(event)],
    ['stopped', (event): void => this.readStopped(event)],
    ['tested', (event): void => this.readTested(event)],
  ])

  push(line: string): void {
    const event = parseEvent(line)
    if (event) this.handlers.get(String(event.type))?.(event)
  }

  absorbResult({ runs, test }: Event): void {
    const [run]: unknown[] = Array.isArray(runs) ? runs : []
    if (isRecord(run) && Array.isArray(run.selected)) this.best = numbers(run.selected)[0]
    const measured = isRecord(test) ? test : isRecord(run) && isRecord(run.test) ? run.test : undefined
    if (measured) this.readTest(measured)
  }

  progress({ run, record, startedAt }: TemporaryStudyRun): OptimizeProgress {
    const baseline = this.score(this.candidates.get(0)?.estimates)
    const best = this.best === undefined ? undefined : this.score(this.candidates.get(this.best)?.estimates)
    return {
      run,
      record,
      metric: this.metric(),
      iterations: this.iterations,
      planned: 1 + this.iterations * this.width,
      ...(baseline === undefined ? {} : { baseline }),
      ...(this.best === undefined || best === undefined ? {} : { best: { number: this.best, score: best } }),
      candidates: [...this.candidates.values()]
        .filter(({ number }) => number !== 0)
        .map((candidate) => this.candidateResult(candidate, baseline)),
      startedAt,
      stopping: false,
    }
  }

  outcome(): TemporaryStudyOutcome {
    const measured = this.measured()
    const best = this.bestOutcome(measured.best)
    const test = this.testDifference()
    return {
      metric: this.metric(),
      ended: this.ended,
      ...(this.error === undefined ? {} : { error: this.error }),
      measuredOn: measured.on,
      baseline: { params: this.candidates.get(0)?.params ?? {}, ...scored(this.score(measured.baseline)) },
      ...(best === undefined ? {} : { best }),
      ...(test === undefined ? {} : { test }),
    }
  }

  private readHeader({ objectives, space, width }: Event): void {
    this.objectives = parseObjectives(objectives)
    this.textKeys = parseTextKeys(space)
    this.width = finite(width) ?? this.width
  }

  private readRun({ iterations }: Event): void {
    this.iterations = finite(iterations) ?? this.iterations
  }

  private readSelection({ best }: Event): void {
    this.best = numbers(best)[0]
  }

  private readFinished(event: Event): void {
    this.readSelection(event)
    this.ended = 'finished'
  }

  private readStopped({ error }: Event): void {
    this.ended = 'stopped'
    this.error = text(error)
  }

  private readCandidate(event: Event): void {
    const number = finite(event.number)
    if (number === undefined) return
    const bestAfter = numbers(event.best_after)
    this.candidates.set(number, {
      number,
      step: finite(event.step),
      params: isRecord(event.params) ? event.params : {},
      failure: failureOf(event),
      bestAfter,
      estimates: parseEstimates(event.estimates),
    })
    this.best = bestAfter[0]
  }

  private readRemeasured({ number, estimates }: Event): void {
    const key = finite(number)
    const known = key === undefined ? undefined : this.candidates.get(key)
    if (known) this.candidates.set(known.number, { ...known, estimates: parseEstimates(estimates) })
  }

  private readValidated({ number, estimates }: Event): void {
    const key = finite(number)
    if (key !== undefined) this.validated.set(key, parseEstimates(estimates))
  }

  private readTested(event: Event): void {
    if (event.role === 'baseline') this.testBaseline = parseArm(event).means
    else if ((event.role === 'selected' || event.role === 'fallback') && !this.testSelected)
      this.testSelected = parseArm(event)
  }

  private readTest({ baseline, selected }: Event): void {
    const [first]: unknown[] = Array.isArray(selected) ? selected : []
    if (isRecord(baseline)) this.testBaseline = parseArm(baseline).means
    if (isRecord(first)) this.testSelected = parseArm(first)
  }

  private metric(): string {
    return this.objectives.map(({ metric }) => metric).join(' + ')
  }

  private combine(value: (metric: string) => number | undefined): number | undefined {
    const [primary, ...others] = this.objectives
    if (!primary) return undefined
    if (others.length === 0) return value(primary.metric)
    const weighted = this.objectives.map(({ metric, weight }) => ({ value: value(metric), weight }))
    const total = weighted.reduce((sum, { weight }) => sum + weight, 0)
    if (total <= 0 || weighted.some(({ value }) => value === undefined)) return undefined
    return weighted.reduce((sum, { value, weight }) => sum + (value ?? 0) * weight, 0) / total
  }

  private score(estimates: Estimates | undefined): number | undefined {
    return this.combine((metric) => estimates?.get(metric)?.mean)
  }

  private interval(estimates: Estimates): Interval | undefined {
    const [primary, ...others] = this.objectives
    return primary && others.length === 0 ? estimates.get(primary.metric)?.ci : undefined
  }

  private measured(): Measured {
    if (this.testBaseline && this.testSelected)
      return { on: 'test', baseline: this.testBaseline, best: this.testSelected.means }
    const validatedBest = this.best === undefined ? undefined : this.validated.get(this.best)
    const validatedBaseline = this.validated.get(0)
    if (validatedBaseline && validatedBest)
      return { on: 'validation', baseline: validatedBaseline, best: validatedBest }
    return {
      on: 'search',
      baseline: this.candidates.get(0)?.estimates,
      best: this.best === undefined ? undefined : this.candidates.get(this.best)?.estimates,
    }
  }

  private bestOutcome(estimates: Estimates | undefined): TemporaryStudyBest | undefined {
    const params = this.best === undefined ? undefined : this.candidates.get(this.best)?.params
    if (this.best === undefined || params === undefined) return undefined
    return { number: this.best, params, ...scored(this.score(estimates)) }
  }

  private testDifference(): TemporaryTestDifference | undefined {
    const differences = this.testSelected?.difference
    const primary = this.objectives[0]
    if (!differences || !primary) return undefined
    const cases = differences.get(primary.metric)?.cases
    const difference = this.combine((metric) => differences.get(metric)?.mean)
    if (cases === undefined || difference === undefined) return undefined
    const ci = this.interval(differences)
    return { difference, cases, ...(ci === undefined ? {} : { ci }) }
  }

  private candidateResult(candidate: CandidateRecord, baselineScore: number | undefined): CandidateResult {
    const { number, step, params, failure, bestAfter, estimates } = candidate
    const baseline = this.candidates.get(0)?.params ?? {}
    const changed = changedKeys(params, baseline)
    const score = this.score(estimates)
    const ci = this.interval(estimates)
    const summary =
      changed.map((key) => describeChange(key, params[key], baseline[key], this.textKeys.has(key))).join('; ') ||
      'no change from the baseline'
    return {
      number,
      ...(step === undefined ? {} : { step }),
      changed,
      summary: failure ?? summary,
      ...(score === undefined ? {} : { score }),
      ...(ci === undefined ? {} : { ci }),
      ...(score === undefined || baselineScore === undefined ? {} : { delta: score - baselineScore }),
      kept: bestAfter.includes(number),
      ...(failure === undefined ? {} : { failed: failure }),
    }
  }
}

export const temporaryStudyReader = (run: TemporaryStudyRun): TemporaryStudyReader => {
  const state = new StudyState()
  return { push: (line) => state.push(line), progress: () => state.progress(run), outcome: () => state.outcome() }
}

const readStudyEvents = async (record: string): Promise<string> => {
  try {
    return await readFile(join(record, 'study.jsonl'), 'utf8')
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT')
      throw new Error(
        `${record} has no study.jsonl, so it is not an optimization record. Pick another record, or run the ` +
          'optimization again.',
        { cause: error }
      )
    throw error
  }
}

const readResult = async (record: string): Promise<unknown> => {
  let content: string
  try {
    content = await readFile(join(record, 'result.json'), 'utf8')
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
  const state = new StudyState()
  const events = await readStudyEvents(record)
  events.split('\n').forEach((line) => state.push(line))
  const result = await readResult(record)
  if (isRecord(result)) state.absorbResult(result)
  return state.outcome()
}
