import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { isRecord } from '../../../values.js'
import type { OptimizeDecision, OptimizeObjective } from '../model.js'
import { stopEvalsProcessGroup } from './evals-process.js'
import {
  listEvalsOptimizations,
  listEvaluationRuns,
  evalsOptimizationFiles,
  evalsOptimizationOf,
  evaluationRunFiles,
  evaluationRunOf,
} from '../layout.js'
import { EVALS_DECISION_CHOICES, type EvalsSplitShares } from '../tuning/plan.js'

const runCommand = promisify(execFile)
const RECORD_VERSION = 1
const POLL_MS = 1000
const REPLACE_ATTEMPTS = 6
const REPLACE_WAIT_MS = 20
const HELD_OPEN: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface EvaluationRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly cases: string
  readonly only?: readonly string[]
  readonly report: string
  readonly log: string
  readonly store: string
  readonly startedAt: number
  readonly pid?: number
}

export interface EvalsOptimizeRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly record: string
  readonly space: string
  readonly iterations: number
  readonly width?: number
  readonly repetitions?: number
  readonly workers?: number
  readonly split?: EvalsSplitShares
  readonly objective?: OptimizeObjective
  readonly decision?: OptimizeDecision
  readonly startedAt: number
  readonly pid?: number
  /** The run is over and an edit of it waits for the developer's answer, so the record outlives the run. */
  readonly awaitsReview?: boolean
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const evaluationRecordPath = ({ report }: EvaluationRecord): string => evaluationRunOf(report).record

const optimizeRecordPath = ({ record }: Pick<EvalsOptimizeRecord, 'record'>): string =>
  evalsOptimizationOf(record).resume

const isEvaluationRecord = (value: unknown): value is EvaluationRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'cases', 'report', 'log', 'store'].every((key) => typeof value[key] === 'string') &&
  (value.only === undefined || (Array.isArray(value.only) && value.only.every((name) => typeof name === 'string'))) &&
  typeof value.startedAt === 'number' &&
  (value.pid === undefined || Number.isInteger(value.pid))

const recordedObjective = (value: unknown): OptimizeObjective | undefined => {
  if (!isRecord(value)) return undefined
  const constraints = value.constraints ?? value.limits
  if (typeof value.expression === 'string' && typeof constraints === 'string')
    return { expression: value.expression, constraints }
  if (value.kind === 'evaluator' && typeof value.evaluator === 'string')
    return { expression: `Maximize(${JSON.stringify(value.evaluator)})`, constraints: '' }
  if (value.kind === 'evaluators' && Array.isArray(value.evaluators)) return { expression: '', constraints: '' }
  return undefined
}

const isDecision = (value: unknown): value is OptimizeDecision =>
  isRecord(value) &&
  typeof value.feasibility === 'number' &&
  value.feasibility > 0 &&
  value.feasibility < 1 &&
  EVALS_DECISION_CHOICES.crashScore.some((score) => score === value.crashScore) &&
  EVALS_DECISION_CHOICES.pickRule.some((rule) => rule === value.pickRule) &&
  Number.isInteger(value.finalists) &&
  Number(value.finalists) >= 1

const isOptimizeRecord = (value: unknown): value is EvalsOptimizeRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'record', 'space'].every((key) => typeof value[key] === 'string') &&
  Number.isInteger(value.iterations) &&
  ['width', 'repetitions', 'workers'].every((key) => value[key] === undefined || Number.isInteger(value[key])) &&
  (value.split === undefined ||
    (Array.isArray(value.split) &&
      value.split.length === 3 &&
      value.split.every((share) => typeof share === 'number'))) &&
  (value.objective === undefined || recordedObjective(value.objective) !== undefined) &&
  (value.decision === undefined || isDecision(value.decision)) &&
  typeof value.startedAt === 'number' &&
  (value.pid === undefined || Number.isInteger(value.pid)) &&
  (value.awaitsReview === undefined || typeof value.awaitsReview === 'boolean')

/** Windows refuses to rename over a file held open, so the rename waits and tries again before it gives up. */
const replaceFile = async (staging: string, path: string): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(staging, path)
    } catch (error) {
      if (attempt >= REPLACE_ATTEMPTS || !isRecord(error) || !HELD_OPEN.has(error.code)) throw error
      await sleep(REPLACE_WAIT_MS * 2 ** attempt)
    }
  }
}

const writeEvalsRecord = async (path: string, record: object): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`)
  try {
    await replaceFile(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

export const saveEvalsRunRecord = (record: EvaluationRecord): Promise<void> =>
  writeEvalsRecord(evaluationRecordPath(record), record)

export const dropEvalsRunRecord = (record: EvaluationRecord): Promise<void> =>
  rm(evaluationRecordPath(record), { force: true })

export const saveEvalsOptimizeRecord = (record: EvalsOptimizeRecord): Promise<void> =>
  writeEvalsRecord(optimizeRecordPath(record), record)

export const dropEvalsOptimizeRecord = (record: Pick<EvalsOptimizeRecord, 'record'>): Promise<void> =>
  rm(optimizeRecordPath(record), { force: true })

const readRecord = async <Kind>(path: string, isKind: (value: unknown) => value is Kind): Promise<Kind[]> => {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || missing(error)) return []
    throw error
  }
  return isKind(value) ? [value] : []
}

export const readEvalsRunRecords = async (workspaceDirectory: string): Promise<EvaluationRecord[]> => {
  const runs = await listEvaluationRuns(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(evaluationRunFiles(home, stamp).record, isEvaluationRecord))
  )
  return records.flat()
}

export const readEvalsOptimizeRecords = async (workspaceDirectory: string): Promise<EvalsOptimizeRecord[]> => {
  const runs = await listEvalsOptimizations(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(evalsOptimizationFiles(home, stamp).resume, isOptimizeRecord))
  )
  return records
    .flat()
    .map(({ objective: saved, ...rest }) => {
      const objective = recordedObjective(saved)
      return objective ? { ...rest, objective } : rest
    })
    .sort((left, right) => left.startedAt - right.startedAt)
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const isEvalsProcessAlive = async (pid: number | undefined, marker: string): Promise<boolean> => {
  if (pid === undefined || process.platform === 'win32' || !processExists(pid)) return false
  const listed = await runCommand('ps', ['-ww', '-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return listed.stdout.includes(marker)
}

export const isEvalsRunAlive = ({ pid, report }: EvaluationRecord): Promise<boolean> => isEvalsProcessAlive(pid, report)

export const isEvalsOptimizeAlive = ({ pid, record }: EvalsOptimizeRecord): Promise<boolean> =>
  isEvalsProcessAlive(pid, record)

const waitForProcess = async (pid: number | undefined, marker: string, signal?: AbortSignal): Promise<void> => {
  const stop = async (): Promise<void> => {
    if (pid !== undefined && (await isEvalsProcessAlive(pid, marker))) stopEvalsProcessGroup(pid)
  }
  const onAbort = (): void => void stop()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (await isEvalsProcessAlive(pid, marker)) await sleep(POLL_MS, undefined, { ref: false })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export const waitForEvalsRun = ({ pid, report }: EvaluationRecord, signal?: AbortSignal): Promise<void> =>
  waitForProcess(pid, report, signal)

export const waitForEvalsOptimize = ({ pid, record }: EvalsOptimizeRecord, signal?: AbortSignal): Promise<void> =>
  waitForProcess(pid, record, signal)

const readable = async (path: string): Promise<boolean> => {
  try {
    JSON.parse(await readFile(path, 'utf8'))
    return true
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
}

export const clearUnreadableCaseResults = async (store: string): Promise<void> => {
  let names: string[]
  try {
    names = await readdir(store)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const path = join(store, name)
        if (!(await readable(path))) await rm(path, { force: true })
      })
  )
}
