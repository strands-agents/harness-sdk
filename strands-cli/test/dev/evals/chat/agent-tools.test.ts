import type { JSONValue } from '@strands-agents/sdk'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { DevChatTool } from '../../../../src/dev/chat-extension.js'
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
  EvaluationResults,
  EvaluationState,
} from '../../../../src/dev/evals/model.js'
import { evalsDevChatPart } from '../../../../src/dev/evals/chat/agent-tools.js'
import {
  EVALS_DECISION_CHOICES,
  EVALS_DECISION_DEFAULTS,
  EVALS_TEST_SHARES,
} from '../../../../src/dev/evals/tuning/plan.js'
import type { AutoOptimizeStatus } from '../../../../src/dev/evals/sessions/auto-optimize.js'
import type { AnsweredOptimizeReview, AppliedOptimizeEdits } from '../../../../src/dev/evals/sessions/review-run.js'
import type { EvalsAppliedChange } from '../../../../src/dev/evals/sessions/optimize-session.js'
import type { EvalsDevSessions } from '../../../../src/dev/evals/sessions/sessions.js'
import { temporaryDirectory } from '../../../fixtures/tempdir.js'

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

const results = (): EvaluationResults => ({
  experiment: 'refunds',
  overall: 0.5,
  report: '/w/strands-dev/tmp/reports/20261112-120000-refunds.json',
  seconds: 12.4,
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
  testShare: EVALS_TEST_SHARES[0]!,
  decision: EVALS_DECISION_DEFAULTS,
  decisionChoices: EVALS_DECISION_CHOICES,
  repetitions: 1,
  width: 4,
  workers: 4,
  iterations: 4,
  maxRollouts: 500,
  rerunPasses: 2,
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
  const experiments = {
    ...state<ExperimentsState>({ folder: '/w/strands-dev/experiments', generations: [] }),
    // The saved experiments that reload gives; a test sets them.
    saved: [REFUNDS] as readonly ExperimentSummary[],
  }
  const evaluate = state<EvaluationState>({ runs: [] })
  const optimize = state<OptimizeState>({ step: 'pick' })
  const ui = state<EvalsBrowserState>({ status: 'ready' })
  const settings = { autoAcceptOptimizationResults: false, autoOptimize: 0 }
  const finishRun = (run: OptimizeRunState): void =>
    optimize.set({ ...run, runs: [{ id: 'run-1', experiment: 'refunds', state: run }] })
  const sessions = {
    experiments: {
      ...experiments,
      reload: vi.fn(async () => experiments.saved),
      suggested: vi.fn(() => generationSettings({ name: 'experiment-2', task: 'Answer refund questions' })),
      agentSummary: vi.fn(() => 'agent.py · 1 tool'),
      generateInBackground: vi.fn((_settings: GenerationSettings): string | undefined => undefined),
      cancel: vi.fn(),
    },
    evaluate: {
      ...evaluate,
      show: vi.fn(async (): Promise<void> => undefined),
      run: vi.fn((chosen: readonly ExperimentSummary[]) =>
        evaluate.set({
          runs: [
            ...evaluate.snapshot().runs.filter(({ experiment }) => !chosen.includes(experiment)),
            ...chosen.map((experiment) => ({
              experiment,
              run: { status: 'running' as const, cases: 2, done: 0 },
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
      autoApplies: vi.fn((): boolean => false),
      appliedChanges: vi.fn((): readonly EvalsAppliedChange[] => []),
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
      setMaxRollouts: vi.fn(),
      setSplit: vi.fn(),
      setPassed: vi.fn(),
      setSeed: vi.fn(),
      setRerunPasses: vi.fn(),
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
    auto: {
      status: vi.fn(async (): Promise<AutoOptimizeStatus> => ({ everyTurns: settings.autoOptimize, turnsSince: 3 })),
      settingChanged: vi.fn(async (): Promise<string | undefined> => undefined),
    },
    settings: vi.fn(() => settings),
    fileChanges: vi.fn((): string | undefined => undefined),
    // As the settings panel does: what is set is what the workspace then goes by.
    setSettings: vi.fn(async (update: Partial<typeof settings>): Promise<void> => {
      Object.assign(settings, update)
    }),
  }
  return { sessions, experiments, evaluate, optimize, ui, finishRun }
}

const generationSettings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
  name: 'experiment-1',
  task: 'Answer refund questions',
  context: '',
  cases: 20,
  topics: 0,
  model: 'us.anthropic.claude-test',
  ...overrides,
})

const progress = () => ({
  run: '20261112-130000-refunds',
  record: '',
  planned: 17,
  tried: 0,
  rollouts: { done: 0, total: 30 },
})

const setup = (changes: readonly EvalsAppliedChange[] = []) => {
  const fake = fakeSessions()
  fake.sessions.optimize.appliedChanges.mockReturnValue(changes)
  const history = {
    pastChats: vi.fn(async (): Promise<number> => 12),
    converter: vi.fn(async (): Promise<string> => 'Follow the session-converter skill below.'),
    unattendedConverter: vi.fn(async (): Promise<string> => 'Follow the session-converter skill on your own.'),
  }
  const showReview = vi.fn((_run: string): boolean => true)
  const answerReview = vi.fn(
    async ({ run }: { run: string; edit: number; apply: boolean }): Promise<AnsweredOptimizeReview> => ({
      run,
      settled: true,
    })
  )
  const applyEdits = vi.fn(
    async ({ run }: { run: string; edits: readonly number[] }): Promise<AppliedOptimizeEdits> => ({
      run,
      settled: true,
      applied: ['agent.py'],
    })
  )
  const part = evalsDevChatPart({
    sessions: () => fake.sessions as unknown as EvalsDevSessions,
    history,
    showReview,
    answerReview,
    applyEdits,
  })
  const tool = (name: string): DevChatTool => part.tools.find((candidate) => candidate.name === name)!
  const call = async (name: string, input: Record<string, JSONValue> = {}): Promise<unknown> =>
    JSON.parse(await tool(name).run(input))
  return { ...fake, part, tool, call, history, showReview, answerReview, applyEdits }
}

/** Saves refunds with two cases as a file, for the tools that read it. */
const saveExperimentFile = async (
  experiments: ReturnType<typeof setup>['experiments'],
  evaluators: readonly string[]
): Promise<void> => {
  const folder = await temporaryDirectory('dev-background-')
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
  experiments.saved = [{ ...REFUNDS, path }]
  experiments.set({ folder, generations: [] })
}

const APPLIED: EvalsAppliedChange = {
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

describe('dev chat instructions', () => {
  it('shouldTellTheAgentWhatStrandsDevChangedInItWhenAnOptimizationWasApplied', () => {
    const { part } = setup([APPLIED])

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

  it('shouldTellTheAgentThatAutoAcceptMadeAChangeTheDeveloperWasNotShown', () => {
    const { part } = setup([{ ...APPLIED, auto: true }])

    expect(part.instructions).toContain(
      '- 2026-11-17T14:52:03.000Z: auto-accept applied 3 edits from run 20261117-144415-diffs of the experiment diffs. ' +
        'The developer has auto-accept on, so they were not shown these edits before they were written. ' +
        'The best candidate scored 0.00 → 1.00 on the test cases.'
    )
  })

  it('shouldSayWhereApplyStoppedWhenAnEditCouldNotBeWritten', () => {
    const { part } = setup([{ ...APPLIED, edits: [], error: 'Could not change agent.ts: it changed.' }])

    expect(part.instructions).toContain('/optimize applied 0 edits from run')
    expect(part.instructions).toContain('Apply stopped early: Could not change agent.ts: it changed.')
  })

  it('shouldLeaveOutTheChangesWhenStrandsDevChangedNothing', () => {
    const { part } = setup()

    expect(part.instructions).not.toContain('Changes that strands dev made to this agent')
  })

  it('shouldGuideTheAgentOnPaidRunsTheAutomaticOptimizationAndADiffOnScreen', () => {
    const { part, tool } = setup()

    for (const guidance of [
      // Plain requests go to the evals skills, and the approval of a paid run waits for a later turn.
      'activate the strands-evals skill',
      'activate the optimize skill',
      'follow the background-evals skill',
      'start a run only after the developer approves it in a later turn',
      'call strands_dev_status again whenever the question is what exists',
      // What the two automatic settings do, so the agent does not go looking for them.
      'Auto-optimize every N turns makes an experiment from the chats',
      'Auto-accept optimization results writes the edits of a finished run',
      'strands_dev_auto_optimize reads and sets them, so do not search files',
      'say what it does and that every automatic run is paid',
      'A question whether you can is not yet a request',
      // A message that came with a diff on screen answers that diff.
      'A message that comes with a <strands_dev_screen> block',
      'pick for them with strands_dev_answer_review',
      'do not ask them to confirm',
    ])
      expect(part.instructions).toContain(guidance)
    expect(tool('strands_dev_run_background').description).toContain(
      'only after the developer answered yes, in an earlier turn'
    )
    expect(tool('strands_dev_auto_optimize').description).toContain('"optimize every 20 turns from my history"')
  })
})

describe('dev chat part', () => {
  it('shouldOfferTheSkillAndLetOnlyTheStatusSkipThePromptWhenThePartIsBuilt', () => {
    const { part } = setup()

    expect(part.skills.map(({ name }) => name)).toEqual(['strands-evals', 'optimize', 'background-evals'])
    expect(part.tools.map(({ name, readOnly }) => [name, readOnly === true])).toEqual([
      ['strands_dev_status', true],
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
      ['strands_dev_auto_optimize', false],
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
    const { call, evaluate } = setup()
    evaluate.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })

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
    const { call, evaluate, sessions } = setup()
    sessions.evaluate.show.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            evaluate.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
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

  it('shouldReadSavedCasesAndEvaluatorsWithoutRunningAnything', async () => {
    const { call, experiments, sessions } = setup()
    await saveExperimentFile(experiments, ['OutputEvaluator'])

    expect(await call('strands_dev_read_experiment', { experiment: 'refunds', limit: 1 })).toMatchObject({
      total: 2,
      nextOffset: 1,
      evaluators: [{ evaluator_type: 'OutputEvaluator' }],
      cases: [{ name: 'first', input: 'First request' }],
    })
    expect(await call('strands_dev_read_experiment', { experiment: 'refunds', offset: 1 })).toMatchObject({
      offset: 1,
      cases: [{ name: 'second', input: 'Second request' }],
    })
    expect(sessions.evaluate.run).not.toHaveBeenCalled()
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
    const { call, evaluate, sessions } = setup()
    expect(await call('strands_dev_evaluation_results', { experiment: 'refunds' })).toMatchObject({ status: 'not_run' })
    evaluate.set({ runs: [{ experiment: REFUNDS, run: { status: 'done', results: results() } }] })
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
    expect(sessions.evaluate.run).not.toHaveBeenCalled()
    expect(sessions.evaluate.runOnly).not.toHaveBeenCalled()
  })

  it.each<[OptimizeRunState, object]>([
    [
      { step: 'cancelled', experiment: 'refunds', run: 'run-7' },
      { step: 'cancelled', experiment: 'refunds', run: 'run-7' },
    ],
    [
      {
        step: 'running',
        progress: {
          ...progress(),
          phase: 'validating',
          rollouts: { done: 21, total: 30 },
        },
      },
      // Which part of the run is going, and how far the whole run is.
      { step: 'running', phase: 'checking the finalists on the validation cases', rollouts: { done: 21, total: 30 } },
    ],
  ])('shouldReportTheOptimizationInTheWorkspaceStatusWhenItIs %o', async (run, optimization) => {
    const { call, finishRun } = setup()
    finishRun(run)

    expect(await call('strands_dev_status')).toMatchObject({ optimization })
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

  it('shouldGiveTheSplitWarningAndTheObjectiveWarningTogetherWhenItPlans', async () => {
    const { tool, optimize, sessions } = setup()
    vi.mocked(sessions.optimize.plan).mockImplementation(() =>
      setTimeout(
        () =>
          optimize.set({
            step: 'setup',
            plan: { ...plan(), warning: 'The split warning.', objectiveWarning: 'The objective warning.' },
          }),
        0
      )
    )

    const planned = JSON.parse(await tool('strands_dev_optimization_plan').run({ experiment: 'refunds' }))

    expect(planned.warning).toBe('The split warning. The objective warning.')
  })

  it('shouldGiveTheFileChangeWarningInTheStatusAndInThePlanWhenTheAgentCanChangeFiles', async () => {
    const { tool, call, sessions } = setup()
    const warning = 'Evaluations and optimizations run this agent in /w, and its shell tool can change files there.'
    vi.mocked(sessions.fileChanges).mockReturnValue(warning)

    const status = await call('strands_dev_status')
    const planned = JSON.parse(await tool('strands_dev_optimization_plan').run({ experiment: 'refunds' }))

    expect(status).toMatchObject({ fileChanges: warning })
    expect(planned.warning).toBe(warning)
  })

  it('shouldPlanWhileAnotherOptimizationIsRunning', async () => {
    const { tool, optimize } = setup()
    optimize.set({
      step: 'pick',
      runs: [{ id: 'run-1', experiment: 'refunds', state: { step: 'running', progress: {} } }],
    } as never)

    const planned = JSON.parse(await tool('strands_dev_optimization_plan').run({ experiment: 'refunds' }))

    expect(planned.knobs.length).toBeGreaterThan(0)
  })

  it('shouldAnswerTheEditsTheDeveloperNamedWithApplyAndSayWhatWasWritten', async () => {
    const { call, applyEdits, sessions } = setup()

    const applied = await call('strands_dev_apply_optimization', { run: review().run, edits: [0] })

    expect(applyEdits.mock.calls).toEqual([[{ run: review().run, edits: [0] }]])
    expect(applied).toEqual({
      run: review().run,
      applied: ['agent.py'],
      next: 'Evaluate the experiment again, after the developer approves it, to check the change.',
    })
    // The tool does not set the edits it was not given: each keeps the answer it has.
    expect(sessions.optimize.accept).not.toHaveBeenCalled()
  })

  it.each([
    [
      { waiting: 1, shown: true },
      '1 other edit of this run still waits',
      'The diff of a waiting edit is on their screen now.',
    ],
    [
      { waiting: 2, shown: false },
      '2 other edits of this run still wait',
      'The run is on the status line under the chat input',
    ],
  ] as const)('shouldSayThatNothingIsWrittenWhileAnEditStillWaits %#', async (outcome, still, where) => {
    const { call, applyEdits } = setup()
    applyEdits.mockResolvedValue({ run: review().run, settled: false, ...outcome })

    const applied = (await call('strands_dev_apply_optimization', { run: review().run, edits: [0] })) as {
      next: string
    }

    expect(applied).toMatchObject({ run: review().run, awaitingAnswer: outcome.waiting })
    expect(applied).not.toHaveProperty('applied')
    expect(applied.next).toContain('Their answer is kept, and nothing is written yet')
    expect(applied.next).toContain(still)
    expect(applied.next).toContain(where)
  })

  it.each([
    ['why the edits could not be answered', new Error('Run r has no edit 4.'), 'Run r has no edit 4.'],
    [
      'why an edit could not be written',
      { run: 'r', settled: true, applied: [], applyError: 'agent.py changed.' },
      'agent.py changed.',
    ],
  ] as const)('shouldPassOn%s', async (_case, outcome, message) => {
    const { tool, applyEdits } = setup()
    if (outcome instanceof Error) applyEdits.mockRejectedValue(outcome)
    else applyEdits.mockResolvedValue({ ...outcome, applied: [...outcome.applied] })

    await expect(tool('strands_dev_apply_optimization').run({ run: 'r', edits: [0] })).rejects.toThrow(message)
  })
})

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
        '--max-rollouts',
        '900',
        '--split',
        '0.6,0.2,0.2',
        '--seed',
        '3',
        '--rerun-passes=1',
        '--reflection-model',
        'bedrock/proposer',
        '--rich',
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
    expect(sessions.optimize.setMaxRollouts).toHaveBeenCalledWith(900)
    expect(sessions.optimize.setSplit).toHaveBeenCalledWith([0.6, 0.2, 0.2])
    expect(sessions.optimize.setSeed).toHaveBeenCalledWith(3)
    expect(sessions.optimize.setRerunPasses).toHaveBeenCalledWith(1)
    expect(sessions.optimize.setPassed).toHaveBeenCalledWith(['--reflection-model', 'bedrock/proposer'])
    expect(started).toMatchObject({
      status: 'started',
      command: 'optimize run',
      experiment: 'refunds',
      run: 'run-1',
      file: REFUNDS.path,
      ignored: ['--rich: strands dev reads the run itself'],
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
    ['a flag it cannot pass', ['--pick-rule', 'mean'], 'strands dev cannot pass --pick-rule'],
    ['a flag that loads code', ['--on-iteration', 'hooks:report'], 'strands dev cannot pass --on-iteration'],
    ['a rollout budget of zero', ['--max-rollouts', '0'], '--max-rollouts must be a whole number of at least 1.'],
    [
      'a rollout budget past a safe integer',
      ['--max-rollouts', '99999999999999999999'],
      '--max-rollouts must be a whole number of at least 1.',
    ],
    ['a split that does not sum to 1', ['--split', '0.5,0.5,0.5'], '--split takes TRAIN,VALIDATION,TEST shares'],
    ['a model knob without models', ['--tune', 'model'], 'Tuning the model needs'],
  ])('shouldRefuseToOptimizeWhenTheFlagsHave%s', async (_case, args, message) => {
    const { tool, sessions } = setup()

    await expect(tool('strands_dev_run_background').run(optimizeRun(args))).rejects.toThrow(message)
    expect(sessions.optimize.start).not.toHaveBeenCalled()
  })

  it('shouldSayWhyAndNotStartWhenThePlanNeedsMoreRolloutsThanOneRunCanUse', async () => {
    const { tool, sessions, optimize } = setup()
    const budgetProblem =
      'Needs about 620 rollouts with re-run headroom, but this run can use 500. Lower the steps, candidates, or runs, or raise --max-rollouts.'
    sessions.optimize.setRepetitions.mockImplementation(() => {
      const current = optimize.snapshot()
      if (current.step === 'setup') optimize.set({ ...current, plan: { ...current.plan, budgetProblem } })
    })

    await expect(tool('strands_dev_run_background').run(optimizeRun(['--runs-per-candidate', '5']))).rejects.toThrow(
      budgetProblem
    )
    expect(sessions.optimize.start).not.toHaveBeenCalled()
  })

  it('shouldSayWhyAndNotStartWhenTheSplitLeavesNoValidationCase', async () => {
    const { tool, sessions, optimize } = setup()
    const splitProblem =
      'The split leaves 2 train cases and 0 validation cases of 2; the optimizer needs at least 1 of each.'
    sessions.optimize.setSplit.mockImplementation(() => {
      const current = optimize.snapshot()
      if (current.step === 'setup') optimize.set({ ...current, plan: { ...current.plan, splitProblem } })
    })

    await expect(tool('strands_dev_run_background').run(optimizeRun(['--split', '0.9,0.05,0.05']))).rejects.toThrow(
      splitProblem
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
    await saveExperimentFile(experiments, ['Helpfulness'])

    await call('strands_dev_run_background', optimizeRun(args))

    expect(sessions.optimize.setObjective).toHaveBeenCalledWith({ expression, constraints })
  })

  it('shouldRefuseAnObjectiveThatIsNotAnEvaluatorOfTheExperiment', async () => {
    const { tool, sessions, experiments } = setup()
    await saveExperimentFile(experiments, ['OutputEvaluator'])

    await expect(
      tool('strands_dev_run_background').run(optimizeRun(['--objective', 'maximize:Helpfulness']))
    ).rejects.toThrow('Helpfulness is not an evaluator of this experiment or a usage number')
    expect(sessions.optimize.reset).not.toHaveBeenCalled()
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
    expect(sessions.evaluate.run).toHaveBeenCalledWith([REFUNDS])
  })

  it('shouldRunOnlyTheNamedCasesAndRefuseAnUnknownCaseOrASecondRun', async () => {
    const { call, tool, sessions, experiments, evaluate } = setup()
    await saveExperimentFile(experiments, ['OutputEvaluator'])
    const [saved] = experiments.saved
    await expect(
      tool('strands_dev_run_background').run({ command: 'run', experiment: 'refunds', args: ['--case', 'third'] })
    ).rejects.toThrow('refunds has no case third.')

    const only = await call('strands_dev_run_background', {
      command: 'run',
      experiment: 'refunds',
      args: ['--case', 'second', '--max-workers', '2'],
    })
    evaluate.set({
      runs: [
        {
          experiment: saved!,
          run: { status: 'running', cases: 1, done: 0 },
        },
      ],
    })

    expect(only).toMatchObject({ cases: 1, ignored: ['--max-workers: strands dev sets it'] })
    expect(sessions.evaluate.runOnly).toHaveBeenCalledWith(saved, ['second'])
    await expect(tool('strands_dev_run_background').run({ command: 'run', experiment: 'refunds' })).rejects.toThrow(
      'refunds is already running.'
    )
  })

  it('shouldGenerateANewExperimentFromTheFlagsOfStrandsEvalsGenerate', async () => {
    const { call, tool, sessions, experiments } = setup()
    const log = '/w/strands-dev/tmp/.state/drafts/billing.log'
    sessions.experiments.generateInBackground.mockImplementationOnce((settings) => {
      const generation = { id: 'generation-1', name: 'billing', settings, phase: 'preparing' as const, log }
      experiments.set({
        ...experiments.snapshot(),
        generations: [{ ...generation, made: 0, failed: 0, total: 3 }],
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
    const { call, tool, sessions, experiments, evaluate, optimize } = setup()
    const stop = (command: string, experiment = 'refunds') =>
      tool('strands_dev_stop_background').run({ command, experiment })

    await expect(stop('run')).rejects.toThrow('No evaluation of refunds is running.')
    await expect(stop('optimize run')).rejects.toThrow('No optimization of refunds is running.')
    await expect(stop('generate', 'billing')).rejects.toThrow('No generation of billing is running.')

    evaluate.set({
      runs: [
        {
          experiment: REFUNDS,
          run: { status: 'running', cases: 2, done: 0 },
        },
      ],
    })
    optimize.set({
      step: 'pick',
      runs: [{ id: 'run-4', experiment: 'refunds', state: { step: 'running', progress: progress() } }],
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
    expect(sessions.evaluate.stop).toHaveBeenCalledWith(REFUNDS.path)
    expect(sessions.optimize.stop).toHaveBeenCalledWith('run-4')
    expect(sessions.experiments.cancel).toHaveBeenCalledWith('generation-2')
  })
})

describe('dev chat tool errors and states', () => {
  it.each<[string, Record<string, JSONValue>, string]>([
    ['read_experiment', { experiment: 'billing' }, 'There is no experiment named billing. Saved experiments: refunds.'],
    ['read_experiment', { experiment: 5 }, 'experiment must be text.'],
    ['read_experiment', {}, 'experiment is required.'],
    ['apply_optimization', { edits: [0] }, 'run is required.'],
    ['apply_optimization', { run: 'r', edits: ['first'] }, 'There is no edit first.'],
    ['apply_optimization', { run: 'r', edits: [-1] }, 'There is no edit -1.'],
    ['auto_optimize', { everyTurns: 7.5 }, 'everyTurns must be a whole number from 0 to 9999.'],
    ['auto_optimize', { everyTurns: -1 }, 'everyTurns must be a whole number from 0 to 9999.'],
    ['auto_optimize', { everyTurns: 10000 }, 'everyTurns must be a whole number from 0 to 9999.'],
    ['auto_optimize', { everyTurns: 'often' }, 'everyTurns must be a whole number from 0 to 9999.'],
    ['auto_optimize', { acceptResults: 'yes' }, 'acceptResults must be true or false.'],
    ['answer_review', { edit: 0, answer: 'apply' }, 'run is required.'],
    ['answer_review', { run: 'r', answer: 'apply' }, 'edit must be the index of the edit'],
    ['answer_review', { run: 'r', edit: 0, answer: 'yes' }, 'answer must be apply or leave.'],
  ])('shouldRefuseAndDoNothingWhen %s is called with %j', async (name, input, message) => {
    const { tool, sessions, applyEdits, answerReview } = setup()

    await expect(tool(`strands_dev_${name}`).run(input)).rejects.toThrow(message)
    for (const effect of [applyEdits, answerReview, sessions.setSettings]) expect(effect).not.toHaveBeenCalled()
  })

  it('shouldFindAnExperimentInAnyCaseAndSayWhenNoneIsSaved', async () => {
    const { call, tool, experiments } = setup()

    expect(await call('strands_dev_evaluation_results', { experiment: 'REFUNDS' })).toMatchObject({
      experiment: 'refunds',
      status: 'not_run',
    })
    experiments.saved = []
    await expect(tool('strands_dev_evaluation_results').run({ experiment: 'refunds' })).rejects.toThrow(
      'no experiment is saved yet'
    )
  })

  it('shouldReportARunningOrFailedEvaluationWithoutItsCases', async () => {
    const { call, evaluate } = setup()

    evaluate.set({
      runs: [
        {
          experiment: REFUNDS,
          run: { status: 'running', cases: 2, done: 1 },
        },
      ],
    })
    const running = await call('strands_dev_evaluation_results', { experiment: 'refunds' })
    evaluate.set({ runs: [{ experiment: REFUNDS, run: { status: 'failed', message: 'It stopped.' } }] })

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
        { id: 'run-3', experiment: 'refunds', state: { step: 'running', progress: progress() } },
        { id: 'run-2', experiment: 'refunds', state: { step: 'review', review: review() } },
        { id: 'run-1', experiment: 'refunds', state: { step: 'failed', message: 'It crashed.' } },
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

  describe('what the developer answered for each edit, in the status', () => {
    const [offered, unavailable] = review().edits
    const statusOf = async (change: Partial<OptimizeReview>) => {
      const { call, finishRun } = setup()
      finishRun({ step: 'review', review: { ...review(), ...change } })
      return ((await call('strands_dev_status')) as { optimization: { edits: object[]; next?: string } }).optimization
    }

    it('shouldSayThatAnEditStillWaitsAndGiveNoAnswerForOneThatWasNeverOffered', async () => {
      const status = await statusOf({})

      expect(status.edits[0]).toMatchObject({ answer: 'waiting' })
      expect(status.edits[1]).not.toHaveProperty('answer')
      // It waits without being called "on screen": the diff may be closed.
      expect(status).toMatchObject({
        step: 'review',
        awaitingAnswer: 1,
        next: expect.stringContaining('The diff may not be showing'),
      })
    })

    it('shouldSayThatAnEditWasLeftAsItIsSoABareYesDoesNotApplyIt', async () => {
      const status = await statusOf({
        reviewed: true,
        edits: [{ ...offered!, accepted: false, decided: true }, unavailable!],
      })

      expect(status.edits[0]).toMatchObject({ answer: 'leave as it is' })
      expect(status).not.toHaveProperty('awaitingAnswer')
      expect(status.next).toBe(
        'The developer left 1 edit of this run as it is. That is their answer: apply such an edit only when they ' +
          'ask for that change in so many words, never on a bare "yes" or "ok".'
      )
    })

    it('shouldSayBothWhenOneEditWaitsAndAnotherWasLeft', async () => {
      const status = await statusOf({
        edits: [
          { ...offered!, accepted: false, decided: true },
          { ...offered!, knob: 'effort', label: 'effort' },
        ],
      })

      expect(status.edits).toMatchObject([{ answer: 'leave as it is' }, { answer: 'waiting' }])
      expect(status.next).toContain('1 edit of this run still waits')
      expect(status.next).toContain('The developer left 1 edit of this run as it is.')
    })

    it.each([
      [
        'was applied on screen',
        { reviewed: true, applied: ['agent.py'], edits: [{ ...offered!, decided: true }] },
        'apply',
      ],
      [
        'was written by auto-accept',
        { auto: true, reviewed: true, applied: ['agent.py'], edits: [{ ...offered!, decided: true }] },
        undefined,
      ],
      ['was written without an answer', { applied: ['agent.py'] }, undefined],
      ['was closed with an edit unanswered', { reviewed: true }, undefined],
    ] as const)('shouldSayWhatWasAnsweredAndNothingMoreWhenTheRun%s', async (_case, change, answer) => {
      const status = await statusOf(change as Partial<OptimizeReview>)

      expect((status.edits[0] as { answer?: string }).answer).toBe(answer)
      expect(status).not.toHaveProperty('next')
      expect(status).not.toHaveProperty('awaitingAnswer')
    })
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

  describe('optimization that runs by itself', () => {
    it('shouldSayThatBothAreOffAndWhereTheDeveloperSetsThem', async () => {
      const { call, sessions } = setup()

      const read = await call('strands_dev_auto_optimize')

      expect(read).toEqual({
        autoOptimize: { everyTurns: 0, state: 'off: an optimization starts only when the developer asks for one' },
        autoAcceptOptimizationResults:
          'off: the edits of a finished run show as a diff, and the developer applies or leaves each one',
        choices: { everyTurns: 'a whole number from 0 to 9999' },
        where: 'Both are in /settings, under Strands dev workspace.',
      })
      expect(sessions.setSettings).not.toHaveBeenCalled()
    })

    it('shouldSetHowManyTurnsPassBetweenTheRunsAndSayWhatThenHappens', async () => {
      const { call, sessions } = setup()

      const set = (await call('strands_dev_auto_optimize', { everyTurns: 20 })) as {
        autoOptimize: { state: string }
      }

      expect(sessions.setSettings.mock.calls).toEqual([[{ autoOptimize: 20 }]])
      expect(set.autoOptimize).toMatchObject({ everyTurns: 20, turnsSinceTheLastOne: 3 })
      // The agent of the chat has no part in it, so it is told not to expect a request or to start anything.
      expect(set.autoOptimize.state).toContain('strands dev works in the background, outside this chat')
      expect(set.autoOptimize.state).toContain('you are sent nothing and start nothing')
      expect(set.autoOptimize.state).toContain('Each one is a paid run.')
      expect(set.autoOptimize).not.toHaveProperty('now')
    })

    it('shouldSayWhatTheBackgroundAgentMakesRightNowAndWhereItsLogIs', async () => {
      const { call, sessions } = setup()
      await call('strands_dev_auto_optimize', { everyTurns: 20 })
      sessions.auto.status.mockResolvedValueOnce({
        everyTurns: 20,
        turnsSince: 21,
        building: 'history-20261123-1502',
        log: '/w/strands-dev/tmp/.state/auto-optimize/history-20261123-1502.log',
      })

      const read = (await call('strands_dev_auto_optimize')) as { autoOptimize: { now: string } }

      expect(read.autoOptimize.now).toBe(
        'The background agent is making the experiment history-20261123-1502 from the chats. ' +
          'Its log: /w/strands-dev/tmp/.state/auto-optimize/history-20261123-1502.log'
      )
    })

    it('shouldSetWhetherTheEditsAreWrittenWithoutADiffAndLeaveTheTurnsAsTheyAre', async () => {
      const { call, sessions } = setup()

      const set = await call('strands_dev_auto_optimize', { acceptResults: true })

      expect(sessions.setSettings.mock.calls).toEqual([[{ autoAcceptOptimizationResults: true }]])
      expect(set).toMatchObject({
        autoOptimize: { everyTurns: 0 },
        autoAcceptOptimizationResults:
          'on: the edits of a finished run are written to the agent source without a diff to answer',
      })
    })

    it('shouldTurnBothOffInOneCall', async () => {
      const { call, sessions } = setup()
      await call('strands_dev_auto_optimize', { everyTurns: 50, acceptResults: true })

      await call('strands_dev_auto_optimize', { everyTurns: 0, acceptResults: false })

      expect(sessions.setSettings.mock.calls.at(-1)).toEqual([
        { autoOptimize: 0, autoAcceptOptimizationResults: false },
      ])
    })

    it('shouldSayThatTheBackgroundAgentStoppedWhenTurningItOffStoppedOne', async () => {
      const { call, sessions } = setup()
      sessions.auto.settingChanged.mockResolvedValueOnce('history-20261123-1502')

      const set = (await call('strands_dev_auto_optimize', { everyTurns: 0 })) as { stopped?: string }

      // Without this the agent told the developer that the work went on and offered to stop it.
      expect(set.stopped).toBe(
        'The background agent that was making history-20261123-1502 has stopped, and no optimization starts from it.'
      )
      expect(sessions.auto.settingChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
        sessions.setSettings.mock.invocationCallOrder[0]!
      )
    })
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
  })

  it('shouldSayInThePlanAndTheStatusWhenAutoAcceptWritesTheEditsWithoutAReview', async () => {
    const { call, sessions, finishRun } = setup()

    const off = await call('strands_dev_optimization_plan', { experiment: 'refunds' })
    sessions.optimize.autoApplies.mockReturnValue(true)
    const on = await call('strands_dev_optimization_plan', { experiment: 'refunds' })
    finishRun({ step: 'review', review: { ...review(), auto: true, reviewed: true, applied: ['agent.py'] } })
    const status = (await call('strands_dev_status')) as { optimization: object }

    expect(off).not.toHaveProperty('autoAccept')
    expect(on).toMatchObject({ autoAccept: expect.stringContaining('writes its edits to the agent source') })
    expect(status.optimization).toMatchObject({ step: 'review', autoApplied: true, applied: ['agent.py'] })
    expect(status.optimization).not.toHaveProperty('awaitingAnswer')
  })
})
