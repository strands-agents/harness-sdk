import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  listTemporaryOptimizations,
  listTemporaryTestRuns,
  pruneTemporaryTestRuns,
  temporaryExperimentHome,
  temporaryFreeStamp,
  temporaryOptimizationFiles,
  temporaryOptimizationLabel,
  temporaryOptimizationOf,
  temporaryOptimizationRunName,
  temporaryRunStamp,
  temporaryStampTime,
  temporaryTestRunFiles,
  temporaryTestRunOf,
  type TemporaryTestRunFiles,
} from '../../../src/dev/temporary-evals-fork/layout.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const WORKSPACE = resolve('/work/strands-dev')
const HOME = join(WORKSPACE, 'tmp/experiments/refunds')
const OUTSIDE_HOME = join(WORKSPACE, 'tmp/.state/outside-experiments/refunds')
const NOW = new Date('2026-11-11T15:04:05Z')
const STAMP = '20261111-150405'

const makeFolders = (folders: readonly string[]): Promise<unknown> =>
  Promise.all(folders.map((folder) => mkdir(folder, { recursive: true })))

describe('TEMPORARY experiment homes', () => {
  it('shouldUseTheExperimentFolderAsHomeWhenTheFileIsInIt', () => {
    expect(temporaryExperimentHome(WORKSPACE, join(HOME, 'refunds.json'))).toBe(HOME)
  })

  it.each([
    { where: 'OutsideTheWorkspace', file: resolve('/elsewhere/refunds.json') },
    { where: 'DirectlyInTheExperimentsFolder', file: join(WORKSPACE, 'tmp/experiments/refunds.json') },
    { where: 'InTheFolderOfAnotherExperiment', file: join(WORKSPACE, 'tmp/experiments/billing/refunds.json') },
  ])('shouldUseAnOutsideHomeWhenTheFileIs$where', ({ file }) => {
    expect(temporaryExperimentHome(WORKSPACE, file)).toBe(OUTSIDE_HOME)
  })
})

describe('TEMPORARY run files', () => {
  it('shouldKeepEveryFileOfATestRunInItsStampFolderWhenGivenAStamp', () => {
    const folder = join(HOME, 'runs', STAMP)

    expect(temporaryTestRunFiles(HOME, STAMP)).toEqual({
      folder,
      report: join(folder, 'report.json'),
      log: join(folder, 'run.log'),
      store: join(folder, '.state/cases'),
      copy: join(folder, '.state/experiment.json'),
      record: join(folder, '.state/record.json'),
    })
  })

  it('shouldKeepEveryFileOfAnOptimizationInItsStampFolderWhenGivenAStamp', () => {
    const folder = join(HOME, 'optimizations', STAMP)

    expect(temporaryOptimizationFiles(HOME, STAMP)).toEqual({
      folder,
      record: join(folder, 'optimizer'),
      log: join(folder, 'run.log'),
      space: join(folder, '.state/space.json'),
      copy: join(folder, '.state/experiment.json'),
      resume: join(folder, '.state/record.json'),
    })
  })

  it.each([
    { where: 'AnExperimentFolder', home: HOME, stamp: STAMP },
    { where: 'AnOutsideHome', home: OUTSIDE_HOME, stamp: `${STAMP}-2` },
  ])('shouldFindTheTestRunFilesAgainWhenGivenTheReportOfARunIn$where', ({ home, stamp }) => {
    const files = temporaryTestRunFiles(home, stamp)

    expect(temporaryTestRunOf(files.report)).toEqual(files)
  })

  it.each([
    { where: 'AnExperimentFolder', home: HOME, stamp: STAMP },
    { where: 'AnOutsideHome', home: OUTSIDE_HOME, stamp: `${STAMP}-2` },
  ])('shouldFindTheOptimizationFilesAgainWhenGivenTheRecordOfAnOptimizationIn$where', ({ home, stamp }) => {
    const files = temporaryOptimizationFiles(home, stamp)

    expect(temporaryOptimizationOf(files.record)).toEqual(files)
  })
})

describe('TEMPORARY optimization names', () => {
  it('shouldNameAnOptimizationByItsStampAndExperimentWhenGivenItsRecord', () => {
    expect(temporaryOptimizationRunName(temporaryOptimizationFiles(HOME, STAMP).record)).toBe(`${STAMP}-refunds`)
  })

  it.each([
    { folder: STAMP, label: { experiment: 'refunds', startedAt: NOW.getTime() } },
    { folder: `${STAMP}-2`, label: { experiment: 'refunds', startedAt: NOW.getTime() } },
    { folder: 'notes', label: { experiment: 'refunds' } },
  ])('shouldLabelAnOptimizationWithItsExperimentAndStartWhenItsFolderIs$folder', ({ folder, label }) => {
    expect(temporaryOptimizationLabel(temporaryOptimizationFiles(HOME, folder).record)).toEqual(label)
  })
})

describe('TEMPORARY run stamps', () => {
  it('shouldStampARunWithItsUtcSecondWhenItStarts', () => {
    expect(temporaryRunStamp(new Date('2026-11-11T15:04:05.678Z'))).toBe(STAMP)
  })

  it.each([STAMP, `${STAMP}-2`])('shouldReadTheStartTimeWhenTheStampIs%s', (stamp) => {
    expect(temporaryStampTime(stamp)).toBe(NOW.getTime())
  })

  it.each(['.venv', 'notes', '20261111-1504', `${STAMP}-refunds`])('shouldReadNoTimeWhen%sIsNotAStamp', (name) => {
    expect(temporaryStampTime(name)).toBeUndefined()
  })

  it.each([
    { when: 'NoRunHasTheStamp', taken: [], stamp: STAMP },
    { when: 'ARunHasTheStamp', taken: [STAMP], stamp: `${STAMP}-2` },
    { when: 'RunsHaveTheStampAndItsFirstSuffix', taken: [STAMP, `${STAMP}-2`], stamp: `${STAMP}-3` },
  ])('shouldPickTheFreeStampWhen$when', ({ taken, stamp }) => {
    expect(temporaryFreeStamp((candidate) => taken.includes(candidate), NOW)).toBe(stamp)
  })
})

describe('TEMPORARY run lists', () => {
  it.each([
    { label: 'TestRuns', kind: 'runs', other: 'optimizations', list: listTemporaryTestRuns },
    { label: 'Optimizations', kind: 'optimizations', other: 'runs', list: listTemporaryOptimizations },
  ])('shouldListEveryHomeOldestFirstWhenTheWorkspaceHas$label', async ({ kind, other, list }) => {
    const directory = await temporaryDirectory()
    const refunds = join(directory, 'tmp/experiments/refunds')
    const billing = join(directory, 'tmp/experiments/billing')
    const outside = join(directory, 'tmp/.state/outside-experiments/legacy')
    await makeFolders([
      join(refunds, kind, `${STAMP}-10`),
      join(refunds, kind, `${STAMP}-2`),
      join(refunds, kind, STAMP),
      join(refunds, kind, 'notes'),
      join(refunds, other, '20261111-100000'),
      join(billing, kind, '20261111-120000'),
      join(outside, kind, '20261110-090000'),
    ])

    const listed = await list(directory)

    expect(listed.map(({ folder }) => folder)).toEqual([
      join(outside, kind, '20261110-090000'),
      join(billing, kind, '20261111-120000'),
      join(refunds, kind, STAMP),
      join(refunds, kind, `${STAMP}-2`),
      join(refunds, kind, `${STAMP}-10`),
    ])
    expect(listed[0]).toEqual({
      home: outside,
      name: 'legacy',
      folder: join(outside, kind, '20261110-090000'),
      stamp: '20261110-090000',
      startedAt: Date.parse('2026-11-10T09:00:00Z'),
    })
  })

  it.each([
    { label: 'TestRuns', list: listTemporaryTestRuns },
    { label: 'Optimizations', list: listTemporaryOptimizations },
  ])('shouldListNothingWhenTheWorkspaceHasNoTemporaryFolder ($label)', async ({ list }) => {
    expect(await list(await temporaryDirectory())).toEqual([])
  })
})

describe('TEMPORARY test run pruning', () => {
  const stampAt = (second: number): string => `20261111-1500${String(second).padStart(2, '0')}`

  const stampsFrom = (first: number, count: number): string[] =>
    Array.from({ length: count }, (_, index) => stampAt(first + index))

  const homeWithRuns = async (count: number): Promise<string> => {
    const home = join(await temporaryDirectory(), 'tmp/experiments/refunds')
    await makeFolders(stampsFrom(0, count).map((stamp) => join(home, 'runs', stamp)))
    return home
  }

  const remainingStamps = async (home: string): Promise<string[]> => (await readdir(join(home, 'runs'))).sort()

  it.each([
    { count: 20, removed: 0 },
    { count: 22, removed: 2 },
  ])('shouldKeepTheNewestTwentyRunsWhenAHomeHas$count', async ({ count, removed }) => {
    const home = await homeWithRuns(count)

    const removedCount = await pruneTemporaryTestRuns(home, [])

    expect(removedCount).toBe(removed)
    expect(await remainingStamps(home)).toEqual(stampsFrom(removed, 20))
  })

  it.each([
    { when: 'TheCallerKeepsIt', protect: async ({ folder }: TemporaryTestRunFiles) => [folder] },
    {
      when: 'ItHasNotFinished',
      protect: async ({ record }: TemporaryTestRunFiles) => {
        await mkdir(dirname(record), { recursive: true })
        await writeFile(record, '{}')
        return []
      },
    },
  ])('shouldKeepTheOldestRunWhen$when', async ({ protect }) => {
    const home = await homeWithRuns(22)
    const kept = await protect(temporaryTestRunFiles(home, stampAt(0)))

    const removedCount = await pruneTemporaryTestRuns(home, kept)

    expect(removedCount).toBe(1)
    expect(await remainingStamps(home)).toEqual([stampAt(0), ...stampsFrom(2, 20)])
  })
})
