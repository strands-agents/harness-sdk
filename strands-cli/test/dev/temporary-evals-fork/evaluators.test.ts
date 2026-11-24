import { describe, expect, it } from 'vitest'

import { temporaryJudgeEvaluatorCount } from '../../../src/dev/temporary-evals-fork/evaluators.js'

describe('TEMPORARY judge evaluators of an experiment', () => {
  it.each([
    { case: 'only Equals', evaluators: [{ evaluator_type: 'Equals' }], judges: 0 },
    {
      case: 'every check evaluator',
      evaluators: [
        'Equals',
        'Contains',
        'StartsWith',
        'ToolCalled',
        'SkillInvoked',
        'StructuredOutputSimilarity',
        'StateEquals',
      ].map((type) => ({ evaluator_type: type })),
      judges: 0,
    },
    { case: 'a labelled check', evaluators: [{ evaluator_type: 'Equals', name: 'exact' }], judges: 0 },
    {
      case: 'a rubric next to checks',
      evaluators: [{ evaluator_type: 'Contains', value: 'Paris' }, { evaluator_type: 'OutputEvaluator' }],
      judges: 1,
    },
    { case: 'a custom evaluator', evaluators: [{ evaluator_type: 'my_module:Grader' }], judges: 1 },
    { case: 'an entry without a type', evaluators: [{ name: 'unknown' }], judges: 1 },
    { case: 'no list', evaluators: undefined, judges: 0 },
  ])('shouldCountOnlyTheEvaluatorsThatCallAModelWhenTheExperimentHas $case', ({ evaluators, judges }) => {
    expect(temporaryJudgeEvaluatorCount(evaluators)).toBe(judges)
  })
})
