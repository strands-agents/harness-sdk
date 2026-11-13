import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import type {
  ExperimentsState,
  OptimizeSession,
  OptimizeState,
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

  it('shouldShowACaseVerdictsWhenTheUserClicksTheCaseInTheReport', async () => {
    const { session } = testSession(withRuns())
    const { click, text } = await showInFrame(session, new DevPanelClicks())
    await click('refunds')
    await vi.waitFor(() => expect(text()).toContain('standard-refund'))

    await click('standard-refund')

    await vi.waitFor(() => expect(text()).toContain('› ✓ standard-refund'))
    expect(text()).toMatch(/OutputEvaluator\s+✓ 1\.00\s+Refunded correctly/u)
  })
})

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
      setIterations: vi.fn(),
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
      { key: 'instructions', label: 'instructions', detail: 'the system prompt', enabled: true },
      { key: 'effort', label: 'effort', detail: 'low · medium · high', enabled: false },
      {
        key: 'tools',
        label: 'tool descriptions',
        detail: '',
        enabled: false,
        unavailable: 'strands-evals optimize cannot tune tools yet',
      },
    ],
    split: { train: 10, validation: 5, test: 5 },
    repetitions: 1,
    width: 4,
    iterations: 4,
    iterationChoices: [1, 2, 4, 6, 8],
    rollouts: 230,
    judgeCalls: 230,
  },
}

describe('OptimizePanel', () => {
  it('shouldShowTheKnobsSplitAndEstimateWhenTheSetupOpens', async () => {
    const { session } = optimizeSession(setup)

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('strands-evals optimize cannot tune tools yet')
    expect(text()).toContain('10 train / 5 validation / 5 test')
    expect(text()).toContain('~230 rollouts · ~230 judge calls')
  })

  it.each<[string, string[], keyof OptimizeSession, unknown[]]>([
    ['SpaceOnEffort', ['\u001b[B', ' '], 'toggleKnob', ['effort']],
    ['Right', ['\u001b[C'], 'setIterations', [6]],
    ['Left', ['\u001b[D'], 'setIterations', [2]],
    ['Enter', ['\r'], 'start', []],
  ])('shouldCallTheSessionWhenTheUserPresses%sInTheSetup', async (_key, keys, action, args) => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    for (const key of keys) await press(key)

    expect(session[action]).toHaveBeenCalledWith(...args)
  })

  it('shouldIgnoreSpaceWhenTheKnobIsUnavailable', async () => {
    const { session } = optimizeSession(setup)
    const { press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('\u001b[B')
    await press('\u001b[B')
    await press(' ')

    expect(session.toggleKnob).not.toHaveBeenCalled()
  })

  it('shouldListTheCandidatesAndStopWhenTheUserPressesX', async () => {
    const { session } = optimizeSession({
      step: 'running',
      progress: {
        run: '20261112-1530-refunds',
        record: '/w/record',
        metric: 'OutputEvaluator',
        iterations: 4,
        planned: 17,
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
            ci: [0.75, 0.89],
            delta: 0.11,
            kept: true,
          },
        ],
      },
    })
    const { text, press } = await show(createElement(OptimizePanel, { ...panelProps, session }))

    await press('x')

    expect(text()).toContain('baseline 0.71')
    expect(text()).toContain('best 0.82 (+0.11)')
    expect(text()).toContain('Add an explicit eligibility step')
    expect(session.stop).toHaveBeenCalledTimes(1)
  })

  it('shouldShowStartAndTheKeysWhenTheSetupIsShort', async () => {
    const { session } = optimizeSession(setup)

    const { text } = await show(createElement(OptimizePanel, { ...panelProps, height: 10, session }), 12)

    expect(text()).toContain('[ Start ]')
    expect(text()).toContain('Enter start')
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
