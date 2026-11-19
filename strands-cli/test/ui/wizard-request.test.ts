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

const panel = async (broker: WizardBroker, rows = 20) =>
  show(createElement(WizardRequestPanel, { broker, width: 96, height: rows - 2, close: vi.fn() }), rows)

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

  it('shouldSayWhenNoQuestionIsWaiting', async () => {
    const { text } = await panel(new WizardBroker())

    expect(text()).toContain('No question is waiting.')
  })
})
