import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Wizard, type WizardField, type WizardProps, type WizardToggle } from '../../src/ui/panels/wizard.js'
import { mountElement } from '../fixtures/chat-app.js'
import { mouseInputSequence } from '../fixtures/terminal.js'

const ENTER = '\r'
const DOWN = '\u001b[B'
const SPACE = ' '
const RIGHT = '\u001b[C'
const ESC = '\u001b'

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

const wizard = async (fields: readonly WizardField[], overrides: Partial<WizardProps> = {}) => {
  const props: WizardProps = {
    name: 'setup',
    fields,
    width: 96,
    height: 18,
    onFinish: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  return { ...(await mountElement(createElement(Wizard, props))), props }
}

describe('Wizard', () => {
  it('shouldFinishWhenTheUserChoosesTheFinishButtonAndNothingBlocks', async () => {
    const { press, props } = await wizard([field()])

    await press(DOWN, ENTER)

    expect(props.onFinish).toHaveBeenCalled()
  })

  it('shouldNotFinishWhileANoticeBlocks', async () => {
    const { screen, press, props } = await wizard([field()], { notice: 'Pick a size.' })

    await press(DOWN, ENTER)

    expect(props.onFinish).not.toHaveBeenCalled()
    expect(screen()).toContain('fix the problem to finish')
  })

  it('shouldShowTheNotice', async () => {
    const { screen } = await wizard([field()], { notice: 'look here' })

    expect(screen()).toContain('look here')
  })

  it('shouldSaveTheTextWhenTheUserEditsAFieldAndPressesEnter', async () => {
    const save = vi.fn()
    const { screen, press } = await wizard([field(save)])

    await press(ENTER)
    expect(screen()).toContain('Enter save · Esc cancel')

    await press('h', 'i', ENTER)

    expect(save).toHaveBeenCalledWith('hi')
  })

  it('shouldNotTypeTheMouseReportsOfTheTerminalIntoATextField', async () => {
    const save = vi.fn()
    const { screen, press } = await wizard([field(save)])
    // The mouse moves, moves with Shift and Alt held, and the wheel turns: each is a report on the same input.
    const mouse = async (): Promise<void> => {
      for (const button of [35, 47, 64, 65]) await press(mouseInputSequence(button, 49, 19, 'M'))
    }

    await mouse()
    const onTheRow = screen()
    await press('h')
    await mouse()
    await press('i')
    const inTheEditor = screen()
    await press(ENTER)

    expect(onTheRow).not.toContain('[<')
    expect(onTheRow).not.toContain('Enter save')
    expect(inTheEditor).not.toContain('[<')
    expect(save).toHaveBeenCalledExactlyOnceWith('hi')
  })

  it('shouldDropTheEditWhenTheUserPressesEscInTheEditor', async () => {
    const save = vi.fn()
    const { press, props } = await wizard([field(save)])

    await press(ENTER, 'h', ESC)

    expect(save).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('shouldGoBackFromTheCancelButtonButStillCancelOnEscWhenTheWizardOffersBack', async () => {
    const onBack = vi.fn()
    const { press, screen, props } = await wizard([field()], { onBack })

    await press(DOWN, RIGHT)
    expect(screen()).toContain('Enter back')
    await press(ENTER)
    expect(onBack).toHaveBeenCalledOnce()
    await press(ESC)

    await vi.waitFor(() => expect(props.onCancel).toHaveBeenCalledOnce())
  })

  it('shouldLineUpTheValuesWhenALabelIsLongerThanTheDefaultWidth', async () => {
    const { screen } = await wizard([field(vi.fn(), 'steps'), field(vi.fn(), 'trials', 'trials at once')])

    const columns = screen()
      .split('\n')
      .filter((line) => /steps|trials at once/u.test(line))
      .map((line) => line.indexOf('medium'))

    expect(columns).toHaveLength(2)
    expect(new Set(columns).size).toBe(1)
  })

  it('shouldCancelWhenTheUserPressesEscOutsideAnEditor', async () => {
    const { press, props } = await wizard([field()])

    await press(ESC)

    await vi.waitFor(() => expect(props.onCancel).toHaveBeenCalled())
  })

  it('shouldToggleTheFieldWhenTheUserPicksAnAvailableKnob', async () => {
    const onToggle = vi.fn()
    const { screen, press } = await wizard([
      { ...toggle('a', 'instructions', onToggle), checked: true },
      toggle('b', 'tools', vi.fn(), 'not supported yet'),
    ])

    expect(screen()).toContain('☑ instructions')
    expect(screen()).toContain('not supported yet')

    await press(SPACE)

    expect(onToggle).toHaveBeenCalled()
  })

  it('shouldFocusAndToggleTheRowTheCursorIsOnWhenAStepMixesTextAndToggles', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { press } = await wizard([field(), toggle('a', 'alpha', first), toggle('b', 'beta', second)])

    await press(DOWN, SPACE)

    expect(first).toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('shouldKeepTheDeclaredOrderWhenAStepMixesTextAndToggles', async () => {
    const { screen } = await wizard([field(), toggle('a', 'alpha')])
    const rows = screen().split('\n')

    expect(rows.findIndex((row) => row.includes('size'))).toBeLessThan(rows.findIndex((row) => row.includes('alpha')))
  })

  it('shouldNotToggleAnUnavailableField', async () => {
    const onToggle = vi.fn()
    const { screen, press } = await wizard([toggle('b', 'tools', onToggle, 'not supported yet')])

    await press(ENTER)

    expect(onToggle).not.toHaveBeenCalled()
    expect(screen()).toContain('not available')
  })
})
