import { describe, expect, it } from 'vitest'

import {
  TEMPORARY_DECISION_CHOICES,
  TEMPORARY_DECISION_DEFAULTS,
  TEMPORARY_ITERATION_CHOICES,
  TEMPORARY_OPTIMIZE_DEFAULTS,
  TEMPORARY_PICK_QUANTILES,
  TEMPORARY_TEST_SHARES,
  temporaryCaseSplit,
  temporaryNearestSplit,
  temporaryOptimizeWarning,
  temporaryRolloutEstimate,
  temporarySplitChoices,
  temporarySplitShares,
  temporaryValidatedFinalists,
  type TemporarySplitShares,
} from '../../../src/dev/temporary-evals-fork/plan.js'

const DEFAULT_SPLIT: TemporarySplitShares = [0.5, 0.25, 0.25]

describe('TEMPORARY optimize plan', () => {
  it.each([
    { cases: 0, split: DEFAULT_SPLIT, counts: [0, 0, 0] },
    { cases: 1, split: DEFAULT_SPLIT, counts: [1, 0, 0] },
    { cases: 2, split: DEFAULT_SPLIT, counts: [1, 1, 0] },
    { cases: 5, split: DEFAULT_SPLIT, counts: [3, 1, 1] },
    { cases: 6, split: DEFAULT_SPLIT, counts: [3, 2, 1] },
    { cases: 7, split: DEFAULT_SPLIT, counts: [3, 2, 2] },
    { cases: 10, split: DEFAULT_SPLIT, counts: [5, 3, 2] },
    { cases: 11, split: DEFAULT_SPLIT, counts: [5, 3, 3] },
    { cases: 3, split: [0.6, 0.2, 0.2], counts: [2, 1, 0] },
    { cases: 12, split: [0.6, 0.2, 0.2], counts: [7, 3, 2] },
    { cases: 5, split: [0.34, 0.33, 0.33], counts: [2, 2, 1] },
    { cases: 5, split: [0.1, 0.45, 0.45], counts: [1, 2, 2] },
    { cases: 6, split: [0.1, 0.45, 0.45], counts: [0, 3, 3] },
  ] as const)('shouldDealCasesLikeTheForkWhen$casesCasesUse$split', ({ cases, split, counts }) => {
    const [train, validation, test] = counts

    expect(temporaryCaseSplit(cases, split)).toEqual({ train, validation, test })
  })

  it('shouldUseTheForkDefaultSplitWhenNoSplitIsGiven', () => {
    expect(TEMPORARY_OPTIMIZE_DEFAULTS).toEqual({
      split: DEFAULT_SPLIT,
      repetitions: 1,
      width: 4,
      iterations: 4,
      concurrency: 4,
      maxRollouts: 500,
      seed: 0,
      decision: { feasibility: 0.9, crashScore: 'worst', pickRule: 'mean', finalists: 3 },
    })
    expect(temporaryCaseSplit(8)).toEqual({ train: 4, validation: 2, test: 2 })
  })

  it('shouldOfferTheForkDefaultOfEachDecisionSettingWhenTheChoicesAreShown', () => {
    expect(TEMPORARY_DECISION_CHOICES.feasibility).toContain(TEMPORARY_DECISION_DEFAULTS.feasibility)
    expect(TEMPORARY_DECISION_CHOICES.crashScore).toContain(TEMPORARY_DECISION_DEFAULTS.crashScore)
    expect(TEMPORARY_DECISION_CHOICES.pickRule).toContain(TEMPORARY_DECISION_DEFAULTS.pickRule)
    expect(TEMPORARY_DECISION_CHOICES.finalists).toContain(TEMPORARY_DECISION_DEFAULTS.finalists)
  })

  it('shouldGiveEachLowerBoundAQuantileThatTheForkAccepts', () => {
    expect(Object.values(TEMPORARY_PICK_QUANTILES).every((quantile) => quantile > 0 && quantile < 0.5)).toBe(true)
    expect(TEMPORARY_DECISION_CHOICES.pickRule.filter((rule) => rule !== 'mean').sort()).toEqual(
      Object.keys(TEMPORARY_PICK_QUANTILES).sort()
    )
  })

  it.each([
    { finalists: 3, pareto: false, validated: 3 },
    { finalists: 1, pareto: false, validated: 1 },
    { finalists: 3, pareto: true, validated: 5 },
    { finalists: 8, pareto: true, validated: 8 },
  ])(
    'shouldValidate$validatedFinalistsWhen$finalistsAreAskedAndParetoIs$pareto',
    ({ finalists, pareto, validated }) => {
      expect(temporaryValidatedFinalists(finalists, pareto)).toBe(validated)
    }
  )

  it('shouldOfferTheDefaultIterationsWhenTheIterationChoicesAreShown', () => {
    expect(TEMPORARY_ITERATION_CHOICES).toEqual([1, 2, 4, 6, 8])
    expect(TEMPORARY_ITERATION_CHOICES).toContain(TEMPORARY_OPTIMIZE_DEFAULTS.iterations)
  })

  it.each([
    { repetitions: 1, iterations: 4, width: 4, evaluators: 1, rollouts: 80, judgeCalls: 80 },
    { repetitions: 2, iterations: 4, width: 4, evaluators: 3, rollouts: 160, judgeCalls: 480 },
    { repetitions: 1, iterations: 0, width: 4, evaluators: 2, rollouts: 16, judgeCalls: 32 },
  ])(
    'shouldCountEveryRolloutWhenTheStudyRuns$iterationsIterationsOf$repetitionsRepetitions',
    ({ repetitions, iterations, width, evaluators, rollouts, judgeCalls }) => {
      const split = { train: 4, validation: 2, test: 2 }

      const estimate = temporaryRolloutEstimate({ split, repetitions, iterations, width, evaluators })

      expect(estimate).toEqual({ rollouts, judgeCalls })
    }
  )

  it.each([
    { finalists: 3, pareto: false, rollouts: 80 },
    { finalists: 1, pareto: false, rollouts: 76 },
    { finalists: 5, pareto: false, rollouts: 84 },
    { finalists: 3, pareto: true, rollouts: 92 },
  ])(
    'shouldReserveTheEndPhaseLikeTheOptimizerWhen$finalistsFinalistsAreAskedAndParetoIs$pareto',
    ({ finalists, pareto, rollouts }) => {
      const split = { train: 4, validation: 2, test: 2 }

      const estimate = temporaryRolloutEstimate({
        split,
        repetitions: 1,
        iterations: 4,
        width: 4,
        evaluators: 1,
        finalists,
        pareto,
      })

      expect(estimate.rollouts).toBe(rollouts)
    }
  )

  it('shouldScaleTheTokensAndTheTimeOfEachEarlierRunWhenAProfileIsGiven', () => {
    const split = { train: 4, validation: 2, test: 2 }
    const profile = {
      experiment: 'refunds',
      runs: [
        { rollouts: 40, tokens: 400_000, seconds: 200 },
        { rollouts: 20, tokens: 300_000, seconds: 80 },
      ],
    }

    const estimate = temporaryRolloutEstimate({
      split,
      repetitions: 1,
      iterations: 4,
      width: 4,
      evaluators: 0,
      profile,
    })

    expect(estimate).toEqual({
      rollouts: 80,
      judgeCalls: 0,
      usage: {
        tokens: { low: 800_000, high: 1_200_000 },
        seconds: { low: 320, high: 400 },
        basedOn: { experiment: 'refunds', runs: 2 },
      },
    })
  })

  it.each([
    { cases: 0, split: DEFAULT_SPLIT, warning: 'The experiment has no cases, so the optimizer refuses to run. Add 7' },
    {
      cases: 4,
      split: [0.1, 0.45, 0.45],
      warning: 'leaves no train cases, so the optimizer refuses to run. Add 1 more case.',
    },
    {
      cases: 5,
      split: DEFAULT_SPLIT,
      warning: 'leaves 1 validation case and 1 test case, so the scores can be luck. Add 2',
    },
    { cases: 6, split: DEFAULT_SPLIT, warning: 'leaves 2 validation cases and 1 test case' },
    { cases: 10, split: [1, 0, 0], warning: 'Give the validation and test shares more of the cases.' },
    { cases: 8, split: [0.5, 0.5, 0.5], warning: 'The three split shares must add up to 1.' },
    { cases: 8, split: [0, 0.5, 0.5], warning: 'the train share must be more than 0' },
  ] as const)('shouldWarnWhen$casesCasesUse$split', ({ cases, split, warning }) => {
    expect(temporaryOptimizeWarning(cases, split)).toContain(warning)
  })

  it.each([7, 8, 40])('shouldNotWarnWhen%iCasesLeaveTwoOfEachPart', (cases) => {
    expect(temporaryOptimizeWarning(cases)).toBeUndefined()
  })

  it('shouldNotAskForTestCasesWhenTheSplitChoosesNone', () => {
    expect(temporaryOptimizeWarning(4, [0.5, 0.5, 0])).toBeUndefined()
    expect(temporaryOptimizeWarning(3, [0.7, 0.3, 0])).toBe(
      'The split leaves 1 validation case, so the scores can be luck. Add 3 more cases.'
    )
  })

  it.each([
    {
      cases: 20,
      choices: [
        [6, 7, 7],
        [8, 6, 6],
        [10, 5, 5],
        [12, 4, 4],
        [14, 3, 3],
        [16, 2, 2],
      ],
    },
    {
      cases: 4,
      choices: [
        [1, 2, 1],
        [2, 1, 1],
        [3, 1, 0],
      ],
    },
    { cases: 1, choices: [] },
  ])('shouldOfferEachDistinctSplitWithTrainAndValidationCasesWhenTheExperimentHas$casesCases', ({ cases, choices }) => {
    expect(temporarySplitChoices(cases).map(({ train, validation, test }) => [train, validation, test])).toEqual(
      choices
    )
  })

  it.each([
    {
      share: 1 / 3,
      choices: [
        [6, 9, 5],
        [8, 8, 4],
        [10, 7, 3],
        [12, 5, 3],
        [14, 4, 2],
        [16, 3, 1],
      ],
    },
    {
      share: 0,
      choices: [
        [6, 14, 0],
        [8, 12, 0],
        [10, 10, 0],
        [12, 8, 0],
        [14, 6, 0],
        [16, 4, 0],
      ],
    },
  ])('shouldGiveTheTestCasesTheirShareOfTheHeldOutCasesWhenTheTestShareIs$share', ({ share, choices }) => {
    expect(TEMPORARY_TEST_SHARES).toContain(share)
    expect(temporarySplitChoices(20, share).map(({ train, validation, test }) => [train, validation, test])).toEqual(
      choices
    )
  })

  it.each([
    { split: { train: 10, validation: 5, test: 5 }, nearest: { train: 10, validation: 10, test: 0 } },
    { split: { train: 11, validation: 5, test: 4 }, nearest: { train: 10, validation: 10, test: 0 } },
    { split: { train: 17, validation: 2, test: 1 }, nearest: { train: 16, validation: 4, test: 0 } },
  ])('shouldKeepTheTrainCountClosestToTheCurrentOneWhenTheChoicesChange', ({ split, nearest }) => {
    expect(temporaryNearestSplit(temporarySplitChoices(20, 0), split)).toEqual(nearest)
  })

  it('shouldFindNoSplitWhenThereIsNoChoice', () => {
    expect(temporaryNearestSplit([], { train: 1, validation: 1, test: 1 })).toBeUndefined()
  })

  it.each([4, 7, 20, 33])('shouldOfferTheDefaultSplitWhenTheExperimentHas%iCases', (cases) => {
    expect(temporarySplitChoices(cases)).toContainEqual(temporaryCaseSplit(cases))
  })

  it.each([4, 7, 20, 33])('shouldGiveTheForkSharesThatDealTheChosenCountsWhenTheExperimentHas%iCases', (cases) => {
    const choices = temporarySplitChoices(cases)

    const shares = choices.map(temporarySplitShares)

    expect(shares.map((share) => temporaryCaseSplit(cases, share))).toEqual(choices)
    expect(shares.map(([train, validation, test]) => Math.abs(train + validation + test - 1) < 1e-9)).toEqual(
      choices.map(() => true)
    )
  })

  it('shouldGiveTheDefaultSharesWhenTheSplitHasNoCases', () => {
    expect(temporarySplitShares({ train: 0, validation: 0, test: 0 })).toEqual(DEFAULT_SPLIT)
  })
})
