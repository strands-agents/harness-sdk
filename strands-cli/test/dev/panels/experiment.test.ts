import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ExperimentPanel, generationSummary } from '../../../src/dev/panels/experiment.js'
import { ExperimentPicker } from '../../../src/dev/panels/picker.js'
import { experimentsSession, generation, generationForm, panelProps, show } from './fixtures.js'

const ENTER = '\r'
const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const ESC = '\u001b'

const saved = { name: 'capital', path: '/w/strands-dev/tmp/experiments/capital.json', caseCount: 12 }

const mixed = () =>
  experimentsSession({
    saved: [saved],
    generations: [
      generation(),
      generation({ id: 'generation-2', name: 'billing', phase: 'ready', made: 18, failed: 2, total: 20 }),
      generation({
        id: 'generation-3',
        name: 'returns',
        phase: 'failed',
        error: {
          summary: 'AWS credentials are missing or expired',
          detail: 'Refresh your AWS credentials, then retry.',
        },
      }),
    ],
  })

describe('ExperimentPanel home', () => {
  it('shouldListEveryGenerationWithItsProgressAndTheSavedExperimentsWhenItOpens', async () => {
    const { session } = mixed()

    const { text } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)

    expect(text()).toContain('experiment · 1 saved experiment · 1 generating')
    expect(text()).toContain('+ New experiment')
    expect(text()).toMatch(/◐ refunds\s+7\/20 cases made · 1 failed/u)
    expect(text()).toMatch(/● billing\s+18 cases ready to review · 2 failed/u)
    expect(text()).toMatch(/✗ returns\s+AWS credentials are missing or expired/u)
    expect(text()).toMatch(/capital\s+12 cases/u)
  })

  it.each([
    ['refunds', 1, 'cancel', 'generation-1'],
    ['returns', 3, 'dismiss', 'generation-3'],
  ] as const)('shouldStopOrDismissWhenTheUserPressesXOn%s', async (_name, row, action, id) => {
    const { session } = mixed()
    const { press } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)

    for (let step = 0; step < row; step++) await press(DOWN)
    await press('x')

    expect(session[action]).toHaveBeenCalledWith(id)
  })

  it('shouldAskAgainBeforeItDiscardsADraftWhenTheUserPressesX', async () => {
    const { session } = mixed()
    const { press, text } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)
    await press(DOWN)
    await press(DOWN)

    await press('x')
    const asked = text()
    await press('x')

    expect(asked).toContain('Press x again to discard 18 drafted cases.')
    expect(session.dismiss).toHaveBeenCalledWith('generation-2')
  })

  it.each([
    [2, 'review', 'generation-2'],
    [4, 'open', saved],
  ] as const)('shouldOpenTheRowWhenTheUserPressesEnterOnRow%i', async (row, action, argument) => {
    const { session } = mixed()
    const { press } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)

    for (let step = 0; step < row; step++) await press(DOWN)
    await press(ENTER)

    expect(session[action]).toHaveBeenCalledWith(argument)
  })

  it('shouldShowWhyAndRetryWhenTheUserOpensAFailedGeneration', async () => {
    const { session } = mixed()
    const { press, text } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)
    for (let step = 0; step < 3; step++) await press(DOWN)

    await press(ENTER)
    const detail = text()
    await press('r')

    expect(detail).toContain('✗ AWS credentials are missing or expired')
    expect(detail).toContain('Refresh your AWS credentials, then retry.')
    expect(session.generate).toHaveBeenCalledWith(expect.objectContaining({ name: 'refunds' }), 'generation-3')
  })
})

describe('ExperimentPanel form', () => {
  const openForm = async () => {
    const { session } = experimentsSession({}, generationForm({ task: '' }))
    const view = await show(createElement(ExperimentPanel, { ...panelProps(), height: 20, session }), 26)
    await view.press(ENTER)
    return { session, ...view }
  }

  it('shouldShowEveryGeneratorSettingWhenTheFormOpens', async () => {
    const { text } = await openForm()

    for (const label of [
      'Name',
      'Task',
      'More context',
      'Cases',
      'Topics',
      'Evaluator',
      'Expected output',
      'Model',
      'Parallel',
    ])
      expect(text()).toContain(label)
    expect(text()).toContain('context: agent.py · 3 tools · instructions.md')
  })

  it('shouldGenerateWithTheTypedAndChosenSettingsWhenTheUserPressesEnter', async () => {
    const { session, press } = await openForm()

    for (const key of 'Refunds') await press(key)
    await press(DOWN)
    await press(DOWN)
    await press(RIGHT)
    await press(DOWN)
    await press(RIGHT)
    for (let step = 0; step < 3; step++) await press(DOWN)
    await press(' ')
    await press(ENTER)

    expect(session.generate).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'Refunds', cases: 20, topics: 2, expectedTrajectory: true }),
      undefined
    )
  })

  it('shouldApplyEveryKeyWhenKeysArriveInOneBurst', async () => {
    const { session, press } = await openForm()

    await press('Refunds')
    await press('\u001b[A')
    await press('\u007f'.repeat('experiment-1'.length))
    await press('billing')
    await press(ENTER)

    expect(session.generate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'billing', task: 'Refunds' }),
      undefined
    )
  })

  it('shouldShowTheProblemAndStayOpenWhenTheSettingsAreRefused', async () => {
    const { session, press, text } = await openForm()
    session.generate.mockReturnValue('Describe the task of the agent.')

    await press(ENTER)

    expect(text()).toContain('Describe the task of the agent.')
    expect(text()).toContain('Enter generate')
  })
})

describe('ExperimentPanel review', () => {
  const reviewing = async () => {
    const { session } = experimentsSession({
      review: {
        key: 'generation-2',
        name: 'billing',
        cases: [
          { name: 'c0', input: 'question c0', expected: 'answer c0', kept: false, saved: false },
          { name: 'c1', input: 'question c1', expected: 'answer c1', kept: true, saved: false },
        ],
      },
    })
    const view = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)
    return { session, ...view }
  }

  it('shouldShowTheDraftsAndTheirExpectedOutcomesWhenTheReviewOpens', async () => {
    const { text } = await reviewing()

    expect(text()).toContain('review · billing · 2 drafted · 1 kept')
    expect(text()).toContain('☐ c0')
    expect(text()).toContain('☑ c1')
    expect(text()).toContain('answer c0')
  })

  it('shouldRewriteTheExpectedOutcomeWhenTheUserEditsACase', async () => {
    const { session, press } = await reviewing()

    await press('e')
    for (let step = 0; step < 'answer c0'.length; step++) await press('\u007f')
    for (const key of 'refund it') await press(key)
    await press(ENTER)

    expect(session.edit).toHaveBeenCalledWith(0, { input: 'question c0', expected: 'refund it' })
  })

  it('shouldSendTheNextKeysToTheEditorWhenTheyArriveInTheSameBurstAsE', async () => {
    const { session, press } = await reviewing()

    await press('e\u007f')
    await press('X')
    await press(ENTER)

    expect(session.edit).toHaveBeenCalledWith(0, { input: 'question c0', expected: 'answer cX' })
  })

  it('shouldAddABlankCaseWhenTheUserWritesANewOne', async () => {
    const { session, press } = await reviewing()

    await press('n')
    for (const key of 'hi') await press(key)
    await press('\t')
    for (const key of 'hello') await press(key)
    await press(ENTER)

    expect(session.add).toHaveBeenCalledWith({ input: 'hi', expected: 'hello' })
  })

  it.each([
    [' ', 'toggle', [0]],
    ['d', 'drop', [0]],
    ['a', 'keepAll', []],
    [ENTER, 'save', []],
    [ESC, 'closeReview', []],
  ] as const)('shouldCallTheSessionWhenTheUserPresses%jInTheReview', async (key, action, args) => {
    const { session, press } = await reviewing()

    await press(key)

    await vi.waitFor(() => expect(session[action]).toHaveBeenCalledWith(...args))
  })
})

describe('ExperimentPicker', () => {
  const picker = async () => {
    const { session } = mixed()
    const onUse = vi.fn()
    const props = panelProps()
    const view = await show(
      createElement(ExperimentPicker, { ...props, experiments: session, command: 'test', onUse }),
      24
    )
    return { onUse, props, ...view }
  }

  it('shouldShowGeneratingExperimentsGreyAndHideFailedOnesWhenItOpens', async () => {
    const { text } = await picker()

    expect(text()).toMatch(/capital\s+12 cases/u)
    expect(text()).toContain('generating · 8/20 cases')
    expect(text()).toContain('waiting for review in /experiment')
    expect(text()).not.toContain('returns')
  })

  it('shouldSkipExperimentsThatAreStillGeneratingWhenTheUserMovesDown', async () => {
    const { press, props } = await picker()

    await press(DOWN)
    await press(ENTER)

    expect(props.openCommand).toHaveBeenCalledWith('experiment')
  })

  it('shouldUseTheSavedExperimentWhenTheUserPressesEnter', async () => {
    const { press, onUse } = await picker()

    await press(ENTER)

    expect(onUse).toHaveBeenCalledWith(saved)
  })
})

describe('generationSummary', () => {
  it.each([
    [generation({ phase: 'preparing', status: 'Installing the fork' }), 'preparing · Installing the fork'],
    [generation({ phase: 'cases', made: 3, failed: 0, total: 10 }), '3/10 cases made'],
    [generation({ phase: 'rubric', made: 10, failed: 0, total: 10 }), '10/10 cases made · writing the rubric'],
    [generation({ phase: 'ready', made: 9, failed: 1 }), '9 cases ready to review · 1 failed'],
  ])('shouldSayWhereTheGenerationIsWhenItIsIn%#', (shown, summary) => {
    expect(generationSummary(shown, Date.now())).toContain(summary)
  })
})
