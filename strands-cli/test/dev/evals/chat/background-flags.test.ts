import { describe, expect, it } from 'vitest'

import type { GenerationSettings } from '../../../../src/dev/evals/model.js'
import {
  generateFlagSettings,
  optimizeFlagSettings,
  runFlagCases,
} from '../../../../src/dev/evals/chat/background-flags.js'

const SUGGESTED: GenerationSettings = {
  name: 'experiment-1',
  task: '',
  context: '',
  cases: 20,
  topics: 0,
  model: '',
}

describe('background flags', () => {
  it('shouldReadTheKnobsAndModelsOfTheOptimizeSkillInEitherSpelling', () => {
    expect(
      optimizeFlagSettings([
        '--tune',
        'system_prompt',
        '--tune=contextManager',
        '--tune',
        'model=["bedrock/a", "bedrock/b"]',
        '--tune',
        'builtin_tools',
        '--tune=tools',
        '--tune',
        'mcp_servers',
        '--tune',
        'builtinPlugins',
        '--tune',
        'interventions',
        '--max-rollouts',
        '500',
      ])
    ).toEqual({
      tune: [
        'instructions',
        'systemPrompt',
        'contextManager',
        'model',
        'builtinTools',
        'tools',
        'mcpServers',
        'builtinPlugins',
        'interventions',
      ],
      models: ['bedrock/a', 'bedrock/b'],
      maxRollouts: 500,
      passed: [],
      ignored: [],
    })
  })

  it.each([
    [['refunds.json'], 'refunds.json is not a flag.'],
    [['--max-iterations'], '--max-iterations needs a value.'],
    [['--max-iterations', 'two'], '--max-iterations must be a whole number, not two.'],
    [['--feasibility-threshold', 'sure'], '--feasibility-threshold must be a number, not sure.'],
    [['--objective', 'best:tokens'], 'must look like maximize:METRIC'],
    [['--tune', 'model={"a": 1}'], 'must list model ids as a JSON list of strings.'],
    [['--tune', 'session'], '--tune session is not a knob that strands dev tunes.'],
    [['--no-tune-instructions'], 'Tune at least one knob'],
    [['--split', '0.5,0.5'], '--split takes TRAIN,VALIDATION,TEST shares'],
    [['--split', '0,0.5,0.5'], '--split takes TRAIN,VALIDATION,TEST shares'],
    [['--split', '0.5,0,0.5'], '--split takes TRAIN,VALIDATION,TEST shares'],
    [['--split', 'a,b,c'], '--split takes TRAIN,VALIDATION,TEST shares'],
    [['--split', 'pkg:split'], 'a MODULE:ATTR Split is not supported.'],
    [['--seed', '1.5'], '--seed must be a whole number, not 1.5.'],
  ])('shouldRefuseOptimizeFlags %j', (args, message) => {
    expect(() => optimizeFlagSettings(args)).toThrow(message)
  })

  it('shouldTakeASplitWithNoTestCasesANegativeSeedAndIgnoreTheLoggingFlags', () => {
    expect(optimizeFlagSettings(['--split', '0.7,0.3,0', '--seed', '-3', '--verbose', '-v', '--debug'])).toMatchObject({
      split: [0.7, 0.3, 0],
      seed: -3,
      passed: [],
      ignored: [
        '--verbose: strands dev reads the run itself',
        '-v: strands dev reads the run itself',
        '--debug: strands dev reads the run itself',
      ],
    })
  })

  it('shouldTakeOnlyTheTaskAndCaseCountOfStrandsEvalsGenerate', () => {
    expect(
      generateFlagSettings(
        'billing',
        ['--context', 'Billing questions.', '--num-cases=5', '--evaluator', 'HelpfulnessEvaluator', '--metadata'],
        SUGGESTED
      )
    ).toEqual({
      settings: { ...SUGGESTED, name: 'billing', task: 'Billing questions.', context: 'Billing questions.', cases: 5 },
      ignored: ['--evaluator: strands dev uses its default', '--metadata: strands dev uses its default'],
    })
  })

  it.each([
    [['refunds.json'], 'refunds.json is not a flag.'],
    [['--num-cases'], '--num-cases needs a value.'],
    [['--num-cases', 'many'], '--num-cases must be a whole number, not many.'],
  ])('shouldRefuseGenerateFlags %j', (args, message) => {
    expect(() => generateFlagSettings('billing', args, SUGGESTED)).toThrow(message)
  })

  it('shouldPassOnlyTheCasesOfStrandsEvalsRun', () => {
    expect(runFlagCases(['--case', 'a', '--case=b', '--rich'])).toEqual({
      cases: ['a', 'b'],
      ignored: ['--rich: strands dev sets it'],
    })
    expect(() => runFlagCases(['--diagnose', 'always'])).toThrow('it passes --case only.')
  })
})
