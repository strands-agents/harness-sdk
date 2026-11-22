import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { OptimizeDecision, OptimizeObjective } from '../panels/model.js'
import { isRecord } from '../../values.js'
import { isTemporaryProcessAlive } from './background-runs.js'
import { stopTemporaryProcessGroup } from './evals-process.js'
import { listTemporaryOptimizations, temporaryOptimizationFiles, temporaryOptimizationOf } from './layout.js'
import { TEMPORARY_DECISION_CHOICES, type TemporarySplitShares } from './plan.js'

const RECORD_VERSION = 1
const POLL_MS = 1000

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

const recordPath = ({ record }: Pick<TemporaryOptimizeRecord, 'record'>): string =>
  temporaryOptimizationOf(record).resume

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

export const saveTemporaryOptimizeRecord = async (record: TemporaryOptimizeRecord): Promise<void> => {
  const path = recordPath(record)
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`)
  await rename(staging, path)
}

export const dropTemporaryOptimizeRecord = (record: Pick<TemporaryOptimizeRecord, 'record'>): Promise<void> =>
  rm(recordPath(record), { force: true })

const readRecord = async (path: string): Promise<TemporaryOptimizeRecord | undefined> => {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || missing(error)) return undefined
    throw error
  }
  if (!isOptimizeRecord(value)) return undefined
  const objective = recordedObjective(value.objective)
  const { objective: _saved, ...rest } = value
  return objective ? { ...rest, objective } : rest
}

export const readTemporaryOptimizeRecords = async (workspaceDirectory: string): Promise<TemporaryOptimizeRecord[]> => {
  const runs = await listTemporaryOptimizations(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(temporaryOptimizationFiles(home, stamp).resume))
  )
  return records
    .filter((record): record is TemporaryOptimizeRecord => record !== undefined)
    .sort((left, right) => left.startedAt - right.startedAt)
}

export const isTemporaryOptimizeAlive = ({ pid, record }: TemporaryOptimizeRecord): Promise<boolean> =>
  isTemporaryProcessAlive(pid, record)

export const stopTemporaryOptimize = async (record: TemporaryOptimizeRecord): Promise<void> => {
  if (record.pid !== undefined && (await isTemporaryOptimizeAlive(record))) stopTemporaryProcessGroup(record.pid)
}

export const waitForTemporaryOptimize = async (
  record: TemporaryOptimizeRecord,
  signal?: AbortSignal
): Promise<void> => {
  const stop = (): void => void stopTemporaryOptimize(record)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (await isTemporaryOptimizeAlive(record)) await sleep(POLL_MS, undefined, { ref: false })
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}
