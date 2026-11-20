import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import {
  defaultAnswers,
  WizardBroker,
  type WizardRequestSpec,
  type WizardStepSpec,
} from '../../src/ui/panels/wizard-request.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const TAB = '\t'
const DOWN = '\u001b[B'
const RIGHT = '\u001b[C'

const steps: WizardStepSpec[] = [
  {
    key: 'knobs',
    title: 'Knobs',
    listLabel: 'knobs',
    fields: [
      { kind: 'toggle', key: 'instructions', label: 'instructions', checked: true },
      { kind: 'toggle', key: 'effort', label: 'effort' },
    ],
  },
  {
    key: 'budget',
    title: 'Budget',
    fields: [{ kind: 'choice', key: 'steps', label: 'steps', options: ['4', '8', '16'] }],
  },
]

const request = (overrides: Partial<WizardRequestSpec> = {}): WizardRequestSpec => ({
  name: 'optimize',
  steps,
  ...overrides,
})

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

const panel = async (broker: WizardBroker, rows = 20, onAutofill?: (on: boolean) => void) =>
  show(
    createElement(WizardRequestPanel, {
      broker,
      width: 96,
      height: rows - 2,
      close: vi.fn(),
      ...(onAutofill ? { onAutofill } : {}),
    }),
    rows
  )

describe('defaultAnswers', () => {
  it('shouldSeedEveryFieldFromItsSpec', () => {
    expect(defaultAnswers(steps)).toEqual({ instructions: true, effort: false, steps: '4' })
  })

  it('shouldSeedAChoiceFromItsValueWhenTheSpecSetsOne', () => {
    const picked: WizardStepSpec[] = [
      {
        key: 'a',
        title: 'A',
        fields: [{ kind: 'choice', key: 'size', label: 'size', options: ['s', 'm'], value: 'm' }],
      },
    ]

    expect(defaultAnswers(picked)).toEqual({ size: 'm' })
  })
})

describe('WizardBroker', () => {
  it('shouldResolveWithTheAnswersWhenThePanelFinishes', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())

    const pending = broker.pending()!
    broker.respond(pending.id, { instructions: true })

    await expect(asked).resolves.toEqual({ instructions: true })
  })

  it('shouldResolveWithNothingWhenThePanelCancels', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())

    broker.respond(broker.pending()!.id, undefined)

    await expect(asked).resolves.toBeUndefined()
  })

  it('shouldIgnoreAnAnswerForAnotherRequest', () => {
    const broker = new WizardBroker()
    void broker.ask(request())

    expect(broker.respond('strands-wizard-999', {})).toBe(false)
  })

  it('shouldHoldTheSecondRequestUntilTheFirstIsAnswered', async () => {
    const broker = new WizardBroker()
    const first = broker.ask(request({ name: 'first' }))
    const second = broker.ask(request({ name: 'second' }))

    expect(broker.pending()?.name).toBe('first')
    broker.respond(broker.pending()!.id, {})
    await first
    await vi.waitFor(() => expect(broker.pending()?.name).toBe('second'))

    broker.respond(broker.pending()!.id, {})
    await expect(second).resolves.toEqual({})
  })

  it('shouldKeepTheSecondRequestOnScreenWhenTheFirstIsAnswered', async () => {
    const broker = new WizardBroker()
    const open = vi.fn(() => true)
    broker.attachOpener(open)
    const seen: (string | undefined)[] = []
    broker.subscribe((pending) => seen.push(pending?.name))
    const first = broker.ask(request({ name: 'first' }))
    void broker.ask(request({ name: 'second' }))

    broker.respond(broker.pending()!.id, {})
    await first

    expect(broker.pending()?.name).toBe('second')
    expect(seen).toEqual(['first', 'second'])
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('shouldSeedAnUnavailableToggleAsFalseEvenWhenTheSpecChecksIt', () => {
    const blocked: WizardStepSpec[] = [
      {
        key: 'a',
        title: 'A',
        fields: [{ kind: 'toggle', key: 'tools', label: 'tools', checked: true, unavailable: 'not yet' }],
      },
    ]

    expect(defaultAnswers(blocked)).toEqual({ tools: false })
  })

  it('shouldAnswerWithTheDefaultsWithoutShowingAnythingWhenAutofillIsOn', async () => {
    const broker = new WizardBroker(true)
    const open = vi.fn(() => true)
    broker.attachOpener(open)

    await expect(broker.ask(request())).resolves.toEqual({ instructions: true, effort: false, steps: '4' })
    expect(broker.pending()).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it('shouldStartWithAutofillOffWhenTheSettingIsNotGiven', () => {
    expect(new WizardBroker().autofill()).toBe(false)
  })

  it('shouldAutofillTheNextQuestionOnceTheToggleGoesOn', async () => {
    const broker = new WizardBroker()
    const first = broker.ask(request())

    broker.setAutofill(true)
    broker.respond(broker.pending()!.id, { instructions: true })
    await first

    await expect(broker.ask(request())).resolves.toEqual({ instructions: true, effort: false, steps: '4' })
  })

  it('shouldResolveWithNothingWhenTheBrokerIsCancelled', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())

    broker.cancelAll()

    await expect(asked).resolves.toBeUndefined()
  })

  it('shouldRefuseARequestThatHasNoStep', async () => {
    const broker = new WizardBroker()

    await expect(broker.ask(request({ steps: [] }))).resolves.toBeUndefined()
  })

  it('shouldTellSubscribersAboutThePendingRequest', () => {
    const broker = new WizardBroker()
    const seen: (string | undefined)[] = []
    broker.subscribe((pending) => seen.push(pending?.name))

    void broker.ask(request())
    broker.respond(broker.pending()!.id, {})

    expect(seen).toEqual(['optimize', undefined])
  })
})

describe('WizardRequestPanel', () => {
  it('shouldRenderTheDeclaredStepsAndFields', async () => {
    const broker = new WizardBroker()
    void broker.ask(request({ titleParts: ['chat-performance'] }))
    const { text } = await panel(broker)

    expect(text()).toContain('optimize · chat-performance')
    expect(text()).toContain('Knobs')
    expect(text()).toContain('Budget')
    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('☐ effort')
  })

  it('shouldReturnTheAnswersThatTheUserPickedWhenTheyFinish', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())
    const { press } = await panel(broker)

    await press(DOWN)
    await press(ENTER)
    await press(TAB)
    await press(RIGHT)
    await press(DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ instructions: true, effort: true, steps: '8' })
  })

  it('shouldReturnNothingWhenTheUserCancels', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())
    const { press } = await panel(broker)

    await press('\u001b')

    await expect(asked).resolves.toBeUndefined()
  })

  it('shouldShowOneQuestionWithNoTabs', async () => {
    const broker = new WizardBroker()
    void broker.ask({
      name: 'optimize',
      question: 'What should the run tune?',
      status: 'Defaults: 57 rollouts',
      steps: [
        {
          key: 'question',
          title: 'Question',
          fields: [
            {
              kind: 'select',
              key: 'tune',
              listLabel: 'knobs',
              multiple: true,
              selected: ['instructions'],
              options: [
                { value: 'instructions', label: 'instructions', detail: 'the system prompt' },
                { value: 'model', label: 'model', unavailable: 'set in code' },
              ],
            },
          ],
        },
      ],
    })
    const { text } = await panel(broker)

    expect(text()).toContain('What should the run tune?')
    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('☐ model')
    expect(text()).toContain('Defaults: 57 rollouts')
    expect(text()).not.toContain('Question')
    expect(text()).not.toContain('Tab next tab')
  })

  it('shouldReturnEveryPickOfASelectMany', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask({
      name: 'optimize',
      question: 'What should the run tune?',
      steps: [
        {
          key: 'question',
          title: 'Question',
          fields: [
            {
              kind: 'select',
              key: 'tune',
              multiple: true,
              options: [
                { value: 'instructions', label: 'instructions' },
                { value: 'caching', label: 'caching' },
              ],
            },
          ],
        },
      ],
    })
    const { press } = await panel(broker)

    await press(ENTER)
    await press(DOWN)
    await press(ENTER)
    await press(DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ tune: ['instructions', 'caching'] })
  })

  it('shouldKeepOnlyTheLastPickOfASelectOne', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask({
      name: 'optimize',
      question: 'How many steps?',
      steps: [
        {
          key: 'question',
          title: 'Question',
          fields: [
            {
              kind: 'select',
              key: 'iterations',
              multiple: false,
              selected: ['4'],
              options: [
                { value: '4', label: '4' },
                { value: '8', label: '8' },
              ],
            },
          ],
        },
      ],
    })
    const { text, press } = await panel(broker)

    expect(text()).toContain('◉ 4')
    expect(text()).toContain('○ 8')

    await press(DOWN)
    await press(ENTER)
    await press(DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ iterations: '8' })
  })

  it('shouldRefuseToPickAnUnavailableOption', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask({
      name: 'optimize',
      question: 'What should the run tune?',
      steps: [
        {
          key: 'question',
          title: 'Question',
          fields: [
            {
              kind: 'select',
              key: 'tune',
              multiple: true,
              options: [{ value: 'model', label: 'model', unavailable: 'set in code' }],
            },
          ],
        },
      ],
    })
    const { text, press } = await panel(broker)

    await press(ENTER)
    expect(text()).toContain('not available')

    await press(DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ tune: [] })
  })

  it('shouldOfferTheAutofillKeyWithoutPuttingItsStateInTheComponent', async () => {
    const broker = new WizardBroker()
    void broker.ask(request())
    const { text } = await panel(broker)

    expect(text()).toContain('ctrl+a autofill')
    expect(text()).not.toContain('autofill: off')
  })

  it('shouldTurnAutofillOnAndReportItOutwardWhenTheUserPressesCtrlA', async () => {
    const broker = new WizardBroker()
    const reported: boolean[] = []
    void broker.ask(request())
    const { text, press } = await panel(broker, 20, (on) => reported.push(on))

    await press('\u0001')

    expect(broker.autofill()).toBe(true)
    expect(reported).toEqual([true])
    expect(text()).not.toContain('the agent answers the next one itself')
  })

  it('shouldSayWhenNoQuestionIsWaiting', async () => {
    const { text } = await panel(new WizardBroker())

    expect(text()).toContain('No question is waiting.')
  })
})
