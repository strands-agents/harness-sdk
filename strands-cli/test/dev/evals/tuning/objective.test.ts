import { describe, expect, it } from 'vitest'

import {
  checkEvalsObjective,
  isEvalsPareto,
  evalsObjectiveArguments,
  evalsObjectivePresets,
  evalsObjectiveFromRequest,
} from '../../../../src/dev/evals/tuning/objective.js'

const EVALUATORS = ['Contains', 'Equals']

describe('optimize objective', () => {
  it.each([
    ['TheMeanOfEveryEvaluator', '', ''],
    ['OneEvaluator', 'Maximize(Contains)', ''],
    ['FewerTokensWithAFloor', 'Minimize(tokens)', 'Contains >= 0.8'],
    ['AWeightedSum', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', ''],
    ['AParetoFront', 'Pareto(Maximize(Contains, weight=2), Minimize(seconds, scale=10))', 'tokens <= 4000'],
    ['AQuotedName', 'Maximize("Equals")', ''],
    ['TwoConstraintsOnOneMetric', 'Maximize(Contains)', 'Equals >= 0.5, Equals <= 1'],
  ])('shouldAccept%s', (_case, expression, constraints) => {
    expect(checkEvalsObjective({ expression, constraints }, EVALUATORS)).toEqual({})
  })

  it('shouldResolveTheShortNameOfAnEvaluatorTheWayTheApiDoes', () => {
    expect(
      checkEvalsObjective({ expression: 'Maximize(Helpfulness)', constraints: '' }, ['HelpfulnessEvaluator'])
    ).toEqual({})
  })

  it('shouldAcceptAQuotedNameThatIsNotAPlainWord', () => {
    expect(
      checkEvalsObjective({ expression: 'Maximize("refund-policy")', constraints: '"refund-policy" >= 0.5' }, [
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
    expect(checkEvalsObjective({ expression, constraints }, EVALUATORS).problem).toContain(problem)
  })

  it('shouldAskForAGoalWhenTheExperimentHasNoEvaluatorAndTheObjectiveIsTheDefault', () => {
    expect(checkEvalsObjective({ expression: '', constraints: '' }, []).problem).toContain('no evaluator')
  })

  it.each([
    ['NoConstraint', 'Minimize(tokens)', '', true],
    ['OnlyAUsageConstraint', 'Minimize(seconds)', 'tokens <= 4000', true],
    ['AnEvaluatorFloor', 'Minimize(tokens)', 'Contains >= 0.8', false],
    ['AnEvaluatorGoal', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', '', false],
  ])('shouldWarnAboutAUsageOnlyObjectiveWhenItHas%s', (_case, expression, constraints, warns) => {
    const { warning } = checkEvalsObjective({ expression, constraints }, EVALUATORS)

    expect(warning !== undefined).toBe(warns)
  })

  it.each([
    ['NoFlagsForTheDefault', { expression: '', constraints: '' }, []],
    [
      'TheObjectiveAndEachConstraint',
      { expression: ' Minimize(tokens) ', constraints: 'Contains >= 0.8, tokens <= 4000' },
      ['--objective', 'minimize:tokens', '--constraint', 'Contains>=0.8', '--constraint', 'tokens<=4000'],
    ],
    [
      'OneSpecForEachTermOfAWeightedSum',
      { expression: 'WeightedSum(Maximize(Contains, weight=2), Minimize(tokens, scale=1000))', constraints: '' },
      ['--objective', 'maximize:Contains:weight=2', '--objective', 'minimize:tokens:scale=1000'],
    ],
    [
      'TheTermsAndParetoForAParetoFront',
      { expression: 'Pareto(Maximize(Contains), Minimize(seconds, scale=10))', constraints: '' },
      ['--objective', 'maximize:Contains', '--objective', 'minimize:seconds:scale=10', '--pareto'],
    ],
    [
      'TheLoneGoalForACombinationOfOneGoal',
      { expression: 'Pareto(Maximize(Contains, weight=2))', constraints: '' },
      ['--objective', 'maximize:Contains'],
    ],
    [
      'TheBareNameOfAQuotedMetric',
      { expression: 'Maximize("refund-policy")', constraints: '"refund-policy" >= 0.5' },
      ['--objective', 'maximize:refund-policy', '--constraint', 'refund-policy>=0.5'],
    ],
  ])('shouldPass%s', (_case, objective, flags) => {
    expect(evalsObjectiveArguments(objective)).toEqual(flags)
  })

  it.each([
    ['AnObjectiveMetricWithAColon', 'Maximize("team:score")', '', 'because the name has a colon'],
    ['AConstraintMetricWithAnOperator', '', '"score=a" >= 0.5', 'because the name has <, >, or ='],
  ])('shouldRefuseANameThatTheOptimizerCannotReadWhenItIs%s', (_case, expression, constraints, problem) => {
    const objective = { expression, constraints }

    expect(checkEvalsObjective(objective, ['team:score', 'score=a']).problem).toContain(problem)
    expect(() => evalsObjectiveArguments(objective)).toThrow(problem)
  })

  it('shouldOfferTheMeanEachEvaluatorAndTheUsageTradeOffsAsPresets', () => {
    expect(evalsObjectivePresets(EVALUATORS)).toEqual([
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
        label: 'the evaluators, fewer tokens, and less time',
        objective: {
          expression:
            'WeightedSum(Maximize(Contains), Maximize(Equals), Minimize(tokens, scale=1000), Minimize(seconds, scale=10))',
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
      evalsObjectivePresets(EVALUATORS).every(({ objective }) => !checkEvalsObjective(objective, EVALUATORS).problem)
    ).toBe(true)
  })

  it('shouldSendEveryEvaluatorTokensAndTimeUpstreamWhenThePresetCombinesThemAll', () => {
    const preset = evalsObjectivePresets(EVALUATORS).find(
      ({ label }) => label === 'the evaluators, fewer tokens, and less time'
    )

    expect(preset && evalsObjectiveArguments(preset.objective)).toEqual([
      '--objective',
      'maximize:Contains',
      '--objective',
      'maximize:Equals',
      '--objective',
      'minimize:tokens:scale=1000',
      '--objective',
      'minimize:seconds:scale=10',
    ])
  })

  it('shouldQuoteAnEvaluatorNameThatIsNotAPlainWordInThePresets', () => {
    expect(evalsObjectivePresets(['refund-policy', 'Equals'])[1]).toEqual({
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
    expect(evalsObjectiveFromRequest(text, undefined, EVALUATORS)).toEqual(objective)
  })

  it('shouldReadTheConstraintsOfAChatRequestAsOneLine', () => {
    expect(evalsObjectiveFromRequest(undefined, ['Contains >= 0.8', 'tokens <= 4000'], EVALUATORS)).toEqual({
      expression: '',
      constraints: 'Contains >= 0.8, tokens <= 4000',
    })
  })

  it.each([
    ['AParetoOfTwoGoals', 'Pareto(Maximize(Contains), Minimize(tokens, scale=1000))', true],
    ['AParetoOfOneGoal', 'Pareto(Maximize(Contains))', false],
    ['AWeightedSum', 'WeightedSum(Maximize(Contains), Minimize(tokens, scale=1000))', false],
    ['OneGoal', 'Maximize(Contains)', false],
    ['TheMeanOfEveryEvaluator', '', false],
    ['AnObjectiveThatDoesNotFit', 'Pareto(Maximize(Contains), Nope)', false],
  ])('shouldTellWhetherTheOptimizerUsesAParetoFrontWhenTheObjectiveIs%s', (_case, expression, pareto) => {
    expect(isEvalsPareto({ expression, constraints: '' })).toBe(pareto)
  })
})
