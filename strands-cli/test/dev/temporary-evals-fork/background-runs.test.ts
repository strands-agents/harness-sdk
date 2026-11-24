import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  clearUnreadableCaseResults,
  dropTemporaryOptimizeRecord,
  dropTemporaryRunRecord,
  isTemporaryOptimizeAlive,
  isTemporaryRunAlive,
  readTemporaryOptimizeRecords,
  readTemporaryRunRecords,
  saveTemporaryOptimizeRecord,
  saveTemporaryRunRecord,
  waitForTemporaryOptimize,
  waitForTemporaryRun,
  type TemporaryOptimizeRecord,
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
  readonly startedAt?: number
  readonly pid?: number
}

const runFolder = (workspace: string, home: string, stamp: string): string => join(workspace, home, 'runs', stamp)

const experimentOf = (workspace: string, home: string): string =>
  home === INSIDE_HOME ? join(workspace, INSIDE_HOME, 'capital.json') : join(dirname(workspace), 'capital.json')

const recordIn = (
  workspace: string,
  { home = INSIDE_HOME, stamp = STAMP, pid }: RunPlace = {}
): TemporaryTestRecord => {
  const run = runFolder(workspace, home, stamp)
  return {
    version: 1,
    experiment: experimentOf(workspace, home),
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

const optimizeRecordIn = (
  workspace: string,
  { home = INSIDE_HOME, stamp = STAMP, startedAt = 1, pid }: RunPlace = {}
): TemporaryOptimizeRecord => {
  const run = join(workspace, home, 'optimizations', stamp)
  return {
    version: 1,
    experiment: experimentOf(workspace, home),
    record: join(run, 'optimizer'),
    space: join(run, '.state/space.json'),
    iterations: 4,
    startedAt,
    ...(pid === undefined ? {} : { pid }),
  }
}

const optimizeRecordFile = (workspace: string, home = INSIDE_HOME): string =>
  join(workspace, home, 'optimizations', STAMP, '.state/record.json')

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

describe('TEMPORARY optimize run records', () => {
  it('shouldListSavedRecordsOldestFirstAndForgetADroppedOne', async () => {
    const workspace = await temporaryDirectory()
    const older = optimizeRecordIn(workspace, { stamp: '20261111-150405', startedAt: 1 })
    const newer = optimizeRecordIn(workspace, { stamp: '20261111-160405', startedAt: 2, pid: 99 })
    await saveTemporaryOptimizeRecord(newer)
    await saveTemporaryOptimizeRecord(older)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([older, newer])

    await dropTemporaryOptimizeRecord(older)
    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([newer])
  })

  it('shouldSaveTheRecordInTheStateFolderOfItsRun', async () => {
    const workspace = await temporaryDirectory()

    await saveTemporaryOptimizeRecord(optimizeRecordIn(workspace))

    expect(await readdir(dirname(optimizeRecordFile(workspace)))).toEqual(['record.json'])
  })

  it.each([
    ['TheOptimizationsFolderOfItsExperiment', INSIDE_HOME],
    ['TheHomeOfAnExperimentOutsideTheExperimentsFolder', OUTSIDE_HOME],
  ])('shouldFindTheRecordOfAnUnfinishedRunWhenItIsIn%s', async (_case, home) => {
    const workspace = await temporaryDirectory()
    const record = optimizeRecordIn(workspace, { home })
    await writeFileAt(optimizeRecordFile(workspace, home), JSON.stringify(record))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([record])
  })

  it('shouldListTheRecordsOfEveryExperimentHomeOldestFirst', async () => {
    const workspace = await temporaryDirectory()
    const inside = optimizeRecordIn(workspace, { stamp: '20261111-160405', startedAt: 2 })
    const outside = optimizeRecordIn(workspace, { home: OUTSIDE_HOME, stamp: '20261111-150405', startedAt: 1 })
    await saveTemporaryOptimizeRecord(inside)
    await saveTemporaryOptimizeRecord(outside)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([outside, inside])
  })

  it('shouldFindNoRecordsWhenNoRunWasEverRecorded', async () => {
    expect(await readTemporaryOptimizeRecords(join(await temporaryDirectory(), 'strands-dev'))).toEqual([])
  })

  it('shouldKeepThatTheRunAwaitsItsReviewSoThatItComesBackAsOne', async () => {
    const workspace = await temporaryDirectory()
    const record = { ...optimizeRecordIn(workspace), awaitsReview: true }
    await saveTemporaryOptimizeRecord(record)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([record])
  })

  it('shouldKeepTheObjectiveOfARecordSoThatTheRunResumesWithIt', async () => {
    const workspace = await temporaryDirectory()
    const record = {
      ...optimizeRecordIn(workspace),
      objective: { expression: 'Minimize(tokens)', constraints: 'Contains >= 0.8' },
    }

    await saveTemporaryOptimizeRecord(record)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([record])
  })

  it('shouldReadTheConstraintsOfARecordThatSavedThemAsLimits', async () => {
    const workspace = await temporaryDirectory()
    const record = optimizeRecordIn(workspace)
    await writeFileAt(
      optimizeRecordFile(workspace),
      JSON.stringify({ ...record, objective: { expression: 'Minimize(tokens)', limits: 'Contains >= 0.8' } })
    )

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([
      { ...record, objective: { expression: 'Minimize(tokens)', constraints: 'Contains >= 0.8' } },
    ])
  })

  it.each([
    ['OneEvaluator', { kind: 'evaluator', evaluator: 'Equals' }, { expression: 'Maximize("Equals")', constraints: '' }],
    ['TheMeanOfEveryEvaluator', { kind: 'evaluators', evaluators: ['Contains'] }, { expression: '', constraints: '' }],
  ])('shouldReadAnObjectiveSavedBeforeTheApiNotationAs%s', async (_case, saved, objective) => {
    const workspace = await temporaryDirectory()
    const record = optimizeRecordIn(workspace)
    await writeFileAt(optimizeRecordFile(workspace), JSON.stringify({ ...record, objective: saved }))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([{ ...record, objective }])
  })

  it.each([
    ['AnEvaluatorObjectiveWithoutAName', { kind: 'evaluator' }],
    ['AnUnknownObjectiveShape', { kind: 'cheapest', metric: 'tokens' }],
    ['AnExpressionWithoutConstraints', { expression: 'Minimize(tokens)' }],
  ])('shouldSkipARecordWith%s', async (_case, objective) => {
    const workspace = await temporaryDirectory()
    await writeFileAt(optimizeRecordFile(workspace), JSON.stringify({ ...optimizeRecordIn(workspace), objective }))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'shouldSeeTheRunAliveOnlyWhileItsProcessStillNamesTheRecord',
    async () => {
      const workspace = await temporaryDirectory()
      const record = optimizeRecordIn(workspace)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)', record.record], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('spawn', resolve))
      const running = { ...record, pid: child.pid! }

      expect(await isTemporaryOptimizeAlive(running)).toBe(true)
      expect(
        await isTemporaryOptimizeAlive({
          ...running,
          record: optimizeRecordIn(workspace, { stamp: '20261111-160405' }).record,
        })
      ).toBe(false)
      await waitForTemporaryOptimize(running)
      expect(await isTemporaryOptimizeAlive(running)).toBe(false)
    },
    10_000
  )
})
