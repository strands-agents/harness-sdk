import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import type {
  CaseResult,
  ExperimentsState,
  ExperimentSummary,
  OptimizePlan,
  OptimizeReview,
  OptimizeStep,
  OptimizeSession,
  OptimizeState,
  PastRun,
  PastRuns,
  RunAgent,
  TestCheck,
  TestResults,
  TestSession,
  TestState,
  UsageEstimate,
} from '../../../src/dev/panels/model.js'
import { OptimizePanel } from '../../../src/dev/panels/optimize.js'
import { TestPanel } from '../../../src/dev/panels/test.js'
import { listWindow } from '../../../src/dev/panels/ui.js'
import type { DevChatPanelProps, DevChatPanelView } from '../../../src/ui/chat/types.js'
import { DevPanelClicks, DevPanelFrame } from '../../../src/ui/panels/dev.js'
import { experimentsSession, generation, panelProps as freshProps, show, store } from './fixtures.js'

const DOWN_KEY = '\u001b[B'
const RIGHT_KEY = '\u001b[C'

const panelProps = freshProps()

const capital = { name: 'capital', path: '/w/capital.json', caseCount: 4 }
const refunds = { name: 'refunds', path: '/w/refunds.json', caseCount: 2 }
const cities = { name: 'cities', path: '/w/cities.json', caseCount: 6 }

const finishedResults: TestResults = {
  experiment: 'refunds',
  evaluators: ['OutputEvaluator'],
  overall: 0.5,
  report: '/w/report.json',
  seconds: 41,
  cases: [
    {
      name: 'standard-refund',
      input: 'Refund order 2001',
      passed: true,
      verdicts: [{ evaluator: 'OutputEvaluator', score: 1, passed: true, reason: 'Refunded correctly' }],
    },
    {
      name: 'refund-window',
      input: 'Refund order 1094',
      passed: false,
      verdicts: [
        {
          evaluator: 'OutputEvaluator',
          score: 0,
          passed: false,
          reason: 'issued refund without checking delivery date',
        },
      ],
    },
  ],
}

const testSession = (runs: TestState['runs'] = [], generations: Partial<ExperimentsState> = {}) => {
  const states = store<TestState>({ runs })
  const { session: experiments } = experimentsSession({ saved: [capital, refunds, cities], ...generations })
  return {
    states,
    session: {
      experiments,
      subscribe: states.subscribe,
      snapshot: states.snapshot,
      run: vi.fn(),
      rerunFailed: vi.fn(),
      stop: vi.fn(),
    } satisfies TestSession,
  }
}

const withRuns = (): TestState['runs'] => [
  {
    experiment: capital,
    run: { status: 'running', cases: 4, evaluators: ['OutputEvaluator'], done: 2, startedAt: Date.now(), rerun: false },
  },
  { experiment: refunds, run: { status: 'done', results: finishedResults } },
]

const withStoppedRun = (): TestState['runs'] => [
  ...withRuns(),
  { experiment: cities, run: { status: 'failed', message: 'All case names must be unique.' } },
]

const showViewInFrame = async (command: string, view: DevChatPanelView, clicks: DevPanelClicks, width = 100) => {
  const props = freshProps()
  const panel = {
    id: 'panel-1',
    kind: 'dev' as const,
    command,
    title: `/${command}`,
    rows: [],
    view,
    close: props.close,
    openCommand: props.openCommand,
  }
  const shown = await show(createElement(DevPanelFrame, { panel, width, height: 22, clicks }), 24)
  const click = async (target: string): Promise<void> => {
    await vi.waitFor(() => expect(shown.text(), `Visible target: ${target}`).toContain(target))
    const lines = shown.text().split('\n')
    const row = lines.findIndex((line) => line.includes(target))
    const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(target))) + 1
    clicks.at({ button: 0, action: 'release', column, row: row + 1 })?.()
    await shown.instance.waitUntilRenderFlush()
  }
  return { ...shown, click }
}

const showInFrame = (session: TestSession, clicks: DevPanelClicks) =>
  showViewInFrame('test', (viewProps) => createElement(TestPanel, { ...viewProps, session }), clicks)

const showOptimizeInFrame = (session: OptimizeSession, clicks: DevPanelClicks) =>
  showViewInFrame('optimize', (viewProps) => createElement(OptimizePanel, { ...viewProps, session }), clicks, 120)

describe('TestPanel', () => {
  it('shouldListEveryExperimentWithItsLastResultWhenItOpens', async () => {
    const { session } = testSession(withRuns(), {
      generations: [
        generation({ name: 'returns' }),
        generation({ id: 'generation-2', name: 'broken', phase: 'failed' }),
      ],
    })

    const { text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    expect(text()).toContain('test · 3 experiments · 1 running')
    expect(text()).toMatch(/☐ capital\s+4 cases · running 2\/4/u)
    expect(text()).toMatch(/☐ refunds\s+2 cases · 1\/2 passed/u)
    expect(text()).toMatch(/☐ cities\s+6 cases · not run yet/u)
    expect(text()).toContain('generating · 8/20 cases')
    expect(text()).not.toContain('broken')
  })

  it('shouldStopTheRunWhenTheUserPressesSInTheProgressView', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press('\r')
    expect(text()).toContain('s stop the run')
    await press('s')

    expect(session.stop).toHaveBeenCalledWith(capital.path)
  })

  it('shouldRunTheSelectedExperimentsWhenTheUserSelectsSomeAndConfirmsEnter', async () => {
    const { session } = testSession()
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(' ')
    await press(DOWN_KEY)
    await press(DOWN_KEY)
    await press(' ')
    const selected = text()
    await press('\r')
    const confirm = text().replace(/\s+/gu, ' ')
    await press('\r')

    expect(selected).toContain('2 selected')
    expect(selected).toContain('Enter run 2')
    expect(confirm).toContain('test · 2 experiments · start a paid run?')
    expect(confirm).toContain(
      'Your agent answers 10 cases from 2 experiments with the model that the agent file sets: capital 4 and cities 6.'
    )
    expect(session.run).toHaveBeenCalledWith([capital, cities])
  })

  it('shouldRunEveryExperimentWhenTheUserSelectsAllAndConfirmsEnter', async () => {
    const { session } = testSession()
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press('a')
    await press('\r')
    await press('\r')

    expect(session.run).toHaveBeenCalledWith([capital, refunds, cities])
  })

  it('shouldRunTheHighlightedExperimentWhenNothingIsSelectedAndTheUserConfirms', async () => {
    const { session } = testSession()
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press('\r')
    await press('\r')

    expect(session.run).toHaveBeenCalledWith([refunds])
  })

  it.each<[string, TestState['runs'], string[], string]>([
    ['EnterOnAnExperiment', [], [DOWN_KEY, '\r'], 'Your agent answers the 2 cases of refunds with'],
    ['EnterOnAStoppedRun', withStoppedRun(), [DOWN_KEY, DOWN_KEY, '\r', '\r'], 'answers the 6 cases of cities again'],
    ['RInTheReport', withRuns(), [DOWN_KEY, '\r', 'r'], 'answers the 1 failed case of refunds again'],
    ['AInTheReport', withRuns(), [DOWN_KEY, '\r', 'a'], 'answers the 2 cases of refunds again'],
  ])('shouldAskAndNotRunWhenTheUserPresses%s', async (_key, runs, keys, scope) => {
    const { session } = testSession(runs)
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    for (const key of keys) await press(key)

    expect(text()).toContain('start a paid run?')
    expect(text().replace(/\s+/gu, ' ')).toContain(scope)
    expect(text()).toContain('Each answer makes paid model calls')
    expect(session.run).not.toHaveBeenCalled()
    expect(session.rerunFailed).not.toHaveBeenCalled()
  })

  it('shouldRunAgainWhenTheUserConfirmsTheRetryOfAStoppedRun', async () => {
    const { session } = testSession(withStoppedRun())
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    for (const key of [DOWN_KEY, DOWN_KEY, '\r', '\r', '\r']) await press(key)

    expect(session.run).toHaveBeenCalledWith([cities])
  })

  it('shouldKeepTheSelectionAndNotRunWhenTheUserPressesEscOnTheConfirm', async () => {
    const { session } = testSession()
    const props = freshProps()
    const { press, text } = await show(createElement(TestPanel, { ...props, session }), 24)

    for (const key of [' ', DOWN_KEY, ' ', '\r', '\u001b']) await press(key)

    await vi.waitFor(() => expect(text()).toContain('2 selected'))
    expect(session.run).not.toHaveBeenCalled()
    expect(props.close).not.toHaveBeenCalled()
  })

  it.each<[string, RunAgent, string[], string[]]>([
    [
      'ShellAndWriteTools',
      { model: 'us.anthropic.claude-sonnet-4-6', folder: '/w/project', fileTools: ['shell', 'write'] },
      [
        'Your agent answers the 4 cases of capital with us.anthropic.claude-sonnet-4-6.',
        '⚠ The cases run in /w/project. The shell and write tools of your agent can change files there.',
      ],
      [],
    ],
    [
      'NoFileTools',
      { model: 'us.anthropic.claude-sonnet-4-6', folder: '/w/project', fileTools: [] },
      ['Your agent answers the 4 cases of capital with us.anthropic.claude-sonnet-4-6.'],
      ['can change files'],
    ],
  ])('shouldShowTheModelAndTheFileRiskOfTheAgentWhenItHas%s', async (_case, agent, shown, hidden) => {
    const { session } = testSession()
    const { press, text } = await show(
      createElement(TestPanel, { ...panelProps, session: { ...session, agent: () => agent } }),
      24
    )

    await press('\r')

    const flat = text().replace(/\s+/gu, ' ')
    for (const line of shown) expect(flat).toContain(line)
    for (const line of hidden) expect(flat).not.toContain(line)
  })

  it('shouldSkipExperimentsThatAreStillGeneratingWhenTheUserMovesDown', async () => {
    const { session } = testSession([], { generations: [generation({ name: 'returns' })] })
    const props = { ...panelProps, openCommand: vi.fn(() => true) }
    const { press } = await show(createElement(TestPanel, { ...props, session }), 24)

    for (let step = 0; step < 3; step++) await press(DOWN_KEY)
    await press('\r')

    expect(props.openCommand).toHaveBeenCalledWith('experiment')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('shouldShowTheFailuresFirstAndRerunThemWhenTheUserOpensTheResults', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press(RIGHT_KEY)
    const lines = text().split('\n')
    await press('r')
    await press('\r')

    const failed = lines.findIndex((line) => line.includes('✗ refund-window'))
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(failed).toBeLessThan(lines.findIndex((line) => line.includes('✓ standard-refund')))
    expect(text()).toContain('issued refund without checking delivery date')
    expect(session.rerunFailed).toHaveBeenCalledWith(refunds.path)
  })

  it('shouldGoBackToTheListWhenTheUserPressesEscOnTheResults', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)
    await press(DOWN_KEY)
    await press(RIGHT_KEY)

    await press('\u001b')

    await vi.waitFor(() => expect(text()).toContain('Space select'))
    expect(panelProps.close).not.toHaveBeenCalled()
  })

  it.each([
    ['Enter', '\r'],
    ['→', RIGHT_KEY],
  ])('shouldShowTheProgressWhenTheUserPresses%sOnARunningExperiment', async (_key, key) => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(key)

    expect(text()).toContain('test · capital · 4 cases · 1 evaluator')
    expect(text()).toContain('2/4')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('shouldOpenTheReportAndNotRunAgainWhenTheUserPressesEnterOnAFinishedExperiment', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    const list = text()
    await press('\r')

    expect(list).toContain('Enter open report')
    expect(text()).toContain('test · refunds · 2 cases · 1 evaluator')
    expect(text()).toContain('✗ refund-window')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('shouldShowWhyTheRunStoppedWhenTheUserPressesEnterOnAStoppedExperiment', async () => {
    const { session } = testSession(withStoppedRun())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press(DOWN_KEY)
    const list = text()
    await press('\r')

    expect(list).toContain('Enter show why it stopped')
    expect(text()).toContain('test · cities · stopped')
    expect(text()).toContain('All case names must be unique.')
    expect(session.run).not.toHaveBeenCalled()
  })

  it.each([
    ['capital', 0, 'Enter show progress'],
    ['cities', 2, 'Enter run'],
    ['Manage experiments', 3, 'Enter open /experiment'],
  ])('shouldSayWhatEnterDoesWhenTheCursorIsOn%s', async (_row, downs, hint) => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    for (let step = 0; step < downs; step++) await press(DOWN_KEY)

    expect(text()).toContain(`a all · ${hint} · Esc close`)
  })

  it('shouldOpenTheReportWhenTheUserClicksAFinishedExperiment', async () => {
    const { session } = testSession(withRuns())
    const { click, text } = await showInFrame(session, new DevPanelClicks())

    await click('refunds')

    await vi.waitFor(() => expect(text()).toContain('test · refunds · 2 cases · 1 evaluator'))
    expect(text()).toContain('issued refund without checking delivery date')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('shouldRunTheExperimentWhenTheUserClicksOneThatHasNotRunAndThenStartTheRun', async () => {
    const { session } = testSession(withRuns())
    const { click } = await showInFrame(session, new DevPanelClicks())

    await click('cities')
    await click('[ Start the run ]')

    expect(session.run).toHaveBeenCalledWith([cities])
  })

  it('shouldOpenTheCaseWhenTheUserClicksItInTheReport', async () => {
    const { session } = testSession(withRuns())
    const { click, text } = await showInFrame(session, new DevPanelClicks())
    await click('refunds')
    await vi.waitFor(() => expect(text()).toContain('standard-refund'))

    await click('standard-refund')

    await vi.waitFor(() => expect(text()).toContain('test · refunds · standard-refund · passed'))
    expect(text()).toMatch(/OutputEvaluator\s+✓ 1\.00\s+Refunded correctly/u)
  })

  it.each<[string, TestResults, string]>([
    ['TheTokensOfTheRun', { ...finishedResults, tokens: 12_345 }, '41s · 2 checks · score 0.50 · 12,345 tokens'],
    ['NoTokens', finishedResults, '41s · 2 checks · score 0.50'],
  ])('shouldShowTheTimeChecksScoreAndTokensInTheReportWhenTheResultsHave%s', async (_case, results, summary) => {
    const { session } = testSession([{ experiment: refunds, run: { status: 'done', results } }])
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press('\r')

    expect(text()).toMatch(new RegExp(`${summary}$`, 'mu'))
  })

  it('shouldRunEveryCaseAgainWhenTheUserPressesAInTheReport', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)
    await press(DOWN_KEY)
    await press('\r')
    const report = text()

    await press('a')
    await press('\r')

    expect(report).toContain('↑↓ · Enter open case · r rerun failed · a rerun all · Esc back to the list')
    expect(session.run).toHaveBeenCalledWith([refunds])
  })

  it.each([
    ['Enter', '\r'],
    ['→', RIGHT_KEY],
  ])('shouldShowTheWholeReasonAndOutputWhenTheUserPresses%sOnACase', async (_key, key) => {
    const { session, text } = await openFailedCase({ reason: LONG_REASON, actual: LONG_OUTPUT }, key)

    const flat = text().replace(/\s+/gu, ' ')
    expect(text()).toContain('test · refunds · refund-window · failed')
    expect(flat).toContain(`OutputEvaluator ✗ 0.00 ${LONG_REASON}`)
    expect(flat).toContain(`output ${LONG_OUTPUT}`)
    expect(flat).toContain('input Refund order 1094')
    expect(flat).toContain('expected Refuse the refund because the order is outside the 30-day window')
    expect(session.run).not.toHaveBeenCalled()
  })

  it('shouldStartEachWrappedRowOfAReasonUnderItsFirstWord', async () => {
    const { text } = await openFailedCase({ reason: LONG_REASON, actual: 'Refunded.' })

    const lines = text().split('\n')
    const first = lines.findIndex((line) => line.includes('The agent issued'))
    expect(first).toBeGreaterThanOrEqual(0)
    expect(lines[first + 1]!.search(/\S/u)).toBe(lines[first]!.indexOf('The agent issued'))
  })

  it.each([
    ['Down', DOWN_KEY, 'lines 2-17 of 33', 'step 14'],
    ['PageDown', '\u001b[6~', 'lines 16-31 of 33', 'step 28'],
    ['End', '\u001b[F', 'lines 18-33 of 33', 'step 30'],
  ])('shouldScrollALongCaseWhenTheUserPresses%s', async (_key, key, position, revealed) => {
    const { press, text } = await openFailedCase({ reason: 'issued refund without checking', actual: STEPS })
    const before = text()

    await press(key)

    expect(before).toContain('lines 1-16 of 33')
    expect(before).not.toContain(revealed)
    expect(text()).toContain(position)
    expect(text()).toContain(revealed)
  })

  it.each([
    ['Esc', '\u001b'],
    ['Left', '\u001b[D'],
    ['Backspace', '\u007f'],
    ['Enter', '\r'],
  ])('shouldGoBackToTheReportWhenTheUserPresses%sInACase', async (_key, key) => {
    const { press, text, props } = await openFailedCase({ reason: 'issued refund without checking', actual: '' })

    await press(key)

    await vi.waitFor(() => expect(text()).toContain('› ✗ refund-window'))
    expect(text()).toContain('Enter open case')
    expect(props.close).not.toHaveBeenCalled()
  })
})

const LONG_REASON =
  'The agent issued a refund before it confirmed eligibility. Policy requires a delivery-date check before any refund, and order 1094 shipped 41 days ago, which is outside the 30-day window.'

const LONG_OUTPUT =
  'I have refunded order 1094 in full. You will see $42.10 back on your original card within three to five business days, and I sent a confirmation email to the address on the order.'

const STEPS = Array.from({ length: 30 }, (_, index) => `step ${index + 1}`).join('\n')

const openFailedCase = async ({ reason, actual }: { reason: string; actual: string }, openKey = '\r') => {
  const results: TestResults = {
    ...finishedResults,
    cases: [
      finishedResults.cases[0]!,
      {
        name: 'refund-window',
        input: 'Refund order 1094',
        expected: 'Refuse the refund because the order is outside the 30-day window',
        actual,
        passed: false,
        verdicts: [{ evaluator: 'OutputEvaluator', score: 0, passed: false, reason }],
      },
    ],
  }
  const { session } = testSession([{ experiment: refunds, run: { status: 'done', results } }])
  const props = freshProps()
  const shown = await show(createElement(TestPanel, { ...props, session }), 24)
  await shown.press(DOWN_KEY)
  await shown.press('\r')
  await shown.press(openKey)
  return { ...shown, session, props }
}

type OptimizeAction = Exclude<keyof OptimizeSession, 'agent'>

const REFUNDS: ExperimentSummary = {
  name: 'refunds',
  path: '/w/strands-dev/experiments/refunds/refunds.json',
  caseCount: 4,
}

const optimizeSession = (initial: OptimizeState, experimentsState: Partial<ExperimentsState> = {}) => {
  const states = store(initial)
  const { session: experiments } = experimentsSession(experimentsState)
  return {
    states,
    session: {
      experiments,
      subscribe: states.subscribe,
      snapshot: states.snapshot,
      plan: vi.fn(),
      toggleKnob: vi.fn(),
      loadModels: vi.fn(),
      pickModel: vi.fn(),
      setIterations: vi.fn(),
      setSplit: vi.fn(),
      setObjective: vi.fn(),
      openExperiment: vi.fn(),
      openPastRun: vi.fn(),
      openRun: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      accept: vi.fn(),
      apply: vi.fn(),
      reset: vi.fn(),
    } satisfies OptimizeSession,
  }
}

const OBJECTIVE_PRESETS = [
  { label: 'the mean of every evaluator', objective: { expression: '', limits: '' } },
  { label: 'Contains only', objective: { expression: 'Maximize(Contains)', limits: '' } },
  { label: 'Equals only', objective: { expression: 'Maximize(Equals)', limits: '' } },
  {
    label: 'fewer tokens, each evaluator at least 0.8',
    objective: { expression: 'Minimize(tokens)', limits: 'Contains >= 0.8, Equals >= 0.8' },
  },
]

const setup: OptimizeState = {
  step: 'setup',
  plan: {
    experiment: { name: 'refunds', path: '/w/refunds.json', caseCount: 20 },
    knobs: [
      {
        key: 'instructions',
        label: 'instructions',
        detail: 'the system prompt',
        group: 'prompt',
        kind: 'text',
        enabled: true,
      },
      { key: 'effort', label: 'effort', detail: 'low · medium · high', group: 'model', kind: 'choice', enabled: false },
      {
        key: 'tools',
        label: 'tool descriptions',
        detail: '',
        group: 'tools',
        kind: 'switches',
        enabled: false,
        unavailable: 'strands-evals optimize cannot tune tools yet',
      },
    ],
    objective: { expression: '', limits: '' },
    objectivePresets: OBJECTIVE_PRESETS,
    metrics: ['Contains', 'Equals', 'tokens', 'seconds'],
    split: { train: 10, validation: 5, test: 5 },
    splitChoices: [
      { train: 8, validation: 6, test: 6 },
      { train: 10, validation: 5, test: 5 },
      { train: 12, validation: 4, test: 4 },
    ],
    repetitions: 1,
    width: 4,
    iterations: 4,
    iterationChoices: [1, 2, 4, 6, 8],
    rollouts: 230,
    judgeCalls: 230,
  },
}

const ESTIMATE: UsageEstimate = {
  tokens: { low: 800_000, high: 1_200_000 },
  seconds: { low: 320, high: 400 },
  basedOn: { experiment: 'refunds', runs: 2 },
}

const trial = (name: string, passed: boolean, reason: string, actual = 'an answer'): CaseResult => ({
  name,
  input: `question ${name}`,
  expected: `answer ${name}`,
  actual,
  passed,
  verdicts: [{ evaluator: 'OutputEvaluator', score: passed ? 1 : 0, passed, reason }],
})

const scoringState = (
  step: OptimizeStep = { kind: 'scoring', iteration: 1, versions: 2, trials: { done: 3, total: 16 } }
): OptimizeState => ({
  step: 'running',
  progress: {
    run: '20261117-142504-starter',
    record: '/w/record',
    metric: 'OutputEvaluator',
    iterations: 1,
    planned: 5,
    trainCases: 8,
    baseline: 0.54,
    startedAt: Date.now(),
    stopping: false,
    step,
    baselineCandidate: {
      number: 0,
      changed: [],
      summary: 'your agent as it is',
      score: 0.54,
      kept: true,
      trials: [trial('a', true, 'Right'), trial('b', false, 'Wrong city')],
    },
    candidates: [
      {
        number: 1,
        step: 1,
        changed: ['instructions'],
        summary: 'Check the order date first.',
        kept: false,
        rationale: 'The baseline refunded late orders.',
        trials: [
          trial('a', true, 'Refunded on time'),
          trial('b', false, 'Skipped the receipt rule', 'Refund approved'),
        ],
        scoring: { done: 2, total: 8, score: 0.5 },
      },
      {
        number: 2,
        step: 1,
        changed: ['effort'],
        summary: 'effort → high',
        kept: false,
        trials: [],
        scoring: { done: 0, total: 8 },
      },
    ],
  },
})

const runningState = (): OptimizeState => ({
  step: 'running',
  progress: {
    run: '20261112-1530-refunds',
    record: '/w/record',
    metric: 'OutputEvaluator',
    iterations: 4,
    planned: 17,
    trainCases: 10,
    baseline: 0.71,
    best: { number: 2, score: 0.82 },
    startedAt: Date.now(),
    stopping: false,
    candidates: [
      { number: 1, step: 1, changed: ['effort'], summary: 'effort → high', score: 0.71, delta: 0, kept: false },
      {
        number: 2,
        step: 1,
        changed: ['instructions'],
        summary: 'Add an explicit eligibility step',
        score: 0.82,
        delta: 0.11,
        kept: true,
      },
    ],
  },
})

const numberedLines = (word: string): string =>
  Array.from({ length: 30 }, (_, index) => `${word} instruction line ${index + 1}`).join('\n')

const reviewWithEdits = (overrides: Partial<OptimizeReview> = {}): OptimizeState => ({
  step: 'review',
  review: {
    run: '20261116-220510-refunds',
    record: '/w/record',
    baseline: 0.5,
    best: 0.9,
    measuredOn: 'test cases',
    edits: [
      {
        knob: 'instructions',
        kind: 'text',
        label: 'instructions',
        target: 'agent.py',
        before: numberedLines('old'),
        after: numberedLines('new'),
        accepted: true,
      },
      {
        knob: 'effort',
        kind: 'value',
        label: 'effort',
        target: 'agent.py',
        before: 'low',
        after: 'high',
        accepted: true,
      },
    ],
    ...overrides,
  },
})

const PAST_RUNS: readonly PastRun[] = [
  {
    record: '/w/strands-dev/tmp/optimization/20261116-220510-refunds',
    experiment: 'refunds',
    startedAt: Date.UTC(2026, 10, 16, 22, 5, 10),
    summary: '0.00 → 1.00 on test cases · 3 edits',
    opens: true,
  },
  {
    record: '/w/strands-dev/tmp/optimization/20261116-210000-refunds',
    experiment: 'refunds',
    summary: 'no better candidate · 0.50 on test cases',
    opens: true,
  },
]

const OBJECTIVE_ROW = [DOWN_KEY, DOWN_KEY, DOWN_KEY]
const LIMITS_ROW = [...OBJECTIVE_ROW, DOWN_KEY]
const CASES_ROW = [...LIMITS_ROW, DOWN_KEY]
const BUDGET_ROW = [...CASES_ROW, DOWN_KEY]
const START_BUTTON = [...BUDGET_ROW, DOWN_KEY]
const CANCEL_BUTTON = [...START_BUTTON, DOWN_KEY]
const LEFT_KEY = '\u001b[D'

describe('OptimizePanel', () => {
  it('shouldShowTheKnobsSplitAndEstimateWhenTheSetupOpens', async () => {
    const { session } = optimizeSession(setup)

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('strands-evals optimize cannot tune tools yet')
    expect(text()).toContain('10 train / 5 validation / 5 test')
    expect(text()).toContain('~230 rollouts · ~230 judge calls')
  })

  it.each<[number, string]>([
    [0, '↓ 6 more'],
    [5, '↑ 3 previous · ↓ 3 more'],
    [10, '↑ 6 previous'],
  ])('shouldCountOnlyTheKnobsAboveAndBelowWhenTheCursorIsOnKnob%iOfEleven', async (downs, overflow) => {
    const knobs = Array.from({ length: 11 }, (_, index) => ({
      key: `knob-${index}`,
      label: `knob-${index}`,
      detail: `detail ${index}`,
      group: 'prompt' as const,
      kind: 'text' as const,
      enabled: index === 0,
    }))
    const { session } = optimizeSession({ ...setup, plan: { ...setup.plan, knobs } })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, height: 18, session }), 20)

    for (let step = 0; step < downs; step++) await press(DOWN_KEY)

    const lines = text()
      .split('\n')
      .map((line) => line.trim())
    expect(lines.find((line) => line.startsWith('›'))).toMatch(new RegExp(`^› [☑☐] knob-${downs} `))
    expect(lines.filter((line) => /^(↑ \d+ previous|↓ \d+ more|…)/.test(line))).toEqual([overflow])
  })

  it.each<[string, string[], OptimizeAction, unknown[]]>([
    ['SpaceOnEffort', ['\u001b[B', ' '], 'toggleKnob', ['effort']],
    ['EnterOnInstructions', ['\r'], 'toggleKnob', ['instructions']],
    ['RightOnTheBudget', [...BUDGET_ROW, RIGHT_KEY], 'setIterations', [6]],
    ['LeftOnTheBudget', [...BUDGET_ROW, LEFT_KEY], 'setIterations', [2]],
    ['RightOnTheCases', [...CASES_ROW, RIGHT_KEY], 'setSplit', [{ train: 12, validation: 4, test: 4 }]],
    ['LeftOnTheCases', [...CASES_ROW, LEFT_KEY], 'setSplit', [{ train: 8, validation: 6, test: 6 }]],
    [
      'RightOnTheObjective',
      [...OBJECTIVE_ROW, RIGHT_KEY],
      'setObjective',
      [{ expression: 'Maximize(Contains)', limits: '' }],
    ],
    ['EnterOnStartAndEnterOnTheConfirm', [...START_BUTTON, '\r', '\r'], 'start', []],
  ])('shouldCallTheSessionWhenTheUserPresses%sInTheSetup', async (_key, keys, action, args) => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of keys) await press(key)

    expect(session[action]).toHaveBeenCalledWith(...args)
  })

  it.each([
    ['Space', ' '],
    ['Enter', '\r'],
  ])('shouldIgnore%sWhenTheKnobIsUnavailable', async (_key, key) => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('\u001b[B')
    await press('\u001b[B')
    await press(key)

    expect(session.toggleKnob).not.toHaveBeenCalled()
    expect(session.start).not.toHaveBeenCalled()
  })

  it('shouldToggleTheKnobAndNotStartWhenTheUserPressesEnterOnAKnob', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('\r')

    expect(session.toggleKnob).toHaveBeenCalledWith('instructions')
    expect(session.start).not.toHaveBeenCalled()
    expect(text()).toContain('Enter toggle')
  })

  it('shouldNotStartWhenNoKnobIsCheckedAndTheUserPressesEnterOnStart', async () => {
    const { session } = optimizeSession({
      ...setup,
      plan: { ...setup.plan, knobs: setup.plan.knobs.map((knob) => ({ ...knob, enabled: false })) },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of [...START_BUTTON, '\r']) await press(key)

    expect(session.start).not.toHaveBeenCalled()
    expect(text()).toContain('check a knob to start')
  })

  it.each([
    ['EnterOnCancel', [...CANCEL_BUTTON, '\r']],
    ['Esc', ['\u001b']],
  ])('shouldGoBackToTheListAndKeepThePanelOpenWhenTheUserPresses%sInTheSetup', async (_key, keys) => {
    const { session } = optimizeSession(setup)
    const props = freshProps()
    const { press } = await show(createElement(OptimizePanel, { ...props, session }))

    for (const key of keys) await press(key)

    await vi.waitFor(() => expect(session.reset).toHaveBeenCalledTimes(1))
    expect(props.close).not.toHaveBeenCalled()
    expect(session.start).not.toHaveBeenCalled()
  })

  it.each<[string, string[], OptimizeAction, unknown[]]>([
    ['AKnob', ['effort'], 'toggleKnob', ['effort']],
    ['StartAndThenStartTheRun', ['[ Start ]', '[ Start the run ]'], 'start', []],
  ])('shouldActWhenTheUserClicks%sInTheSetup', async (_target, labels, action, args) => {
    const { session } = optimizeSession(setup)
    const { click } = await showOptimizeInFrame(session, new DevPanelClicks())

    for (const label of labels) await click(label)

    expect(session[action]).toHaveBeenCalledWith(...args)
  })

  it('shouldAskBeforeItStartsWhenTheUserClicksStartInTheSetup', async () => {
    const { session } = optimizeSession(setup)
    const { click, text } = await showOptimizeInFrame(session, new DevPanelClicks())

    await click('[ Start ]')

    await vi.waitFor(() => expect(text()).toContain('optimize · refunds · start a paid run?'))
    expect(session.start).not.toHaveBeenCalled()
  })

  it('shouldShowWhatTheRunTunesAndCostsAndTheShellWarningWhenTheUserPressesEnterOnStart', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 30)

    for (const key of [...START_BUTTON, '\r']) await press(key)

    const flat = text().replace(/\s+/gu, ' ')
    expect(flat).toContain(
      'The optimizer tunes the instructions of your agent on 10 train, 5 validation, and 5 test cases of refunds.'
    )
    expect(flat).toContain('It tries 4 steps of 4 candidates: about 230 rollouts of your agent with')
    expect(flat).toContain(
      "The proposer is the optimizer's own AWS Bedrock model. It uses the AWS credentials and region of the shell " +
        'that started strands dev, not the chat provider.'
    )
    expect(flat).toContain(
      '⚠ To rewrite the instructions, a proposer agent writes shell commands and runs them on this machine.'
    )
    expect(flat).toContain('This is not a sandbox')
    expect(flat).toContain('run strands dev in a container or VM')
    expect(text()).toContain('Enter start the run · Esc back to the setup')
    expect(session.start).not.toHaveBeenCalled()
  })

  it.each<[string, OptimizePlan, string, string]>([
    [
      'AnEstimateFromEarlierRuns',
      { ...setup.plan, judgeCalls: 0, usage: ESTIMATE },
      '~230 rollouts · no judge calls',
      '~800k–1.2M tokens · ~5–7 min · price unknown',
    ],
    ['NoEstimate', setup.plan, '~230 rollouts · ~230 judge calls', 'no token or time estimate yet · price unknown'],
  ])('shouldShowTheCallsTokensTimeAndPriceNextToStartWhenThePlanHas%s', async (_case, plan, calls, usage) => {
    const { session } = optimizeSession({ step: 'setup', plan })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain(calls)
    expect(
      text()
        .split('\n')
        .find((line) => line.includes('[ Start ]'))
    ).toContain(usage)
  })

  it.each<[string, OptimizePlan, string]>([
    [
      'AnEstimateFromEarlierRuns',
      { ...setup.plan, judgeCalls: 0, usage: ESTIMATE },
      'and no judge calls. About 800k–1.2M tokens and 5–7 min, from the last 2 runs of refunds. ' +
        'The price is unknown, because strands dev has no model prices.',
    ],
    [
      'NoEstimate',
      setup.plan,
      'and about 230 judge calls. strands dev cannot estimate the tokens and the time yet, and it has no model prices.',
    ],
  ])('shouldShowTheEstimateAndThePriceInTheConfirmWhenThePlanHas%s', async (_case, plan, sentence) => {
    const { session } = optimizeSession({ step: 'setup', plan })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 30)

    for (const key of [...START_BUTTON, '\r']) await press(key)

    expect(text().replace(/\s+/gu, ' ')).toContain(sentence)
  })

  it.each<[string, Partial<OptimizePlan>, string]>([
    [
      'FewTestCases',
      { split: { train: 4, validation: 2, test: 2 } },
      'The split leaves 2 test cases, so the range of the test check will be wide.',
    ],
    [
      'FewHeldOutCasesAndAPlanWarning',
      { split: { train: 4, validation: 1, test: 1 }, warning: 'The split leaves 1 validation case and 1 test case.' },
      'The split leaves 1 validation case and 1 test case.',
    ],
  ])('shouldShowTheSplitWarningNextToStartWhenTheSetupHas%s', async (_case, change, warning) => {
    const { session } = optimizeSession({ ...setup, plan: { ...setup.plan, ...change } })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain(warning)
    expect(
      text()
        .split('\n')
        .filter((line) => line.includes('The split leaves'))
    ).toHaveLength(1)
  })

  it('shouldShowTheAgentModelAndTheFileRiskWhenTheSessionKnowsTheAgent', async () => {
    const agent: RunAgent = { model: 'us.anthropic.claude-sonnet-4-6', folder: '/w/project', fileTools: ['edit'] }
    const { session } = optimizeSession(setup)
    const { press, text } = await show(
      createElement(OptimizePanel, { ...panelProps, session: { ...session, agent: () => agent } }),
      30
    )

    for (const key of [...START_BUTTON, '\r']) await press(key)

    const flat = text().replace(/\s+/gu, ' ')
    expect(flat).toContain('rollouts of your agent with us.anthropic.claude-sonnet-4-6')
    expect(flat).toContain('⚠ The cases run in /w/project. The edit tool of your agent can change files there.')
  })

  it('shouldNotWarnAboutShellCommandsWhenTheRunTunesNoText', async () => {
    const knobs = setup.plan.knobs.map((knob) => ({ ...knob, enabled: knob.key === 'effort' }))
    const { session } = optimizeSession({ ...setup, plan: { ...setup.plan, knobs } })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 30)

    for (const key of [...START_BUTTON, '\r']) await press(key)

    expect(text()).toContain('The optimizer tunes the effort of your agent')
    expect(text()).not.toContain('shell commands')
    expect(text()).not.toContain('The proposer is')
  })

  it('shouldGoBackToTheSetupAndNotStartWhenTheUserPressesEscOnTheConfirm', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of [...START_BUTTON, '\r', '\u001b']) await press(key)

    await vi.waitFor(() => expect(text()).toContain('↑↓ · Enter start · Esc cancel'))
    expect(session.start).not.toHaveBeenCalled()
    expect(session.reset).not.toHaveBeenCalled()
  })

  it('shouldStartOnceAndIgnoreTheSetupKeysWhileTheConfirmIsOpen', async () => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of [...START_BUTTON, '\r', DOWN_KEY, '\r']) await press(key)

    expect(session.start).toHaveBeenCalledTimes(1)
    expect(session.reset).not.toHaveBeenCalled()
  })

  it('shouldNotStartWhenTheKeysAfterEnterOnStartArriveInTheSameBurst', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of START_BUTTON) await press(key)
    await press(`\r${DOWN_KEY}\r`)

    expect(text()).toContain('start a paid run?')
    expect(session.start).not.toHaveBeenCalled()
    expect(session.reset).not.toHaveBeenCalled()
  })

  it.each<[string, OptimizeStep, string]>([
    [
      'TheBaseline',
      { kind: 'baseline', trials: { done: 2, total: 8 } },
      'measuring your agent on the train cases · 2 of 8 trials',
    ],
    [
      'TheProposer',
      { kind: 'proposing', iteration: 1 },
      'step 1 of 1 · the proposer is writing new candidates from the scored conversations',
    ],
    [
      'TheScoring',
      { kind: 'scoring', iteration: 1, versions: 2, trials: { done: 3, total: 16 } },
      'step 1 of 1 · scoring 2 candidates on the train cases · 3 of 16 trials',
    ],
    [
      'TheValidation',
      { kind: 'validating', versions: 2, trials: { done: 1, total: 8 } },
      'measuring the best candidate and your agent on the validation cases · 1 of 8 trials',
    ],
    [
      'TheValidationOfYourAgentAlone',
      { kind: 'validating', versions: 1, trials: { done: 1, total: 2 } },
      'measuring your agent on the validation cases · 1 of 2 trials',
    ],
    [
      'TheTest',
      { kind: 'testing', versions: 2, trials: { done: 1, total: 4 } },
      'checking the winner against your agent on the test cases · 1 of 4 trials',
    ],
    [
      'TheTestOfYourAgentAlone',
      { kind: 'testing', versions: 1, trials: { done: 0, total: 2 } },
      'no candidate beat your agent · checking your agent on the test cases · 0 of 2 trials',
    ],
  ])('shouldSayWhatTheRunDoesNowDuring%s', async (_step, step, line) => {
    const { session } = optimizeSession(scoringState(step))

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain(line)
  })

  it('shouldListEachCandidateWithItsTrialsSoFarAndYourAgent', async () => {
    const { session } = optimizeSession(scoringState())

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toMatch(/step 1 · 2\s+scoring 0\/8 · effort → high/u)
    expect(text()).toMatch(/step 1 · 1\s+scoring 2\/8 · 0\.50 so far · Check the order date first\./u)
    expect(text()).toMatch(/your agent\s+baseline 0\.54/u)
    expect(text()).toContain('1/5 candidates')
  })

  it('shouldShowTheReasonAndTheScoreSoFarOfTheSelectedCandidate', async () => {
    const { session } = optimizeSession(scoringState())
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)

    expect(text()).toContain('why     The baseline refunded late orders.')
    expect(text()).toContain('score   0.50 so far, on 2 of 8 training cases')
  })

  it('shouldOpenTheTrialsOfACandidateAndThenACaseWhenTheUserPressesEnter', async () => {
    const { session } = optimizeSession(scoringState())
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)
    await press(DOWN_KEY)

    await press('\r')
    const trials = text()
    await press('\r')
    const opened = text()
    await press('\u001b')
    await vi.waitFor(() => expect(text()).toContain('Esc back to the run'))
    await press('\u001b')

    expect(trials).toContain('optimize · run 20261117-142504-starter · step 1 · 1 · 2/8 train cases')
    expect(trials).toMatch(/› ✗ b\s+Skipped the receipt rule/u)
    expect(trials).toContain('score 0.50 so far')
    expect(trials).toContain('↑↓ · Enter open case · Esc back to the run')
    expect(opened).toContain('optimize · run 20261117-142504-starter · step 1 · 1 · b · failed')
    expect(opened).toContain('Refund approved')
    await vi.waitFor(() => expect(text()).toContain('x stop and keep best'))
    expect(session.reset).not.toHaveBeenCalled()
  })

  it('shouldOpenTheTrialsOfYourAgentWhenTheUserPressesEnterOnItsRow', async () => {
    const { session } = optimizeSession(scoringState())
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press(DOWN_KEY)
    await press('\r')

    expect(text()).toContain('optimize · run 20261117-142504-starter · your agent')
    expect(text()).toMatch(/✗ b\s+Wrong city/u)
    expect(text()).toContain('score 0.54')
  })

  it('shouldShowTokensAndFewerTokensWhenTheObjectiveMinimizesTokens', async () => {
    const running = scoringState()
    if (running.step !== 'running') throw new Error('expected a running state')
    const { session } = optimizeSession({
      ...running,
      progress: {
        ...running.progress,
        measure: { kind: 'metric', metric: 'tokens', usage: true, lower: true },
        metric: 'fewer tokens',
        baseline: -1234,
        best: { number: 1, score: -900 },
      },
    })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain('baseline 1,234 tokens')
    expect(text()).toContain('best 900 tokens (334 tokens fewer)')
    expect(text()).toContain('fewer tokens')
  })

  it('shouldCountOnlyMeasuredCandidatesInTheRunList', async () => {
    const running = scoringState()
    if (running.step !== 'running') throw new Error('expected a running state')
    const { session } = optimizeSession({
      step: 'pick',
      runs: [{ id: 'run-1', experiment: 'starter', startedAt: Date.UTC(2026, 10, 17, 14, 25), state: running }],
    })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toMatch(/starter\s+.*running · 1\/5 candidates/u)
  })

  it('shouldListTheCandidatesAndStopWhenTheUserPressesX', async () => {
    const { session } = optimizeSession(runningState())
    const { text, press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('x')

    expect(text()).toContain('baseline 0.71')
    expect(text()).toContain('best 0.82 (+0.11)')
    expect(text()).toContain('Add an explicit eligibility step')
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  it('shouldSayWhatTheScoreMeansWhenTheRunShowsTheSelectedCandidate', async () => {
    const { session } = optimizeSession(runningState())

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain('score   0.82 average on 10 training cases, from 0 to 1 · +0.11 vs your agent')
    expect(text()).not.toContain('CI')
  })

  it.each([
    ['Right', RIGHT_KEY],
    ['Left', LEFT_KEY],
  ])('shouldNotChangeTheBudgetOrTheSplitWhenTheUserPresses%sOnAKnob', async (_key, key) => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press(key)

    expect(session.setIterations).not.toHaveBeenCalled()
    expect(session.setSplit).not.toHaveBeenCalled()
    expect(session.setObjective).not.toHaveBeenCalled()
  })

  it.each([
    ['Objective', OBJECTIVE_ROW, /› objective\s+█─*\s+the mean of every evaluator/u, '←→ preset · Enter edit'],
    ['Cases', CASES_ROW, /› cases\s+─*█─*\s+10 train \/ 5 validation \/ 5 test/u, '←→ split'],
    ['Budget', BUDGET_ROW, /› budget\s+─*█─*\s+4 steps × 4 candidates/u, '←→ budget'],
  ])('shouldSelectThe%sSliderWhenTheUserMovesDownToIt', async (_row, keys, row, hint) => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of keys) await press(key)

    expect(text()).toMatch(row)
    expect(text()).toContain(`↑↓ · ${hint} · Esc cancel`)
    expect(text()).not.toMatch(/› [☑☐]/u)
  })

  it.each([
    ['APreset', { expression: 'Maximize(Contains)', limits: '' }, 'Contains only', 'Maximize(Contains)'],
    ['ACustomObjective', { expression: 'Minimize(seconds)', limits: '' }, 'custom', 'Minimize(seconds)'],
  ])('shouldShowTheObjectiveAndItsExpressionWhenItIs%s', async (_case, objective, label, expression) => {
    const { session } = optimizeSession({ ...setup, plan: { ...setup.plan, objective } })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toMatch(new RegExp(`objective\\s+─*█─*\\s+${label}`, 'u'))
    expect(text()).toContain(expression)
  })

  it('shouldSkipASettingWithOneChoiceButKeepTheObjectiveSelectable', async () => {
    const only = { train: 10, validation: 5, test: 5 }
    const { session } = optimizeSession({
      ...setup,
      plan: { ...setup.plan, split: only, splitChoices: [only] },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    for (const key of [...LIMITS_ROW, DOWN_KEY]) await press(key)

    expect(text()).toMatch(/ {2}cases {6}10 train/u)
    expect(text()).toMatch(/› budget\s+─*█─*/u)
  })

  it('shouldSaveTheTypedObjectiveWhenTheUserEditsItAndPressesEnter', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)
    for (const key of OBJECTIVE_ROW) await press(key)

    await press('\r')
    const editing = text()
    for (const character of 'Minimize(tokens)') await press(character)
    await press('\r')

    expect(editing).toContain('metrics: Contains, Equals, tokens, seconds')
    expect(editing).toContain('Enter save · Esc cancel')
    expect(session.setObjective).toHaveBeenCalledWith({ expression: 'Minimize(tokens)', limits: '' })
    expect(session.reset).not.toHaveBeenCalled()
  })

  it('shouldSaveTheTypedLimitsWhenTheUserEditsThemAndPressesEnter', async () => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)
    for (const key of LIMITS_ROW) await press(key)

    await press('\r')
    for (const character of 'tokens <= 4000') await press(character)
    await press('\r')

    expect(session.setObjective).toHaveBeenCalledWith({ expression: '', limits: 'tokens <= 4000' })
  })

  it('shouldKeepTheObjectiveAndTheSetupWhenTheUserPressesEscWhileEditing', async () => {
    const { session } = optimizeSession(setup)
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)
    for (const key of OBJECTIVE_ROW) await press(key)
    await press('\r')
    await press('M')

    await press('\u001b')

    await vi.waitFor(() => expect(text()).toContain('←→ preset · Enter edit'))
    expect(session.setObjective).not.toHaveBeenCalled()
    expect(session.reset).not.toHaveBeenCalled()
  })

  it('shouldNotStartAndSayWhyWhenTheObjectiveHasAProblem', async () => {
    const problem = 'Nope is not an evaluator of this experiment or a usage number.'
    const { session } = optimizeSession({
      ...setup,
      plan: { ...setup.plan, objective: { expression: 'Maximize(Nope)', limits: '' }, objectiveProblem: problem },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    for (const key of [...START_BUTTON, '\r']) await press(key)

    expect(text()).toContain(problem)
    expect(text()).toContain('fix the objective to start')
    expect(session.start).not.toHaveBeenCalled()
  })

  it('shouldWarnWhenEveryGoalIsAUsageNumber', async () => {
    const warning = 'Every goal is a usage number, so a broken agent can look best.'
    const { session } = optimizeSession({
      ...setup,
      plan: { ...setup.plan, objective: { expression: 'Minimize(tokens)', limits: '' }, objectiveWarning: warning },
    })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain(warning)
  })

  it('shouldScrollTheDiffWithTheArrowKeysWhenAnEditIsLongerThanThePanel', async () => {
    const { session } = optimizeSession(reviewWithEdits())
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 20)
    const before = text()

    await press(DOWN_KEY)

    expect(before).toMatch(/lines 1-\d+ of \d+ · ↑↓ scroll/u)
    expect(text()).toMatch(/lines 2-\d+ of \d+ · ↑↓ scroll/u)
    expect(text()).toContain('←→ edit · ↑↓ scroll · a accept')
    expect(text()).not.toContain('PgUp')
  })

  it.each([
    ['Right', RIGHT_KEY, 1],
    ['Left', LEFT_KEY, 0],
  ])('shouldShowTheChosenEditWhenTheUserPresses%sInTheReview', async (_key, key, chosen) => {
    const { session } = optimizeSession(reviewWithEdits())
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 20)

    await press(RIGHT_KEY)
    if (key === LEFT_KEY) await press(LEFT_KEY)

    expect(text()).toMatch(chosen === 1 ? /› ☑ effort/u : /› ☑ instructions/u)
    expect(text()).toContain(`${chosen + 1}/2`)
  })

  it.each<[string, TestCheck, string, string]>([
    [
      'AboveZero',
      { difference: 0.4, cases: 5, confidence: 0.9, range: [0.1, 0.7] },
      '+0.40 on 5 unseen test cases · 90% confidence range +0.10 to +0.70',
      'The whole range is above 0, so the gain is likely real.',
    ],
    [
      'AcrossZero',
      { difference: 0.2, cases: 4, confidence: 0.9, range: [-0.1, 0.5] },
      '+0.20 on 4 unseen test cases · 90% confidence range -0.10 to +0.50',
      'The range includes 0, so the gain may be luck.',
    ],
    [
      'FromOneCase',
      { difference: 1, cases: 1, confidence: 0.9 },
      '+1.00 on 1 unseen test case',
      'One test case is too few for a confidence range.',
    ],
  ])('shouldExplainTheTestCheckWhenItsRangeIs%s', async (_case, testCheck, result, verdict) => {
    const { session } = optimizeSession(reviewWithEdits({ testCheck }))

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 20)

    expect(text()).toContain(`test check  ${result}`)
    expect(text()).toContain(verdict)
  })

  it('shouldWrapTheTestCheckAtSpacesWhenThePanelIsNarrow', async () => {
    const testCheck: TestCheck = { difference: 0.15, cases: 3, confidence: 0.9, range: [-0.11, 0.4] }
    const { session } = optimizeSession(reviewWithEdits({ testCheck }))

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, width: 60, session }), 24)

    const rows = text().split('\n')
    const first = rows.findIndex((row) => row.includes('test check'))
    const flat = text().replace(/\s+/gu, ' ')
    expect(flat).toContain('test check +0.15 on 3 unseen test cases · 90% confidence range -0.11 to +0.40')
    expect(flat).toContain('The range includes 0, so the gain may be luck. More test cases make the range narrower.')
    expect(rows.slice(first, first + 5).join('\n')).not.toContain('…')
    expect(rows.slice(first, first + 5).every((row) => row.trimEnd().length <= 60)).toBe(true)
  })

  it('shouldSayThatNoTestCaseCheckedTheWinnerWhenTheRunHadNone', async () => {
    const { session } = optimizeSession(reviewWithEdits())

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 20)

    expect(text()).toContain('No test cases were left to check the winner on unseen cases.')
  })

  it.each<[string, OptimizeState, string]>([
    ['AReport', reviewWithEdits(), 'Esc back to the list'],
    ['ARunningRun', runningState(), 'Esc back to the list, the run goes on'],
    ['ACancelledRun', { step: 'cancelled', experiment: 'refunds' }, 'Esc back to the list'],
    ['AFailedRun', { step: 'failed', message: 'The optimizer stopped.' }, 'Esc back to the list'],
  ])('shouldGoBackToTheListAndKeepThePanelOpenWhenTheUserPressesEscOn%s', async (_page, state, hint) => {
    const { session } = optimizeSession(state)
    const props = freshProps()
    const { press, text } = await show(createElement(OptimizePanel, { ...props, session }), 20)
    const hints = text()

    await press('\u001b')

    await vi.waitFor(() => expect(session.reset).toHaveBeenCalledTimes(1))
    expect(props.close).not.toHaveBeenCalled()
    expect(session.stop).not.toHaveBeenCalled()
    expect(hints).toContain(hint)
  })

  it('shouldListEachExperimentWithItsRunsAndOpenItWhenTheUserPressesEnter', async () => {
    const running = runningState()
    if (running.step !== 'running') throw new Error('expected a running state')
    const { session } = optimizeSession(
      {
        step: 'pick',
        runs: [{ id: 'run-1', experiment: 'refunds', startedAt: Date.UTC(2026, 10, 17, 14, 25), state: running }],
        pastRuns: { loading: false, runs: PAST_RUNS },
      },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    const list = text()
    await press('\r')

    expect(list).toMatch(/› refunds\s+4 cases · 3 runs · 1 running/u)
    expect(list).not.toContain('runs (3)')
    expect(session.openExperiment).toHaveBeenCalledWith(REFUNDS)
  })

  it('shouldListTheRunsOfTheOpenExperimentAndOpenARunThatIsStillGoing', async () => {
    const running = runningState()
    if (running.step !== 'running') throw new Error('expected a running state')
    const { session } = optimizeSession(
      {
        step: 'pick',
        experiment: REFUNDS,
        runs: [{ id: 'run-1', experiment: 'refunds', startedAt: Date.UTC(2026, 10, 17, 14, 25), state: running }],
        pastRuns: { loading: false, runs: PAST_RUNS },
      },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    const page = text()
    await press('\r')

    expect(page).toContain('optimize · refunds · 4 cases · 1 running')
    expect(page).toContain('+ New optimization run')
    expect(page).toContain('runs (3)')
    expect(page).toMatch(/› 2026-11-17 \d\d:25\s+running · 3\/17 candidates · best 0\.82/u)
    expect(page).toContain('Enter open the run')
    expect(session.openRun).toHaveBeenCalledWith('run-1')
  })

  it('shouldListARunOnceWhenItAlsoHasARecordOnDisk', async () => {
    const { session } = optimizeSession(
      {
        step: 'pick',
        experiment: REFUNDS,
        runs: [
          {
            id: 'run-1',
            experiment: 'refunds',
            startedAt: 0,
            record: PAST_RUNS[0]!.record,
            state: { step: 'cancelled', experiment: 'refunds' },
          },
        ],
        pastRuns: { loading: false, runs: PAST_RUNS },
      },
      { saved: [REFUNDS] }
    )

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain('runs (2)')
    expect(text()).toContain('cancelled · the agent source is unchanged')
    expect(text()).not.toContain('0.00 → 1.00 on test cases · 3 edits')
  })

  it('shouldOpenAPastRunOfTheOpenExperimentWhenTheUserPressesEnterOnIt', async () => {
    const { session } = optimizeSession(
      { step: 'pick', experiment: REFUNDS, pastRuns: { loading: false, runs: PAST_RUNS } },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    const page = text()
    await press('\r')

    expect(page).toMatch(/› 2026-11-1[67] \d\d:\d\d\s+0\.00 → 1\.00 on test cases · 3 edits/u)
    expect(page).toContain('no better candidate · 0.50 on test cases')
    expect(session.openPastRun).toHaveBeenCalledWith(PAST_RUNS[0]!.record)
  })

  it('shouldSkipAPastRunThatCannotBeOpenedWhenTheUserMovesDown', async () => {
    const unreadable: PastRun = {
      record: '/w/strands-dev/experiments/refunds/optimizations/20261113-224053/optimizer',
      experiment: 'refunds',
      summary: 'made by the older optimizer, so it cannot be opened',
      opens: false,
    }
    const { session } = optimizeSession(
      { step: 'pick', experiment: REFUNDS, pastRuns: { loading: false, runs: [unreadable, ...PAST_RUNS] } },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press('\r')

    expect(text()).toContain('made by the older optimizer, so it cannot be opened')
    expect(session.openPastRun).toHaveBeenCalledWith(PAST_RUNS[0]!.record)
  })

  it.each<[string, PastRuns, string]>([
    ['Loading', { loading: true, runs: [] }, 'reading past runs…'],
    ['Empty', { loading: false, runs: [] }, 'none yet · each run shows here'],
    ['Unreadable', { loading: false, runs: [], error: 'Past runs cannot be read: EACCES' }, 'EACCES'],
  ])('shouldSayWhyNoPastRunIsListedWhenThePastRunsAre%s', async (_case, pastRuns, note) => {
    const { session } = optimizeSession({ step: 'pick', experiment: REFUNDS, pastRuns }, { saved: [REFUNDS] })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain('runs')
    expect(text()).toContain(note)
  })

  it('shouldSetUpANewRunOfTheOpenExperimentWhenTheUserPressesEnterOnNew', async () => {
    const { session } = optimizeSession(
      { step: 'pick', experiment: REFUNDS, pastRuns: { loading: false, runs: [] } },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    const page = text()
    await press('\r')

    expect(page).toContain('Enter set up a run')
    expect(session.plan).toHaveBeenCalledWith(REFUNDS)
  })

  it('shouldGoBackToTheExperimentsWhenTheUserPressesEscOnTheExperimentPage', async () => {
    const { session } = optimizeSession(
      { step: 'pick', experiment: REFUNDS, pastRuns: { loading: false, runs: [] } },
      { saved: [REFUNDS] }
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    const page = text()
    await press('\u001b')

    expect(page).toContain('Esc back to the experiments')
    await vi.waitFor(() => expect(session.openExperiment).toHaveBeenCalledWith(undefined))
  })

  it('shouldListTheRunsOfAnExperimentThatIsGoneUnderOtherExperiments', async () => {
    const retired: PastRun = {
      record: '/w/strands-dev/tmp/.state/outside-experiments/retired/optimizations/20261110-101010/optimizer',
      experiment: 'retired',
      summary: '0.20 → 0.40 on test cases · 1 edit',
      opens: true,
    }
    const { session } = optimizeSession(
      { step: 'pick', pastRuns: { loading: false, runs: [...PAST_RUNS, retired] } },
      { saved: [REFUNDS] }
    )

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toMatch(/refunds\s+4 cases · 2 runs/u)
    expect(text()).toContain('runs of other experiments')
    expect(text()).toMatch(/retired\s+.*0\.20 → 0\.40 on test cases · 1 edit/u)
    expect(text()).not.toContain('0.00 → 1.00 on test cases · 3 edits')
  })

  it.each<[string, string, OptimizeAction, unknown[], string[]]>([
    ['AKnob', 'effort', 'toggleKnob', ['effort'], ['\r']],
    ['StartAndConfirms', '[ Start ]', 'start', [], ['\r', '\r']],
  ])('shouldActOn%sUnderThePointerWhenTheUserPointsAtItAndPressesEnter', async (_target, label, action, args, keys) => {
    const { session } = optimizeSession(setup)
    const clicks = new DevPanelClicks()
    const props = freshProps()
    const panel = {
      id: 'panel-1',
      kind: 'dev' as const,
      command: 'optimize',
      title: '/optimize',
      rows: [],
      view: (viewProps: DevChatPanelProps) => createElement(OptimizePanel, { ...viewProps, session }),
      close: props.close,
      openCommand: props.openCommand,
    }
    const shown = await show(createElement(DevPanelFrame, { panel, width: 120, height: 22, clicks }), 24)
    await shown.press(label === 'effort' ? '\u001b[B\u001b[B\u001b[B' : '\u001b[B')
    const lines = shown.text().split('\n')
    const row = lines.findIndex((line) => line.includes(label))
    const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(label))) + 1

    clicks.hoverAt({ button: 35, action: 'move', column, row: row + 1 })?.()
    await shown.instance.waitUntilRenderFlush()
    for (const key of keys) await shown.press(key)

    expect(session[action]).toHaveBeenCalledWith(...args)
    expect(session[action === 'start' ? 'toggleKnob' : 'start']).not.toHaveBeenCalled()
  })

  it('shouldOpenTheModelChooserAndPickAModelWhenTheUserPressesEnterOnTheModelKnob', async () => {
    const { session } = optimizeSession({
      ...setup,
      plan: {
        ...setup.plan,
        knobs: [
          ...setup.plan.knobs,
          {
            key: 'model',
            label: 'model',
            detail: 'choose models to try',
            group: 'model',
            kind: 'models',
            enabled: false,
          },
        ],
        models: {
          current: 'bedrock/model-alpha',
          picked: [],
          options: [
            { id: 'bedrock/model-alpha', name: 'Model Alpha' },
            { id: 'bedrock/model-beta', name: 'Model Beta' },
          ],
        },
      },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of ['\u001b[B', '\u001b[B', '\u001b[B', '\r']) await press(key)

    expect(session.loadModels).toHaveBeenCalledTimes(1)
    expect(session.toggleKnob).not.toHaveBeenCalled()
    expect(text()).toContain('models to try')
    expect(text()).toContain('bedrock/model-alpha (current)')
    await press('\u001b[B')
    await press('\r')
    expect(session.pickModel).toHaveBeenCalledWith('bedrock/model-beta', true)
    await press('\u001b')
    await vi.waitFor(() => expect(text()).toContain('☑ instructions'))
  })

  it('shouldShowStartAndTheKeysWhenTheSetupIsShort', async () => {
    const { session } = optimizeSession(setup)

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, height: 10, session }), 12)

    expect(text()).toContain('[ Start ]')
    expect(text()).toContain('Enter toggle')
    expect(text()).not.toContain('The best candidate on the validation cases wins')
  })

  it('shouldGoBackToTheListWhenTheUserPressesEscOnAReviewWithNothingToApply', async () => {
    const { session } = optimizeSession({
      step: 'review',
      review: { run: 'r1', record: '/w/record', baseline: 0.5, best: 0.5, measuredOn: 'test cases', edits: [] },
    })
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('\u001b')

    await vi.waitFor(() => expect(session.reset).toHaveBeenCalledTimes(1))
  })

  it('shouldWrapALongInstructionLineSoTheWholeChangeIsVisible', async () => {
    const ending = 'and always confirm the delivery date first.'
    const { session } = optimizeSession({
      step: 'review',
      review: {
        run: 'r1',
        record: '/w/record',
        baseline: 0.5,
        best: 0.8,
        measuredOn: 'test cases',
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            target: 'agent.py',
            before: 'You handle refunds for the store and answer questions about orders politely.',
            after: `You handle refunds for the store and answer questions about orders politely, ${ending}`,
            accepted: true,
          },
        ],
      },
    })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, width: 60, session }), 20)

    expect(text().replace(/\s+/gu, ' ')).toContain(ending)
  })

  it('shouldShowWhatWasChangedAndWhatFailedWhenAnApplyStopsHalfway', async () => {
    const { session } = optimizeSession({
      step: 'review',
      review: {
        run: 'r1',
        record: '/w/record',
        baseline: 0.5,
        best: 0.8,
        measuredOn: 'test cases',
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            target: 'instructions.md',
            before: 'Be quick.',
            after: 'Check the date.',
            accepted: true,
          },
        ],
        applied: ['instructions.md'],
        applyError: 'Could not change agent.py: it changed on disk. Change it by hand, then run /test.',
      },
    })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain('Applied 1 edit: instructions.md')
    expect(text()).toContain('Could not change agent.py')
  })

  it('shouldSayWhyAnEditCannotBeAcceptedAndCheckTheFileAgainWhenTheUserPressesA', async () => {
    const reason = 'Paste the new instructions into agent.ts yourself; the old text is not a plain string there.'
    const { session } = optimizeSession(
      reviewWithEdits({
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            before: 'Be quick.',
            after: 'Check the date.',
            accepted: false,
            unavailable: reason,
          },
        ],
      })
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('a')

    expect(text().replace(/\s+/gu, ' ')).toContain(
      `${reason} Press c to copy the new text, and a to check the file again.`
    )
    expect(text()).toContain('c copy the new text · a check again')
    expect(text()).not.toContain('a accept')
    expect(session.accept).toHaveBeenCalledWith(0, true)
  })

  it.each<[string, OptimizeState, unknown]>([
    ['AReview', reviewWithEdits(), { view: 'optimization', record: '/w/record' }],
    ['TheExperimentList', { step: 'pick', pastRuns: { loading: false, runs: [] } }, { view: 'opt-runs' }],
  ])('shouldOpenTheMatchingPageOfTheEvalsUiWhenTheUserPressesOOn%s', async (_case, state, place) => {
    const browser = {
      subscribe: () => () => undefined,
      snapshot: () => ({ status: 'ready' as const }),
      open: vi.fn(async () => undefined),
    }
    const { session } = optimizeSession(state)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session, browser }))

    await press('o')

    await vi.waitFor(() => expect(browser.open).toHaveBeenCalledWith(place))
  })

  it('shouldCopyTheNewTextOfTheEditWhenTheUserPressesC', async () => {
    const { session } = optimizeSession(
      reviewWithEdits({
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            before: 'Be quick.',
            after: 'Check the date.',
            accepted: false,
            unavailable: 'Paste the new instructions into agent.ts yourself.',
          },
        ],
      })
    )
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('c')

    await vi.waitFor(() => expect(text()).toContain('15 chars copied to clipboard'))
  })

  it('shouldNotApplyWhenTheOnlyAcceptedEditIsRejectedInTheSameBurstAsEnter', async () => {
    const reviewState: OptimizeState = {
      step: 'review',
      review: {
        run: 'r1',
        record: '/w/record',
        baseline: 0.5,
        best: 0.8,
        measuredOn: 'test cases',
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            target: 'instructions.md',
            before: 'Be quick.',
            after: 'Check the date.',
            accepted: true,
          },
        ],
      },
    }
    const { session, states } = optimizeSession(reviewState)
    session.accept.mockImplementation((index: number, accepted: boolean) => {
      const state = states.snapshot()
      if (state.step !== 'review') return
      states.set({
        step: 'review',
        review: {
          ...state.review,
          edits: state.review.edits.map((edit, position) => (position === index ? { ...edit, accepted } : edit)),
        },
      })
    })
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('x\u001b[A\r')

    expect(session.accept).toHaveBeenCalledWith(0, false)
    expect(session.apply).not.toHaveBeenCalled()
  })

  it('shouldShowTheDiffAndApplyTheAcceptedEditsWhenTheReviewOpens', async () => {
    const { session } = optimizeSession({
      step: 'review',
      review: {
        run: '20261112-1530-refunds',
        record: '/w/record',
        baseline: 0.71,
        best: 0.9,
        measuredOn: 'test cases',
        edits: [
          {
            knob: 'instructions',
            kind: 'text',
            label: 'instructions',
            target: 'instructions.md',
            before: 'You handle refunds.\nBe quick.',
            after: 'You handle refunds.\nCheck the delivery date first.',
            accepted: true,
          },
        ],
      },
    })
    const { text, press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('\r')

    expect(text()).toContain('0.71 → 0.90 on test cases (+0.19)')
    expect(text()).toContain('instructions.md')
    expect(text()).toContain('+Check the delivery date first.')
    expect(text()).toContain('-Be quick.')
    expect(session.apply).toHaveBeenCalledTimes(1)
  })
})

describe('listWindow', () => {
  it.each([
    [0, 5, 1, { start: 0, end: 1 }],
    [3, 5, 1, { start: 3, end: 4 }],
    [0, 5, 3, { start: 0, end: 2 }],
    [1, 2, 3, { start: 0, end: 2 }],
  ])('shouldKeepItem%iOf%iVisibleWhenTheListHolds%iRows', (selected, count, capacity, window) => {
    expect(listWindow(selected, count, capacity)).toEqual(window)
  })
})
