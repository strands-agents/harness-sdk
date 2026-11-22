import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createDiffPreview } from '../../src/agent/file-changes.js'
import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import {
  defaultAnswers,
  WizardBroker,
  wizardRequestRows,
  type WizardRequestSpec,
  type WizardStepSpec,
} from '../../src/ui/panels/wizard-request.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const TAB = '\t'
const DOWN = '\u001b[B'
const SPACE = ' '
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

const panel = async (broker: WizardBroker, rows = 20, onAutofill?: (on: boolean) => void, active = true) =>
  show(
    createElement(WizardRequestPanel, {
      broker,
      width: 96,
      height: rows - 2,
      close: vi.fn(),
      active,
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

  it('shouldCancelTheQuestionATurnWaitsOnWhenAMessageIsSentInstead', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(request())

    expect(broker.dropForMessage()).toBe(true)

    await expect(asked).resolves.toBeUndefined()
    expect(broker.pending()).toBeUndefined()
  })

  it('shouldKeepAStandingQuestionOnScreenWhenAMessageIsSent', () => {
    const broker = new WizardBroker()
    const settled = vi.fn()
    void broker.ask(request({ name: 'review', standing: true })).then(settled)

    expect(broker.dropForMessage()).toBe(false)

    expect(broker.pending()?.name).toBe('review')
    expect(settled).not.toHaveBeenCalled()
  })

  it('shouldShowATurnsQuestionBeforeAStandingOneAndReturnToItAfterwards', async () => {
    const broker = new WizardBroker()
    const seen: (string | undefined)[] = []
    void broker.ask(request({ name: 'review', standing: true }))
    broker.subscribe((pending) => seen.push(pending?.name))

    const asked = broker.ask(request({ name: 'setup' }))
    expect(broker.pending()?.name).toBe('setup')
    broker.respond(broker.pending()!.id, {})

    await expect(asked).resolves.toEqual({})
    expect(broker.pending()?.name).toBe('review')
    expect(seen).toEqual(['review', 'setup', 'review'])
  })

  it('shouldDropOnlyTheTurnsQuestionWhenAStandingOneWaitsBehindIt', async () => {
    const broker = new WizardBroker()
    void broker.ask(request({ name: 'review', standing: true }))
    const asked = broker.ask(request({ name: 'setup' }))

    expect(broker.dropForMessage()).toBe(true)

    await expect(asked).resolves.toBeUndefined()
    expect(broker.pending()?.name).toBe('review')
  })

  it('shouldPutTheWaitingQuestionAboutATopicOnScreenAndKeepTheOtherWaiting', async () => {
    const broker = new WizardBroker()
    const seen: (string | undefined)[] = []
    const first = broker.ask(request({ name: 'first', standing: true, topic: 'run-1' }))
    void broker.ask(request({ name: 'second', standing: true, topic: 'run-2' }))
    broker.subscribe((pending) => seen.push(pending?.name))

    expect(broker.bringForward('run-2')).toBe(true)
    expect(broker.pending()?.name).toBe('second')
    broker.respond(broker.pending()!.id, {})

    expect(broker.pending()?.name).toBe('first')
    broker.respond(broker.pending()!.id, { answered: true })
    await expect(first).resolves.toEqual({ answered: true })
    expect(seen).toEqual(['first', 'second', 'first', undefined])
  })

  it('shouldSayWhetherAQuestionAboutTheTopicWaits', () => {
    const broker = new WizardBroker()
    void broker.ask(request({ name: 'first', topic: 'run-1' }))

    expect(broker.bringForward('run-1')).toBe(true)
    expect(broker.bringForward('run-9')).toBe(false)
    expect(broker.pending()?.name).toBe('first')
  })

  it('shouldPutAStandingQuestionOnScreenEvenWhenAutofillIsOn', () => {
    const broker = new WizardBroker(true)
    const settled = vi.fn()

    void broker.ask(request({ name: 'review', standing: true })).then(settled)

    expect(broker.pending()?.name).toBe('review')
    expect(settled).not.toHaveBeenCalled()
  })

  it('shouldCancelTheQuestionsAboutATopicAndShowTheNextThatWaits', async () => {
    const broker = new WizardBroker()
    const first = broker.ask(request({ name: 'first', standing: true, topic: 'run-1' }))
    void broker.ask(request({ name: 'second', standing: true, topic: 'run-2' }))
    const third = broker.ask(request({ name: 'third', standing: true, topic: 'run-1' }))

    broker.withdraw('run-1')

    await expect(first).resolves.toBeUndefined()
    await expect(third).resolves.toBeUndefined()
    expect(broker.pending()?.name).toBe('second')
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

    await press(SPACE)
    await press(DOWN)
    await press(SPACE)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ tune: ['instructions', 'caching'] })
  })

  it('shouldStartAPickOneListWithNothingPicked', () => {
    const one: WizardStepSpec[] = [
      {
        key: 'a',
        title: 'A',
        fields: [
          {
            kind: 'select',
            key: 'size',
            multiple: false,
            selected: ['m'],
            options: [
              { value: 's', label: 's' },
              { value: 'm', label: 'm' },
            ],
          },
        ],
      },
    ]

    expect(defaultAnswers(one)).toEqual({ size: '' })
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

    expect(text()).toContain('○ 4')
    expect(text()).toContain('○ 8')

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

    await press(SPACE)
    expect(text()).toContain('not available')

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

  it('shouldAnswerOnEnterWithNoButtonsToReachFor', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask({ name: 'optimize', question: 'Which knobs?', steps: [steps[0]!] })
    const { text, press } = await panel(broker)

    expect(text()).not.toContain('[ OK ]')
    expect(text()).not.toContain('Cancel')
    expect(text()).toContain('Space toggle · Enter done')

    await press(ENTER)

    await expect(asked).resolves.toEqual({ instructions: true, effort: false })
  })

  it('shouldPickAndAnswerOnOneEnterForARadioList', async () => {
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
    expect(text()).toContain('Enter pick')

    await press(DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ iterations: '8' })
  })

  it('shouldStayIdleWhileTheChatInputHoldsTheKeyboard', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask({ name: 'optimize', question: 'Which knobs?', steps: [steps[0]!] })
    const { press } = await panel(broker, 20, undefined, false)

    await press(ENTER)
    await press('\u001b')

    expect(broker.pending()).toBeDefined()
    void asked
  })

  it('shouldCarryOnIntoTheChatWhenDownPassesTheLastRow', async () => {
    const broker = new WizardBroker()
    const left: number[] = []
    void broker.ask({ name: 'optimize', question: 'Which knobs?', steps: [steps[0]!] })
    const { text, press } = await show(
      createElement(WizardRequestPanel, {
        broker,
        width: 96,
        height: 18,
        close: vi.fn(),
        blur: () => left.push(1),
      })
    )

    expect(text()).toContain('↓ chat')
    expect(text()).not.toContain('Tab chat')

    await press(DOWN)
    expect(left).toEqual([])

    await press(DOWN)

    expect(left).toEqual([1])
    expect(broker.pending()).toBeDefined()
  })

  it('shouldSayWhenNoQuestionIsWaiting', async () => {
    const { text } = await panel(new WizardBroker())

    expect(text()).toContain('No question is waiting.')
  })
})

const PAGE_DOWN = '\u001b[6~'
const PAGE_UP = '\u001b[5~'

const OLD_PROMPT = [
  'You are a careful assistant for a small support desk.',
  '',
  'Tone:',
  '- Be brief and direct.',
  '- Never apologise more than once.',
  '',
  'Process:',
  '1. Read the whole question before answering.',
  '    2. An indented   line   with   inner spacing.',
  '3. Give the answer first, then at most one sentence of reasoning.',
  '',
  'Closing:',
  '- Do not add a sign-off.',
].join('\n')

const NEW_PROMPT = OLD_PROMPT.replace(
  'Tone:',
  'Required reply format (highest priority, applies to every reply, including one-word answers): begin with the prefix.\n\nTone:'
).replace('3. Give the answer first', '3. After the prefix, give the answer first')

const review = (before = OLD_PROMPT, after = NEW_PROMPT): WizardRequestSpec => ({
  name: 'optimize',
  titleParts: ['edit 1 of 2', '20261122-162600-prefix-smoke'],
  question: 'Apply this change to instructions?',
  standing: true,
  steps: [
    {
      key: 'review',
      title: 'Review',
      fields: [
        {
          kind: 'select',
          key: 'verdict',
          multiple: false,
          options: [
            { value: 'accept', label: 'Apply this change' },
            { value: 'reject', label: 'Leave it as it is' },
          ],
        },
        {
          kind: 'diff',
          key: 'change',
          label: 'instructions',
          path: 'agent.ts',
          proposed: after,
          diff: createDiffPreview('agent.ts', before, after),
        },
      ],
    },
  ],
})

const reviewPanel = async (width: number, height: number, spec = review(), active = true) => {
  const broker = new WizardBroker()
  const asked = broker.ask(spec)
  const input = ttyInput()
  const output = ttyOutput(width + 2, height + 2)
  const frame = captureFrame(output)
  const instance = render(createElement(WizardRequestPanel, { broker, width, height, close: vi.fn(), active }), {
    stdin: input,
    stdout: output,
  })
  await instance.waitUntilRenderFlush()
  const press = async (key: string): Promise<void> => {
    input.write(key)
    await instance.waitUntilRenderFlush()
  }
  const lines = (): string[] => frame().map((line) => line.trimEnd())
  return { asked, broker, press, lines, text: (): string => lines().join('\n') }
}

describe('a question that shows a change to read', () => {
  it('shouldShowTheWholeChangeAndBothChoicesWhenThePanelHasTheRoom', async () => {
    const { lines, text } = await reviewPanel(76, 30)

    expect(text()).toContain('  agent.ts · +3 -1 lines')
    expect(lines()).toContain('  + 3. After the prefix, give the answer first, then at most one sentence of')
    expect(lines()).toContain('    - Do not add a sign-off.')
    expect(lines()).toContain('› ○ Apply this change')
    expect(lines()).toContain('  ○ Leave it as it is')
    expect(text()).not.toMatch(/↓ \d+ more/u)
  })

  it.each([
    [76, 10],
    [56, 8],
    [40, 9],
  ])('shouldKeepBothChoicesWholeAndFillTheRestWithTheChangeAt%ix%i', async (width, height) => {
    const { lines, text } = await reviewPanel(width, height)

    expect(lines()).toHaveLength(height)
    expect(lines()).toContain('› ○ Apply this change')
    expect(lines()).toContain('  ○ Leave it as it is')
    expect(lines()).toContain('    @@ -1,5 +1,7 @@')
    expect(text()).toMatch(/↓ \d+ more · PgUp\/PgDn scroll/u)
  })

  it('shouldScrollAChangeLongerThanThePanelWithPageDownAndPageUp', async () => {
    const { press, lines, text } = await reviewPanel(76, 12)
    expect(text()).not.toContain('Closing:')

    await press(PAGE_DOWN)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)

    expect(text()).toContain('    - Do not add a sign-off.')
    expect(text()).toMatch(/↑ \d+ previous · PgUp\/PgDn scroll/u)
    expect(text()).not.toMatch(/↓ \d+ more/u)

    await press(PAGE_UP)
    await press(PAGE_UP)
    await press(PAGE_UP)
    await press(PAGE_UP)

    expect(lines()).toContain('    @@ -1,5 +1,7 @@')
    expect(text()).not.toContain('previous')
  })

  it('shouldLeaveTheChoiceWhereItIsWhileTheChangeScrolls', async () => {
    const { asked, press } = await reviewPanel(76, 12)
    await press(DOWN)

    await press(PAGE_DOWN)
    await press(ENTER)

    await expect(asked).resolves.toEqual({ verdict: 'reject' })
  })

  it('shouldNotScrollWithTheKeysWhileTheChatInputHoldsTheKeyboard', async () => {
    const { press, lines, text } = await reviewPanel(76, 12, review(), false)

    await press(PAGE_DOWN)

    expect(lines()).toContain('    @@ -1,5 +1,7 @@')
    expect(text()).toMatch(/↓ \d+ more$/mu)
    expect(text()).not.toContain('PgUp/PgDn scroll')
  })

  it('shouldKeepTheSpacingInsideALineAndStartEveryLineInTheSameColumn', async () => {
    const { lines } = await reviewPanel(76, 30)

    expect(lines()).toContain('        2. An indented   line   with   inner spacing.')
    expect(lines()).toContain('    Tone:')
    expect(lines()).toContain('  - 3. Give the answer first, then at most one sentence of reasoning.')
  })

  it('shouldWrapALongLineBetweenWordsUnderItsOwnText', async () => {
    const { lines } = await reviewPanel(52, 30)

    expect(lines()).toContain('  + Required reply format (highest priority, applies')
    expect(lines()).toContain('    to every reply, including one-word answers):')
    expect(lines()).toContain('    begin with the prefix.')
  })

  it('shouldShowTheChoicesInFullWhenTheyHaveNoDetailBesideThem', async () => {
    const { lines } = await reviewPanel(30, 12)

    expect(lines()).toContain('› ○ Apply this change')
    expect(lines()).toContain('  ○ Leave it as it is')
  })

  it('shouldNotOfferAutofillForAQuestionThatStandsForTheDeveloper', async () => {
    const { broker, press, text } = await reviewPanel(76, 30)
    expect(text()).not.toContain('autofill')

    await press('\u0001')

    expect(broker.autofill()).toBe(false)
  })

  it('shouldCountTheWrappedLinesOfTheChangeInTheRowsItNeeds', () => {
    const broker = new WizardBroker()
    void broker.ask(review('one\n', 'two\n'))
    const short = wizardRequestRows(broker.pending(), 76)
    const wide = new WizardBroker()
    void wide.ask(review())

    expect(short).toBe(13)
    expect(wizardRequestRows(wide.pending(), 76)).toBe(28)
    expect(wizardRequestRows(wide.pending(), 40)).toBeGreaterThan(28)
  })
})
