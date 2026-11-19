import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { Wizard, type WizardProps, type WizardStep } from '../../src/ui/panels/wizard.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const TAB = '\t'
const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'
const LEFT = '\u001b[D'
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

const choices = (move: (step: 1 | -1) => void) =>
  ({
    kind: 'choice',
    key: 'size',
    label: 'size',
    count: 3,
    position: 1,
    detail: 'medium',
    hint: '←→ size',
    move,
  }) as const

const wizard = async (
  steps: readonly WizardStep[],
  overrides: Partial<WizardProps> = {},
  rows = 20
): Promise<{ text: () => string; press: (key: string) => Promise<void>; props: WizardProps }> => {
  const props: WizardProps = {
    name: 'setup',
    steps,
    width: 96,
    height: rows - 2,
    finishHint: (blocking) => (blocking ? 'fix it to start' : 'Enter start'),
    onFinish: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  const view = await show(createElement(Wizard, props), rows)
  return { ...view, props }
}

const twoSteps = (move: (step: 1 | -1) => void = vi.fn()): WizardStep[] => [
  { key: 'one', title: 'One', fields: [choices(move)] },
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
      { key: 'one', title: 'One', fields: [choices(vi.fn())] },
      { key: 'two', title: 'Two', fields: [choices(vi.fn())] },
      { key: 'three', title: 'Three', fields: [], body: () => null },
    ]
    const { text, press } = await wizard(steps)

    await press(DOWN)
    await press(ENTER)
    expect(text()).toContain('Back')

    await press(DOWN)
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
      { key: 'one', title: 'One', fields: [choices(vi.fn())], notice: { tone: 'error', text: 'Pick a size.' } },
      { key: 'two', title: 'Two', fields: [choices(vi.fn())] },
    ]
    const { text, press } = await wizard(steps)

    await press(TAB)

    expect(text()).toContain('Pick a size.')
  })

  it.each([
    [RIGHT, 1],
    [LEFT, -1],
  ])('shouldMoveTheChoiceWhenTheUserPresses%s', async (key, step) => {
    const move = vi.fn()
    const { press } = await wizard(twoSteps(move))

    await press(key)

    expect(move).toHaveBeenCalledWith(step)
  })

  it('shouldSaveTheTextWhenTheUserEditsAFieldAndPressesEnter', async () => {
    const save = vi.fn()
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        fields: [
          {
            kind: 'text',
            key: 'goal',
            label: 'goal',
            display: 'none',
            hint: 'Enter edit',
            edit: { value: '', placeholder: 'type a goal', save },
          },
        ],
      },
      { key: 'two', title: 'Two', fields: [], body: () => null },
    ]
    const { text, press } = await wizard(steps)

    await press(ENTER)
    expect(text()).toContain('Enter save · Esc cancel')

    await press('h')
    await press('i')
    await press(ENTER)

    expect(save).toHaveBeenCalledWith('hi')
  })

  it('shouldDropTheEditWhenTheUserPressesEscInTheEditor', async () => {
    const save = vi.fn()
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        fields: [
          {
            kind: 'text',
            key: 'goal',
            label: 'goal',
            display: 'none',
            hint: 'Enter edit',
            edit: { value: '', placeholder: 'type a goal', save },
          },
        ],
      },
    ]
    const { press, props } = await wizard(steps)

    await press(ENTER)
    await press('h')
    await press(ESC)

    expect(save).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('shouldCancelWhenTheUserPressesEscOutsideAnEditor', async () => {
    const { press, props } = await wizard(twoSteps())

    await press(ESC)

    await vi.waitFor(() => expect(props.onCancel).toHaveBeenCalled())
  })

  it('shouldToggleTheFieldWhenTheUserPicksAnAvailableKnob', async () => {
    const toggle = vi.fn()
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        listLabel: 'knobs',
        fields: [
          { kind: 'toggle', key: 'a', label: 'instructions', checked: true, hint: 'Enter toggle', toggle },
          {
            kind: 'toggle',
            key: 'b',
            label: 'tools',
            checked: false,
            unavailable: 'not supported yet',
            hint: 'Enter toggle',
            toggle: vi.fn(),
          },
        ],
      },
    ]
    const { text, press } = await wizard(steps)

    expect(text()).toContain('knobs')
    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('not supported yet')

    await press(ENTER)

    expect(toggle).toHaveBeenCalled()
  })

  it('shouldFocusAndToggleTheRowTheCursorIsOnWhenAStepMixesChoicesAndToggles', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        fields: [
          choices(vi.fn()),
          { kind: 'toggle', key: 'a', label: 'alpha', checked: false, hint: 'Enter toggle', toggle: first },
          { kind: 'toggle', key: 'b', label: 'beta', checked: false, hint: 'Enter toggle', toggle: second },
        ],
      },
    ]
    const { press } = await wizard(steps)

    await press(DOWN)
    await press(ENTER)

    expect(first).toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('shouldKeepTheDeclaredOrderWhenAStepMixesChoicesAndToggles', async () => {
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        fields: [
          choices(vi.fn()),
          { kind: 'toggle', key: 'a', label: 'alpha', checked: false, hint: 'Enter toggle', toggle: vi.fn() },
        ],
      },
    ]
    const { text } = await wizard(steps)
    const rows = text().split('\n')

    expect(rows.findIndex((row) => row.includes('size'))).toBeLessThan(rows.findIndex((row) => row.includes('alpha')))
  })

  it('shouldNotToggleAnUnavailableField', async () => {
    const toggle = vi.fn()
    const steps: WizardStep[] = [
      {
        key: 'one',
        title: 'One',
        fields: [
          {
            kind: 'toggle',
            key: 'b',
            label: 'tools',
            checked: false,
            unavailable: 'not supported yet',
            hint: 'Enter toggle',
            toggle,
          },
        ],
      },
    ]
    const { text, press } = await wizard(steps)

    await press(ENTER)

    expect(toggle).not.toHaveBeenCalled()
    expect(text()).toContain('not available')
  })

  it('shouldIgnoreKeysWhileBlockedByAnotherView', async () => {
    const { press, props } = await wizard(twoSteps(), { blocked: () => true })

    await press(ESC)
    await press(TAB)

    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('shouldShowTheStatusAndTheFooter', async () => {
    const { text } = await wizard(twoSteps(), { status: '~57 rollouts', footer: '~25M tokens' })

    expect(text()).toContain('~57 rollouts')
    expect(text()).toContain('~25M tokens')
  })

  it('shouldHideTheFootnoteWhenThePanelIsShort', async () => {
    const steps = twoSteps()
    steps[0] = { ...steps[0]!, footnote: 'train guides the search' }

    const tall = await wizard(steps, {}, 20)
    expect(tall.text()).toContain('train guides the search')

    const short = await wizard(steps, { height: 8 }, 10)
    expect(short.text()).not.toContain('train guides the search')
  })
})
