import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { isRecord } from '../../values.js'
import { stopTemporaryProcessGroup } from './evals-process.js'
import { listTemporaryTestRuns, temporaryTestRunFiles, temporaryTestRunOf } from './layout.js'

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

const missing = (error: unknown): boolean => isRecord(error) && error.code === 'ENOENT'

const recordPath = ({ report }: TemporaryTestRecord): string => temporaryTestRunOf(report).record

const isTestRecord = (value: unknown): value is TemporaryTestRecord =>
  isRecord(value) &&
  value.version === RECORD_VERSION &&
  ['experiment', 'cases', 'report', 'log', 'store'].every((key) => typeof value[key] === 'string') &&
  typeof value.rerun === 'boolean' &&
  (value.only === undefined || (Array.isArray(value.only) && value.only.every((name) => typeof name === 'string'))) &&
  typeof value.startedAt === 'number' &&
  (value.pid === undefined || Number.isInteger(value.pid))

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

export const writeTemporaryRecord = async (path: string, record: object): Promise<void> => {
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
  writeTemporaryRecord(recordPath(record), record)

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

export const readTemporaryRunRecords = async (workspaceDirectory: string): Promise<TemporaryTestRecord[]> => {
  const runs = await listTemporaryTestRuns(workspaceDirectory)
  const records = await Promise.all(
    runs.map(({ home, stamp }) => readRecord(temporaryTestRunFiles(home, stamp).record))
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

export const isTemporaryProcessAlive = async (pid: number | undefined, marker: string): Promise<boolean> => {
  if (pid === undefined || process.platform === 'win32' || !processExists(pid)) return false
  const listed = await runCommand('ps', ['-ww', '-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  return listed.stdout.includes(marker)
}

export const isTemporaryRunAlive = ({ pid, report }: TemporaryTestRecord): Promise<boolean> =>
  isTemporaryProcessAlive(pid, report)

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
