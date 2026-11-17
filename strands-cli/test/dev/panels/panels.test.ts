import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import type {
  ExperimentsState,
  OptimizeReview,
  OptimizeSession,
  OptimizeState,
  PastRun,
  PastRuns,
  TestCheck,
  TestResults,
  TestSession,
  TestState,
} from '../../../src/dev/panels/model.js'
import { OptimizePanel } from '../../../src/dev/panels/optimize.js'
import { TestPanel } from '../../../src/dev/panels/test.js'
import { listWindow } from '../../../src/dev/panels/ui.js'
import type { DevChatPanelProps } from '../../../src/ui/chat/types.js'
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

const showInFrame = async (session: TestSession, clicks: DevPanelClicks) => {
  const props = freshProps()
  const panel = {
    id: 'panel-1',
    kind: 'dev' as const,
    command: 'test',
    title: '/test',
    rows: [],
    view: (viewProps: DevChatPanelProps) => createElement(TestPanel, { ...viewProps, session }),
    close: props.close,
    openCommand: props.openCommand,
  }
  const shown = await show(createElement(DevPanelFrame, { panel, width: 100, height: 22, clicks }), 24)
  const click = async (target: string): Promise<void> => {
    const lines = shown.text().split('\n')
    const row = lines.findIndex((line) => line.includes(target))
    expect(row, `Visible target: ${target}`).toBeGreaterThanOrEqual(0)
    const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(target))) + 1
    clicks.at({ button: 0, action: 'release', column, row: row + 1 })?.()
    await shown.instance.waitUntilRenderFlush()
  }
  return { ...shown, click }
}

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

  it('shouldRunTheSelectedExperimentsWhenTheUserSelectsSomeAndPressesEnter', async () => {
    const { session } = testSession()
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(' ')
    await press(DOWN_KEY)
    await press(DOWN_KEY)
    await press(' ')
    const selected = text()
    await press('\r')

    expect(selected).toContain('2 selected')
    expect(selected).toContain('Enter run 2')
    expect(session.run).toHaveBeenCalledWith([capital, cities])
  })

  it('shouldRunEveryExperimentWhenTheUserSelectsAllAndPressesEnter', async () => {
    const { session } = testSession()
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press('a')
    await press('\r')

    expect(session.run).toHaveBeenCalledWith([capital, refunds, cities])
  })

  it('shouldRunTheHighlightedExperimentWhenNothingIsSelected', async () => {
    const { session } = testSession()
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press('\r')

    expect(session.run).toHaveBeenCalledWith([refunds])
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

  it('shouldRunTheExperimentWhenTheUserClicksOneThatHasNotRun', async () => {
    const { session } = testSession(withRuns())
    const { click } = await showInFrame(session, new DevPanelClicks())

    await click('cities')

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

  it('shouldRunEveryCaseAgainWhenTheUserPressesAInTheReport', async () => {
    const { session } = testSession(withRuns())
    const { press, text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)
    await press(DOWN_KEY)
    await press('\r')
    const report = text()

    await press('a')

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

const optimizeSession = (initial: OptimizeState) => {
  const states = store(initial)
  const { session: experiments } = experimentsSession()
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
      openPastRun: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      accept: vi.fn(),
      apply: vi.fn(),
      reset: vi.fn(),
    } satisfies OptimizeSession,
  }
}

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
    objective: { kind: 'evaluators', evaluators: ['Contains', 'Equals'] },
    objectiveChoices: [
      { kind: 'evaluators', evaluators: ['Contains', 'Equals'] },
      { kind: 'evaluator', evaluator: 'Contains' },
      { kind: 'evaluator', evaluator: 'Equals' },
    ],
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
const CASES_ROW = [...OBJECTIVE_ROW, DOWN_KEY]
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
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, height: 16, session }), 18)

    for (let step = 0; step < downs; step++) await press(DOWN_KEY)

    const lines = text()
      .split('\n')
      .map((line) => line.trim())
    expect(lines.find((line) => line.startsWith('›'))).toMatch(new RegExp(`^› [☑☐] knob-${downs} `))
    expect(lines.filter((line) => /^(↑ \d+ previous|↓ \d+ more|…)/.test(line))).toEqual([overflow])
  })

  it.each<[string, string[], keyof OptimizeSession, unknown[]]>([
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
      [{ kind: 'evaluator', evaluator: 'Contains' }],
    ],
    ['EnterOnStart', [...START_BUTTON, '\r'], 'start', []],
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

  it('shouldCancelTheSetupWhenTheUserPressesEnterOnCancel', async () => {
    const { session } = optimizeSession(setup)
    const props = freshProps()
    const { press } = await show(createElement(OptimizePanel, { ...props, session }))

    for (const key of [...CANCEL_BUTTON, '\r']) await press(key)

    expect(session.reset).toHaveBeenCalledTimes(1)
    expect(props.close).toHaveBeenCalledTimes(1)
    expect(session.start).not.toHaveBeenCalled()
  })

  it.each<[string, string, keyof OptimizeSession, unknown[]]>([
    ['AKnob', 'effort', 'toggleKnob', ['effort']],
    ['Start', '[ Start ]', 'start', []],
  ])('shouldActWhenTheUserClicks%sInTheSetup', async (_target, label, action, args) => {
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
    const lines = shown.text().split('\n')
    const row = lines.findIndex((line) => line.includes(label))
    const column = stringWidth(lines[row]!.slice(0, lines[row]!.indexOf(label))) + 1

    clicks.at({ button: 0, action: 'release', column, row: row + 1 })?.()
    await shown.instance.waitUntilRenderFlush()

    expect(session[action]).toHaveBeenCalledWith(...args)
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
    ['Objective', OBJECTIVE_ROW, /› objective\s+█─*\s+maximize the mean of Contains, Equals/u, '←→ objective'],
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
    ['ContainsAlone', { kind: 'evaluator' as const, evaluator: 'Contains' }, 'maximize Contains only'],
    ['EqualsAlone', { kind: 'evaluator' as const, evaluator: 'Equals' }, 'maximize Equals only'],
  ])('shouldShowTheChosenObjectiveWhenItIs%s', async (_case, objective, detail) => {
    const { session } = optimizeSession({ ...setup, plan: { ...setup.plan, objective } })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toMatch(new RegExp(`objective\\s+─*█─*\\s+${detail}`, 'u'))
  })

  it('shouldNameTheOnlyEvaluatorAndKeepTheObjectiveWhenTheExperimentHasOneEvaluator', async () => {
    const only = { kind: 'evaluators' as const, evaluators: ['OutputEvaluator'] }
    const { session } = optimizeSession({
      ...setup,
      plan: { ...setup.plan, objective: only, objectiveChoices: [only] },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of [...OBJECTIVE_ROW, RIGHT_KEY]) await press(key)

    expect(text()).toMatch(/› objective\s+█─*\s+maximize OutputEvaluator/u)
    expect(text()).toContain('↑↓ · the only evaluator · Esc cancel')
    expect(session.setObjective).not.toHaveBeenCalled()
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

  it('shouldSayThatNoTestCaseCheckedTheWinnerWhenTheRunHadNone', async () => {
    const { session } = optimizeSession(reviewWithEdits())

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 20)

    expect(text()).toContain('No test cases were left to check the winner on unseen cases.')
  })

  it('shouldGoBackToThePastRunsAndKeepThePanelOpenWhenTheUserPressesEscOnAPastReport', async () => {
    const { session } = optimizeSession(reviewWithEdits({ past: true }))
    const props = freshProps()
    const { press, text } = await show(createElement(OptimizePanel, { ...props, session }), 20)
    const hints = text()

    await press('\u001b')

    await vi.waitFor(() => expect(session.reset).toHaveBeenCalledTimes(1))
    expect(props.close).not.toHaveBeenCalled()
    expect(hints).toContain('Esc back to past runs')
  })

  it('shouldListThePastRunsAndOpenOneWhenTheUserPressesEnterOnIt', async () => {
    const { session } = optimizeSession({ step: 'pick', pastRuns: { loading: false, runs: PAST_RUNS } })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    const list = text()
    await press('\r')

    expect(list).toContain('past runs (2)')
    expect(list).toMatch(/› refunds\s+.*0\.00 → 1\.00 on test cases · 3 edits/u)
    expect(list).toContain('no better candidate · 0.50 on test cases')
    expect(list).toContain('Enter open the report')
    expect(session.openPastRun).toHaveBeenCalledWith(PAST_RUNS[0]!.record)
  })

  it('shouldSkipAPastRunThatCannotBeOpenedWhenTheUserMovesDown', async () => {
    const unreadable: PastRun = {
      record: '/w/strands-dev/tmp/optimization/20261113-224053-refunds',
      experiment: 'refunds',
      summary: 'made by the older optimizer, so it cannot be opened',
      opens: false,
    }
    const { session } = optimizeSession({
      step: 'pick',
      pastRuns: { loading: false, runs: [unreadable, ...PAST_RUNS] },
    })
    const { press, text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    await press(DOWN_KEY)
    await press('\r')

    expect(text()).toContain('made by the older optimizer, so it cannot be opened')
    expect(session.openPastRun).toHaveBeenCalledWith(PAST_RUNS[0]!.record)
  })

  it.each<[string, PastRuns, string]>([
    ['Loading', { loading: true, runs: [] }, 'reading past runs…'],
    ['Empty', { loading: false, runs: [] }, 'none yet · each finished run shows here'],
    ['Unreadable', { loading: false, runs: [], error: 'Past runs cannot be read: EACCES' }, 'EACCES'],
  ])('shouldSayWhyNoPastRunIsListedWhenThePastRunsAre%s', async (_case, pastRuns, note) => {
    const { session } = optimizeSession({ step: 'pick', pastRuns })

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }), 24)

    expect(text()).toContain('past runs')
    expect(text()).toContain(note)
  })

  it.each<[string, string, keyof OptimizeSession, unknown[]]>([
    ['AKnob', 'effort', 'toggleKnob', ['effort']],
    ['Start', '[ Start ]', 'start', []],
  ])('shouldActOn%sUnderThePointerWhenTheUserPointsAtItAndPressesEnter', async (_target, label, action, args) => {
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
    await shown.press('\r')

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

  it.each<[string, string]>([
    ['Esc', '\u001b'],
    ['n', 'n'],
  ])('shouldStartOverWhenTheUserPresses%sOnAReviewWithNothingToApply', async (_key, key) => {
    const { session } = optimizeSession({
      step: 'review',
      review: { run: 'r1', record: '/w/record', baseline: 0.5, best: 0.5, measuredOn: 'test cases', edits: [] },
    })
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press(key)

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
