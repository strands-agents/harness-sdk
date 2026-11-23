import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import {
  defaultAnswers,
  WizardBroker,
  type WizardFieldSpec,
  type WizardRequestSpec,
} from '../../src/ui/panels/wizard-request.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const DOWN = '\u001b[B'
const ESCAPE = '\u001b'
const BACKSPACE = '\u007f'

const question = (fields: readonly WizardFieldSpec[], name = 'optimize'): WizardRequestSpec => ({
  name,
  question: 'What should the run tune?',
  steps: [{ key: 'question', title: 'Question', fields }],
})

const tune: WizardFieldSpec = {
  kind: 'select',
  key: 'tune',
  multiple: true,
  selected: ['instructions'],
  options: [
    { value: 'instructions', label: 'instructions', detail: 'the system prompt' },
    { value: 'caching', label: 'caching' },
    { value: 'model', label: 'model', unavailable: 'set in code' },
  ],
}

const objective: WizardFieldSpec = {
  kind: 'select',
  key: 'objective',
  multiple: false,
  selected: ['mean'],
  options: [
    { value: 'mean', label: 'the mean of every evaluator' },
    { value: 'other', label: 'something else', input: true },
  ],
}

const budget: readonly WizardFieldSpec[] = [
  { kind: 'number', key: 'iterations', label: 'steps', value: 4, min: 1, detail: 'rounds' },
  { kind: 'number', key: 'workers', label: 'parallel', value: 4, min: 1, max: 16 },
]

const show = async (element: ReactElement, rows = 20) => {
  const input = ttyInput()
  const output = ttyOutput(100, rows)
  const frame = captureFrame(output)
  const instance = render(element, { stdin: input, stdout: output })
  await instance.waitUntilRenderFlush()
  const press = async (...keys: readonly string[]): Promise<void> => {
    for (const key of keys) {
      input.write(key)
      await instance.waitUntilRenderFlush()
    }
  }
  return { text: (): string => frame().join('\n'), press }
}

const panel = async (broker: WizardBroker, rows = 20) =>
  show(createElement(WizardRequestPanel, { broker, width: 96, height: rows - 2, close: vi.fn() }), rows)

describe('defaultAnswers', () => {
  it('shouldSeedEveryFieldFromItsSpecAndLeaveOutAnUnavailablePick', () => {
    const blocked: WizardFieldSpec = { ...tune, selected: ['instructions', 'model'] } as WizardFieldSpec

    expect(
      defaultAnswers([
        {
          key: 'q',
          title: 'Q',
          fields: [blocked, objective, ...budget, { kind: 'text', key: 'notes', label: 'notes' }],
        },
      ])
    ).toEqual({ tune: ['instructions'], objective: 'mean', iterations: 4, workers: 4, notes: '' })
  })
})

describe('WizardBroker', () => {
  it('shouldResolveWithTheAnswersOrNothingAndIgnoreAnAnswerForAnotherRequest', async () => {
    const broker = new WizardBroker()
    const answered = broker.ask(question([tune]))
    expect(broker.respond('strands-wizard-999', {})).toBe(false)
    broker.respond(broker.pending()!.id, { tune: ['caching'] })
    const cancelled = broker.ask(question([tune]))
    broker.respond(broker.pending()!.id, undefined)

    await expect(answered).resolves.toEqual({ tune: ['caching'] })
    await expect(cancelled).resolves.toBeUndefined()
  })

  it('shouldKeepTheSecondRequestOnScreenUntilTheFirstIsAnswered', async () => {
    const broker = new WizardBroker()
    const open = vi.fn(() => true)
    broker.attachOpener(open)
    const seen: (string | undefined)[] = []
    broker.subscribe((pending) => seen.push(pending?.name))
    const first = broker.ask(question([tune], 'first'))
    const second = broker.ask(question([tune], 'second'))

    broker.respond(broker.pending()!.id, {})
    await first
    expect(broker.pending()?.name).toBe('second')
    broker.respond(broker.pending()!.id, {})

    await expect(second).resolves.toEqual({})
    expect(seen).toEqual(['first', 'second', undefined])
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('shouldResolveWithNothingWhenCancelledOrWhenTheRequestHasNoStep', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question([tune]))

    broker.cancelAll()

    await expect(asked).resolves.toBeUndefined()
    await expect(broker.ask({ name: 'optimize', steps: [] })).resolves.toBeUndefined()
  })
})

describe('WizardRequestPanel', () => {
  it('shouldShowOneQuestionAndReturnEveryPickOfASelectManyButNotAnUnavailableOne', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question([tune]))
    const { text, press } = await panel(broker)

    expect(text()).toContain('What should the run tune?')
    expect(text()).toContain('☑ instructions')
    expect(text()).toContain('☐ caching')
    expect(text()).not.toContain('Tab next tab')
    await press(DOWN, ENTER, DOWN, ENTER)
    expect(text()).toContain('not available')
    await press(DOWN, ENTER)

    await expect(asked).resolves.toEqual({ tune: ['instructions', 'caching'] })
  })

  it('shouldEditTheInputRowInPlaceAndAnswerWithTheTypedTextWhenItIsPicked', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question([objective]))
    const { text, press } = await panel(broker)

    expect(text()).toContain('◉ the mean of every evaluator')
    await press(DOWN, ENTER, ...'tokens <= 4000')
    const editing = text().split('\n')
    expect(editing.find((line) => line.includes('something else'))).toContain('tokens <= 4000▏')
    expect(editing.filter((line) => line.includes('tokens <= 4000'))).toHaveLength(1)
    await press(ENTER)
    expect(text()).toContain('◉ something else')
    expect(text()).toContain('tokens <= 4000')
    await press(DOWN, ENTER)

    await expect(asked).resolves.toEqual({ objective: 'tokens <= 4000' })
  })

  it('shouldUnpickTheInputRowWhenItsTextIsSavedEmpty', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question([{ ...objective, selected: [] } as WizardFieldSpec]))
    const { press } = await panel(broker)

    await press(DOWN, ENTER, ...'x', ENTER, ENTER, BACKSPACE, ENTER, DOWN, ENTER)

    await expect(asked).resolves.toEqual({ objective: '' })
  })

  it('shouldTakeDigitsOnlyAndBlockFinishingUntilEveryNumberFits', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question(budget))
    const { text, press } = await panel(broker)

    expect(text()).toContain('4   rounds')
    await press(ENTER, BACKSPACE, ...'0x', ENTER)
    expect(text()).toContain('steps must be at least 1.')
    await press(DOWN, DOWN, ENTER)
    expect(broker.pending()).toBeDefined()
    await press(ESCAPE)
    await expect(asked).resolves.toBeUndefined()

    const fixed = broker.ask(question(budget))
    const again = await panel(broker)
    await again.press(DOWN, ENTER, BACKSPACE, ENTER)
    expect(again.text()).toContain('parallel needs a whole number.')
    await again.press(ENTER, ...'32', ENTER)
    expect(again.text()).toContain('parallel must be at most 16.')
    await again.press(ENTER, BACKSPACE, ENTER, DOWN, ENTER)

    await expect(fixed).resolves.toEqual({ iterations: 4, workers: 3 })
  })

  it('shouldSayWhenNoQuestionIsWaiting', async () => {
    const { text } = await panel(new WizardBroker())

    expect(text()).toContain('No question is waiting.')
  })
})
