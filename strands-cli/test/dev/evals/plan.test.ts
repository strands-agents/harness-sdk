import { describe, expect, it } from 'vitest'

import {
  isEvalsBudgetValue,
  EVALS_DECISION_CHOICES,
  EVALS_DECISION_DEFAULTS,
  EVALS_OPTIMIZE_DEFAULTS,
  EVALS_PICK_QUANTILES,
  EVALS_TEST_SHARES,
  evalsCaseSplit,
  evalsOptimizeWarning,
  evalsRolloutEstimate,
  evalsRolloutPhases,
  evalsSplitChoices,
  evalsSplitShares,
  evalsValidatedFinalists,
  type EvalsSplitShares,
} from '../../../src/dev/evals/plan.js'

const DEFAULT_SPLIT: EvalsSplitShares = [0.5, 0.25, 0.25]

describe('optimize plan', () => {
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
  ] as const)('shouldDealCasesLikeStrandsEvalsWhen$casesCasesUse$split', ({ cases, split, counts }) => {
    const [train, validation, test] = counts

    expect(evalsCaseSplit(cases, split)).toEqual({ train, validation, test })
  })

  it('shouldUseStrandsEvalsDefaultSplitWhenNoSplitIsGiven', () => {
    expect(EVALS_OPTIMIZE_DEFAULTS).toEqual({
      split: DEFAULT_SPLIT,
      repetitions: 1,
      width: 4,
      iterations: 4,
      concurrency: 4,
      maxRollouts: 500,
      seed: 0,
      decision: { feasibility: 0.9, crashScore: 'worst', pickRule: 'mean', finalists: 3 },
    })
    expect(evalsCaseSplit(8)).toEqual({ train: 4, validation: 2, test: 2 })
  })

  it('shouldOfferStrandsEvalsDefaultOfEachDecisionSettingWhenTheChoicesAreShown', () => {
    expect(EVALS_DECISION_CHOICES.feasibility).toContain(EVALS_DECISION_DEFAULTS.feasibility)
    expect(EVALS_DECISION_CHOICES.crashScore).toContain(EVALS_DECISION_DEFAULTS.crashScore)
    expect(EVALS_DECISION_CHOICES.pickRule).toContain(EVALS_DECISION_DEFAULTS.pickRule)
  })

  it('shouldGiveEachLowerBoundAQuantileThatStrandsEvalsAccepts', () => {
    expect(Object.values(EVALS_PICK_QUANTILES).every((quantile) => quantile > 0 && quantile < 0.5)).toBe(true)
    expect(EVALS_DECISION_CHOICES.pickRule.filter((rule) => rule !== 'mean').sort()).toEqual(
      Object.keys(EVALS_PICK_QUANTILES).sort()
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
      expect(evalsValidatedFinalists(finalists, pareto)).toBe(validated)
    }
  )

  it('shouldTakeAnyWholeBudgetValueFromTheOptimizerMinimum', () => {
    expect([3, 10, 0].map((value) => isEvalsBudgetValue('iterations', value))).toEqual([true, true, true])
    expect([3, 7, 0, 1.5].map((value) => isEvalsBudgetValue('width', value))).toEqual([true, true, false, false])
  })

  it('shouldSplitTheEstimateIntoTheSearchAndTheTwoChecksThatRunAfterIt', () => {
    const plan = { split: { train: 4, validation: 2, test: 2 }, repetitions: 1, iterations: 1, width: 4, finalists: 2 }

    const phases = evalsRolloutPhases(plan)

    expect(phases).toEqual({ search: 20, validation: 6, test: 4 })
    expect(evalsRolloutEstimate({ ...plan, evaluators: 1 }).rollouts).toBe(
      phases.search + phases.validation + phases.test
    )
  })

  it.each([
    { repetitions: 1, iterations: 4, width: 4, evaluators: 1, rollouts: 80, judgeCalls: 80 },
    { repetitions: 2, iterations: 4, width: 4, evaluators: 3, rollouts: 160, judgeCalls: 480 },
    { repetitions: 1, iterations: 0, width: 4, evaluators: 2, rollouts: 16, judgeCalls: 32 },
  ])(
    'shouldCountEveryRolloutWhenTheStudyRuns$iterationsIterationsOf$repetitionsRepetitions',
    ({ repetitions, iterations, width, evaluators, rollouts, judgeCalls }) => {
      const split = { train: 4, validation: 2, test: 2 }

      const estimate = evalsRolloutEstimate({ split, repetitions, iterations, width, evaluators })

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

      const estimate = evalsRolloutEstimate({
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

    const estimate = evalsRolloutEstimate({
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
    expect(evalsOptimizeWarning(cases, split)).toContain(warning)
  })

  it.each([19, 40])('shouldNotWarnWhen%iCasesLeaveFiveTestCasesOrMore', (cases) => {
    expect(evalsOptimizeWarning(cases)).toBeUndefined()
  })

  it.each([
    { cases: 7, tested: 2 },
    { cases: 8, tested: 2 },
    { cases: 16, tested: 4 },
  ])('shouldSayTheTestIntervalIsWideWhen$casesCasesLeave$testedTestCases', ({ cases, tested }) => {
    expect(evalsOptimizeWarning(cases)).toBe(
      `The split leaves ${tested} test cases, so the interval of the test check will be wide. ` +
        `Add ${19 - cases} more case${19 - cases === 1 ? '' : 's'} to narrow it.`
    )
  })

  it('shouldSayThatOneTrainCaseMakesTheEffectsLessCertain', () => {
    const warning = evalsOptimizeWarning(5, [0.2, 0.4, 0.4])

    expect(warning).toContain('The split leaves 1 train case, so the score model cannot tell the cases apart')
    expect(warning).toContain('The split leaves 2 test cases, so the interval of the test check will be wide.')
  })

  it('shouldNotAskForTestCasesWhenTheSplitChoosesNone', () => {
    expect(evalsOptimizeWarning(4, [0.5, 0.5, 0])).toBeUndefined()
    expect(evalsOptimizeWarning(3, [0.7, 0.3, 0])).toBe(
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
    expect(evalsSplitChoices(cases).map(({ train, validation, test }) => [train, validation, test])).toEqual(choices)
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
    expect(EVALS_TEST_SHARES).toContain(share)
    expect(evalsSplitChoices(20, share).map(({ train, validation, test }) => [train, validation, test])).toEqual(
      choices
    )
  })

  it.each([4, 7, 20, 33])('shouldOfferTheDefaultSplitWhenTheExperimentHas%iCases', (cases) => {
    expect(evalsSplitChoices(cases)).toContainEqual(evalsCaseSplit(cases))
  })

  it.each([4, 7, 20, 33])('shouldGiveStrandsEvalsSharesThatDealTheChosenCountsWhenTheExperimentHas%iCases', (cases) => {
    const choices = evalsSplitChoices(cases)

    const shares = choices.map(evalsSplitShares)

    expect(shares.map((share) => evalsCaseSplit(cases, share))).toEqual(choices)
    expect(shares.map(([train, validation, test]) => Math.abs(train + validation + test - 1) < 1e-9)).toEqual(
      choices.map(() => true)
    )
  })

  it('shouldGiveTheDefaultSharesWhenTheSplitHasNoCases', () => {
    expect(evalsSplitShares({ train: 0, validation: 0, test: 0 })).toEqual(DEFAULT_SPLIT)
  })
})
