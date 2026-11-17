import { describe, expect, it } from 'vitest'

import {
  formatObjective,
  formatObjectiveChange,
  smallSplitWarning,
  type CaseSplit,
  type ObjectiveMeasure,
} from '../../../src/dev/panels/model.js'

const FEWER_TOKENS: ObjectiveMeasure = { kind: 'metric', metric: 'tokens', usage: true, lower: true }
const LESS_TIME: ObjectiveMeasure = { kind: 'metric', metric: 'seconds', usage: true, lower: true }
const LOWER_SCORE: ObjectiveMeasure = { kind: 'metric', metric: 'Harmfulness', usage: false, lower: true }

describe('optimize objective numbers', () => {
  it.each<[string, number, ObjectiveMeasure | undefined, string]>([
    ['AScore', 0.826, undefined, '0.83'],
    ['ACombinedValue', 0.4, { kind: 'combined' }, '0.40'],
    ['TokensToMinimize', -1234.4, FEWER_TOKENS, '1,234 tokens'],
    ['SecondsToMinimize', -2.25, LESS_TIME, '2.3 s'],
    ['AScoreToMinimize', -0.2, LOWER_SCORE, '0.20'],
  ])('shouldShow%s', (_case, value, measure, shown) => {
    expect(formatObjective(value, measure)).toBe(shown)
  })

  it.each<[string, number, ObjectiveMeasure | undefined, string]>([
    ['AScoreGain', 0.11, undefined, '+0.11'],
    ['FewerTokens', 334, FEWER_TOKENS, '334 tokens fewer'],
    ['MoreTokens', -50, FEWER_TOKENS, '50 tokens more'],
    ['LessTime', 1.5, LESS_TIME, '1.5 s less'],
    ['NoChange', 0, FEWER_TOKENS, 'no change in tokens'],
    ['ALowerScore', 0.1, LOWER_SCORE, '-0.10'],
  ])('shouldDescribeTheChangeFor%s', (_case, delta, measure, shown) => {
    expect(formatObjectiveChange(delta, measure)).toBe(shown)
  })
})

describe('optimize split warnings', () => {
  it.each<[string, CaseSplit, string | undefined]>([
    [
      'TwoTestCases',
      { train: 4, validation: 2, test: 2 },
      'The split leaves 2 test cases, so the range of the test check will be wide.',
    ],
    [
      'OneTestCase',
      { train: 3, validation: 2, test: 1 },
      'The split leaves 1 test case, so the range of the test check will be wide.',
    ],
    [
      'OneTrainCase',
      { train: 1, validation: 2, test: 2 },
      'The split leaves 1 train case, so the measured effects are less certain.',
    ],
    ['FiveTestCases', { train: 10, validation: 5, test: 5 }, undefined],
    ['NoTestCase', { train: 3, validation: 2, test: 0 }, undefined],
  ])('shouldWarnLikeTheEvalsSplitWhenTheSplitHas%s', (_case, split, warning) => {
    expect(smallSplitWarning(split)).toBe(warning)
  })
})
