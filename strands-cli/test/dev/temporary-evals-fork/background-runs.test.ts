import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const heldOpen = (): Error => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })

const STAMP = '20261116-090000'
const INSIDE_HOME = 'experiments/capital'
const OUTSIDE_HOME = 'tmp/.state/outside-experiments/capital'

interface RunPlace {
  readonly home?: string
  readonly stamp?: string
  readonly pid?: number
}

const runFolder = (workspace: string, home: string, stamp: string): string => join(workspace, home, 'runs', stamp)

const recordIn = (
  workspace: string,
  { home = INSIDE_HOME, stamp = STAMP, pid }: RunPlace = {}
): TemporaryTestRecord => {
  const run = runFolder(workspace, home, stamp)
  const experiment =
    home === INSIDE_HOME ? join(workspace, INSIDE_HOME, 'capital.json') : join(dirname(workspace), 'capital.json')
  return {
    version: 1,
    experiment,
    cases: join(run, '.state/experiment.json'),
    rerun: false,
    report: join(run, 'report.json'),
    log: join(run, 'run.log'),
    store: join(run, '.state/cases'),
    startedAt: 1_763_283_600_000,
    ...(pid === undefined ? {} : { pid }),
  }
}

const savedRecordFile = (workspace: string, home = INSIDE_HOME, stamp = STAMP): string =>
  join(runFolder(workspace, home, stamp), '.state/record.json')

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

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
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace, { pid: 4242 })

    await saveTemporaryRunRecord(record)
    const saved = await readTemporaryRunRecords(workspace)
    await dropTemporaryRunRecord(record)

    expect(saved).toEqual([record])
    expect(await readTemporaryRunRecords(workspace)).toEqual([])
  })

  it('shouldSaveTheRecordInTheStateFolderOfItsRun', async () => {
    const workspace = await temporaryDirectory()

    await saveTemporaryRunRecord(recordIn(workspace))

    expect(await readdir(dirname(savedRecordFile(workspace)))).toEqual(['record.json'])
  })

  it.each([
    ['TheRunsFolderOfItsExperiment', INSIDE_HOME],
    ['TheHomeOfAnExperimentOutsideTheExperimentsFolder', OUTSIDE_HOME],
  ])('shouldFindTheRecordOfAnUnfinishedRunWhenItIsIn%s', async (_case, home) => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace, { home })
    await writeFileAt(savedRecordFile(workspace, home), JSON.stringify(record))

    expect(await readTemporaryRunRecords(workspace)).toEqual([record])
  })

  it('shouldSkipRecordsThatAreNotWholeOrNotRunRecords', async () => {
    const workspace = await temporaryDirectory()
    await writeFileAt(savedRecordFile(workspace, INSIDE_HOME, '20261116-070000'), '{"version": 1, "experi')
    await writeFileAt(savedRecordFile(workspace, INSIDE_HOME, '20261116-080000'), '{"version": 2}')
    await saveTemporaryRunRecord(recordIn(workspace))

    expect(await readTemporaryRunRecords(workspace)).toEqual([recordIn(workspace)])
  })

  it('shouldFindNoRecordsWhenNoRunWasEverRecorded', async () => {
    expect(await readTemporaryRunRecords(join(await temporaryDirectory(), 'strands-dev'))).toEqual([])
  })

  it('shouldSaveTheRecordWhenTheFileItReplacesIsHeldOpenForAMoment', async () => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace)
    await saveTemporaryRunRecord(record)
    vi.mocked(rename).mockRejectedValueOnce(heldOpen()).mockRejectedValueOnce(heldOpen())

    await saveTemporaryRunRecord({ ...record, pid: 4242 })

    expect(await readTemporaryRunRecords(workspace)).toEqual([{ ...record, pid: 4242 }])
  })

  it('shouldGiveUpAndLeaveNoStagingFileWhenTheRecordCannotBeReplaced', async () => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace)
    await saveTemporaryRunRecord(record)
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }))

    await expect(saveTemporaryRunRecord({ ...record, pid: 4242 })).rejects.toThrow('ENOSPC')

    expect(await readTemporaryRunRecords(workspace)).toEqual([record])
    expect(await readdir(dirname(savedRecordFile(workspace)))).toEqual(['record.json'])
  })
})

describe.skipIf(process.platform === 'win32')('TEMPORARY test runs that outlive strands dev', () => {
  it('shouldTreatARunAsAliveOnlyWhileItsProcessStillWritesItsReport', async () => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace)
    const child = await running(record.report)

    const live = await isTemporaryRunAlive({ ...record, pid: child.pid! })
    const reused = await isTemporaryRunAlive({
      ...record,
      pid: child.pid!,
      report: recordIn(workspace, { stamp: '20261116-100000' }).report,
    })
    child.kill()
    await once(child, 'exit')

    expect(live).toBe(true)
    expect(reused).toBe(false)
    expect(await isTemporaryRunAlive({ ...record, pid: child.pid! })).toBe(false)
    expect(await isTemporaryRunAlive(record)).toBe(false)
  })

  it('shouldStopTheRunAndReturnWhenItsProcessHasEnded', async () => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace)
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
    const { store } = recordIn(await temporaryDirectory())
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'done.json'), '{"output": "Paris"}')
    await writeFile(join(store, 'cut.json'), '{"outp')
    await writeFile(join(store, 'notes.txt'), 'keep')

    await clearUnreadableCaseResults(store)

    expect((await readdir(store)).sort()).toEqual(['done.json', 'notes.txt'])
  })

  it('shouldDoNothingWhenTheRunSavedNoCaseYet', async () => {
    const { store } = recordIn(await temporaryDirectory())

    await clearUnreadableCaseResults(store)

    expect(existsSync(store)).toBe(false)
  })
})
