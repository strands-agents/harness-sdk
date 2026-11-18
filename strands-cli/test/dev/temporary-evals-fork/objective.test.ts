import { describe, expect, it } from 'vitest'

import {
  checkTemporaryObjective,
  temporaryObjectiveArguments,
  temporaryObjectivePresets,
  temporaryObjectiveFromRequest,
} from '../../../src/dev/temporary-evals-fork/objective.js'

const EVALUATORS = ['Contains', 'Equals']

describe('TEMPORARY optimize objective', () => {
  it.each([
    ['TheMeanOfEveryEvaluator', '', ''],
    ['OneEvaluator', 'Maximize(Contains)', ''],
    ['FewerTokensWithAFloor', 'Minimize(tokens)', 'Contains >= 0.8'],
    ['AWeightedSum', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', ''],
    ['AParetoFront', 'Pareto(Maximize(Contains, weight=2), Minimize(seconds, scale=10))', 'tokens <= 4000'],
    ['AQuotedName', 'Maximize("Equals")', ''],
    ['TwoConstraintsOnOneMetric', 'Maximize(Contains)', 'Equals >= 0.5, Equals <= 1'],
  ])('shouldAccept%s', (_case, expression, constraints) => {
    expect(checkTemporaryObjective({ expression, constraints }, EVALUATORS)).toEqual({})
  })

  it('shouldResolveTheShortNameOfAnEvaluatorTheWayTheApiDoes', () => {
    expect(
      checkTemporaryObjective({ expression: 'Maximize(Helpfulness)', constraints: '' }, ['HelpfulnessEvaluator'])
    ).toEqual({})
  })

  it('shouldAcceptAQuotedNameThatIsNotAPlainWord', () => {
    expect(
      checkTemporaryObjective({ expression: 'Maximize("refund-policy")', constraints: '"refund-policy" >= 0.5' }, [
        'refund-policy',
      ])
    ).toEqual({})
  })

  it.each([
    ['AnUnfinishedCall', 'Maximize(Contains', '', "'Maximize(Contains' does not fit"],
    ['AnUnknownFunction', 'Foo(Contains)', '', "'Foo' does not fit"],
    ['AnUnknownMetric', 'Maximize(Nope)', '', 'Nope is not an evaluator of this experiment or a usage number'],
    ['AWeightOnALoneGoal', 'Maximize(Contains, weight=2)', '', 'weight= and scale= count only inside'],
    [
      'AUsageMetricWithoutAScaleInACombination',
      'WeightedSum(Maximize(Contains), Minimize(tokens))',
      '',
      'tokens needs a scale= inside WeightedSum',
    ],
    ['AMetricTwice', 'WeightedSum(Maximize(Contains), Maximize(Contains))', '', 'Contains is in the objective twice'],
    ['AZeroWeight', 'WeightedSum(Maximize(Contains, weight=0), Maximize(Equals))', '', "'0' does not fit"],
    ['AConstraintWithoutABound', '', 'tokens < 4000', "'tokens < 4000' does not fit"],
    ['AConstraintOnAnUnknownMetric', '', 'Nope >= 1', 'Nope is not an evaluator of this experiment or a usage number'],
  ])('shouldExplainWhatIsWrongWithAnObjectiveThatHas%s', (_case, expression, constraints, problem) => {
    expect(checkTemporaryObjective({ expression, constraints }, EVALUATORS).problem).toContain(problem)
  })

  it('shouldAskForAGoalWhenTheExperimentHasNoEvaluatorAndTheObjectiveIsTheDefault', () => {
    expect(checkTemporaryObjective({ expression: '', constraints: '' }, []).problem).toContain('no evaluator')
  })

  it.each([
    ['NoConstraint', 'Minimize(tokens)', '', true],
    ['OnlyAUsageConstraint', 'Minimize(seconds)', 'tokens <= 4000', true],
    ['AnEvaluatorFloor', 'Minimize(tokens)', 'Contains >= 0.8', false],
    ['AnEvaluatorGoal', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', '', false],
  ])('shouldWarnAboutAUsageOnlyObjectiveWhenItHas%s', (_case, expression, constraints, warns) => {
    const { warning } = checkTemporaryObjective({ expression, constraints }, EVALUATORS)

    expect(warning !== undefined).toBe(warns)
  })

  it.each([
    ['NoFlagsForTheDefault', { expression: '', constraints: '' }, []],
    [
      'TheObjectiveAndEachConstraint',
      { expression: ' Minimize(tokens) ', constraints: 'Contains >= 0.8, tokens <= 4000' },
      ['--objective', 'Minimize(tokens)', '--at-least', 'Contains=0.8', '--at-most', 'tokens=4000'],
    ],
  ])('shouldPass%s', (_case, objective, flags) => {
    expect(temporaryObjectiveArguments(objective)).toEqual(flags)
  })

  it('shouldOfferTheMeanEachEvaluatorAndTheUsageTradeOffsAsPresets', () => {
    expect(temporaryObjectivePresets(EVALUATORS)).toEqual([
      { label: 'the mean of every evaluator', objective: { expression: '', constraints: '' } },
      { label: 'Contains only', objective: { expression: 'Maximize(Contains)', constraints: '' } },
      { label: 'Equals only', objective: { expression: 'Maximize(Equals)', constraints: '' } },
      {
        label: 'fewer tokens, each evaluator at least 0.8',
        objective: { expression: 'Minimize(tokens)', constraints: 'Contains >= 0.8, Equals >= 0.8' },
      },
      {
        label: 'less time, each evaluator at least 0.8',
        objective: { expression: 'Minimize(seconds)', constraints: 'Contains >= 0.8, Equals >= 0.8' },
      },
      {
        label: 'the evaluators and fewer tokens',
        objective: {
          expression: 'WeightedSum(Maximize(Contains), Maximize(Equals), Minimize(tokens, scale=1000))',
          constraints: '',
        },
      },
      {
        label: 'the evaluators and less time',
        objective: {
          expression: 'WeightedSum(Maximize(Contains), Maximize(Equals), Minimize(seconds, scale=10))',
          constraints: '',
        },
      },
      {
        label: 'the best trade-offs of the evaluators and tokens',
        objective: {
          expression: 'Pareto(Maximize(Contains), Maximize(Equals), Minimize(tokens, scale=1000))',
          constraints: '',
        },
      },
    ])
    expect(
      temporaryObjectivePresets(EVALUATORS).every(
        ({ objective }) => !checkTemporaryObjective(objective, EVALUATORS).problem
      )
    ).toBe(true)
  })

  it('shouldQuoteAnEvaluatorNameThatIsNotAPlainWordInThePresets', () => {
    expect(temporaryObjectivePresets(['refund-policy', 'Equals'])[1]).toEqual({
      label: 'refund-policy only',
      objective: { expression: 'Maximize("refund-policy")', constraints: '' },
    })
  })

  it.each([
    ['AnEvaluatorName', 'equals', { expression: 'Maximize(Equals)', constraints: '' }],
    ['AUsageName', 'tokens', { expression: 'Minimize(tokens)', constraints: '' }],
    ['AnUnknownName', 'Helpfulness', { expression: 'Maximize(Helpfulness)', constraints: '' }],
    ['TheApiNotation', 'Minimize(tokens)', { expression: 'Minimize(tokens)', constraints: '' }],
  ])('shouldReadTheObjectiveOfAChatRequestGivenAs%s', (_case, text, objective) => {
    expect(temporaryObjectiveFromRequest(text, undefined, EVALUATORS)).toEqual(objective)
  })

  it('shouldReadTheConstraintsOfAChatRequestAsOneLine', () => {
    expect(temporaryObjectiveFromRequest(undefined, ['Contains >= 0.8', 'tokens <= 4000'], EVALUATORS)).toEqual({
      expression: '',
      constraints: 'Contains >= 0.8, tokens <= 4000',
    })
  })
})
