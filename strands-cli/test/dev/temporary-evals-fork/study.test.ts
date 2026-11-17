import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { measuredVersions, type EvalCase } from '../../../src/dev/panels/model.js'
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
  optimizerFinalists,
  optimizerIterationEnd,
  optimizerPicked,
  optimizerStop,
  optimizerTested,
  optimizerTrial,
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

const readerOf = (lines: readonly string[], labels: Record<string, string> = {}, cases?: readonly EvalCase[]) => {
  const reader = temporaryStudyReader({ run: 'r1', record: '/w/r1', startedAt: 7, labels, ...(cases ? { cases } : {}) })
  lines.forEach((line) => reader.push(line))
  return reader
}

const SPLIT = { train: ['a', 'b', 'c', 'd'], validation: ['e', 'f'], test: ['g', 'h'] }

const CASES: readonly EvalCase[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => ({
  name,
  input: `question ${name}`,
  expected: `answer ${name}`,
}))

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

describe('TEMPORARY optimization trials', () => {
  it('shouldCountTheBaselineTrialsAndShowThemBeforeItsScoreArrives', () => {
    const progress = readerOf(
      [
        optimizerConfig({ cases: SPLIT }),
        ...optimizerCandidate(base),
        optimizerTrial({ candidate: 'base', caseName: 'a', score: 1, reason: 'Right answer', output: 'answer a' }),
        optimizerTrial({ candidate: 'base', caseName: 'b', score: 0, reason: 'Wrong city', output: 'rome' }),
      ],
      {},
      CASES
    ).progress()

    expect(progress.step).toEqual({ kind: 'baseline', trials: { done: 2, total: 4 } })
    expect(progress.baselineCandidate?.trials).toEqual([
      {
        name: 'a',
        input: 'question a',
        expected: 'answer a',
        actual: 'answer a',
        passed: true,
        verdicts: [{ evaluator: 'OutputEvaluator', score: 1, passed: true, reason: 'Right answer' }],
      },
      {
        name: 'b',
        input: 'question b',
        expected: 'answer b',
        actual: 'rome',
        passed: false,
        verdicts: [{ evaluator: 'OutputEvaluator', score: 0, passed: false, reason: 'Wrong city' }],
      },
    ])
  })

  it('shouldSayTheProposerIsWorkingWhenTheBaselineIsScoredAndNoVersionIsProposedYet', () => {
    expect(readerOf(measuredBaseline()).progress().step).toEqual({ kind: 'proposing', iteration: 1 })
  })

  it('shouldListEachVersionWithItsTrialsAsSoonAsItIsProposed', () => {
    const progress = readerOf([
      ...measuredBaseline(),
      ...proposed('v1', 1),
      ...proposed('v2', 2),
      optimizerTrial({ candidate: 'v1', caseName: 'a' }),
      optimizerTrial({ candidate: 'v1', caseName: 'b', score: 0 }),
    ]).progress()

    expect(progress.step).toEqual({ kind: 'scoring', iteration: 1, versions: 2, trials: { done: 2, total: 8 } })
    expect(
      progress.candidates.map(({ number, scoring, trials, rationale }) => ({
        number,
        scoring,
        trials: trials?.map(({ name, passed }) => [name, passed]),
        rationale,
      }))
    ).toEqual([
      {
        number: 1,
        scoring: { done: 2, total: 4, score: 0.5 },
        trials: [
          ['a', true],
          ['b', false],
        ],
        rationale: 'Version 1 checks the date.',
      },
      { number: 2, scoring: { done: 0, total: 4 }, trials: [], rationale: 'Version 2 checks the date.' },
    ])
    expect(measuredVersions(progress)).toBe(1)
  })

  it('shouldShowYourAgentAsARowThatScoresUntilTheBaselineScoreArrives', () => {
    const scoring = readerOf([
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', score: 1 }),
    ]).progress()
    const measured = readerOf(measuredBaseline()).progress()

    expect(scoring.baselineCandidate).toMatchObject({
      number: 0,
      summary: 'your agent as it is',
      scoring: { done: 1, total: 4, score: 1 },
    })
    expect(measured.baselineCandidate).toMatchObject({ number: 0, score: 0.5 })
    expect(measured.baselineCandidate).not.toHaveProperty('scoring')
  })

  it.each([
    ['TheMeanOfEveryEvaluator', 'WeightedSum(Maximize(Contains), Maximize(Equals))', 0.5],
    ['OneEvaluator', 'Maximize(Equals)', 0],
  ])('shouldScoreTheTrialsSoFarByTheObjectiveWhenItIs%s', (_case, objective, score) => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT, objective }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', scores: { Contains: 1, Equals: 0 } }),
    ]).progress()

    expect(progress.baselineCandidate?.scoring?.score).toBe(score)
  })

  it('shouldCountATrialThatFailedAsZeroInTheScoreSoFar', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', score: 1 }),
      optimizerTrial({ candidate: 'base', caseName: 'b', status: 'agent_failure', error: 'boom' }),
    ]).progress()

    expect(progress.baselineCandidate?.scoring).toEqual({ done: 2, total: 4, score: 0.5 })
  })

  it('shouldStopCountingAVersionAsScoringWhenItsTrainScoreArrives', () => {
    const progress = readerOf([
      ...measuredBaseline(),
      ...proposed('v1', 1),
      ...SPLIT.train.map((caseName) => optimizerTrial({ candidate: 'v1', caseName })),
      ...optimizerCandidate({ id: 'v1', number: 1, iteration: 1, values: {}, train: 1 }).slice(1),
    ]).progress()

    expect(progress.candidates[0]).not.toHaveProperty('scoring')
    expect(progress.candidates[0]?.score).toBe(1)
    expect(measuredVersions(progress)).toBe(2)
  })

  it('shouldCountTheValidationTrialsOfTheFinalistsAndYourAgent', () => {
    const progress = readerOf([
      ...measuredBaseline(),
      ...proposed('v1', 1),
      optimizerFinalists(['v1', 'base']),
      optimizerTrial({ candidate: 'v1', caseName: 'e', split: 'validation' }),
    ]).progress()

    expect(progress.step).toEqual({ kind: 'validating', versions: 2, trials: { done: 1, total: 4 } })
  })

  it('shouldCountTheTestTrialsOfTheWinnerAndYourAgent', () => {
    const progress = readerOf([
      ...measuredBaseline(),
      ...proposed('v1', 1),
      optimizerFinalists(['v1', 'base']),
      optimizerPicked('v1'),
      optimizerTrial({ candidate: 'base', caseName: 'g', split: 'test' }),
    ]).progress()

    expect(progress.step).toEqual({ kind: 'testing', versions: 2, trials: { done: 1, total: 4 } })
  })

  it('shouldCountOnlyYourAgentWhenNoCandidateIsAFinalistOrTheWinner', () => {
    const validating = readerOf([...measuredBaseline(), optimizerStop(), optimizerFinalists([])]).progress()
    const testing = readerOf([
      ...measuredBaseline(),
      optimizerStop(),
      optimizerFinalists([]),
      optimizerPicked('base'),
    ]).progress()

    expect(validating.step).toEqual({ kind: 'validating', versions: 1, trials: { done: 0, total: 2 } })
    expect(testing.step).toEqual({ kind: 'testing', versions: 1, trials: { done: 0, total: 2 } })
  })

  it.each([
    ['TheTest', [optimizerFinalists(['v1', 'base']), optimizerPicked('v1'), optimizerTested('v1', 'base', 0.2, 2)]],
    ['AFailedStop', [optimizerStop('proposer_error', 'the proposer raised')]],
  ])('shouldShowNoStepAfter%s', (_case, end) => {
    expect(readerOf([...measuredBaseline(), ...proposed('v1', 1), ...end]).progress().step).toBeUndefined()
  })

  it('shouldCountTokensAsTheScoreSoFarWhenTheObjectiveMinimizesTokens', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT, objective: 'Minimize(tokens)' }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a' }),
    ]).progress()

    expect(progress.metric).toBe('fewer tokens')
    expect(progress.measure).toEqual({ kind: 'metric', metric: 'tokens', usage: true, lower: true })
    expect(progress.baselineCandidate?.scoring).toEqual({ done: 1, total: 4, score: -12 })
  })

  it.each([
    ['ATradeOff', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', { kind: 'combined' }],
    ['TheMeanOfEveryEvaluator', 'WeightedSum(Maximize(Contains), Maximize(Equals))', { kind: 'score' }],
    ['OneEvaluator', 'Maximize(Equals)', { kind: 'metric', metric: 'Equals', usage: false, lower: false }],
  ])('shouldMeasureTheObjectiveWhenItIs%s', (_case, objective, measure) => {
    expect(readerOf([optimizerConfig({ objective })]).progress().measure).toEqual(measure)
  })

  it('shouldGiveNoScoreSoFarWhenTheObjectiveCombinesGoals', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT, objective: 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))' }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', scores: { Contains: 1 } }),
    ]).progress()

    expect(progress.baselineCandidate?.scoring).toEqual({ done: 1, total: 4 })
  })

  it('shouldKeepOnlyTheLastTrialWhenACaseRanAgain', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', status: 'infrastructure_invalid', error: 'throttled' }),
      optimizerTrial({ candidate: 'base', caseName: 'a', score: 1 }),
    ]).progress()

    expect(progress.baselineCandidate?.trials?.map(({ name, passed }) => [name, passed])).toEqual([['a', true]])
    expect(progress.step).toEqual({ kind: 'baseline', trials: { done: 1, total: 4 } })
  })

  it('shouldNameTheSplitAndTheRunOfATrialBeyondTheFirstTrainRun', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT, runs: 2 }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', run: 1 }),
      optimizerTrial({ candidate: 'base', caseName: 'e', split: 'validation' }),
    ]).progress()

    expect(progress.baselineCandidate?.trials?.map(({ name }) => name)).toEqual(['a · run 2', 'e · validation'])
    expect(progress.step).toEqual({ kind: 'baseline', trials: { done: 1, total: 8 } })
  })

  it('shouldShowTheErrorOfATrialThatFailedAsItsReason', () => {
    const progress = readerOf([
      optimizerConfig({ cases: SPLIT }),
      ...optimizerCandidate(base),
      optimizerTrial({ candidate: 'base', caseName: 'a', status: 'agent_failure', error: 'the model timed out' }),
    ]).progress()

    expect(progress.baselineCandidate?.trials).toEqual([
      {
        name: 'a',
        input: '',
        passed: false,
        verdicts: [{ evaluator: 'agent_failure', score: 0, passed: false, reason: 'AgentError: the model timed out' }],
      },
    ])
  })
})

describe('TEMPORARY optimization run', () => {
  it.each([
    ['OneEvaluator', 'Maximize(OutputEvaluator)', 'OutputEvaluator'],
    ['TheMeanOfEveryEvaluator', 'WeightedSum(Maximize(Contains), Maximize(Equals))', 'mean of Contains, Equals'],
    [
      'AnUnknownObjective',
      'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))',
      'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))',
    ],
  ])('shouldNameTheObjectiveWhenTheRunOptimizes%s', (_case, objective, metric) => {
    const progress = readerOf([optimizerConfig({ objective })]).progress()

    expect(progress.metric).toBe(metric)
  })

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
        trials: [],
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
        trials: [expect.objectContaining({ name: 'first', passed: false })],
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
