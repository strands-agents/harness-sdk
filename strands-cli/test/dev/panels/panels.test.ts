import { createElement } from 'react'
import stringWidth from 'string-width'
import { describe, expect, it, vi } from 'vitest'

import type { ExperimentsState, RunAgent, TestResults, TestSession, TestState } from '../../../src/dev/panels/model.js'
import { TestPanel } from '../../../src/dev/panels/test.js'
import { listWindow } from '../../../src/dev/panels/ui.js'
import type { DevChatPanelView } from '../../../src/ui/chat/types.js'
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
  showViewInFrame('evaluate', (viewProps) => createElement(TestPanel, { ...viewProps, session }), clicks)

describe('TestPanel', () => {
  it('shouldListEveryExperimentWithItsLastResultWhenItOpens', async () => {
    const { session } = testSession(withRuns(), {
      generations: [
        generation({ name: 'returns' }),
        generation({ id: 'generation-2', name: 'broken', phase: 'failed' }),
      ],
    })

    const { text } = await show(createElement(TestPanel, { ...panelProps, session }), 24)

    expect(text()).toContain('evaluate · 3 experiments · 1 running')
    expect(text()).toMatch(/☐ capital\s+4 cases · running 2\/4/u)
    expect(text()).toMatch(/☐ refunds\s+2 cases · 1\/2 passed/u)
    expect(text()).toMatch(/☐ cities\s+6 cases · not run yet/u)
    expect(text()).toContain('generating · 8/20 cases')
    expect(text()).not.toContain('broken')
  })

  it('shouldShowTheProgressOfARunWhenThePanelOpensOnIt', async () => {
    const { session } = testSession(withRuns())

    const { text } = await show(createElement(TestPanel, { ...panelProps, session, initialRun: capital.path }), 24)

    expect(text()).toContain('s stop the run')
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
    expect(confirm).toContain('evaluate · 2 experiments · start a paid run?')
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
    expect(text().replace(/\s+/gu, ' ')).toContain(
      'Judge calls use AWS Bedrock, with the AWS credentials and region of the shell that started strands dev, ' +
        'also when your agent uses another provider.'
    )
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

    expect(text()).toContain('evaluate · capital · 4 cases · 1 evaluator')
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
    expect(text()).toContain('evaluate · refunds · 2 cases · 1 evaluator')
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
    expect(text()).toContain('evaluate · cities · stopped')
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

    await vi.waitFor(() => expect(text()).toContain('evaluate · refunds · 2 cases · 1 evaluator'))
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

    await vi.waitFor(() => expect(text()).toContain('evaluate · refunds · standard-refund · passed'))
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
    expect(text()).toContain('evaluate · refunds · refund-window · failed')
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
