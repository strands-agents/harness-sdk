import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { isRecord } from '../../values.js'
import type { OptimizeDecision, OptimizeObjective } from '../panels/model.js'
import { stopTemporaryProcessGroup } from './evals-process.js'
import {
  listTemporaryOptimizations,
  listTemporaryTestRuns,
  temporaryOptimizationFiles,
  temporaryOptimizationOf,
  temporaryTestRunFiles,
  temporaryTestRunOf,
} from './layout.js'
import { TEMPORARY_DECISION_CHOICES, type TemporarySplitShares } from './plan.js'

const runCommand = promisify(execFile)
const RECORD_VERSION = 1
const POLL_MS = 1000
const REPLACE_ATTEMPTS = 6
const REPLACE_WAIT_MS = 20
const HELD_OPEN: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface TemporaryTestRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly cases: string
  readonly rerun: boolean
  readonly only?: readonly string[]
  readonly report: string
  readonly log: string
  readonly store: string
  readonly startedAt: number
  readonly pid?: number
}

export interface TemporaryOptimizeRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly record: string
  readonly space: string
  readonly iterations: number
  readonly width?: number
  readonly repetitions?: number
  readonly workers?: number
  readonly split?: TemporarySplitShares
  readonly objective?: OptimizeObjective
  readonly decision?: OptimizeDecision
  readonly startedAt: number
  readonly pid?: number
  /** The run is over and an edit of it waits for the developer's answer, so the record outlives the run. */
  readonly awaitsReview?: boolean
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const testRecordPath = ({ report }: TemporaryTestRecord): string => temporaryTestRunOf(report).record

const optimizeRecordPath = ({ record }: Pick<TemporaryOptimizeRecord, 'record'>): string =>
  temporaryOptimizationOf(record).resume

const isTestRecord = (value: unknown): value is TemporaryTestRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'cases', 'report', 'log', 'store'].every((key) => typeof value[key] === 'string') &&
  typeof value.rerun === 'boolean' &&
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
  TEMPORARY_DECISION_CHOICES.crashScore.some((score) => score === value.crashScore) &&
  TEMPORARY_DECISION_CHOICES.pickRule.some((rule) => rule === value.pickRule) &&
  Number.isInteger(value.finalists) &&
  Number(value.finalists) >= 1

const isOptimizeRecord = (value: unknown): value is TemporaryOptimizeRecord =>
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

const writeTemporaryRecord = async (path: string, record: object): Promise<void> => {
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

export const saveTemporaryRunRecord = (record: TemporaryTestRecord): Promise<void> =>
  writeTemporaryRecord(testRecordPath(record), record)

export const dropTemporaryRunRecord = (record: TemporaryTestRecord): Promise<void> =>
  rm(testRecordPath(record), { force: true })

export const saveTemporaryOptimizeRecord = (record: TemporaryOptimizeRecord): Promise<void> =>
  writeTemporaryRecord(optimizeRecordPath(record), record)

export const dropTemporaryOptimizeRecord = (record: Pick<TemporaryOptimizeRecord, 'record'>): Promise<void> =>
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

export const readTemporaryRunRecords = async (workspaceDirectory: string): Promise<TemporaryTestRecord[]> => {
  const runs = await listTemporaryTestRuns(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(temporaryTestRunFiles(home, stamp).record, isTestRecord))
  )
  return records.flat()
}

export const readTemporaryOptimizeRecords = async (workspaceDirectory: string): Promise<TemporaryOptimizeRecord[]> => {
  const runs = await listTemporaryOptimizations(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(temporaryOptimizationFiles(home, stamp).resume, isOptimizeRecord))
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

export const isTemporaryProcessAlive = async (pid: number | undefined, marker: string): Promise<boolean> => {
  if (pid === undefined || process.platform === 'win32' || !processExists(pid)) return false
  const listed = await runCommand('ps', ['-ww', '-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return listed.stdout.includes(marker)
}

export const isTemporaryRunAlive = ({ pid, report }: TemporaryTestRecord): Promise<boolean> =>
  isTemporaryProcessAlive(pid, report)

export const isTemporaryOptimizeAlive = ({ pid, record }: TemporaryOptimizeRecord): Promise<boolean> =>
  isTemporaryProcessAlive(pid, record)

const waitForProcess = async (pid: number | undefined, marker: string, signal?: AbortSignal): Promise<void> => {
  const stop = async (): Promise<void> => {
    if (pid !== undefined && (await isTemporaryProcessAlive(pid, marker))) stopTemporaryProcessGroup(pid)
  }
  const onAbort = (): void => void stop()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (await isTemporaryProcessAlive(pid, marker)) await sleep(POLL_MS, undefined, { ref: false })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

export const waitForTemporaryRun = ({ pid, report }: TemporaryTestRecord, signal?: AbortSignal): Promise<void> =>
  waitForProcess(pid, report, signal)

export const waitForTemporaryOptimize = (
  { pid, record }: TemporaryOptimizeRecord,
  signal?: AbortSignal
): Promise<void> => waitForProcess(pid, record, signal)

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
