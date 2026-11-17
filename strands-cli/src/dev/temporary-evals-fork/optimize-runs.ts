import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { OptimizeObjective } from '../panels/model.js'
import { isRecord } from '../../values.js'
import { isTemporaryProcessAlive } from './background-runs.js'
import { stopTemporaryProcessGroup } from './evals-process.js'
import { listTemporaryOptimizations, temporaryOptimizationFiles, temporaryOptimizationOf } from './layout.js'
import type { TemporarySplitShares } from './plan.js'

const RECORD_VERSION = 1
const POLL_MS = 1000

export interface TemporaryOptimizeRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly record: string
  readonly space: string
  readonly iterations: number
  readonly split?: TemporarySplitShares
  readonly objective?: OptimizeObjective
  readonly startedAt: number
  readonly pid?: number
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const recordPath = ({ record }: Pick<TemporaryOptimizeRecord, 'record'>): string =>
  temporaryOptimizationOf(record).resume

const recordedObjective = (value: unknown): OptimizeObjective | undefined => {
  if (!isRecord(value)) return undefined
  if (typeof value.expression === 'string' && typeof value.limits === 'string')
    return { expression: value.expression, limits: value.limits }
  if (value.kind === 'evaluator' && typeof value.evaluator === 'string')
    return { expression: `Maximize(${JSON.stringify(value.evaluator)})`, limits: '' }
  if (value.kind === 'evaluators' && Array.isArray(value.evaluators)) return { expression: '', limits: '' }
  return undefined
}

const isOptimizeRecord = (value: unknown): value is TemporaryOptimizeRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'record', 'space'].every((key) => typeof value[key] === 'string') &&
  Number.isInteger(value.iterations) &&
  (value.split === undefined ||
    (Array.isArray(value.split) &&
      value.split.length === 3 &&
      value.split.every((share) => typeof share === 'number'))) &&
  (value.objective === undefined || recordedObjective(value.objective) !== undefined) &&
  typeof value.startedAt === 'number' &&
  (value.pid === undefined || Number.isInteger(value.pid))

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
