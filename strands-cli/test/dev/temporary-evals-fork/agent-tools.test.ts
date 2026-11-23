import type { JSONValue } from '@strands-agents/sdk'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { DevChatTool } from '../../../src/dev/chat-extension.js'
import type {
  EvalsBrowserState,
  ExperimentsState,
  ExperimentSummary,
  GenerationSettings,
  Knob,
  OptimizePlan,
  OptimizeReview,
  OptimizeRunState,
  OptimizeState,
  TestResults,
  TestState,
} from '../../../src/dev/panels/model.js'
import { temporaryDevChatPart } from '../../../src/dev/temporary-evals-fork/agent-tools.js'
import {
  TEMPORARY_DECISION_CHOICES,
  TEMPORARY_DECISION_DEFAULTS,
  TEMPORARY_TEST_SHARES,
} from '../../../src/dev/temporary-evals-fork/plan.js'
import type { TemporaryEvaluator } from '../../../src/dev/temporary-evals-fork/evaluators.js'
import type { AnsweredOptimizeReview } from '../../../src/dev/temporary-evals-fork/review-run.js'
import type { TemporaryAppliedChange, TemporaryDevSessions } from '../../../src/dev/temporary-evals-fork/sessions.js'

const REFUNDS: ExperimentSummary = {
  name: 'refunds',
  path: '/w/strands-dev/experiments/refunds.json',
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
  { key: 'instructions', label: 'instructions', detail: '', group: 'prompt', kind: 'text', enabled: true },
  { key: 'effort', label: 'effort', detail: '', group: 'model', kind: 'choice', enabled: false, notInCall: true },
  { key: 'model', label: 'model', detail: '', group: 'model', kind: 'models', enabled: false },
  {
    key: 'skills',
    label: 'skills',
    detail: '',
    group: 'skills',
    kind: 'switches',
    enabled: false,
    unavailable: 'not yet',
  },
]

const plan = (): OptimizePlan => ({
  experiment: REFUNDS,
  knobs: KNOBS,
  objective: { expression: '', constraints: '' },
  objectivePresets: [
    { label: 'the mean of every evaluator', objective: { expression: '', constraints: '' } },
    {
      label: 'fewer tokens, each evaluator at least 0.8',
      objective: { expression: 'Minimize(tokens)', constraints: 'OutputEvaluator >= 0.8' },
    },
    {
      label: 'the best trade-offs of the evaluators and tokens',
      objective: { expression: 'Pareto(Maximize(OutputEvaluator), Minimize(tokens, scale=1000))', constraints: '' },
    },
  ],
  metrics: ['OutputEvaluator', 'tokens'],
  split: { train: 1, validation: 1, test: 0 },
  splitChoices: [{ train: 1, validation: 1, test: 0 }],
  testShare: TEMPORARY_TEST_SHARES[0]!,
  testShareChoices: TEMPORARY_TEST_SHARES,
  decision: TEMPORARY_DECISION_DEFAULTS,
  decisionChoices: TEMPORARY_DECISION_CHOICES,
  validatedFinalists: TEMPORARY_DECISION_DEFAULTS.finalists,
  repetitions: 1,
  width: 4,
  workers: 4,
  iterations: 4,
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
    {
      knob: 'instructions',
      kind: 'text',
      label: 'instructions',
      target: 'agent.py',
      before: 'Old.',
      after: 'New.',
      accepted: true,
    },
    {
      knob: 'effort',
      kind: 'value',
      label: 'effort',
      before: 'low',
      after: 'high',
      accepted: false,
      unavailable: 'set in code',
      added: 'effort is new in the call: applying writes effort = "high"',
    },
  ],
})

const fakeSessions = () => {
  const experiments = state<ExperimentsState>({
    loaded: true,
    folder: '/w/strands-dev/experiments',
    saved: [REFUNDS],
    generations: [],
  })
  const test = state<TestState>({ runs: [] })
  const optimize = state<OptimizeState>({ step: 'pick' })
  const ui = state<EvalsBrowserState>({ status: 'ready' })
  const finishRun = (run: OptimizeRunState): void =>
    optimize.set({ ...run, runs: [{ id: 'run-1', experiment: 'refunds', startedAt: 0, state: run }] })
  const sessions = {
    experiments: {
      ...experiments,
      reload: vi.fn(async () => experiments.snapshot().saved),
      suggested: vi.fn(() => generationSettings({ name: 'experiment-2', task: 'Answer refund questions' })),
      agentSummary: vi.fn(() => 'agent.py · 1 tool'),
      generateInBackground: vi.fn((_settings: GenerationSettings): string | undefined => undefined),
      cancel: vi.fn(),
    },
    test: {
      ...test,
      show: vi.fn(async (): Promise<void> => undefined),
      run: vi.fn((chosen: readonly ExperimentSummary[]) =>
        test.set({
          runs: [
            ...test.snapshot().runs.filter(({ experiment }) => !chosen.includes(experiment)),
            ...chosen.map((experiment) => ({
              experiment,
              run: { status: 'running' as const, cases: 2, evaluators: [], done: 0, startedAt: 0, rerun: false },
            })),
          ],
        })
      ),
      runOnly: vi.fn(),
      stop: vi.fn(),
    },
    optimize: {
      ...optimize,
      reset: vi.fn(() => optimize.set({ step: 'pick', runs: optimize.snapshot().runs ?? [] })),
      openRun: vi.fn(),
      autoApplies: vi.fn((): boolean => false),
      appliedChanges: vi.fn((): readonly TemporaryAppliedChange[] => []),
      stop: vi.fn(),
      plan: vi.fn(() => setTimeout(() => optimize.set({ step: 'setup', plan: plan() }), 0)),
      toggleKnob: vi.fn(),
      pickModel: vi.fn(),
      setIterations: vi.fn(),
      setWidth: vi.fn(),
      setRepetitions: vi.fn(),
      setWorkers: vi.fn(),
      setObjective: vi.fn(),
      setDecision: vi.fn(),
      start: vi.fn((): string => {
        finishRun({ step: 'running', progress: progress() })
        return 'run-1'
      }),
      accept: vi.fn(),
      apply: vi.fn(() => {
        const current = optimize.snapshot()
        if (current.step === 'review')
          setTimeout(() => finishRun({ step: 'review', review: { ...current.review, applied: ['agent.py'] } }), 0)
      }),
    },
    ui: { ...ui, open: vi.fn() },
    openFile: vi.fn(async (_path: string): Promise<void> => {}),
  }
  return { sessions, experiments, test, optimize, ui, finishRun }
}

const generationSettings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
  name: 'experiment-1',
  task: 'Answer refund questions',
  context: '',
  cases: 20,
  topics: 0,
  evaluators: [{ name: 'OutputEvaluator' }],
  model: 'us.anthropic.claude-test',
  parallel: 4,
  expectedTrajectory: false,
  expectedInteractions: false,
  metadata: false,
  ...overrides,
})

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

const setup = (evaluators = vi.fn(async () => CATALOG), changes: readonly TemporaryAppliedChange[] = []) => {
  const fake = fakeSessions()
  fake.sessions.optimize.appliedChanges.mockReturnValue(changes)
  const history = {
    pastChats: vi.fn(async (): Promise<number> => 12),
    converter: vi.fn(async (): Promise<string> => 'Follow the session-converter skill below.'),
  }
  const showReview = vi.fn((_run: string): boolean => true)
  const answerReview = vi.fn(
    async ({ run }: { run: string; edit: number; apply: boolean }): Promise<AnsweredOptimizeReview> => ({
      run,
      settled: true,
    })
  )
  const part = temporaryDevChatPart({
    sessions: () => fake.sessions as unknown as TemporaryDevSessions,
    evaluators,
    history,
    showReview,
    answerReview,
  })
  const tool = (name: string): DevChatTool => part.tools.find((candidate) => candidate.name === name)!
  const call = async (name: string, input: Record<string, JSONValue> = {}): Promise<unknown> =>
    JSON.parse(await tool(name).run(input))
  return { ...fake, part, tool, call, evaluators, history, showReview, answerReview }
}

const APPLIED: TemporaryAppliedChange = {
  run: '20261117-144415-diffs',
  experiment: 'diffs',
  appliedAt: Date.parse('2026-11-17T14:52:03Z'),
  baseline: 0,
  best: 1,
  measuredOn: 'test cases',
  testCheck: { difference: 1, cases: 2, confidence: 0.9, range: [0.4, 1.6] },
  edits: [
    {
      knob: 'instructions',
      kind: 'text',
      label: 'instructions',
      target: 'agent.ts',
      before: 'Add 10 to every answer.',
      after: 'Give the exact answer.',
      accepted: true,
    },
    {
      knob: 'caching',
      kind: 'value',
      label: 'prompt caching',
      target: 'agent.ts',
      before: 'auto',
      after: 'on',
      accepted: true,
    },
    {
      knob: 'effort',
      kind: 'value',
      label: 'effort',
      target: 'agent.ts',
      before: 'auto (the harness default; not in the call)',
      after: 'high',
      accepted: true,
      added: 'effort is new in the call: applying writes effort = "high"',
    },
  ],
}

describe('TEMPORARY dev chat instructions', () => {
  it('shouldTellTheAgentWhatStrandsDevChangedInItWhenAnOptimizationWasApplied', () => {
    const { part } = setup(undefined, [APPLIED])

    expect(part.instructions).toContain(
      '- 2026-11-17T14:52:03.000Z: /optimize applied 3 edits from run 20261117-144415-diffs of the experiment diffs. ' +
        'The best candidate scored 0.00 → 1.00 on the test cases. ' +
        'The test check gave +1.00 on 2 unseen test cases (90% confidence range +0.40 to +1.60).'
    )
    expect(part.instructions).toContain(
      '  - instructions in agent.ts: was "Add 10 to every answer.", now "Give the exact answer."'
    )
    expect(part.instructions).toContain('  - prompt caching in agent.ts: auto → on\n')
    expect(part.instructions).toContain(
      '  - effort in agent.ts: auto (the harness default; not in the call) → high; ' +
        'effort is new in the call: applying writes effort = "high"'
    )
  })

  it('shouldTellTheAgentThatAutoOptimizeMadeAChangeTheDeveloperWasNotShown', () => {
    const { part } = setup(undefined, [{ ...APPLIED, auto: true }])

    expect(part.instructions).toContain(
      '- 2026-11-17T14:52:03.000Z: auto-optimize applied 3 edits from run 20261117-144415-diffs of the experiment diffs. ' +
        'The developer has auto-optimize on, so they were not shown these edits before they were written. ' +
        'The best candidate scored 0.00 → 1.00 on the test cases.'
    )
  })

  it('shouldSayWhereApplyStoppedWhenAnEditCouldNotBeWritten', () => {
    const { part } = setup(undefined, [{ ...APPLIED, edits: [], error: 'Could not change agent.ts: it changed.' }])

    expect(part.instructions).toContain('/optimize applied 0 edits from run')
    expect(part.instructions).toContain('Apply stopped early: Could not change agent.ts: it changed.')
  })

  it('shouldLeaveOutTheChangesWhenStrandsDevChangedNothing', () => {
    const { part } = setup()

    expect(part.instructions).not.toContain('Changes that strands dev made to this agent')
  })
})

describe('TEMPORARY dev chat part', () => {
  it('shouldOfferTheSkillAndLetOnlyTheStatusSkipThePromptWhenThePartIsBuilt', () => {
    const { part } = setup()

    expect(part.skills.map(({ name }) => name)).toEqual(['strands-evals', 'optimize', 'background-evals'])
    expect(part.tools.map(({ name, readOnly }) => [name, readOnly === true])).toEqual([
      ['strands_dev_status', true],
      ['strands_dev_evaluators', false],
      ['strands_dev_session_converter', false],
      ['strands_dev_read_experiment', true],
      ['strands_dev_evaluation_results', true],
      ['strands_dev_run_background', false],
      ['strands_dev_stop_background', false],
      ['strands_dev_open_evals_ui', true],
      ['strands_dev_open_file', true],
      ['strands_dev_optimization_plan', false],
      ['strands_dev_single_select', false],
      ['strands_dev_multi_select', false],
      ['strands_dev_number_input', false],
      ['strands_dev_confirm', false],
      ['strands_dev_review_optimization', false],
      ['strands_dev_answer_review', false],
      ['strands_dev_apply_optimization', false],
    ])
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
        pastChats: 12,
        agentContext: 'agent.py · 1 tool',
      },
      experimentsFolder: '/w/strands-dev/experiments',
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
      evalsUi: {
        status: 'ready',
        open: expect.stringContaining(
          'strands_dev_open_evals_ui opens an experiment, a report, or an optimization run'
        ),
      },
    })
  })

  it.each([
    [{ status: 'starting' as const, detail: 'Installing strands-agents-evals' }],
    [{ status: 'unavailable' as const, detail: 'the page server exited with code 1' }],
  ])('shouldSayWhyTheEvalsUiCannotOpenYetWhenTheStatusShowsIt %o', async (shown) => {
    const { call, ui } = setup()
    ui.set(shown)

    const status = await call('strands_dev_status')

    expect(status).toMatchObject({ evalsUi: shown })
    expect(JSON.stringify(status)).not.toContain('127.0.0.1')
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

  it('shouldGiveTheNewestSessionConverterSkillWhenTheAgentAsksForIt', async () => {
    const { tool, history } = setup()

    const guide = await tool('strands_dev_session_converter').run({})

    expect(guide).toBe('Follow the session-converter skill below.')
    expect(history.converter).toHaveBeenCalledTimes(1)
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

  it('shouldOpenAnExperimentOrAnyFileInTheEditorAndSayWhatToOfferWhenNoEditorOpens', async () => {
    const { call, tool, sessions } = setup()

    expect(await call('strands_dev_open_file', { experiment: 'Refunds' })).toEqual({
      opened: true,
      file: REFUNDS.path,
    })
    sessions.openFile.mockRejectedValueOnce(new Error('This terminal cannot open an editor.'))
    expect(await call('strands_dev_open_file', { experiment: 'refunds' })).toEqual({
      opened: false,
      file: REFUNDS.path,
      detail:
        'This terminal cannot open an editor. Give the path, offer strands_dev_open_evals_ui, and ask in chat what to change.',
    })
    expect(await call('strands_dev_open_file', { path: 'agent.ts' })).toEqual({ opened: true, file: 'agent.ts' })
    await expect(tool('strands_dev_open_file').run({})).rejects.toThrow('Give experiment or path, one of them.')
    expect(sessions.openFile.mock.calls).toEqual([[REFUNDS.path], [REFUNDS.path], ['agent.ts']])
  })

  it('shouldOpenTheReportTheRunsOrAnOptimizationAndPassOnTheLinesWhenNoBrowserOpens', async () => {
    const { call, sessions, optimize } = setup()
    sessions.ui.open.mockResolvedValueOnce({ tone: 'normal', lines: ['Open this link in a browser:', 'http://x'] })

    expect(await call('strands_dev_open_evals_ui', { experiment: 'refunds', view: 'report', case: 'c0' })).toEqual({
      opened: false,
      tell: ['Open this link in a browser:', 'http://x'],
    })
    expect(await call('strands_dev_open_evals_ui')).toEqual({ opened: true })
    await call('strands_dev_open_evals_ui', { view: 'optimization' })
    await call('strands_dev_open_evals_ui', { experiment: 'refunds', view: 'optimization' })
    await call('strands_dev_open_evals_ui', { experiment: 'refunds' })
    const run = { id: 'run-1', experiment: 'refunds', startedAt: 0 }
    for (const state of [
      { step: 'running', progress: { ...progress(), record: '/w/running' } },
      { step: 'review', review: { ...review(), record: '/w/review' } },
      { step: 'failed', message: 'x', record: '/w/failed' },
      { step: 'cancelled', experiment: 'refunds' },
    ] as const) {
      optimize.set({
        step: 'pick',
        runs: [
          { ...run, state },
          { ...run, record: '/w/listed', state },
        ],
      })
      await call('strands_dev_open_evals_ui', { experiment: 'refunds', view: 'optimization' })
    }
    expect(sessions.ui.open.mock.calls).toEqual([
      [{ view: 'report', experiment: REFUNDS.path, case: 'c0' }],
      [{ view: 'runs' }],
      [{ view: 'opt-runs' }],
      [{ view: 'opt-runs' }],
      [{ view: 'experiment', experiment: REFUNDS.path }],
      ...['/w/running', '/w/review', '/w/failed', '/w/listed'].map((record) => [{ view: 'optimization', record }]),
    ])
  })

  it('shouldReadSavedTestDetailsWithoutRerunning', async () => {
    const { call, test, sessions } = setup()
    expect(await call('strands_dev_evaluation_results', { experiment: 'refunds' })).toMatchObject({ status: 'not_run' })
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
    expect(await call('strands_dev_evaluation_results', { experiment: 'refunds', offset: 1, limit: 1 })).toMatchObject({
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
    expect(sessions.test.runOnly).not.toHaveBeenCalled()
  })

  it('shouldReportACancelledOptimizationInTheWorkspaceStatus', async () => {
    const { call, optimize } = setup()
    optimize.set({ step: 'cancelled', experiment: 'refunds', run: 'run-7' })

    expect(await call('strands_dev_status')).toMatchObject({
      optimization: { step: 'cancelled', experiment: 'refunds', run: 'run-7' },
    })
  })

  it('shouldReportOnlyTheTunableKnobsAndTheObjectivePresetsWhenItPlans', async () => {
    const { tool } = setup()

    const planned = JSON.parse(await tool('strands_dev_optimization_plan').run({ experiment: 'refunds' }))

    expect(planned.knobs).toEqual([
      { key: 'instructions', label: 'instructions', onByDefault: true },
      { key: 'effort', label: 'effort', notInCall: true },
      { key: 'model', label: 'model' },
    ])
    expect(planned.objective.presets).toEqual([
      { label: 'the mean of every evaluator' },
      {
        label: 'fewer tokens, each evaluator at least 0.8',
        objective: 'Minimize(tokens)',
        constraints: 'OutputEvaluator >= 0.8',
      },
      {
        label: 'the best trade-offs of the evaluators and tokens',
        objective: 'Pareto(Maximize(OutputEvaluator), Minimize(tokens, scale=1000))',
      },
    ])
    expect(planned.objective.usageMetrics).toContain('tokens')
    expect(planned.objective.notation).toContain('Pareto(Maximize(X), Minimize(Y, scale=1000))')
    expect(planned.budget.iterations.value).toBe(4)
    expect(planned.budget.iterations.min).toBe(0)
    expect(planned.budget.candidatesPerStep.min).toBe(1)
    expect(planned.estimate.rollouts).toBeDefined()
  })

  it('shouldPlanWhileAnotherOptimizationIsRunning', async () => {
    const { tool, optimize } = setup()
    optimize.set({
      step: 'pick',
      runs: [{ id: 'run-1', experiment: 'refunds', startedAt: 0, state: { step: 'running', progress: {} } }],
    } as never)

    const planned = JSON.parse(await tool('strands_dev_optimization_plan').run({ experiment: 'refunds' }))

    expect(planned.knobs.length).toBeGreaterThan(0)
  })

  it('shouldWriteOnlyTheAcceptedEditsWhenTheDeveloperApproves', async () => {
    const { call, optimize, sessions } = setup()
    optimize.set({ step: 'review', review: review() })

    const applied = await call('strands_dev_apply_optimization', { edits: [0] })

    expect(sessions.optimize.accept.mock.calls).toEqual([
      [0, true, undefined],
      [1, false, undefined],
    ])
    expect(applied).toEqual({
      applied: ['agent.py'],
      next: 'Evaluate the experiment again, after the developer approves it, to check the change.',
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

const withExperimentFile = async (
  experiments: ReturnType<typeof setup>['experiments'],
  evaluators: readonly string[],
  run: () => Promise<void>
): Promise<void> => {
  const folder = await mkdtemp(join(tmpdir(), 'dev-background-'))
  try {
    const path = join(folder, 'refunds.json')
    await writeFile(
      path,
      JSON.stringify({
        evaluators: evaluators.map((type) => ({ evaluator_type: type })),
        cases: [
          { name: 'first', input: 'First request' },
          { name: 'second', input: 'Second request' },
        ],
      })
    )
    experiments.set({ loaded: true, folder, saved: [{ ...REFUNDS, path }], generations: [] })
    await run()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

describe('background strands-evals runs', () => {
  const optimizeRun = (args: string[]): Record<string, JSONValue> => ({
    command: 'optimize run',
    experiment: 'refunds',
    args,
  })

  it('shouldApplyTheFlagsOfTheOptimizeSkillAndReturnAtOnceWhenItStartsAnOptimization', async () => {
    const { call, sessions, optimize } = setup()
    optimize.set({ step: 'running', progress: progress() })

    const started = await call(
      'strands_dev_run_background',
      optimizeRun([
        '--tune',
        'effort',
        '--max-iterations',
        '3',
        '--proposals-per-iteration=7',
        '--runs-per-candidate',
        '2',
        '--max-workers',
        '6',
        '--feasibility-threshold',
        '0.95',
        '--agent-failure-score',
        'none',
        '--n-finalists',
        '7',
        '--rich',
        '--seed',
        '0',
      ])
    )

    expect(sessions.optimize.plan).toHaveBeenCalledWith(REFUNDS)
    expect(sessions.optimize.toggleKnob.mock.calls).toEqual([['effort']])
    expect(sessions.optimize.setIterations).toHaveBeenCalledWith(3)
    expect(sessions.optimize.setWidth).toHaveBeenCalledWith(7)
    expect(sessions.optimize.setRepetitions).toHaveBeenCalledWith(2)
    expect(sessions.optimize.setWorkers).toHaveBeenCalledWith(6)
    expect(sessions.optimize.setDecision.mock.calls).toEqual([
      ['feasibility', 0.95],
      ['crashScore', 'none'],
      ['finalists', 7],
    ])
    expect(started).toMatchObject({
      status: 'started',
      command: 'optimize run',
      experiment: 'refunds',
      run: 'run-1',
      file: REFUNDS.path,
      ignored: ['--rich: strands dev reads the run itself', '--seed: strands dev sets the seed'],
    })
  })

  it('shouldPickTheModelsToTryAndSayWhyWhenTheRunCannotBePlannedOrStarted', async () => {
    const { call, tool, sessions, optimize } = setup()

    await call('strands_dev_run_background', optimizeRun(['--tune', 'model=["bedrock/us.other"]']))
    sessions.optimize.start.mockReturnValueOnce(undefined as never)
    const unstarted = tool('strands_dev_run_background').run(optimizeRun([]))
    await expect(unstarted).rejects.toThrow('The optimization did not start.')
    sessions.optimize.plan.mockImplementationOnce(() =>
      setTimeout(() => optimize.set({ step: 'failed', message: 'The agent file cannot be read.' }), 0)
    )

    expect(sessions.optimize.pickModel).toHaveBeenCalledWith('bedrock/us.other', true)
    await expect(tool('strands_dev_run_background').run(optimizeRun([]))).rejects.toThrow(
      'The agent file cannot be read.'
    )
  })

  it('shouldStopTuningTheInstructionsWhenTheSkillPassesNoTuneInstructions', async () => {
    const { call, sessions } = setup()

    await call('strands_dev_run_background', optimizeRun(['--no-tune-instructions', '--tune', 'effort']))

    expect(sessions.optimize.toggleKnob.mock.calls).toEqual([['instructions'], ['effort']])
  })

  it.each<[string, string[], string]>([
    ['an unknown knob', ['--tune', 'temperature'], '--tune temperature is not a knob that strands dev tunes.'],
    [
      'a budget below the optimizer minimum',
      ['--proposals-per-iteration', '0'],
      '--proposals-per-iteration must be a whole number of at least 1.',
    ],
    [
      'a threshold it does not offer',
      ['--feasibility-threshold', '0.5'],
      '--feasibility-threshold must be one of 0.8, 0.9, 0.95, 0.99.',
    ],
    ['a flag it cannot pass', ['--rerun-passes', '2'], 'strands dev cannot pass --rerun-passes'],
    ['a model knob without models', ['--tune', 'model'], 'Tuning the model needs'],
  ])('shouldRefuseToOptimizeWhenTheFlagsHave%s', async (_case, args, message) => {
    const { tool, sessions } = setup()

    await expect(tool('strands_dev_run_background').run(optimizeRun(args))).rejects.toThrow(message)
    expect(sessions.optimize.start).not.toHaveBeenCalled()
  })

  it('shouldSayWhyAndNotStartWhenThePlanNeedsMoreRolloutsThanOneRunCanUse', async () => {
    const { tool, sessions, optimize } = setup()
    const budgetProblem = 'Needs about 620 rollouts, but one run can use 500. Lower the steps, candidates, or runs.'
    sessions.optimize.setRepetitions.mockImplementation(() => {
      const current = optimize.snapshot()
      if (current.step === 'setup') optimize.set({ ...current, plan: { ...current.plan, budgetProblem } })
    })

    await expect(tool('strands_dev_run_background').run(optimizeRun(['--runs-per-candidate', '5']))).rejects.toThrow(
      budgetProblem
    )
    expect(sessions.optimize.start).not.toHaveBeenCalled()
  })

  it.each([
    ['OneGoal', ['--objective', 'maximize:Helpfulness'], 'Maximize(Helpfulness)', ''],
    [
      'AWeightedSumAndAConstraint',
      [
        '--objective',
        'maximize:Helpfulness',
        '--objective',
        'minimize:tokens:scale=1000',
        '--constraint',
        'seconds<=30',
      ],
      'WeightedSum(Maximize(Helpfulness), Minimize(tokens, scale=1000))',
      'seconds <= 30',
    ],
    [
      'TheBestTradeOffs',
      ['--objective', 'maximize:Helpfulness', '--objective', 'minimize:seconds:scale=10', '--pareto'],
      'Pareto(Maximize(Helpfulness), Minimize(seconds, scale=10))',
      '',
    ],
  ])('shouldPassTheObjectiveOfTheSkillWhenItHas%s', async (_case, args, expression, constraints) => {
    const { call, sessions, experiments } = setup()
    await withExperimentFile(experiments, ['Helpfulness'], async () => {
      await call('strands_dev_run_background', optimizeRun(args))

      expect(sessions.optimize.setObjective).toHaveBeenCalledWith({ expression, constraints })
    })
  })

  it('shouldRefuseAnObjectiveThatIsNotAnEvaluatorOfTheExperiment', async () => {
    const { tool, sessions, experiments } = setup()
    await withExperimentFile(experiments, ['OutputEvaluator'], async () => {
      await expect(
        tool('strands_dev_run_background').run(optimizeRun(['--objective', 'maximize:Helpfulness']))
      ).rejects.toThrow('Helpfulness is not an evaluator of this experiment or a usage number')
      expect(sessions.optimize.reset).not.toHaveBeenCalled()
    })
  })

  it('shouldRunTheWholeExperimentWhenItEvaluatesWithoutCases', async () => {
    const { call, sessions } = setup()

    const whole = await call('strands_dev_run_background', { command: 'run', experiment: 'refunds' })

    expect(whole).toMatchObject({
      status: 'started',
      command: 'run',
      experiment: 'refunds',
      cases: 2,
      file: REFUNDS.path,
    })
    expect(sessions.test.run).toHaveBeenCalledWith([REFUNDS])
  })

  it('shouldRunOnlyTheNamedCasesAndRefuseAnUnknownCaseOrASecondRun', async () => {
    const { call, tool, sessions, experiments, test } = setup()
    await withExperimentFile(experiments, ['OutputEvaluator'], async () => {
      const [saved] = experiments.snapshot().saved
      await expect(
        tool('strands_dev_run_background').run({ command: 'run', experiment: 'refunds', args: ['--case', 'third'] })
      ).rejects.toThrow('refunds has no case third.')

      const only = await call('strands_dev_run_background', {
        command: 'run',
        experiment: 'refunds',
        args: ['--case', 'second', '--max-workers', '2'],
      })
      test.set({
        runs: [
          {
            experiment: saved!,
            run: { status: 'running', cases: 1, evaluators: [], done: 0, startedAt: 0, rerun: true },
          },
        ],
      })

      expect(only).toMatchObject({ cases: 1, ignored: ['--max-workers: strands dev sets it'] })
      expect(sessions.test.runOnly).toHaveBeenCalledWith(saved, ['second'])
      await expect(tool('strands_dev_run_background').run({ command: 'run', experiment: 'refunds' })).rejects.toThrow(
        'refunds is already running.'
      )
    })
  })

  it('shouldGenerateANewExperimentFromTheFlagsOfStrandsEvalsGenerate', async () => {
    const { call, tool, sessions, experiments } = setup()
    const log = '/w/strands-dev/tmp/.state/drafts/billing.log'
    sessions.experiments.generateInBackground.mockImplementationOnce((settings) => {
      const generation = { id: 'generation-1', name: 'billing', settings, phase: 'preparing' as const, log }
      experiments.set({
        ...experiments.snapshot(),
        generations: [{ ...generation, made: 0, failed: 0, total: 3, startedAt: 0, status: '' }],
      })
      return undefined
    })

    const started = await call('strands_dev_run_background', {
      command: 'generate',
      experiment: 'billing',
      args: [
        '--task-description',
        'Answer billing questions',
        '--num-cases',
        '3',
        '--evaluator',
        'HelpfulnessEvaluator',
      ],
    })
    sessions.experiments.generateInBackground.mockReturnValueOnce('An experiment named billing exists already.')

    expect(sessions.experiments.generateInBackground).toHaveBeenCalledWith(
      generationSettings({
        name: 'billing',
        task: 'Answer billing questions',
        cases: 3,
      })
    )
    expect(started).toMatchObject({
      status: 'started',
      command: 'generate',
      experiment: 'billing',
      cases: 3,
      file: join('/w/strands-dev/experiments', 'billing', 'billing.json'),
      log,
    })
    await expect(
      tool('strands_dev_run_background').run({ command: 'generate', experiment: 'billing' })
    ).rejects.toThrow('exists already')
  })

  it('shouldStopOnlyTheRunThatIsGoingWhenTheDeveloperAsks', async () => {
    const { call, tool, sessions, experiments, test, optimize } = setup()
    const stop = (command: string, experiment = 'refunds') =>
      tool('strands_dev_stop_background').run({ command, experiment })

    await expect(stop('run')).rejects.toThrow('No evaluation of refunds is running.')
    await expect(stop('optimize run')).rejects.toThrow('No optimization of refunds is running.')
    await expect(stop('generate', 'billing')).rejects.toThrow('No generation of billing is running.')

    test.set({
      runs: [
        {
          experiment: REFUNDS,
          run: { status: 'running', cases: 2, evaluators: [], done: 0, startedAt: 0, rerun: false },
        },
      ],
    })
    optimize.set({
      step: 'pick',
      runs: [{ id: 'run-4', experiment: 'refunds', startedAt: 0, state: { step: 'running', progress: progress() } }],
    })
    experiments.set({
      ...experiments.snapshot(),
      generations: [
        {
          id: 'generation-2',
          name: 'billing',
          settings: generationSettings({ name: 'billing' }),
          phase: 'cases',
          made: 1,
          failed: 0,
          total: 3,
          startedAt: 0,
          status: 'Writing cases',
          log: 'billing.log',
        },
      ],
    })

    expect(await call('strands_dev_stop_background', { command: 'run', experiment: 'refunds' })).toMatchObject({
      status: 'stopping',
    })
    expect(await call('strands_dev_stop_background', { command: 'optimize run', experiment: 'refunds' })).toMatchObject(
      {
        status: 'stopping',
      }
    )
    expect(await call('strands_dev_stop_background', { command: 'generate', experiment: 'billing' })).toMatchObject({
      status: 'stopped',
    })
    expect(sessions.test.stop).toHaveBeenCalledWith(REFUNDS.path)
    expect(sessions.optimize.stop).toHaveBeenCalledWith('run-4')
    expect(sessions.experiments.cancel).toHaveBeenCalledWith('generation-2')
  })
})

describe('dev chat guidance', () => {
  it('shouldPointPlainRequestsAtTheEvalsSkillsAndKeepThePaidRunApprovalForALaterTurn', () => {
    const { part, tool } = setup()

    expect(part.instructions).toContain('activate the strands-evals skill')
    expect(part.instructions).toContain('activate the optimize skill')
    expect(part.instructions).toContain('follow the background-evals skill')
    expect(part.instructions).toContain('start a run only after the developer approves it in a later turn')
    expect(part.instructions).toContain('call strands_dev_status again whenever the question is what exists')
    expect(tool('strands_dev_run_background').description).toContain(
      'only after the developer answered yes, in an earlier turn'
    )
  })
})

describe('dev chat tool errors and states', () => {
  it.each<[string, Record<string, JSONValue>, string]>([
    ['an unknown name', { experiment: 'billing' }, 'There is no experiment named billing. Saved experiments: refunds.'],
    ['a name that is not text', { experiment: 5 }, 'experiment must be text.'],
    ['no name', {}, 'experiment is required.'],
  ])('shouldRefuseToReadAnExperimentWhenTheRequestHas%s', async (_case, input, message) => {
    const { tool } = setup()

    await expect(tool('strands_dev_read_experiment').run(input)).rejects.toThrow(message)
  })

  it('shouldFindAnExperimentInAnyCaseAndSayWhenNoneIsSaved', async () => {
    const { call, tool, experiments } = setup()

    expect(await call('strands_dev_evaluation_results', { experiment: 'REFUNDS' })).toMatchObject({
      experiment: 'refunds',
      status: 'not_run',
    })
    experiments.set({ ...experiments.snapshot(), saved: [] })
    await expect(tool('strands_dev_evaluation_results').run({ experiment: 'refunds' })).rejects.toThrow(
      'no experiment is saved yet'
    )
  })

  it('shouldReportARunningOrFailedEvaluationWithoutItsCases', async () => {
    const { call, test } = setup()

    test.set({
      runs: [
        {
          experiment: REFUNDS,
          run: { status: 'running', cases: 2, evaluators: [], done: 1, startedAt: 0, rerun: false },
        },
      ],
    })
    const running = await call('strands_dev_evaluation_results', { experiment: 'refunds' })
    test.set({ runs: [{ experiment: REFUNDS, run: { status: 'failed', message: 'It stopped.' } }] })

    expect(running).toEqual({ experiment: 'refunds', status: 'running', done: 1, cases: 2 })
    expect(await call('strands_dev_evaluation_results', { experiment: 'refunds' })).toEqual({
      experiment: 'refunds',
      status: 'failed',
      message: 'It stopped.',
    })
  })

  it('shouldReportEveryOptimizationRunInTheWorkspaceStatus', async () => {
    const { call, optimize } = setup()
    optimize.set({
      step: 'setup',
      plan: plan(),
      runs: [
        { id: 'run-3', experiment: 'refunds', startedAt: 3, state: { step: 'running', progress: progress() } },
        { id: 'run-2', experiment: 'refunds', startedAt: 2, state: { step: 'review', review: review() } },
        { id: 'run-1', experiment: 'refunds', startedAt: 1, state: { step: 'failed', message: 'It crashed.' } },
      ],
    })

    expect(await call('strands_dev_status')).toMatchObject({
      optimization: {
        step: 'setup',
        experiment: 'refunds',
        runs: [
          { experiment: 'refunds', step: 'running', run: '20261112-130000-refunds', tried: 0, planned: 17 },
          {
            experiment: 'refunds',
            step: 'review',
            best: 0.9,
            edits: [
              { index: 0, knob: 'instructions' },
              { index: 1, knob: 'effort', newInCall: 'effort is new in the call: applying writes effort = "high"' },
            ],
          },
          { experiment: 'refunds', step: 'failed', message: 'It crashed.' },
        ],
      },
    })
  })

  it('shouldRefuseToApplyWhenThereIsNoReviewTheEditsWereAppliedOrTheWriteFails', async () => {
    const { tool, optimize, sessions } = setup()
    const apply = (): Promise<string> => tool('strands_dev_apply_optimization').run({ edits: [0] })

    await expect(apply()).rejects.toThrow('There is no finished optimization to apply.')
    optimize.set({ step: 'review', review: { ...review(), applied: ['agent.py'] } })
    await expect(apply()).rejects.toThrow('These edits were applied already: agent.py.')
    optimize.set({
      step: 'pick',
      runs: [{ id: 'run-2', experiment: 'refunds', startedAt: 0, state: { step: 'review', review: review() } }],
    })
    sessions.optimize.apply.mockImplementationOnce(() =>
      setTimeout(
        () =>
          optimize.set({
            step: 'pick',
            runs: [
              {
                id: 'run-2',
                experiment: 'refunds',
                startedAt: 0,
                state: { step: 'review', review: { ...review(), applied: [], applyError: 'agent.py changed.' } },
              },
            ],
          }),
        0
      )
    )

    await expect(apply()).rejects.toThrow('agent.py changed.')
    expect(sessions.optimize.accept).toHaveBeenCalledWith(0, true, 'run-2')
    expect(sessions.optimize.apply).toHaveBeenCalledWith('run-2')
  })

  it('shouldPutTheDiffOfTheWaitingRunBackOnScreenWhenTheDeveloperAsksToSeeItAgain', async () => {
    const { call, finishRun, showReview, sessions } = setup()
    finishRun({ step: 'review', review: review() })

    const shown = await call('strands_dev_review_optimization')

    expect(showReview.mock.calls).toEqual([['run-1']])
    expect(shown).toMatchObject({ run: review().run, shown: true, next: expect.stringContaining('Say so in one line') })
    expect(sessions.optimize.accept).not.toHaveBeenCalled()
    expect(sessions.optimize.apply).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<OptimizeReview>, Record<string, JSONValue>, string]>([
    ['was answered', { reviewed: true }, {}, 'No finished optimization has an edit waiting for an answer.'],
    ['was applied', { applied: ['agent.py'] }, {}, 'No finished optimization has an edit waiting for an answer.'],
    ['is not the one named', {}, { run: 'another-run' }, 'Run another-run has no edit waiting for an answer.'],
  ])('shouldRefuseToShowADiffWhenTheRun%s', async (_case, change, input, message) => {
    const { tool, finishRun, showReview } = setup()
    finishRun({ step: 'review', review: { ...review(), ...change } })

    await expect(tool('strands_dev_review_optimization').run(input)).rejects.toThrow(message)
    expect(showReview).not.toHaveBeenCalled()
  })

  describe('an answer to the diff on screen, given in a chat message', () => {
    const RUN = '20261123-154559-combined-all'

    it('shouldPickTheChoiceOnScreenForTheDeveloperAndSayWhatWasWritten', async () => {
      const { call, answerReview, sessions } = setup()
      answerReview.mockResolvedValue({ run: RUN, settled: true, applied: ['cli.toml'] })

      const answered = await call('strands_dev_answer_review', { run: RUN, edit: 1, answer: 'apply' })

      expect(answerReview.mock.calls).toEqual([[{ run: RUN, edit: 1, apply: true }]])
      expect(answered).toEqual({
        run: RUN,
        edit: 1,
        picked: 'Apply this change',
        applied: ['cli.toml'],
        next: expect.stringContaining('the diff is closed, and the edits in applied are written'),
      })
      // It is the answer on screen and nothing else: the apply tool, which answers every edit at once, is not used.
      expect(sessions.optimize.accept).not.toHaveBeenCalled()
      expect(sessions.optimize.apply).not.toHaveBeenCalled()
    })

    it('shouldSayThatTheNextEditIsOnScreenAndWhoseItIsToAnswer', async () => {
      const { call, answerReview } = setup()
      answerReview.mockResolvedValue({
        run: RUN,
        settled: false,
        next: { edit: 1, change: 'effort in cli.toml: high → low', at: 1, of: 2 },
      })

      const answered = (await call('strands_dev_answer_review', { run: RUN, edit: 0, answer: 'leave' })) as {
        next: string
      }

      expect(answerReview.mock.calls).toEqual([[{ run: RUN, edit: 0, apply: false }]])
      expect(answered).toMatchObject({ picked: 'Leave it as it is' })
      expect(answered).not.toHaveProperty('applied')
      expect(answered.next).toContain(
        "The diff of edit 1 of this run took its place on the developer's screen, 2 of 2: effort in cli.toml: high → low."
      )
      expect(answered.next).toContain('If their message answered every edit of the run')
      expect(answered.next).toContain('Otherwise it is theirs to answer')
    })

    it.each([
      [{ settled: true }, 'leave', 'the diff is closed, and nothing was written'],
      [{ settled: true, applied: [], applyError: 'cli.toml changed.' }, 'apply', 'give applyError as it is'],
      [{ settled: false }, 'apply', 'still waits behind a question on screen'],
    ] as const)('shouldSayWhereTheReviewStandsAfterTheAnswer %#', async (outcome, answer, said) => {
      const { call, answerReview } = setup()
      answerReview.mockResolvedValue({ run: RUN, ...outcome })

      const answered = (await call('strands_dev_answer_review', { run: RUN, edit: 0, answer })) as { next: string }

      expect(answered.next).toContain(said)
    })

    it('shouldPassOnWhyTheDiffCouldNotBeAnswered', async () => {
      const { tool, answerReview } = setup()
      answerReview.mockRejectedValue(new Error("Edit 0 of run r is not the diff on the developer's screen now."))

      await expect(tool('strands_dev_answer_review').run({ run: 'r', edit: 0, answer: 'apply' })).rejects.toThrow(
        "is not the diff on the developer's screen now"
      )
    })

    it.each<[string, Record<string, JSONValue>, string]>([
      ['no run', { edit: 0, answer: 'apply' }, 'run is required.'],
      ['no edit', { run: RUN, answer: 'apply' }, 'edit must be the index of the edit'],
      ['an answer that is neither', { run: RUN, edit: 0, answer: 'yes' }, 'answer must be apply or leave.'],
    ])('shouldPickNothingWhenTheCallHas%s', async (_case, input, message) => {
      const { tool, answerReview } = setup()

      await expect(tool('strands_dev_answer_review').run(input)).rejects.toThrow(message)
      expect(answerReview).not.toHaveBeenCalled()
    })

    it('shouldTellTheAgentToAnswerTheDiffThatAMessageCameWith', () => {
      const { part } = setup()

      expect(part.instructions).toContain('A message that comes with a <strands_dev_screen> block')
      expect(part.instructions).toContain('pick for them with strands_dev_answer_review')
      expect(part.instructions).toContain('do not ask them to confirm')
    })
  })

  it('shouldSayThatAnEditStillWaitsWithoutCallingItOnScreen', async () => {
    const { call, finishRun } = setup()
    finishRun({ step: 'review', review: review() })

    const waiting = (await call('strands_dev_status')) as { optimization: Record<string, unknown> }
    finishRun({ step: 'review', review: { ...review(), reviewed: true } })
    const answered = (await call('strands_dev_status')) as { optimization: Record<string, unknown> }

    expect(waiting.optimization).toMatchObject({
      step: 'review',
      awaitingAnswer: 1,
      next: expect.stringContaining('The diff may not be showing'),
    })
    expect(answered.optimization).not.toHaveProperty('awaitingAnswer')
  })

  it('shouldSayWhichPartOfTheRunIsGoingAndHowFarTheWholeRunIs', async () => {
    const { call, finishRun } = setup()
    finishRun({
      step: 'running',
      progress: {
        ...progress(),
        step: { kind: 'validating', versions: 3, trials: { done: 1, total: 6 } },
        rollouts: { done: 21, total: 30 },
      },
    })

    expect(await call('strands_dev_status')).toMatchObject({
      optimization: {
        step: 'running',
        phase: 'checking the finalists on the validation cases',
        rollouts: { done: 21, total: 30 },
      },
    })
  })

  it('shouldSayInThePlanAndTheStatusWhenAutoOptimizeWritesTheEditsWithoutAReview', async () => {
    const { call, sessions, finishRun } = setup()

    const off = await call('strands_dev_optimization_plan', { experiment: 'refunds' })
    sessions.optimize.autoApplies.mockReturnValue(true)
    const on = await call('strands_dev_optimization_plan', { experiment: 'refunds' })
    finishRun({ step: 'review', review: { ...review(), auto: true, reviewed: true, applied: ['agent.py'] } })
    const status = (await call('strands_dev_status')) as { optimization: object }

    expect(off).not.toHaveProperty('autoOptimize')
    expect(on).toMatchObject({ autoOptimize: expect.stringContaining('writes its edits to the agent source') })
    expect(status.optimization).toMatchObject({ step: 'review', autoApplied: true, applied: ['agent.py'] })
    expect(status.optimization).not.toHaveProperty('awaitingAnswer')
  })
})
