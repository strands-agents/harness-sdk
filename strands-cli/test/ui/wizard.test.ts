import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  Wizard,
  type WizardField,
  type WizardProps,
  type WizardStep,
  type WizardToggle,
} from '../../src/ui/panels/wizard.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const TAB = '\t'
const DOWN = '\u001b[B'
const SPACE = ' '
const RIGHT = '\u001b[C'
const ESC = '\u001b'

const show = async (element: ReactElement, rows = 20) => {
  const input = ttyInput()
  const output = ttyOutput(100, rows)
  const frame = captureFrame(output)
  const instance = render(element, { stdin: input, stdout: output })
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  return { text: (): string => frame().join('\n'), press }
}

const field = (save: (text: string) => void = vi.fn(), key = 'size', label = key): WizardField => ({
  kind: 'text',
  key,
  label,
  display: 'medium',
  hint: 'Enter edit',
  edit: { value: '', save },
})

const toggle = (key: string, label: string, onToggle: () => void = vi.fn(), unavailable?: string): WizardToggle => ({
  kind: 'toggle',
  key,
  label,
  checked: false,
  hint: 'Enter toggle',
  toggle: onToggle,
  ...(unavailable === undefined ? {} : { unavailable }),
})

const wizard = async (
  steps: readonly WizardStep[],
  overrides: Partial<WizardProps> = {}
): Promise<{ text: () => string; press: (key: string) => Promise<void>; props: WizardProps }> => {
  const props: WizardProps = {
    name: 'setup',
    steps,
    width: 96,
    height: 18,
    finishHint: (blocking) => (blocking ? 'fix it to start' : 'Enter start'),
    onFinish: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  const view = await show(createElement(Wizard, props))
  return { ...view, props }
}

const twoSteps = (save?: (text: string) => void): WizardStep[] => [
  { key: 'one', title: 'One', fields: [field(save)] },
  { key: 'two', title: 'Two', fields: [], body: () => null },
]

describe('Wizard', () => {
  it('shouldOfferNextAndCancelOnTheFirstStep', async () => {
    const { text } = await wizard(twoSteps())

    expect(text()).toContain('[ Next ]')
    expect(text()).toContain('Cancel')
    expect(text()).not.toContain('Back')
  })

  it('shouldOfferStartAndCancelOnTheLastStep', async () => {
    const { text, press } = await wizard(twoSteps())

    await press(TAB)

    expect(text()).toContain('[ Start ]')
    expect(text()).not.toContain('[ Next ]')
  })

  it('shouldWalkToTheNextStepWhenTheUserChoosesNext', async () => {
    const { text, press } = await wizard(twoSteps())

    await press(DOWN)
    await press(ENTER)

    expect(text()).toContain('[ Start ]')
  })

  it('shouldWalkBackWhenTheUserChoosesBack', async () => {
    const steps: WizardStep[] = [
      { key: 'one', title: 'One', fields: [field()] },
      { key: 'two', title: 'Two', fields: [field()] },
      { key: 'three', title: 'Three', fields: [], body: () => null },
    ]
    const { text, press } = await wizard(steps)

    await press(DOWN)
    await press(ENTER)
    expect(text()).toContain('Back')

    await press(RIGHT)
    await press(ENTER)

    expect(text()).toContain('[ Next ]')
    expect(text()).not.toContain('Back')
  })

  it('shouldFinishWhenTheUserChoosesStartAndNoStepBlocks', async () => {
    const { press, props } = await wizard(twoSteps())

    await press(TAB)
    await press(ENTER)

    expect(props.onFinish).toHaveBeenCalled()
  })

  it('shouldNotFinishWhenAStepHasABlockingNotice', async () => {
    const steps = twoSteps()
    steps[0] = { ...steps[0]!, notice: { tone: 'error', text: 'Pick a size.' } }
    const { text, press, props } = await wizard(steps)

    await press(TAB)
    await press(ENTER)

    expect(props.onFinish).not.toHaveBeenCalled()
    expect(text()).toContain('fix it to start')
  })

  it.each([
    ['error', '!'],
    ['warning', '!'],
  ])('shouldMarkTheStepThatCarriesA%sNotice', async (tone, mark) => {
    const steps = twoSteps()
    steps[0] = { ...steps[0]!, notice: { tone: tone as 'error' | 'warning', text: 'look here' } }
    const { text } = await wizard(steps)

    expect(text()).toContain(`One ${mark}`)
    expect(text()).toContain('look here')
  })

  it('shouldShowTheBlockingNoticeOnEveryStepThatHasNoneOfItsOwn', async () => {
    const steps: WizardStep[] = [
      { key: 'one', title: 'One', fields: [field()], notice: { tone: 'error', text: 'Pick a size.' } },
      { key: 'two', title: 'Two', fields: [field()] },
    ]
    const { text, press } = await wizard(steps)

    await press(TAB)

    expect(text()).toContain('Pick a size.')
  })

  it('shouldSaveTheTextWhenTheUserEditsAFieldAndPressesEnter', async () => {
    const save = vi.fn()
    const { text, press } = await wizard(twoSteps(save))

    await press(ENTER)
    expect(text()).toContain('Enter save · Esc cancel')

    await press('h')
    await press('i')
    await press(ENTER)

    expect(save).toHaveBeenCalledWith('hi')
  })

  it('shouldNotTypeTheMouseReportsOfTheTerminalIntoATextField', async () => {
    const save = vi.fn()
    const { text, press } = await wizard(twoSteps(save))
    // The mouse moves, moves with Shift and Alt held, and the wheel turns: each is a report on the same input.
    const mouse = async (): Promise<void> => {
      for (const button of [35, 47, 64, 65]) await press(mouseInputSequence(button, 49, 19, 'M'))
    }

    await mouse()
    const onTheRow = text()
    await press('h')
    await mouse()
    await press('i')
    const inTheEditor = text()
    await press(ENTER)

    expect(onTheRow).not.toContain('[<')
    expect(onTheRow).not.toContain('Enter save')
    expect(inTheEditor).not.toContain('[<')
    expect(save).toHaveBeenCalledExactlyOnceWith('hi')
  })

  it('shouldDropTheEditWhenTheUserPressesEscInTheEditor', async () => {
    const save = vi.fn()
    const { press, props } = await wizard([{ key: 'one', title: 'One', fields: [field(save)] }])

    await press(ENTER)
    await press('h')
    await press(ESC)

    expect(save).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('shouldGoBackFromTheCancelButtonButStillCancelOnEscWhenTheWizardOffersBack', async () => {
    const onBack = vi.fn()
    const { press, text, props } = await wizard([{ key: 'one', title: 'One', fields: [field()] }], { onBack })

    await press(DOWN)
    await press(RIGHT)
    expect(text()).toContain('Enter back')
    await press(ENTER)
    expect(onBack).toHaveBeenCalledOnce()
    await press(ESC)

    await vi.waitFor(() => expect(props.onCancel).toHaveBeenCalledOnce())
  })

  it('shouldLineUpTheValuesWhenALabelIsLongerThanTheDefaultWidth', async () => {
    const { text } = await wizard([
      {
        key: 'budget',
        title: 'Budget',
        fields: [field(vi.fn(), 'steps'), field(vi.fn(), 'trials', 'trials at once')],
      },
    ])

    const columns = text()
      .split('\n')
      .filter((line) => /steps|trials at once/u.test(line))
      .map((line) => line.indexOf('medium'))

    expect(columns).toHaveLength(2)
    expect(new Set(columns).size).toBe(1)
  })

  it('shouldCancelWhenTheUserPressesEscOutsideAnEditor', async () => {
    const { press, props } = await wizard(twoSteps())

    await press(ESC)

    await vi.waitFor(() => expect(props.onCancel).toHaveBeenCalled())
  })

  it('shouldToggleTheFieldWhenTheUserPicksAnAvailableKnob', async () => {
    const onToggle = vi.fn()
    const { text, press } = await wizard([
      {
        key: 'one',
        title: 'One',
        fields: [
          { ...toggle('a', 'instructions', onToggle), checked: true },
          toggle('b', 'tools', vi.fn(), 'not supported yet'),
        ],
      },
    ])

    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('not supported yet')

    await press(SPACE)

    expect(onToggle).toHaveBeenCalled()
  })

  it('shouldFocusAndToggleTheRowTheCursorIsOnWhenAStepMixesTextAndToggles', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { press } = await wizard([
      { key: 'one', title: 'One', fields: [field(), toggle('a', 'alpha', first), toggle('b', 'beta', second)] },
    ])

    await press(DOWN)
    await press(SPACE)

    expect(first).toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('shouldKeepTheDeclaredOrderWhenAStepMixesTextAndToggles', async () => {
    const { text } = await wizard([{ key: 'one', title: 'One', fields: [field(), toggle('a', 'alpha')] }])
    const rows = text().split('\n')

    expect(rows.findIndex((row) => row.includes('size'))).toBeLessThan(rows.findIndex((row) => row.includes('alpha')))
  })

  it('shouldNotToggleAnUnavailableField', async () => {
    const onToggle = vi.fn()
    const { text, press } = await wizard([
      { key: 'one', title: 'One', fields: [toggle('b', 'tools', onToggle, 'not supported yet')] },
    ])

    await press(ENTER)

    expect(onToggle).not.toHaveBeenCalled()
    expect(text()).toContain('not available')
  })

  it('shouldShowTheStatus', async () => {
    const { text } = await wizard(twoSteps(), { status: '~57 rollouts' })

    expect(text()).toContain('~57 rollouts')
  })
})
