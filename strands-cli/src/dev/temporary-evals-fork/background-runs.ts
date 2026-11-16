import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { isRecord } from '../../values.js'
import { stopTemporaryProcessGroup } from './evals-process.js'

const runCommand = promisify(execFile)
const RECORD_VERSION = 1
const RUNS_FOLDER = 'running'
const POLL_MS = 1000

export interface TemporaryTestRecord {
  readonly version: typeof RECORD_VERSION
  readonly experiment: string
  readonly cases: string
  readonly rerun: boolean
  readonly report: string
  readonly log: string
  readonly store: string
  readonly startedAt: number
  readonly pid?: number
}

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const recordPath = ({ report }: TemporaryTestRecord): string => join(dirname(report), RUNS_FOLDER, basename(report))

const isTestRecord = (value: unknown): value is TemporaryTestRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'cases', 'report', 'log', 'store'].every((key) => typeof value[key] === 'string') &&
  typeof value.rerun === 'boolean' &&
  typeof value.startedAt === 'number' &&
  (value.pid === undefined || Number.isInteger(value.pid))

export const saveTemporaryRunRecord = async (record: TemporaryTestRecord): Promise<void> => {
  const path = recordPath(record)
  await mkdir(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.tmp`
  await writeFile(staging, `${JSON.stringify(record, null, 2)}\n`)
  await rename(staging, path)
}

export const dropTemporaryRunRecord = (record: TemporaryTestRecord): Promise<void> =>
  rm(recordPath(record), { force: true })

const readRecord = async (path: string): Promise<TemporaryTestRecord | undefined> => {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || missing(error)) return undefined
    throw error
  }
  return isTestRecord(value) ? value : undefined
}

export const readTemporaryRunRecords = async (reportsFolder: string): Promise<TemporaryTestRecord[]> => {
  const folder = join(reportsFolder, RUNS_FOLDER)
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
  return records.filter((record): record is TemporaryTestRecord => record !== undefined)
}

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const isTemporaryRunAlive = async ({ pid, report }: TemporaryTestRecord): Promise<boolean> => {
  if (pid === undefined || process.platform === 'win32' || !processExists(pid)) return false
  const listed = await runCommand('ps', ['-ww', '-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return listed.stdout.includes(report)
}

export const stopTemporaryRun = async (record: TemporaryTestRecord): Promise<void> => {
  if (record.pid !== undefined && (await isTemporaryRunAlive(record))) stopTemporaryProcessGroup(record.pid)
}

export const waitForTemporaryRun = async (record: TemporaryTestRecord, signal?: AbortSignal): Promise<void> => {
  const stop = (): void => void stopTemporaryRun(record)
  signal?.addEventListener('abort', stop, { once: true })
  try {
    while (await isTemporaryRunAlive(record)) await sleep(POLL_MS, undefined, { ref: false })
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

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
