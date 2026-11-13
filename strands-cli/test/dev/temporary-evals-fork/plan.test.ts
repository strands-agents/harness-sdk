import { describe, expect, it } from 'vitest'

import {
  TEMPORARY_ITERATION_CHOICES,
  TEMPORARY_OPTIMIZE_DEFAULTS,
  temporaryCaseSplit,
  temporaryOptimizeWarning,
  temporaryRolloutEstimate,
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
    expect(TEMPORARY_OPTIMIZE_DEFAULTS).toEqual({ split: DEFAULT_SPLIT, repetitions: 1, width: 4, iterations: 4 })
    expect(temporaryCaseSplit(8)).toEqual({ train: 4, validation: 2, test: 2 })
  })

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
})
