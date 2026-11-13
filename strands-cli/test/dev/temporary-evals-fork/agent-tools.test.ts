import type { JSONValue } from '@strands-agents/sdk'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { DevChatTool } from '../../../src/dev/chat-extension.js'
import type {
  ExperimentsState,
  ExperimentSummary,
  GenerationSettings,
  Knob,
  OptimizePlan,
  OptimizeReview,
  OptimizeState,
  TestResults,
  TestState,
} from '../../../src/dev/panels/model.js'
import { temporaryDevChatPart } from '../../../src/dev/temporary-evals-fork/agent-tools.js'
import type { TemporaryEvaluator } from '../../../src/dev/temporary-evals-fork/evaluators.js'
import type { TemporaryDevSessions } from '../../../src/dev/temporary-evals-fork/sessions.js'
import { generationSettings } from '../panels/fixtures.js'

const CAPITAL: ExperimentSummary = {
  name: 'capital',
  path: '/w/strands-dev/tmp/experiments/capital.json',
  caseCount: 1,
}
const REFUNDS: ExperimentSummary = {
  name: 'refunds',
  path: '/w/strands-dev/tmp/experiments/refunds.json',
  caseCount: 2,
}

const state = <State>(initial: State) => {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    snapshot: (): State => current,
    set: (next: State): void => {
      current = next
      for (const listener of listeners) listener()
    },
  }
}

const results = (): TestResults => ({
  experiment: 'refunds',
  overall: 0.5,
  report: '/w/strands-dev/tmp/reports/20261112-120000-refunds.json',
  seconds: 12.4,
  evaluators: ['OutputEvaluator'],
  cases: [
    { name: 'late-refund', input: 'Refund an order from May?', passed: true, verdicts: [] },
    {
      name: 'no-receipt',
      input: 'Refund without a receipt?',
      expected: 'Ask for the order number',
      actual: 'Refund approved',
      passed: false,
      verdicts: [{ evaluator: 'OutputEvaluator', score: 0, passed: false, reason: 'It skipped the receipt rule.' }],
    },
  ],
})

const KNOBS: readonly Knob[] = [
  { key: 'instructions', label: 'instructions', detail: '', enabled: true },
  { key: 'effort', label: 'effort', detail: '', enabled: false },
  { key: 'tools', label: 'tool descriptions', detail: '', enabled: false, unavailable: 'not yet' },
]

const plan = (): OptimizePlan => ({
  experiment: REFUNDS,
  knobs: KNOBS,
  split: { train: 1, validation: 1, test: 0 },
  repetitions: 1,
  width: 4,
  iterations: 4,
  iterationChoices: [2, 4, 8],
  rollouts: 10,
  judgeCalls: 10,
})

const review = (): OptimizeReview => ({
  run: '20261112-130000-refunds',
  record: '/w/strands-dev/tmp/optimization/20261112-130000-refunds',
  baseline: 0.5,
  best: 0.9,
  measuredOn: 'validation cases',
  edits: [
    { knob: 'instructions', label: 'instructions', target: 'agent.py', before: 'Old.', after: 'New.', accepted: true },
    { knob: 'effort', label: 'effort', before: 'low', after: 'high', accepted: false, unavailable: 'set in code' },
  ],
})

const fakeSessions = () => {
  const experiments = state<ExperimentsState>({
    loaded: true,
    folder: 'strands-dev/tmp/experiments',
    saved: [REFUNDS],
    generations: [],
  })
  const test = state<TestState>({ runs: [] })
  const optimize = state<OptimizeState>({ step: 'pick' })
  const sessions = {
    experiments: {
      ...experiments,
      reload: vi.fn(async () => experiments.snapshot().saved),
      suggested: vi.fn(() => generationSettings({ name: 'experiment-2', task: 'Answer refund questions' })),
      agentSummary: vi.fn(() => 'agent.py · 1 tool'),
      createExperiment: vi.fn(async (settings: GenerationSettings) => ({
        name: settings.name,
        path: `/w/strands-dev/tmp/experiments/${settings.name}.json`,
        caseCount: 2,
        failed: 0,
        cases: [
          { name: 'c0', input: 'question 0', kept: true, saved: true },
          { name: 'c1', input: 'question 1', kept: true, saved: true },
        ],
      })),
    },
    test: {
      ...test,
      show: vi.fn(async (): Promise<void> => undefined),
      run: vi.fn((chosen: readonly ExperimentSummary[]) =>
        test.set({
          runs: chosen.map((experiment) => ({
            experiment,
            run: { status: 'running', cases: 2, evaluators: [], done: 0, startedAt: 0, rerun: false },
          })),
        })
      ),
      rerunFailed: vi.fn(),
    },
    optimize: {
      ...optimize,
      reset: vi.fn(() => optimize.set({ step: 'pick' })),
      stop: vi.fn(),
      plan: vi.fn(() => setTimeout(() => optimize.set({ step: 'setup', plan: plan() }), 0)),
      toggleKnob: vi.fn(),
      setIterations: vi.fn(),
      start: vi.fn(() => optimize.set({ step: 'running', progress: progress() })),
      accept: vi.fn(),
      apply: vi.fn(() => {
        const current = optimize.snapshot()
        if (current.step === 'review')
          setTimeout(() => optimize.set({ step: 'review', review: { ...current.review, applied: ['agent.py'] } }), 0)
      }),
    },
  }
  return { sessions, experiments, test, optimize }
}

const progress = () => ({
  run: '20261112-130000-refunds',
  record: '',
  metric: '',
  iterations: 4,
  planned: 17,
  candidates: [],
  startedAt: 0,
  stopping: false,
})

const CATALOG: readonly TemporaryEvaluator[] = [
  { name: 'OutputEvaluator', kind: 'rubric', description: 'Judges the answer', settings: [], available: true },
  {
    name: 'ToolCalled',
    kind: 'check',
    description: 'Checks that a tool ran',
    settings: [{ name: 'tool_name', type: 'string', required: true, description: 'The tool' }],
    available: true,
  },
  {
    name: 'InteractionsEvaluator',
    kind: 'rubric',
    description: 'Judges interactions',
    settings: [],
    available: false,
    limit: 'A dev run records no interactions.',
  },
]

const setup = (evaluators = vi.fn(async () => CATALOG)) => {
  const fake = fakeSessions()
  const part = temporaryDevChatPart({
    sessions: () => fake.sessions as unknown as TemporaryDevSessions,
    evaluators,
  })
  const tool = (name: string): DevChatTool => part.tools.find((candidate) => candidate.name === name)!
  const call = async (name: string, input: Record<string, JSONValue> = {}): Promise<unknown> =>
    JSON.parse(await tool(name).run(input))
  return { ...fake, part, tool, call, evaluators }
}

describe('TEMPORARY dev chat part', () => {
  it('shouldOfferTheSkillAndLetOnlyTheStatusSkipThePromptWhenThePartIsBuilt', () => {
    const { part } = setup()

    expect(part.skills.map(({ name }) => name)).toEqual([
      'create-experiment',
      'manage-experiments',
      'run-tests',
      'optimize-harness',
    ])
    expect(part.tools.map(({ name, readOnly }) => [name, readOnly === true])).toEqual([
      ['strands_dev_status', true],
      ['strands_dev_evaluators', false],
      ['strands_dev_create_experiment', false],
      ['strands_dev_read_experiment', true],
      ['strands_dev_test_results', true],
      ['strands_dev_test', false],
      ['strands_dev_optimize', false],
      ['strands_dev_cancel_optimization', false],
      ['strands_dev_reject_optimization', false],
      ['strands_dev_apply_optimization', false],
    ])
    expect(part.instructions).toContain('wait for the developer to agree')
    for (const tool of part.tools) {
      expect(tool.inputSchema).not.toHaveProperty('oneOf')
      expect(tool.inputSchema).not.toHaveProperty('anyOf')
      expect(tool.inputSchema).not.toHaveProperty('allOf')
    }
  })

  it('shouldListTheExperimentsTheirLastTestAndTheSuggestedSettingsWhenItShowsTheStatus', async () => {
    const { call, test } = setup()
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })

    const status = await call('strands_dev_status')

    expect(status).toMatchObject({
      newExperiment: {
        name: 'experiment-2',
        task: 'Answer refund questions',
        agentContext: 'agent.py · 1 tool',
        generator: { provider: 'bedrock', defaultModel: 'evals Python SDK default (not the chat model)' },
      },
      experimentsFolder: 'strands-dev/tmp/experiments',
      experiments: [
        {
          name: 'refunds',
          cases: 2,
          file: REFUNDS.path,
          lastTest: { status: 'done', passed: 1, total: 2, score: 0.5 },
        },
      ],
      generations: [],
      optimization: { step: 'idle' },
    })
  })

  it('shouldGiveTheLastResultFromAnEarlierSessionWhenTheStatusFollowsARestart', async () => {
    const { call, test, sessions } = setup()
    sessions.test.show.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
            resolve()
          }, 0)
        )
    )

    const status = await call('strands_dev_status')

    expect(status).toMatchObject({ experiments: [{ name: 'refunds', lastTest: { status: 'done', passed: 1 } }] })
  })

  it('shouldListTheUsableEvaluatorsAndReadTheCatalogOnceWhenItIsAskedTwice', async () => {
    const { call, evaluators } = setup()

    const first = await call('strands_dev_evaluators')
    await call('strands_dev_evaluators')

    expect(first).toEqual({
      available: [
        { name: 'OutputEvaluator', kind: 'rubric', description: 'Judges the answer', settings: [] },
        {
          name: 'ToolCalled',
          kind: 'check',
          description: 'Checks that a tool ran',
          settings: [{ name: 'tool_name', type: 'string', required: true, description: 'The tool' }],
        },
      ],
      unavailable: [
        {
          name: 'InteractionsEvaluator',
          description: 'Judges interactions',
          limit: 'A dev run records no interactions.',
        },
      ],
    })
    expect(evaluators).toHaveBeenCalledOnce()
  })

  it('shouldReadTheCatalogAgainWhenTheFirstReadFailed', async () => {
    const evaluators = vi.fn().mockRejectedValueOnce(new Error('no venv')).mockResolvedValue(CATALOG)
    const { tool } = setup(evaluators)

    await expect(tool('strands_dev_evaluators').run({})).rejects.toThrow('no venv')
    await tool('strands_dev_evaluators').run({})

    expect(evaluators).toHaveBeenCalledTimes(2)
  })

  it('shouldFillTheMissingSettingsWithTheSuggestedOnesWhenItCreatesAnExperiment', async () => {
    const { call, sessions } = setup()

    const created = await call('strands_dev_create_experiment', {
      name: 'refunds-v2',
      task: 'Answer refund questions',
      context: 'Customers without a receipt',
      cases: 5,
      evaluators: [{ name: 'ToolCalled', settings: { tool_name: 'lookup_order' } }],
      expectedTrajectory: true,
    })

    expect(sessions.experiments.createExperiment).toHaveBeenCalledWith({
      ...generationSettings({ name: 'experiment-2', task: 'Answer refund questions' }),
      name: 'refunds-v2',
      context: 'Customers without a receipt',
      cases: 5,
      evaluators: [{ name: 'ToolCalled', settings: { tool_name: 'lookup_order' } }],
      expectedTrajectory: true,
    })
    expect(created).toEqual({
      name: 'refunds-v2',
      file: '/w/strands-dev/tmp/experiments/refunds-v2.json',
      cases: 2,
      failedCases: 0,
      inputs: [
        { name: 'c0', input: 'question 0' },
        { name: 'c1', input: 'question 1' },
      ],
    })
  })

  it.each<[string, Record<string, JSONValue>, string]>([
    ['no task', { name: 'refunds-v2' }, 'task is required.'],
    ['zero cases', { name: 'refunds-v2', task: 'Refunds', cases: 0 }, 'cases must be a whole number from 1 to 50.'],
    ['no evaluator', { name: 'refunds-v2', task: 'Refunds', evaluators: [] }, 'at least one evaluator'],
    ['a nameless evaluator', { name: 'refunds-v2', task: 'Refunds', evaluators: [{}] }, 'Each evaluator needs a name'],
  ])('shouldRefuseToCreateAnExperimentWhenTheInputHas%s', async (_case, input, message) => {
    const { tool, sessions } = setup()

    await expect(tool('strands_dev_create_experiment').run(input)).rejects.toThrow(message)
    expect(sessions.experiments.createExperiment).not.toHaveBeenCalled()
  })

  it('shouldReadSavedCasesAndEvaluatorsWithoutRunningAnything', async () => {
    const { call, experiments, sessions } = setup()
    const folder = await mkdtemp(join(tmpdir(), 'dev-experiment-read-'))
    try {
      const path = join(folder, 'refunds.json')
      await writeFile(
        path,
        JSON.stringify({
          evaluators: [{ name: 'OutputEvaluator', rubric: 'Check evidence' }],
          cases: [
            { name: 'first', input: 'First request', expected_output: 'First answer' },
            { name: 'second', input: 'Second request', expected_trajectory: ['lookup'] },
          ],
        })
      )
      experiments.set({ loaded: true, folder, saved: [{ ...REFUNDS, path }], generations: [] })
      expect(await call('strands_dev_read_experiment', { experiment: 'refunds', limit: 1 })).toMatchObject({
        total: 2,
        nextOffset: 1,
        evaluators: [{ name: 'OutputEvaluator', rubric: 'Check evidence' }],
        cases: [{ name: 'first', expected_output: 'First answer' }],
      })
      expect(await call('strands_dev_read_experiment', { experiment: 'refunds', offset: 1 })).toMatchObject({
        offset: 1,
        cases: [{ name: 'second', expected_trajectory: ['lookup'] }],
      })
      expect(sessions.test.run).not.toHaveBeenCalled()
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })

  it('shouldReadSavedTestDetailsWithoutRerunning', async () => {
    const { call, test, sessions } = setup()
    expect(await call('strands_dev_test_results', { experiment: 'refunds' })).toMatchObject({ status: 'not_run' })
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
    expect(await call('strands_dev_test_results', { experiment: 'refunds', offset: 1, limit: 1 })).toMatchObject({
      status: 'done',
      passed: 1,
      total: 2,
      cases: [
        {
          name: 'no-receipt',
          passed: false,
          actual: 'Refund approved',
          verdicts: [{ reason: 'It skipped the receipt rule.' }],
        },
      ],
    })
    expect(sessions.test.run).not.toHaveBeenCalled()
    expect(sessions.test.rerunFailed).not.toHaveBeenCalled()
  })

  it('shouldStartMultipleExperimentsAndRetainBothResults', async () => {
    const { call, test, sessions, experiments } = setup()
    experiments.set({ ...experiments.snapshot(), saved: [REFUNDS, CAPITAL] })
    const done = call('strands_dev_test', { experiments: ['refunds', 'capital'] })
    await vi.waitFor(() => expect(sessions.test.run).toHaveBeenCalledWith([REFUNDS, CAPITAL]))
    test.set({
      runs: [
        { experiment: REFUNDS, run: { status: 'done', results: results() } },
        { experiment: CAPITAL, run: { status: 'failed', message: 'Missing credentials' } },
      ],
    })
    expect(await done).toMatchObject({
      experiments: [{ passed: 1 }, { experiment: 'capital', status: 'failed', message: 'Missing credentials' }],
    })
  })

  it('shouldValidateAllRequestedExperimentsBeforeStartingAny', async () => {
    const { call, sessions } = setup()
    await expect(call('strands_dev_test', { experiments: ['refunds', 'missing'] })).rejects.toThrow(
      'no experiment named missing'
    )
    await expect(call('strands_dev_test', { experiment: 'refunds', experiments: ['capital'] })).rejects.toThrow(
      'not both'
    )
    await expect(call('strands_dev_test', { experiments: [] })).rejects.toThrow('nonempty list')
    expect(sessions.test.run).not.toHaveBeenCalled()
  })

  it('shouldRejectAnAlreadyRunningTestInsteadOfWaitingForANonexistentRerun', async () => {
    const { call, test, sessions } = setup()
    test.set({
      runs: [
        {
          experiment: REFUNDS,
          run: { status: 'running', cases: 2, evaluators: [], done: 0, startedAt: 0, rerun: false },
        },
      ],
    })
    await expect(call('strands_dev_test', { experiment: 'refunds' })).rejects.toThrow('already running')
    expect(await call('strands_dev_test_results', { experiment: 'refunds' })).toMatchObject({ status: 'running' })
    expect(sessions.test.run).not.toHaveBeenCalled()
  })

  it('shouldPreserveUnappliedOptimizationEditsUntilExplicitlyDiscarded', async () => {
    const { call, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: review() })
    await expect(call('strands_dev_optimize', { experiment: 'refunds' })).rejects.toThrow('pending optimization edits')
    expect(sessions.optimize.reset).not.toHaveBeenCalled()
    expect(await call('strands_dev_reject_optimization')).toMatchObject({ status: 'discarded' })
    expect(sessions.optimize.reset).toHaveBeenCalledOnce()
    expect(sessions.optimize.apply).not.toHaveBeenCalled()
  })

  it('shouldNotTreatANoChangeOptimizationAsPendingEdits', async () => {
    const { call, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: { ...review(), edits: [] } })
    const run = call('strands_dev_optimize', { experiment: 'refunds' })
    await vi.waitFor(() => expect(sessions.optimize.start).toHaveBeenCalledOnce())
    optimize.set({ step: 'review', review: { ...review(), edits: [] } })
    expect(await run).toMatchObject({ edits: [] })
  })

  it('shouldStopOnlyAnActiveOptimizationAndNeverApplyOnStop', async () => {
    const { call, optimize, sessions } = setup()
    await expect(call('strands_dev_cancel_optimization')).rejects.toThrow('No optimization is running')
    optimize.set({ step: 'running', progress: progress() })
    expect(await call('strands_dev_cancel_optimization')).toEqual({ status: 'stopping' })
    expect(sessions.optimize.stop).toHaveBeenCalledOnce()
    expect(sessions.optimize.apply).not.toHaveBeenCalled()
  })

  it('shouldWaitForTheRunAndReportWhyEachCaseFailedWhenItTestsAnExperiment', async () => {
    const { tool, test, sessions } = setup()

    const running = tool('strands_dev_test').run({ experiment: 'Refunds' })
    await vi.waitFor(() => expect(sessions.test.run).toHaveBeenCalledWith([REFUNDS]))
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
    const report = JSON.parse(await running)

    expect(report).toMatchObject({ experiment: 'refunds', passed: 1, total: 2, score: 0.5, seconds: 12 })
    expect(report.cases).toEqual([
      { name: 'late-refund', passed: true },
      {
        name: 'no-receipt',
        passed: false,
        input: 'Refund without a receipt?',
        expected: 'Ask for the order number',
        actual: 'Refund approved',
        reasons: ['OutputEvaluator: It skipped the receipt rule.'],
      },
    ])
  })

  it('shouldRunOnlyTheFailedCasesWhenTheDeveloperAsksForThem', async () => {
    const { tool, test, sessions } = setup()
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
    sessions.test.rerunFailed.mockImplementation(() =>
      setTimeout(() => test.set({ runs: [{ experiment: REFUNDS, run: { status: 'failed', message: 'boom' } }] }), 0)
    )

    await expect(tool('strands_dev_test').run({ experiment: 'refunds', failedOnly: true })).rejects.toThrow('boom')
    expect(sessions.test.rerunFailed).toHaveBeenCalledWith(REFUNDS.path)
  })

  it('shouldRunTheFailedCasesOfARunFromAnEarlierSessionWhenTheDeveloperAsksForThem', async () => {
    const { tool, test, sessions } = setup()
    sessions.test.show.mockImplementation(async () => {
      test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
    })
    sessions.test.rerunFailed.mockImplementation(() =>
      setTimeout(() => test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] }), 0)
    )

    const report = JSON.parse(await tool('strands_dev_test').run({ experiment: 'refunds', failedOnly: true }))

    expect(sessions.test.rerunFailed).toHaveBeenCalledWith(REFUNDS.path)
    expect(report).toMatchObject({ passed: 1, total: 2 })
  })

  it('shouldNameTheSavedExperimentsWhenTheRequestedOneDoesNotExist', async () => {
    const { tool, sessions } = setup()

    await expect(tool('strands_dev_test').run({ experiment: 'billing' })).rejects.toThrow(
      'There is no experiment named billing. Saved experiments: refunds.'
    )
    expect(sessions.test.run).not.toHaveBeenCalled()
  })

  it('shouldTuneTheChosenSettingsAndReportTheProposedEditsWhenItOptimizes', async () => {
    const { tool, optimize, sessions } = setup()

    const running = tool('strands_dev_optimize').run({ experiment: 'refunds', tune: ['effort'], iterations: 8 })
    await vi.waitFor(() => expect(sessions.optimize.start).toHaveBeenCalled())
    optimize.set({ step: 'review', review: review() })
    const result = JSON.parse(await running)

    expect(sessions.optimize.plan).toHaveBeenCalledWith(REFUNDS)
    expect(sessions.optimize.toggleKnob.mock.calls).toEqual([['instructions'], ['effort']])
    expect(sessions.optimize.setIterations).toHaveBeenCalledWith(8)
    expect(result).toEqual({
      run: '20261112-130000-refunds',
      baseline: 0.5,
      best: 0.9,
      measuredOn: 'validation cases',
      edits: [
        { index: 0, knob: 'instructions', target: 'agent.py', before: 'Old.', after: 'New.' },
        { index: 1, knob: 'effort', unavailable: 'set in code', before: 'low', after: 'high' },
      ],
    })
  })

  it.each<[string, Record<string, JSONValue>, string]>([
    ['an unknown setting', { experiment: 'refunds', tune: ['tools'] }, 'tune must list instructions, effort, or both.'],
    [
      'an iteration count it does not offer',
      { experiment: 'refunds', iterations: 3 },
      'iterations must be one of 1, 2, 4, 6, 8.',
    ],
  ])('shouldKeepTheLastReviewAndRefuseToOptimizeWhenTheRequestHas%s', async (_case, input, message) => {
    const { tool, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: review() })

    await expect(tool('strands_dev_optimize').run(input)).rejects.toThrow(message)
    expect(sessions.optimize.reset).not.toHaveBeenCalled()
    expect(optimize.snapshot().step).toBe('review')
  })

  it('shouldRefuseToStartASecondOptimizationWhenOneIsRunning', async () => {
    const { tool, optimize } = setup()
    optimize.set({ step: 'running', progress: progress() })

    await expect(tool('strands_dev_optimize').run({ experiment: 'refunds' })).rejects.toThrow('is still running')
  })

  it('shouldWriteOnlyTheAcceptedEditsWhenTheDeveloperApproves', async () => {
    const { call, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: review() })

    const applied = await call('strands_dev_apply_optimization', { edits: [0] })

    expect(sessions.optimize.accept.mock.calls).toEqual([
      [0, true],
      [1, false],
    ])
    expect(applied).toEqual({
      applied: ['agent.py'],
      next: 'Run strands_dev_test on the experiment to check the change.',
    })
  })

  it.each<[string, Record<string, JSONValue>, string]>([
    ['an edit that does not exist', { edits: [4] }, 'There is no edit 4.'],
    ['an edit that cannot be written', { edits: [1] }, 'Edit 1 cannot be written: set in code'],
  ])('shouldRefuseToApplyWhenTheDeveloperChooses%s', async (_case, input, message) => {
    const { tool, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: review() })

    await expect(tool('strands_dev_apply_optimization').run(input)).rejects.toThrow(message)
    expect(sessions.optimize.apply).not.toHaveBeenCalled()
  })
})
