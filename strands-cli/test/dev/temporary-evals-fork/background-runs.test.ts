import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  clearUnreadableCaseResults,
  dropTemporaryRunRecord,
  isTemporaryRunAlive,
  readTemporaryRunRecords,
  saveTemporaryRunRecord,
  waitForTemporaryRun,
  type TemporaryTestRecord,
} from '../../../src/dev/temporary-evals-fork/background-runs.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const recordIn = (reports: string, pid?: number): TemporaryTestRecord => ({
  version: 1,
  experiment: join(reports, '../experiments/capital.json'),
  cases: join(reports, '../experiments/capital.json'),
  rerun: false,
  report: join(reports, '20261116-090000-capital.json'),
  log: join(reports, '20261116-090000-capital.log'),
  store: join(reports, '20261116-090000-capital.cases'),
  startedAt: 1_763_283_600_000,
  ...(pid === undefined ? {} : { pid }),
})

const running = async (...args: string[]) => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', ...args], {
    stdio: 'ignore',
    detached: true,
  })
  await once(child, 'spawn')
  return child
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('TEMPORARY test run records', () => {
  it('shouldReadBackASavedRecordAndForgetItWhenItIsDropped', async () => {
    const reports = await temporaryDirectory()
    const record = recordIn(reports, 4242)

    await saveTemporaryRunRecord(record)
    const saved = await readTemporaryRunRecords(reports)
    await dropTemporaryRunRecord(record)

    expect(saved).toEqual([record])
    expect(await readTemporaryRunRecords(reports)).toEqual([])
  })

  it('shouldSkipRecordsThatAreNotWholeOrNotRunRecords', async () => {
    const reports = await temporaryDirectory()
    await mkdir(join(reports, 'running'))
    await writeFile(join(reports, 'running', 'cut.json'), '{"version": 1, "experi')
    await writeFile(join(reports, 'running', 'other.json'), '{"version": 2}')
    await saveTemporaryRunRecord(recordIn(reports))

    expect(await readTemporaryRunRecords(reports)).toEqual([recordIn(reports)])
  })

  it('shouldFindNoRecordsWhenNoRunWasEverRecorded', async () => {
    expect(await readTemporaryRunRecords(join(await temporaryDirectory(), 'reports'))).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('TEMPORARY test runs that outlive strands dev', () => {
  it('shouldTreatARunAsAliveOnlyWhileItsProcessStillWritesItsReport', async () => {
    const reports = await temporaryDirectory()
    const record = recordIn(reports)
    const child = await running(record.report)

    const live = await isTemporaryRunAlive({ ...record, pid: child.pid! })
    const reused = await isTemporaryRunAlive({ ...record, pid: child.pid!, report: join(reports, 'other.json') })
    child.kill()
    await once(child, 'exit')

    expect(live).toBe(true)
    expect(reused).toBe(false)
    expect(await isTemporaryRunAlive({ ...record, pid: child.pid! })).toBe(false)
    expect(await isTemporaryRunAlive(record)).toBe(false)
  })

  it('shouldStopTheRunAndReturnWhenItsProcessHasEnded', async () => {
    const reports = await temporaryDirectory()
    const record = recordIn(reports)
    const child = await running(record.report)
    const stop = new AbortController()

    const waiting = waitForTemporaryRun({ ...record, pid: child.pid! }, stop.signal)
    stop.abort()
    await waiting

    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false))
  })
})

describe('TEMPORARY case results before a resume', () => {
  it('shouldRemoveOnlyTheCaseResultsThatAreNotWholeJson', async () => {
    const store = join(await temporaryDirectory(), 'run.cases')
    await mkdir(store)
    await writeFile(join(store, 'done.json'), '{"output": "Paris"}')
    await writeFile(join(store, 'cut.json'), '{"outp')
    await writeFile(join(store, 'notes.txt'), 'keep')

    await clearUnreadableCaseResults(store)

    expect((await readdir(store)).sort()).toEqual(['done.json', 'notes.txt'])
  })

  it('shouldDoNothingWhenTheRunSavedNoCaseYet', async () => {
    const store = join(await temporaryDirectory(), 'run.cases')

    await clearUnreadableCaseResults(store)

    expect(existsSync(store)).toBe(false)
  })
})
