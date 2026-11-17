import { spawn } from 'node:child_process'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  dropTemporaryOptimizeRecord,
  isTemporaryOptimizeAlive,
  readTemporaryOptimizeRecords,
  saveTemporaryOptimizeRecord,
  waitForTemporaryOptimize,
  type TemporaryOptimizeRecord,
} from '../../../src/dev/temporary-evals-fork/optimize-runs.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const STAMP = '20261111-150405'
const INSIDE_HOME = 'experiments/refunds'
const OUTSIDE_HOME = 'tmp/.state/outside-experiments/refunds'

interface RunPlace {
  readonly home?: string
  readonly stamp?: string
  readonly startedAt?: number
  readonly pid?: number
}

const runFolder = (workspace: string, home: string, stamp: string): string =>
  join(workspace, home, 'optimizations', stamp)

const recordIn = (
  workspace: string,
  { home = INSIDE_HOME, stamp = STAMP, startedAt = 1, pid }: RunPlace = {}
): TemporaryOptimizeRecord => {
  const run = runFolder(workspace, home, stamp)
  return {
    version: 1,
    experiment:
      home === INSIDE_HOME ? join(workspace, INSIDE_HOME, 'refunds.json') : join(dirname(workspace), 'refunds.json'),
    record: join(run, 'optimizer'),
    space: join(run, '.state/space.json'),
    iterations: 4,
    startedAt,
    ...(pid === undefined ? {} : { pid }),
  }
}

const savedRecordFile = (workspace: string, home = INSIDE_HOME, stamp = STAMP): string =>
  join(runFolder(workspace, home, stamp), '.state/record.json')

const writeFileAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

describe('TEMPORARY optimize run records', () => {
  it('shouldListSavedRecordsOldestFirstAndForgetADroppedOne', async () => {
    const workspace = await temporaryDirectory()
    const older = recordIn(workspace, { stamp: '20261111-150405', startedAt: 1 })
    const newer = recordIn(workspace, { stamp: '20261111-160405', startedAt: 2, pid: 99 })
    await saveTemporaryOptimizeRecord(newer)
    await saveTemporaryOptimizeRecord(older)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([older, newer])

    await dropTemporaryOptimizeRecord(older)
    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([newer])
  })

  it('shouldSaveTheRecordInTheStateFolderOfItsRun', async () => {
    const workspace = await temporaryDirectory()

    await saveTemporaryOptimizeRecord(recordIn(workspace))

    expect(await readdir(dirname(savedRecordFile(workspace)))).toEqual(['record.json'])
  })

  it.each([
    ['TheOptimizationsFolderOfItsExperiment', INSIDE_HOME],
    ['TheHomeOfAnExperimentOutsideTheExperimentsFolder', OUTSIDE_HOME],
  ])('shouldFindTheRecordOfAnUnfinishedRunWhenItIsIn%s', async (_case, home) => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace, { home })
    await writeFileAt(savedRecordFile(workspace, home), JSON.stringify(record))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([record])
  })

  it('shouldListTheRecordsOfEveryExperimentHomeOldestFirst', async () => {
    const workspace = await temporaryDirectory()
    const inside = recordIn(workspace, { stamp: '20261111-160405', startedAt: 2 })
    const outside = recordIn(workspace, { home: OUTSIDE_HOME, stamp: '20261111-150405', startedAt: 1 })
    await saveTemporaryOptimizeRecord(inside)
    await saveTemporaryOptimizeRecord(outside)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([outside, inside])
  })

  it('shouldFindNoRecordsWhenNoRunWasEverRecorded', async () => {
    expect(await readTemporaryOptimizeRecords(join(await temporaryDirectory(), 'strands-dev'))).toEqual([])
  })

  it('shouldKeepTheObjectiveOfARecordSoThatTheRunResumesWithIt', async () => {
    const workspace = await temporaryDirectory()
    const record = {
      ...recordIn(workspace),
      objective: { expression: 'Minimize(tokens)', limits: 'Contains >= 0.8' },
    }

    await saveTemporaryOptimizeRecord(record)

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([record])
  })

  it.each([
    ['OneEvaluator', { kind: 'evaluator', evaluator: 'Equals' }, { expression: 'Maximize("Equals")', limits: '' }],
    ['TheMeanOfEveryEvaluator', { kind: 'evaluators', evaluators: ['Contains'] }, { expression: '', limits: '' }],
  ])('shouldReadAnObjectiveSavedBeforeTheApiNotationAs%s', async (_case, saved, objective) => {
    const workspace = await temporaryDirectory()
    const record = recordIn(workspace)
    await writeFileAt(savedRecordFile(workspace), JSON.stringify({ ...record, objective: saved }))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([{ ...record, objective }])
  })

  it.each([
    ['AnEvaluatorObjectiveWithoutAName', { kind: 'evaluator' }],
    ['AnUnknownObjectiveShape', { kind: 'cheapest', metric: 'tokens' }],
    ['AnExpressionWithoutLimits', { expression: 'Minimize(tokens)' }],
  ])('shouldSkipARecordWith%s', async (_case, objective) => {
    const workspace = await temporaryDirectory()
    await writeFileAt(savedRecordFile(workspace), JSON.stringify({ ...recordIn(workspace), objective }))

    expect(await readTemporaryOptimizeRecords(workspace)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'shouldSeeTheRunAliveOnlyWhileItsProcessStillNamesTheRecord',
    async () => {
      const workspace = await temporaryDirectory()
      const record = recordIn(workspace)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)', record.record], { stdio: 'ignore' })
      await new Promise((resolve) => child.once('spawn', resolve))
      const running = { ...record, pid: child.pid! }

      expect(await isTemporaryOptimizeAlive(running)).toBe(true)
      expect(
        await isTemporaryOptimizeAlive({ ...running, record: recordIn(workspace, { stamp: '20261111-160405' }).record })
      ).toBe(false)
      await waitForTemporaryOptimize(running)
      expect(await isTemporaryOptimizeAlive(running)).toBe(false)
    },
    10_000
  )
})
