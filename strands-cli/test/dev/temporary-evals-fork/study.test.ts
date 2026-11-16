import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  readTemporaryStudy,
  tailTemporaryRun,
  temporaryStudyReader,
} from '../../../src/dev/temporary-evals-fork/study.js'
import {
  OPTIMIZER_RUN_FOLDER,
  type OptimizerCandidate,
  optimizerCandidate,
  optimizerConfig,
  optimizerIterationEnd,
  optimizerPicked,
  optimizerStop,
  optimizerTested,
  writeOptimizerRun,
} from '../../fixtures/optimizer-run.js'
import { temporaryDirectory } from '../../fixtures/tempdir.js'

const BASELINE = 'Answer refund questions.'
const WINNER = 'Answer refund questions.\nCheck the order date first.'

const baseline = { id: 'base', number: 0, values: { instructions: BASELINE, caching: true }, train: 0.5 }
const winner = {
  id: 'win',
  number: 1,
  iteration: 1,
  values: { instructions: WINNER, caching: false },
  changed: ['instructions', 'caching'],
  train: 0.8,
}

const untrained = ({ train: _train, ...candidate }: OptimizerCandidate): OptimizerCandidate => candidate

const searchLines = (): string[] => [
  optimizerConfig(),
  ...optimizerCandidate(baseline),
  ...optimizerCandidate(winner),
  ...optimizerCandidate({
    id: 'broken',
    number: 2,
    iteration: 1,
    values: { instructions: BASELINE, caching: 'auto' },
    changed: ['caching'],
    failed: 'ModelThrottledError: slow down',
  }),
  optimizerIterationEnd(['win', 'base']),
]

const readerOf = (lines: readonly string[], labels: Record<string, string> = {}) => {
  const reader = temporaryStudyReader({ run: 'r1', record: '/w/r1', startedAt: 7, labels })
  lines.forEach((line) => reader.push(line))
  return reader
}

describe('TEMPORARY optimization run', () => {
  it('shouldListTheScoredCandidatesAfterTheBaselineWhenTheSearchRuns', () => {
    const progress = readerOf(searchLines(), { caching: 'prompt caching' }).progress()

    expect(progress).toMatchObject({
      run: 'r1',
      metric: 'OutputEvaluator',
      iterations: 1,
      planned: 5,
      baseline: 0.5,
      best: { number: 1, score: 0.8 },
      startedAt: 7,
      stopping: false,
    })
    expect(progress.candidates).toEqual([
      {
        number: 1,
        step: 1,
        changed: ['instructions', 'caching'],
        summary: 'Check the order date first.; prompt caching → off',
        score: 0.8,
        delta: expect.closeTo(0.3),
        kept: true,
      },
      {
        number: 2,
        step: 1,
        changed: ['caching'],
        summary: 'ModelThrottledError: slow down',
        score: 0,
        delta: -0.5,
        kept: false,
        failed: 'ModelThrottledError: slow down',
      },
    ])
  })

  it('shouldIgnoreLinesWhenTheyAreBlankOrNotEvents', () => {
    const progress = readerOf(['', 'not json', '{"type":"study"}', ...searchLines()]).progress()

    expect(progress.candidates).toHaveLength(2)
  })

  it.each([
    [
      'the test cases when both were tested',
      [
        ...optimizerCandidate({ ...untrained(baseline), validation: 0.4, test: 0.3 }),
        ...optimizerCandidate({ ...untrained(winner), validation: 0.9, test: 0.7 }),
        optimizerTested('win', 'base', 0.4, 6, [0.1, 0.7]),
      ],
      'test',
      0.3,
      0.7,
    ],
    [
      'the validation cases when no test ran',
      [
        ...optimizerCandidate({ ...untrained(baseline), validation: 0.4 }),
        ...optimizerCandidate({ ...untrained(winner), validation: 0.9 }),
      ],
      'validation',
      0.4,
      0.9,
    ],
  ])('shouldMeasureTheChampionOn %s', (_, extra, measuredOn, baselineScore, bestScore) => {
    const outcome = readerOf([...searchLines(), optimizerStop(), ...extra, optimizerPicked('win')]).outcome()

    expect(outcome).toMatchObject({
      metric: 'OutputEvaluator',
      ended: 'finished',
      measuredOn,
      baseline: { params: { instructions: BASELINE, caching: true }, score: baselineScore },
      best: { number: 1, params: { instructions: WINNER, caching: false }, score: bestScore },
    })
  })

  it('shouldReportTheTestDifferenceWhenTheTestReportArrives', () => {
    const outcome = readerOf([
      ...searchLines(),
      optimizerPicked('win'),
      optimizerTested('win', 'base', 0.25, 4, [0.1, 0.4]),
    ]).outcome()

    expect(outcome.test).toEqual({ difference: 0.25, cases: 4, confidence: 0.9, ci: [0.1, 0.4] })
  })

  it('shouldReportTheStopMessageWhenTheRunStopsAtSetup', () => {
    const outcome = readerOf([
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      optimizerStop('setup', 'the baseline failed every case'),
    ]).outcome()

    expect(outcome).toMatchObject({ ended: 'stopped', error: 'the baseline failed every case' })
  })

  it('shouldReportRunningAndTheLeaderWhenNoChampionIsPickedYet', () => {
    expect(readerOf(searchLines()).outcome()).toMatchObject({ ended: 'running', best: { number: 1 } })
  })

  it('shouldShipTheBaselineWhenItIsTheChampion', async () => {
    const record = await temporaryDirectory()
    await writeOptimizerRun(record, [...searchLines(), optimizerStop(), optimizerPicked('base')])

    const outcome = await readTemporaryStudy(record)

    expect(outcome).toMatchObject({ ended: 'finished', best: { number: 0, params: baseline.values } })
  })

  it('shouldTakeTheChampionAndTheTestFromTheResultFileWhenTheEventsStopEarly', async () => {
    const record = await temporaryDirectory()
    await writeOptimizerRun(record, searchLines(), {
      baseline_id: 'base',
      validation: { champion_id: 'win' },
      test: {
        champion_id: 'win',
        baseline_id: 'base',
        objective: { mean_diff: 0.2, ci_low: null, ci_high: null, n_cases: 3 },
      },
    })

    const outcome = await readTemporaryStudy(record)

    expect(outcome).toMatchObject({ ended: 'finished', best: { number: 1 }, test: { difference: 0.2, cases: 3 } })
  })

  it('shouldExplainTheFolderWhenItHasNoRun', async () => {
    const record = await temporaryDirectory()

    await expect(readTemporaryStudy(record)).rejects.toThrow('has no optimization run with events.jsonl')
  })

  it('shouldFollowTheRunFolderWhenItAppearsAfterTheTailStarts', async () => {
    const record = await temporaryDirectory()
    const lines: string[] = []
    const tail = tailTemporaryRun(record, (line) => lines.push(line))

    await mkdir(join(record, OPTIMIZER_RUN_FOLDER), { recursive: true })
    await appendFile(join(record, OPTIMIZER_RUN_FOLDER, 'events.jsonl'), `${optimizerConfig()}\n`)

    await vi.waitFor(() => expect(lines).toEqual([optimizerConfig()]), { timeout: 5000 })
    await tail.stop()
  })
})
