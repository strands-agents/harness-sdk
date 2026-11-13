import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ExperimentPanel, generationSummary } from '../../../src/dev/panels/experiment.js'
import { ExperimentPicker } from '../../../src/dev/panels/picker.js'
import { experimentsSession, generation, panelProps, show } from './fixtures.js'

const ENTER = '\r'
const DOWN = '\u001b[B'
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

  it('shouldIndentEveryLineOfTheErrorDetailWhenItWraps', async () => {
    const long = `strands-evals said: ${'AccessDeniedException is not authorized to perform '.repeat(4)}`
    const { session } = experimentsSession({
      generations: [
        generation({ id: 'generation-3', phase: 'failed', error: { summary: 'Bedrock denied access', detail: long } }),
      ],
    })
    const { press, text } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)

    await press(DOWN)
    await press(ENTER)

    const wrapped = text()
      .split('\n')
      .filter((line) => line.includes('perform'))
    expect(wrapped.length).toBeGreaterThan(1)
    expect(wrapped.every((line) => line.startsWith('  '))).toBe(true)
  })

  it('shouldOfferTheReviewAndNoDeleteKeysWhenTheOpenGenerationFinishes', async () => {
    const { session, states } = mixed()
    const { press, text } = await show(createElement(ExperimentPanel, { ...panelProps(), session }), 24)
    await press(DOWN)
    await press(ENTER)

    states.set({
      ...states.snapshot(),
      generations: states
        .snapshot()
        .generations.map((item) =>
          item.id === 'generation-1' ? { ...item, phase: 'ready' as const, made: 19 } : item
        ),
    })
    await vi.waitFor(() => expect(text()).toContain('Enter reviews the cases'))
    await press('d')
    await press('r')
    await press(ENTER)

    expect(text()).not.toContain('stopped')
    expect(session.dismiss).not.toHaveBeenCalled()
    expect(session.generate).not.toHaveBeenCalled()
    expect(session.review).toHaveBeenCalledWith('generation-1')
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

describe('ExperimentPanel new experiment', () => {
  it.each([
    ['Enter', ENTER],
    ['n', 'n'],
  ])('shouldCloseThePanelAndStartTheSkillInTheChatWhenTheUserPresses%s', async (_key, key) => {
    const { session } = experimentsSession()
    const props = panelProps()
    const { press, text } = await show(createElement(ExperimentPanel, { ...props, session }), 24)
    const home = text()

    await press(key)

    expect(home).toMatch(/\+ New experiment\s+describe it to the agent in the chat/u)
    expect(props.close).toHaveBeenCalledOnce()
    expect(session.startInChat).toHaveBeenCalledOnce()
    expect(session.generate).not.toHaveBeenCalled()
  })

  it('shouldAskTheAgentToFixAFailedGenerationWhenTheUserPressesEnterOnIt', async () => {
    const { session } = mixed()
    const props = panelProps()
    const { press, text } = await show(createElement(ExperimentPanel, { ...props, session }), 24)
    for (let step = 0; step < 3; step++) await press(DOWN)
    await press(ENTER)
    const detail = text()

    await press(ENTER)

    expect(detail).toContain('Enter fix it in the chat')
    expect(props.close).toHaveBeenCalledOnce()
    expect(session.retryInChat).toHaveBeenCalledWith('generation-3')
  })
})

describe('ExperimentPanel review', () => {
  const reviewing = async () => {
    const { session, states } = experimentsSession({
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
    return { session, states, ...view }
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

    expect(session.edit).toHaveBeenCalledWith(0, { expected: 'refund it' })
  })

  it('shouldSendTheNextKeysToTheEditorWhenTheyArriveInTheSameBurstAsE', async () => {
    const { session, press } = await reviewing()

    await press('e\u007f')
    await press('X')
    await press(ENTER)

    expect(session.edit).toHaveBeenCalledWith(0, { expected: 'answer cX' })
  })

  it('shouldPutTheCursorOnTheNewCaseWhenTheUserAddsOne', async () => {
    const { session, states, press, text } = await reviewing()
    session.add.mockImplementation(({ input = '', expected = '' }) => {
      const review = states.snapshot().review!
      states.set({
        ...states.snapshot(),
        review: { ...review, cases: [...review.cases, { name: 'case-3', input, expected, kept: true, saved: false }] },
      })
    })

    await press('n')
    await press('third')
    await press(ENTER)

    await vi.waitFor(() => expect(text()).toContain('3/3'))
    await press(' ')
    expect(session.toggle).toHaveBeenCalledWith(2)
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
