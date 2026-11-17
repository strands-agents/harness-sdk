import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { temporaryWorkspaceReady } from '../../../src/dev/temporary-evals-fork/layout-migration.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const STAMP = '20261112-101010'
const UNFINISHED_STAMP = '20261112-111111'
const STARTED_AT = Date.UTC(2026, 10, 12, 10, 10, 10)

const children: ChildProcess[] = []

const workspace = async (): Promise<string> => join(await temporaryDirectory(), 'strands-dev')

const inTmp = (directory: string, path: string): string => join(directory, 'tmp', path)

const inWorkspace = (directory: string, path: string): string => join(directory, path)

const newPlace = (directory: string, path: string): string =>
  path.startsWith('experiments/') ? inWorkspace(directory, path) : inTmp(directory, path)

const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const writeEach = async (directory: string, paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map((path) => writeAt(inTmp(directory, path), path)))
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'))

const liveProcess = async (marker: string): Promise<number> => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' })
  children.push(child)
  await once(child, 'spawn')
  return child.pid!
}

const endedProcess = async (): Promise<number> => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  return child.pid!
}

const oldTestRecord = (directory: string, stamp: string, cases: string) => ({
  version: 1,
  experiment: inTmp(directory, 'experiments/refunds.json'),
  cases: inTmp(directory, cases),
  rerun: false,
  report: inTmp(directory, `reports/${stamp}-refunds.json`),
  log: inTmp(directory, `reports/${stamp}-refunds.log`),
  store: inTmp(directory, `reports/${stamp}-refunds.cases`),
  startedAt: STARTED_AT,
})

const oldOptimizationRecord = (directory: string, stamp: string) => ({
  version: 1,
  experiment: inTmp(directory, 'experiments/refunds.json'),
  record: inTmp(directory, `optimization/${stamp}-refunds`),
  space: inTmp(directory, `optimization/${stamp}-refunds.space.json`),
  iterations: 4,
  split: [0.6, 0.2, 0.2],
  startedAt: STARTED_AT,
})

describe('TEMPORARY workspace layout migration', () => {
  it.each<[string, Record<string, string>, number]>([
    ['an experiment', { 'experiments/refunds.json': 'experiments/refunds/refunds.json' }, 1],
    ['a draft', { [`experiments/drafts/${STAMP}-refunds.json`]: `.state/drafts/${STAMP}-refunds.json` }, 1],
    ['a downloaded skill', { 'skills/session-converter/SKILL.md': '.state/skills/session-converter/SKILL.md' }, 1],
    [
      'a finished test run',
      {
        'experiments/refunds.json': 'experiments/refunds/refunds.json',
        [`reports/${STAMP}-refunds.json`]: `experiments/refunds/runs/${STAMP}/report.json`,
        [`reports/${STAMP}-refunds.log`]: `experiments/refunds/runs/${STAMP}/run.log`,
        [`reports/${STAMP}-refunds.cases/c0.json`]: `experiments/refunds/runs/${STAMP}/.state/cases/c0.json`,
        [`reports/${STAMP}-refunds.experiment.json`]: `experiments/refunds/runs/${STAMP}/.state/experiment.json`,
      },
      5,
    ],
    [
      'a finished optimization',
      {
        'experiments/refunds.json': 'experiments/refunds/refunds.json',
        [`optimization/${STAMP}-refunds/candidates.jsonl`]: `experiments/refunds/optimizations/${STAMP}/optimizer/candidates.jsonl`,
        [`optimization/${STAMP}-refunds.log`]: `experiments/refunds/optimizations/${STAMP}/run.log`,
        [`optimization/${STAMP}-refunds.space.json`]: `experiments/refunds/optimizations/${STAMP}/.state/space.json`,
        [`optimization/${STAMP}-refunds.experiment.json`]: `experiments/refunds/optimizations/${STAMP}/.state/experiment.json`,
      },
      5,
    ],
    [
      'runs of an experiment that no longer exists',
      {
        [`reports/${STAMP}-retired.json`]: `.state/outside-experiments/retired/runs/${STAMP}/report.json`,
        [`reports/${STAMP}-retired.log`]: `.state/outside-experiments/retired/runs/${STAMP}/run.log`,
        [`optimization/${STAMP}-retired/candidates.jsonl`]: `.state/outside-experiments/retired/optimizations/${STAMP}/optimizer/candidates.jsonl`,
      },
      3,
    ],
  ])('shouldMoveEachFileToItsNewPlaceWhenTheWorkspaceHas %s', async (_case, moves, moved) => {
    const directory = await workspace()
    const [from, to] = [Object.keys(moves), Object.values(moves)]
    await writeEach(directory, from)

    const migration = await temporaryWorkspaceReady(directory)

    expect(migration).toEqual({ moved, problems: [] })
    expect(await Promise.all(to.map((path) => readFile(newPlace(directory, path), 'utf8')))).toEqual(from)
    expect(from.filter((path) => existsSync(inTmp(directory, path)))).toEqual([])
  })

  it('shouldCopyTheLatestReportNextToTheExperimentWhenTheOldLayoutRecordedOne', async () => {
    const directory = await workspace()
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(inTmp(directory, `reports/${STAMP}-refunds.json`), 'the report')
    await writeAt(
      inTmp(directory, 'reports/latest/refunds.json'),
      JSON.stringify({ report: `${STAMP}-refunds.json`, seconds: 12 })
    )

    const migration = await temporaryWorkspaceReady(directory)

    const home = inWorkspace(directory, 'experiments/refunds')
    expect(migration).toEqual({ moved: 2, problems: [] })
    expect(await readFile(join(home, 'refunds.report.json'), 'utf8')).toBe('the report')
    expect(await readFile(join(home, 'runs', STAMP, 'report.json'), 'utf8')).toBe('the report')
    expect(await readJson(join(home, '.state/latest.json'))).toEqual({ run: join('runs', STAMP), seconds: 12 })
    expect(existsSync(inTmp(directory, 'reports'))).toBe(false)
  })

  it.each([
    [
      'a copy of the experiment',
      `reports/${STAMP}-refunds.experiment.json`,
      `experiments/refunds/runs/${STAMP}/.state/experiment.json`,
    ],
    ['the experiment itself', 'experiments/refunds.json', 'experiments/refunds/refunds.json'],
  ])('shouldRewriteTheRecordOfAnUnfinishedTestRunToTheNewPathsWhenItRanOn %s', async (_case, cases, movedCases) => {
    const directory = await workspace()
    const record = { ...oldTestRecord(directory, STAMP, cases), pid: await endedProcess() }
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(inTmp(directory, `reports/running/${STAMP}-refunds.json`), JSON.stringify(record))

    await temporaryWorkspaceReady(directory)

    const run = inWorkspace(directory, `experiments/refunds/runs/${STAMP}`)
    expect(await readJson(join(run, '.state/record.json'))).toEqual({
      ...record,
      experiment: inWorkspace(directory, 'experiments/refunds/refunds.json'),
      cases: newPlace(directory, movedCases),
      report: join(run, 'report.json'),
      log: join(run, 'run.log'),
      store: join(run, '.state/cases'),
    })
    expect(existsSync(inTmp(directory, 'reports'))).toBe(false)
  })

  it('shouldRewriteTheRecordOfAnUnfinishedOptimizationToTheNewPathsWhenItsProcessEnded', async () => {
    const directory = await workspace()
    const record = { ...oldOptimizationRecord(directory, STAMP), pid: await endedProcess() }
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(inTmp(directory, `optimization/${STAMP}-refunds/candidates.jsonl`), 'candidate')
    await writeAt(inTmp(directory, `optimization/running/${STAMP}-refunds.json`), JSON.stringify(record))

    await temporaryWorkspaceReady(directory)

    const run = inWorkspace(directory, `experiments/refunds/optimizations/${STAMP}`)
    expect(await readJson(join(run, '.state/record.json'))).toEqual({
      ...record,
      experiment: inWorkspace(directory, 'experiments/refunds/refunds.json'),
      record: join(run, 'optimizer'),
      space: join(run, '.state/space.json'),
    })
    expect(await readFile(join(run, 'optimizer/candidates.jsonl'), 'utf8')).toBe('candidate')
    expect(existsSync(inTmp(directory, 'optimization'))).toBe(false)
  })

  it('shouldDeleteTheOldOptimizerEnvironmentWhenTheWorkspaceHasOne', async () => {
    const directory = await workspace()
    await writeAt(inTmp(directory, 'optimization/.venv/bin/python'), 'fixture interpreter')

    const migration = await temporaryWorkspaceReady(directory)

    expect(migration).toEqual({ moved: 0, problems: [] })
    expect(existsSync(inTmp(directory, 'optimization'))).toBe(false)
  })

  it('shouldMoveTheLogOfAnOptimizationThatStoppedBeforeItMadeItsRunFolder', async () => {
    const directory = await workspace()
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(inTmp(directory, `optimization/${STAMP}-refunds.log`), 'setup failed')
    await writeAt(inTmp(directory, `optimization/${STAMP}-refunds.experiment.json`), '{"cases": []}')

    const migration = await temporaryWorkspaceReady(directory)

    const run = inWorkspace(directory, `experiments/refunds/optimizations/${STAMP}`)
    expect(migration).toEqual({ moved: 3, problems: [] })
    expect(await readFile(join(run, 'run.log'), 'utf8')).toBe('setup failed')
    expect(await readFile(join(run, '.state/experiment.json'), 'utf8')).toBe('{"cases": []}')
    expect(existsSync(inTmp(directory, 'optimization'))).toBe(false)
  })

  it('shouldMoveAnExperimentFolderOutOfTmpAndRewriteTheRecordsOfItsUnfinishedRunsWhenNoRunIsActive', async () => {
    const directory = await workspace()
    const from = inTmp(directory, 'experiments/refunds')
    const to = inWorkspace(directory, 'experiments/refunds')
    const record = {
      version: 1,
      experiment: join(from, 'refunds.json'),
      cases: join(from, `runs/${STAMP}/.state/experiment.json`),
      rerun: false,
      report: join(from, `runs/${STAMP}/report.json`),
      log: join(from, `runs/${STAMP}/run.log`),
      store: join(from, `runs/${STAMP}/.state/cases`),
      startedAt: STARTED_AT,
      pid: await endedProcess(),
    }
    await writeAt(join(from, 'refunds.json'), '{"cases": []}')
    await writeAt(join(from, 'refunds.report.json'), 'latest')
    await writeAt(join(from, `runs/${STAMP}/.state/record.json`), JSON.stringify(record))

    await temporaryWorkspaceReady(directory)

    expect(existsSync(from)).toBe(false)
    expect(await readFile(join(to, 'refunds.report.json'), 'utf8')).toBe('latest')
    expect(await readJson(join(to, `runs/${STAMP}/.state/record.json`))).toEqual({
      ...record,
      experiment: join(to, 'refunds.json'),
      cases: join(to, `runs/${STAMP}/.state/experiment.json`),
      report: join(to, `runs/${STAMP}/report.json`),
      log: join(to, `runs/${STAMP}/run.log`),
      store: join(to, `runs/${STAMP}/.state/cases`),
    })
  })

  it('shouldKeepHistoryOutOfGitButNotTheExperimentWhenItMakesTheExperimentsFolder', async () => {
    const directory = await workspace()

    await temporaryWorkspaceReady(directory)

    expect(await readFile(inWorkspace(directory, 'experiments/.gitignore'), 'utf8')).toBe(
      '*/runs/\n*/optimizations/\n*/.state/\n*/*.report.json\n'
    )
  })

  it('shouldKeepTheIgnoreFileOfTheDeveloperWhenTheExperimentsFolderHasOne', async () => {
    const directory = await workspace()
    await writeAt(inWorkspace(directory, 'experiments/.gitignore'), 'mine\n')

    await temporaryWorkspaceReady(directory)

    expect(await readFile(inWorkspace(directory, 'experiments/.gitignore'), 'utf8')).toBe('mine\n')
  })

  it('shouldRemoveTheOldFoldersWhenEverythingInThemMoved', async () => {
    const directory = await workspace()
    await writeEach(directory, [
      'experiments/refunds.json',
      `experiments/drafts/${STAMP}-refunds.json`,
      `reports/${STAMP}-refunds.json`,
      `optimization/${STAMP}-refunds/candidates.jsonl`,
      'optimization/.venv/bin/python',
      'skills/session-converter/SKILL.md',
    ])
    await writeAt(
      inTmp(directory, 'reports/latest/refunds.json'),
      JSON.stringify({ report: `${STAMP}-refunds.json`, seconds: 3 })
    )
    await writeAt(
      inTmp(directory, `reports/running/${UNFINISHED_STAMP}-refunds.json`),
      JSON.stringify(oldTestRecord(directory, UNFINISHED_STAMP, 'experiments/refunds.json'))
    )
    await writeAt(
      inTmp(directory, `optimization/running/${UNFINISHED_STAMP}-refunds.json`),
      JSON.stringify(oldOptimizationRecord(directory, UNFINISHED_STAMP))
    )

    const migration = await temporaryWorkspaceReady(directory)

    expect(migration.problems).toEqual([])
    expect((await readdir(join(directory, 'tmp'))).sort()).toEqual(['.state'])
    expect((await readdir(inWorkspace(directory, 'experiments'))).sort()).toEqual(['.gitignore', 'refunds'])
  })

  it('shouldMoveTheOldLayoutOnlyOnceWhenTheSameWorkspaceIsMadeReadyAgain', async () => {
    const directory = await workspace()
    const other = await workspace()
    await writeAt(inTmp(directory, 'experiments/refunds.json'), 'refunds')
    const first = await temporaryWorkspaceReady(directory)
    await writeAt(inTmp(directory, 'experiments/billing.json'), 'billing')
    await writeAt(inTmp(other, 'experiments/billing.json'), 'billing')

    const again = await temporaryWorkspaceReady(directory)
    const elsewhere = await temporaryWorkspaceReady(other)

    expect(again).toBe(first)
    expect(existsSync(inTmp(directory, 'experiments/billing.json'))).toBe(true)
    expect(elsewhere).toEqual({ moved: 1, problems: [] })
    expect(await readFile(inWorkspace(other, 'experiments/billing/billing.json'), 'utf8')).toBe('billing')
  })
})

describe.skipIf(process.platform === 'win32')('TEMPORARY workspace layout migration of runs that still run', () => {
  afterEach(() => {
    children.splice(0).forEach((child) => child.kill())
  })

  it('shouldLeaveATestRunWhereItIsWhenItsProcessStillRuns', async () => {
    const directory = await workspace()
    const report = inTmp(directory, `reports/${STAMP}-refunds.json`)
    const record = JSON.stringify({
      ...oldTestRecord(directory, STAMP, 'experiments/refunds.json'),
      pid: await liveProcess(report),
    })
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(report, 'partial report')
    await writeAt(inTmp(directory, `reports/running/${STAMP}-refunds.json`), record)

    const migration = await temporaryWorkspaceReady(directory)

    expect(migration).toEqual({ moved: 1, problems: [] })
    expect(await readFile(report, 'utf8')).toBe('partial report')
    expect(await readFile(inTmp(directory, `reports/running/${STAMP}-refunds.json`), 'utf8')).toBe(record)
    expect(existsSync(inWorkspace(directory, `experiments/refunds/runs/${STAMP}`))).toBe(false)
  })

  it('shouldLeaveAnExperimentFolderInTmpWhenOneOfItsRunsStillRuns', async () => {
    const directory = await workspace()
    const from = inTmp(directory, 'experiments/refunds')
    const report = join(from, `runs/${STAMP}/report.json`)
    await writeAt(join(from, 'refunds.json'), '{"cases": []}')
    await writeAt(
      join(from, `runs/${STAMP}/.state/record.json`),
      JSON.stringify({ version: 1, report, pid: await liveProcess(report) })
    )

    await temporaryWorkspaceReady(directory)

    expect(await readFile(join(from, 'refunds.json'), 'utf8')).toBe('{"cases": []}')
    expect(existsSync(inWorkspace(directory, 'experiments/refunds'))).toBe(false)
  })

  it('shouldKeepTheOldOptimizerEnvironmentWhenARunThatStillRunsUsesIt', async () => {
    const directory = await workspace()
    const report = inTmp(directory, `reports/${STAMP}-refunds.json`)
    const record = JSON.stringify({
      ...oldTestRecord(directory, STAMP, 'experiments/refunds.json'),
      pid: await liveProcess(report),
    })
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(inTmp(directory, `reports/running/${STAMP}-refunds.json`), record)
    await writeAt(inTmp(directory, 'optimization/.venv/bin/python'), 'fixture interpreter')

    await temporaryWorkspaceReady(directory)

    expect(await readFile(inTmp(directory, 'optimization/.venv/bin/python'), 'utf8')).toBe('fixture interpreter')
  })

  it('shouldLeaveAnOptimizationWhereItIsWhenItsProcessStillRuns', async () => {
    const directory = await workspace()
    const folder = inTmp(directory, `optimization/${STAMP}-refunds`)
    const record = JSON.stringify({ ...oldOptimizationRecord(directory, STAMP), pid: await liveProcess(folder) })
    await writeAt(inTmp(directory, 'experiments/refunds.json'), '{"cases": []}')
    await writeAt(join(folder, 'candidates.jsonl'), 'candidate')
    await writeAt(inTmp(directory, `optimization/running/${STAMP}-refunds.json`), record)

    const migration = await temporaryWorkspaceReady(directory)

    expect(migration).toEqual({ moved: 1, problems: [] })
    expect(await readFile(join(folder, 'candidates.jsonl'), 'utf8')).toBe('candidate')
    expect(await readFile(inTmp(directory, `optimization/running/${STAMP}-refunds.json`), 'utf8')).toBe(record)
    expect(existsSync(inWorkspace(directory, `experiments/refunds/optimizations/${STAMP}`))).toBe(false)
  })
})
