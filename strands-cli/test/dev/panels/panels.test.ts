import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { OptimizeSession, OptimizeState, TestSession, TestState } from '../../../src/dev/panels/model.js'
import { OptimizePanel } from '../../../src/dev/panels/optimize.js'
import { TestPanel } from '../../../src/dev/panels/test.js'
import { listWindow } from '../../../src/dev/panels/ui.js'
import { experimentsSession, panelProps as freshProps, show, store } from './fixtures.js'

const panelProps = freshProps()

const testSession = (initial: TestState) => {
  const states = store(initial)
  const { session: experiments } = experimentsSession()
  return {
    states,
    session: {
      experiments,
      subscribe: states.subscribe,
      snapshot: states.snapshot,
      run: vi.fn(),
      rerunFailed: vi.fn(),
      reset: vi.fn(),
    } satisfies TestSession,
  }
}

const results: TestState = {
  step: 'results',
  results: {
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
  },
}

describe('TestPanel', () => {
  it('shouldShowTheProgressWhileTheCasesRun', async () => {
    const { session } = testSession({
      step: 'running',
      experiment: 'refunds',
      cases: 4,
      evaluators: ['OutputEvaluator'],
      done: 2,
      startedAt: Date.now(),
      rerun: false,
    })

    const { text } = await show(createElement(TestPanel, { ...panelProps, session }))

    expect(text()).toContain('test · refunds · 4 cases · 1 evaluator')
    expect(text()).toContain('2/4')
    expect(text()).toContain('Esc run in background')
  })

  it('shouldListTheFailedCasesFirstWithTheirReasonsWhenTheTestFinishes', async () => {
    const { session } = testSession(results)

    const { text } = await show(createElement(TestPanel, { ...panelProps, session }))

    const lines = text().split('\n')
    const failed = lines.findIndex((line) => line.includes('✗ refund-window'))
    expect(failed).toBeGreaterThanOrEqual(0)
    expect(failed).toBeLessThan(lines.findIndex((line) => line.includes('✓ standard-refund')))
    expect(text()).toContain('✓ 1 passed')
    expect(text()).toContain('✗ 1 failed')
    expect(text()).toContain('issued refund without checking delivery date')
  })

  it.each<[string, string, keyof TestSession]>([
    ['r', 'r', 'rerunFailed'],
    ['Enter', '\r', 'reset'],
  ])('shouldCallTheSessionWhenTheUserPresses%sOnTheResults', async (_key, key, action) => {
    const { session } = testSession(results)
    const { press } = await show(createElement(TestPanel, { ...panelProps, session }))

    await press(key)

    expect(session[action]).toHaveBeenCalledTimes(1)
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
