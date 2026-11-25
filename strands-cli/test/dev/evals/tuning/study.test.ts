import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  hasEvalsRunResult,
  readEvalsProposerFailure,
  readEvalsStudy,
  readEvalsUsageProfile,
  tailEvalsRun,
  evalsStudyReader,
} from '../../../../src/dev/evals/tuning/study.js'
import {
  OPTIMIZER_RUN_FOLDER,
  type OptimizerCandidate,
  optimizerCandidate,
  optimizerConfig,
  optimizerFinalists,
  optimizerIterationEnd,
  optimizerPicked,
  optimizerProposerError,
  optimizerResume,
  optimizerStop,
  optimizerTested,
  optimizerTrial,
  writeOptimizerRun,
} from '../../../fixtures/optimizer-run.js'
import { evalsExperimentsFolder, evalsOptimizationFiles } from '../../../../src/dev/evals/layout.js'
import { temporaryDirectory } from '../../../fixtures/tempdir.js'

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

const PROPOSER_STOP_MESSAGE = 'a proposer raised; see the proposer_error event'

const PROPOSER_CREDENTIALS =
  "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell that " +
  'started strands dev, not the chat provider. Set AWS_PROFILE or AWS credentials that can call Bedrock, then ' +
  'start the run again.'

const proposerError = (type: string, error: string): string =>
  JSON.stringify({ event: 'proposer_error', iteration: 1, block: 'instructions', redraw: 0, error_type: type, error })

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

// One step of four candidates on SPLIT: 4 train cases for your agent and each candidate, then 2 finalists and your
// agent on 2 validation cases, then the winner and your agent on 2 test cases.
const PLANNED = { search: 20, validation: 6, test: 4 }

const readerOf = (lines: readonly string[]) => {
  const reader = evalsStudyReader({ run: 'r1', record: '/w/r1', planned: PLANNED })
  lines.forEach((line) => reader.push(line))
  return reader
}

const rolloutsAfter = (lines: readonly string[]) => readerOf(lines).progress().rollouts

const scoredOnTrain = (id: string, number: number): string[] => [
  ...proposed(id, number),
  ...SPLIT.train.map((caseName) => optimizerTrial({ candidate: id, caseName })),
  ...optimizerCandidate({ id, number, iteration: 1, values: {}, train: 1 }).slice(1),
]

const searched = (): string[] => [
  ...measuredBaseline(),
  ...scoredOnTrain('v1', 1),
  ...scoredOnTrain('v2', 2),
  ...scoredOnTrain('v3', 3),
  ...scoredOnTrain('v4', 4),
]

const SPLIT = { train: ['a', 'b', 'c', 'd'], validation: ['e', 'f'], test: ['g', 'h'] }

const base = { id: 'base', number: 0, values: { instructions: BASELINE } }

const measuredBaseline = (): string[] => [
  optimizerConfig({ cases: SPLIT }),
  ...optimizerCandidate(base),
  ...SPLIT.train.map((caseName) => optimizerTrial({ candidate: 'base', caseName })),
  ...optimizerCandidate({ ...base, train: 0.5 }).slice(1),
]

const proposed = (id: string, number: number): string[] =>
  optimizerCandidate({
    id,
    number,
    iteration: 1,
    values: { instructions: `${BASELINE}\nVersion ${number}.` },
    changed: ['instructions'],
    rationale: `Version ${number} checks the date.`,
  })

describe('optimization rollouts', () => {
  it('shouldCountTheWholeRunFromTheStartSoTheTotalIsWhatThePlanAllowed', () => {
    expect(rolloutsAfter([])).toEqual({ done: 0, total: 30 })
    expect(rolloutsAfter(measuredBaseline())).toEqual({ done: 4, total: 30 })
  })

  it('shouldNotBeDoneWhenTheSearchIsBecauseTheFinalistsAndTheTestAreStillToRun', () => {
    expect(rolloutsAfter(searched())).toEqual({ done: 20, total: 30 })
  })

  it('shouldCountTheCheckOfTheFinalistsAndThenTheTest', () => {
    const checking = [
      ...searched(),
      optimizerFinalists(['v1', 'v2']),
      optimizerTrial({ candidate: 'v1', caseName: 'e', split: 'validation' }),
    ]
    const testing = [
      ...checking,
      ...['v1', 'v2', 'base'].flatMap((candidate) =>
        SPLIT.validation.map((caseName) => optimizerTrial({ candidate, caseName, split: 'validation' }))
      ),
      optimizerPicked('v1'),
      optimizerTrial({ candidate: 'base', caseName: 'g', split: 'test' }),
    ]

    expect(rolloutsAfter(checking)).toEqual({ done: 21, total: 30 })
    expect(rolloutsAfter(testing)).toEqual({ done: 27, total: 30 })
  })

  it('shouldReachItsTotalOnlyWhenTheTestIsDone', () => {
    const finished = [
      ...searched(),
      optimizerFinalists(['v1', 'v2']),
      ...['v1', 'v2', 'base'].flatMap((candidate) =>
        SPLIT.validation.map((caseName) => optimizerTrial({ candidate, caseName, split: 'validation' }))
      ),
      optimizerPicked('v1'),
      ...['v1', 'base'].flatMap((candidate) =>
        SPLIT.test.map((caseName) => optimizerTrial({ candidate, caseName, split: 'test' }))
      ),
    ]

    expect(rolloutsAfter(finished.slice(0, -1))).toEqual({ done: 29, total: 30 })
    expect(rolloutsAfter(finished)).toEqual({ done: 30, total: 30 })
    expect(rolloutsAfter([...finished, optimizerTested('v1', 'base', 0.5, 2)])).toEqual({ done: 30, total: 30 })
  })

  it('shouldLowerTheTotalWhenTheSearchStopsEarlyOrFewerVersionsGoOnThanPlanned', () => {
    const stoppedEarly = [...measuredBaseline(), ...scoredOnTrain('v1', 1), optimizerStop()]
    const oneFinalist = [...stoppedEarly, optimizerFinalists(['v1'])]
    const yourAgentWon = [...oneFinalist, optimizerPicked('base')]

    expect(rolloutsAfter(stoppedEarly)).toEqual({ done: 8, total: 18 })
    expect(rolloutsAfter(oneFinalist)).toEqual({ done: 8, total: 16 })
    expect(rolloutsAfter(yourAgentWon)).toEqual({ done: 8, total: 10 })
  })

  it.each([
    { ran: 'the agent ran again', rollouts: 1, done: 2 },
    { ran: 'only the judges ran again', rollouts: 0, done: 1 },
  ])('shouldCountTheRolloutsTheOptimizerSpentWhen$ran', ({ rollouts, done }) => {
    const again = [
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', status: 'infrastructure_invalid', error: 'throttled' }),
      optimizerTrial({ candidate: 'base', caseName: 'a', rollouts, previousRollouts: [1] }),
    ]

    expect(rolloutsAfter(again)).toEqual({ done, total: 29 + done })
  })
})

describe('optimization phase', () => {
  it('shouldMeasureYourAgentUntilTheBaselineScoreArrives', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a' }),
    ]).progress()

    expect(progress.phase).toBe('baseline')
    expect(progress).not.toHaveProperty('baseline')
  })

  it('shouldSayTheProposerIsWorkingWhenTheBaselineIsScoredAndNoVersionIsProposedYet', () => {
    expect(readerOf(measuredBaseline()).progress()).toMatchObject({ phase: 'proposing', baseline: 0.5, tried: 0 })
  })

  it('shouldScoreAVersionAsSoonAsItIsProposedAndNotCountItAsTriedYet', () => {
    const progress = readerOf([
      ...measuredBaseline(),
      ...proposed('v1', 1),
      ...proposed('v2', 2),
      optimizerTrial({ candidate: 'v1', caseName: 'a' }),
    ]).progress()

    expect(progress).toMatchObject({ phase: 'scoring', tried: 0 })
  })

  it('shouldCountAVersionAsTriedWhenItsTrainScoreArrives', () => {
    const progress = readerOf([...measuredBaseline(), ...scoredOnTrain('v1', 1), ...proposed('v2', 2)]).progress()

    expect(progress).toMatchObject({ phase: 'scoring', tried: 1 })
  })

  it('shouldCheckTheFinalistsOnceTheyAreNamedAndTestOnceTheWinnerIsPicked', () => {
    const finalists = [...measuredBaseline(), ...proposed('v1', 1), optimizerFinalists(['v1', 'base'])]

    expect(readerOf(finalists).progress().phase).toBe('validating')
    expect(readerOf([...finalists, optimizerPicked('v1')]).progress().phase).toBe('testing')
  })

  it.each([
    ['TheTest', [optimizerFinalists(['v1', 'base']), optimizerPicked('v1'), optimizerTested('v1', 'base', 0.2, 2)]],
    ['AFailedStop', [optimizerStop('proposer_error', 'the proposer raised')]],
  ])('shouldShowNoPhaseAfter%s', (_case, end) => {
    expect(readerOf([...measuredBaseline(), ...proposed('v1', 1), ...end]).progress()).not.toHaveProperty('phase')
  })
})

describe('optimization run', () => {
  it.each([
    ['NoRunFolder', false, false],
    ['ARunFolderWithoutAResult', true, false],
    ['ARunFolderWithAResult', true, true],
  ])('shouldSeeAFinishedRunOnlyWhenTheRecordHas%s', async (_case, started, finished) => {
    const record = join(await temporaryDirectory(), 'optimizer')
    if (started) await writeOptimizerRun(record, [optimizerConfig()], finished ? { baseline_id: 'base' } : undefined)

    expect(await hasEvalsRunResult(record)).toBe(finished)
  })

  it('shouldReportTheBaselineTheLeaderAndTheVersionsTriedWhenTheSearchRuns', () => {
    expect(readerOf(searchLines()).progress()).toMatchObject({
      run: 'r1',
      record: '/w/r1',
      baseline: 0.5,
      best: 0.8,
      tried: 2,
    })
  })

  it('shouldIgnoreLinesWhenTheyAreBlankOrNotEvents', () => {
    expect(readerOf(['', 'not json', '{"type":"study"}', ...searchLines()]).progress().tried).toBe(2)
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

  it.each([
    [
      'ACredentialErrorType',
      'ProfileNotFound',
      'The config profile (dev) could not be found',
      `The proposer failed with ProfileNotFound: The config profile (dev) could not be found. ${PROPOSER_CREDENTIALS}`,
    ],
    [
      'ACredentialErrorInItsText',
      'ClientError',
      'An error occurred (ExpiredTokenException) when calling the ConverseStream operation: the token is expired',
      'The proposer failed with ClientError: An error occurred (ExpiredTokenException) when calling the ' +
        `ConverseStream operation: the token is expired. ${PROPOSER_CREDENTIALS}`,
    ],
    ['AnotherError', 'RuntimeError', 'model down', 'The proposer failed with RuntimeError: model down.'],
    [
      'AnErrorThatEndsWithAPeriod',
      'AccessDeniedException',
      'You do not have access to the model.',
      `The proposer failed with AccessDeniedException: You do not have access to the model. ${PROPOSER_CREDENTIALS}`,
    ],
  ])('shouldNameTheProposerErrorWhenTheRunStopsBecauseOf%s', (_case, type, error, message) => {
    const outcome = readerOf([
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      proposerError(type, error),
      optimizerStop('proposer_error', PROPOSER_STOP_MESSAGE),
    ]).outcome()

    expect(outcome).toMatchObject({ ended: 'stopped', error: message })
  })

  it('shouldReportTheStopMessageWhenTheProposerFailedWithoutAnErrorEvent', () => {
    const outcome = readerOf([
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      optimizerStop('proposer_error', PROPOSER_STOP_MESSAGE),
    ]).outcome()

    expect(outcome).toMatchObject({ ended: 'stopped', error: PROPOSER_STOP_MESSAGE })
  })

  it('shouldStopWithTheProposerErrorWhenTheSearchEndsOnAProposerErrorWithoutAStopEvent', () => {
    const outcome = readerOf([
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      optimizerProposerError('RuntimeError', 'model down'),
    ]).outcome()

    expect(outcome).toMatchObject({ ended: 'stopped', error: 'The proposer failed with RuntimeError: model down.' })
  })

  it('shouldReportRunningAgainWhenTheRunResumesAfterAProposerError', () => {
    const outcome = readerOf([
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      optimizerProposerError('RuntimeError', 'model down'),
      optimizerResume(),
    ]).outcome()

    expect(outcome.ended).toBe('running')
    expect(outcome.error).toBeUndefined()
  })

  it('shouldNameTheProposerFailureOfARecordWhenItsRunStoppedOnAProposerError', async () => {
    const record = await temporaryDirectory()
    await writeOptimizerRun(record, [
      optimizerConfig(),
      ...optimizerCandidate(baseline),
      optimizerProposerError('RuntimeError', 'model down'),
    ])

    await expect(readEvalsProposerFailure(record)).resolves.toBe('The proposer failed with RuntimeError: model down.')
  })

  it.each([
    ['ASetupStop', [optimizerStop('setup', 'the baseline is unmeasured')]],
    ['NoStop', []],
  ])('shouldGiveNoProposerFailureWhenTheRunHas%s', async (_case, lines) => {
    const record = await temporaryDirectory()
    await writeOptimizerRun(record, [optimizerConfig(), ...optimizerCandidate(baseline), ...lines])

    await expect(readEvalsProposerFailure(record)).resolves.toBeUndefined()
  })

  it('shouldReportRunningAndTheLeaderWhenNoChampionIsPickedYet', () => {
    expect(readerOf(searchLines()).outcome()).toMatchObject({ ended: 'running', best: { number: 1 } })
  })

  it('shouldShipTheBaselineWhenItIsTheChampion', async () => {
    const record = await temporaryDirectory()
    await writeOptimizerRun(record, [...searchLines(), optimizerStop(), optimizerPicked('base')])

    const outcome = await readEvalsStudy(record)

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

    const outcome = await readEvalsStudy(record)

    expect(outcome).toMatchObject({ ended: 'finished', best: { number: 1 }, test: { difference: 0.2, cases: 3 } })
  })

  it('shouldExplainTheFolderWhenItHasNoRun', async () => {
    const record = await temporaryDirectory()

    await expect(readEvalsStudy(record)).rejects.toThrow('has no optimization run with events.jsonl')
  })

  it('shouldFollowTheRunFolderWhenItAppearsAfterTheTailStarts', async () => {
    const record = await temporaryDirectory()
    const lines: string[] = []
    const tail = tailEvalsRun(record, (line) => lines.push(line))

    await mkdir(join(record, OPTIMIZER_RUN_FOLDER), { recursive: true })
    await appendFile(join(record, OPTIMIZER_RUN_FOLDER, 'events.jsonl'), `${optimizerConfig()}\n`)

    await vi.waitFor(() => expect(lines).toEqual([optimizerConfig()]), { timeout: 5000 })
    await tail.stop()
  })
})

const RUN_START = Date.UTC(2026, 10, 16, 22, 0, 0)

const at = (seconds: number): string => new Date(RUN_START + seconds * 1000).toISOString()

const usageLines = ({ trials, proposer, seconds }: { trials: number[]; proposer?: number; seconds: number }) => [
  optimizerConfig(),
  ...trials.map((tokens, index) =>
    JSON.stringify({
      event: 'trial',
      iteration: 0,
      record: { usage: { tokens }, judge_usage: { OutputEvaluator: { tokens: 50 }, Equals: { tokens: 0 } } },
      time: at(index),
    })
  ),
  ...(proposer === undefined
    ? []
    : [JSON.stringify({ event: 'proposer_usage', iteration: 1, usage: { tokens: proposer }, time: at(1) })]),
  JSON.stringify({ event: 'stop', iteration: 1, reason: 'iterations', message: 'done', time: at(seconds) }),
]

const writeUsageRun = async (workspace: string, run: string, lines: readonly string[]): Promise<void> => {
  const [, stamp = '', experiment = ''] = /^(\d{8}-\d{6})-(.+)$/u.exec(run) ?? []
  const home = join(evalsExperimentsFolder(workspace), experiment)
  await writeOptimizerRun(evalsOptimizationFiles(home, stamp).record, lines)
}

describe('usage of earlier optimization runs', () => {
  it('shouldSumTheAgentJudgeAndProposerTokensOfTheNewestRunsOfTheExperiment', async () => {
    const folder = await temporaryDirectory()
    await writeUsageRun(
      folder,
      '20261116-220000-refunds',
      usageLines({ trials: [100, 300], proposer: 1000, seconds: 100 })
    )
    await writeUsageRun(folder, '20261116-210000-refunds', usageLines({ trials: [150], seconds: 10 }))
    await writeUsageRun(folder, '20261116-230000-capital', usageLines({ trials: [999], seconds: 5 }))

    const profile = await readEvalsUsageProfile(folder, 'refunds')

    expect(profile).toEqual({
      experiment: 'refunds',
      runs: [
        { rollouts: 2, tokens: 1500, seconds: 100 },
        { rollouts: 1, tokens: 200, seconds: 10 },
      ],
    })
  })

  it('shouldUseOnlyTheThreeNewestRunsOfTheExperiment', async () => {
    const folder = await temporaryDirectory()
    for (const hour of ['18', '19', '20', '21'])
      await writeUsageRun(folder, `20261116-${hour}0000-refunds`, usageLines({ trials: [Number(hour)], seconds: 10 }))

    const profile = await readEvalsUsageProfile(folder, 'refunds')

    expect(profile?.runs.map(({ tokens }) => tokens - 50)).toEqual([21, 20, 19])
  })

  it('shouldUseTheNewestRunOfAnotherExperimentWhenTheExperimentHasNoRunWithTrials', async () => {
    const folder = await temporaryDirectory()
    await writeUsageRun(folder, '20261116-230000-refunds', usageLines({ trials: [], seconds: 10 }))
    await writeUsageRun(folder, '20261116-220000-capital', usageLines({ trials: [100], seconds: 30 }))
    await writeUsageRun(folder, '20261116-210000-billing', usageLines({ trials: [500], seconds: 60 }))

    const profile = await readEvalsUsageProfile(folder, 'refunds')

    expect(profile).toEqual({ experiment: 'capital', runs: [{ rollouts: 1, tokens: 150, seconds: 30 }] })
  })

  it.each([
    ['NoRunHasTrials', [['20261116-230000-refunds', usageLines({ trials: [], seconds: 10 })]] as const],
    ['TheFolderIsEmpty', [] as const],
  ])('shouldGiveNoProfileWhen%s', async (_case, runs) => {
    const folder = await temporaryDirectory()
    for (const [name, lines] of runs) await writeUsageRun(folder, name, lines)

    expect(await readEvalsUsageProfile(folder, 'refunds')).toBeUndefined()
  })

  it('shouldGiveNoProfileWhenTheWorkspaceFolderIsMissing', async () => {
    const folder = await temporaryDirectory()

    expect(await readEvalsUsageProfile(join(folder, 'missing'), 'refunds')).toBeUndefined()
  })
})
