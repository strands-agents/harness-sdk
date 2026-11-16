import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { isRecord } from '../../values.js'
import { isTemporaryProcessAlive } from './background-runs.js'
import { stopTemporaryProcessGroup } from './evals-process.js'

const RECORD_VERSION = 1
const RUNS_FOLDER = 'running'
const POLL_MS = 1000

export interface TemporaryOptimizeRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly record: string
  readonly space: string
  readonly iterations: number
  readonly startedAt: number
  readonly pid?: number
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const recordPath = ({ record }: Pick<TemporaryOptimizeRecord, 'record'>): string =>
  join(dirname(record), RUNS_FOLDER, `${basename(record)}.json`)

const isOptimizeRecord = (value: unknown): value is TemporaryOptimizeRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'record', 'space'].every((key) => typeof value[key] === 'string') &&
  Number.isInteger(value.iterations) &&
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
  return isOptimizeRecord(value) ? value : undefined
}

export const readTemporaryOptimizeRecords = async (optimizationFolder: string): Promise<TemporaryOptimizeRecord[]> => {
  const folder = join(optimizationFolder, RUNS_FOLDER)
  let names: string[]
  try {
    names = await readdir(folder)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const records = await Promise.all(
    names.filter((name) => name.endsWith('.json')).map((name) => readRecord(join(folder, name)))
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
