import { createElement, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { createDiffPreview } from '../../src/agent/file-changes.js'
import type { ChatBackend } from '../../src/agent/types.js'
import type { DevChatCommand } from '../../src/ui/chat/controller.js'
import { WizardRequestPanel } from '../../src/ui/panels/wizard-request-panel.js'
import {
  defaultAnswers,
  WizardBroker,
  wizardRequestHasDiff,
  wizardRequestRows,
  type WizardFieldSpec,
  type WizardRequestSpec,
} from '../../src/ui/panels/wizard-request.js'
import { mountChat } from '../fixtures/chat-app.js'
import { idleBackend } from '../fixtures/chat-backend.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const ENTER = '\r'
const UP = '\u001b[A'
const DOWN = '\u001b[B'
const ESCAPE = '\u001b'
const BACKSPACE = '\u007f'
const CTRL_A = '\u0001'

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

const panel = async (broker: WizardBroker, rows = 20, options: { active?: boolean; blur?: () => void } = {}) =>
  show(createElement(WizardRequestPanel, { broker, width: 96, height: rows - 2, close: vi.fn(), ...options }), rows)

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

  it('shouldDropTheTurnsQuestionAndKeepAStandingOneWhenAMessageIsSent', async () => {
    const broker = new WizardBroker()
    const review = vi.fn()
    void broker.ask({ ...question([tune], 'review'), standing: true }).then(review)
    const asked = broker.ask(question([tune], 'setup'))
    expect(broker.pending()?.name).toBe('setup')

    expect(broker.dropForTurn()).toBe(true)

    await expect(asked).resolves.toBeUndefined()
    expect(broker.pending()?.name).toBe('review')
    expect(broker.dropForTurn()).toBe(false)
    expect(review).not.toHaveBeenCalled()
  })

  it('shouldBringTheQuestionAboutATopicForwardAndWithdrawIt', async () => {
    const broker = new WizardBroker()
    const open = vi.fn(() => true)
    broker.attachOpener(open)
    const first = broker.ask({ ...question([tune], 'first'), standing: true, topic: 'run-1' })
    void broker.ask({ ...question([tune], 'second'), standing: true, topic: 'run-2' })
    open.mockClear()

    expect(broker.bringForward('run-2')).toBe(true)
    expect(broker.pending()?.name).toBe('second')
    expect(broker.bringForward('run-9')).toBe(false)
    broker.withdraw('run-1')

    await expect(first).resolves.toBeUndefined()
    expect(broker.pending()?.name).toBe('second')
    expect(open).toHaveBeenCalledOnce()
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

  it('shouldKeepAQuestionOnScreenAndOfferNoAutofillWhenTheUserPressesCtrlA', async () => {
    const broker = new WizardBroker()
    void broker.ask(question([tune]))
    const { text, press } = await panel(broker)

    expect(text()).not.toContain('autofill')
    await press(CTRL_A)

    expect(broker.pending()?.name).toBe('optimize')
    expect(text()).toContain('instructions')
  })

  it('shouldTakeWhatIsTypedOnATextRowAsTheStartOfItsAnswer', async () => {
    const broker = new WizardBroker()
    const asked = broker.ask(question([{ kind: 'text', key: 'notes', label: 'notes' }]))
    const { text, press } = await panel(broker)

    await press(...'1 step')
    expect(text()).toContain('1 step▌')
    await press(ENTER, DOWN, ENTER)

    await expect(asked).resolves.toEqual({ notes: '1 step' })
  })

  it('shouldStayIdleWithoutACursorWhileTheChatInputHoldsTheKeyboard', async () => {
    const broker = new WizardBroker()
    void broker.ask(question([tune]))
    const { text, press } = await panel(broker, 20, { active: false })

    await press(ENTER, ESCAPE)

    expect(broker.pending()).toBeDefined()
    expect(text()).toContain('↑ answer this')
    expect(text()).not.toContain('›')
  })

  it('shouldCarryOnIntoTheChatWhenDownPassesTheButtons', async () => {
    const broker = new WizardBroker()
    const blur = vi.fn()
    void broker.ask(question([tune]))
    const { text, press } = await panel(broker, 20, { blur })

    expect(text()).toContain('↓ chat')
    await press(DOWN, DOWN, DOWN)
    expect(blur).not.toHaveBeenCalled()
    await press(DOWN)

    expect(blur).toHaveBeenCalledOnce()
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
  finishLabel: '[ OK ]',
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
          diff: createDiffPreview('agent.ts', before, after),
        },
      ],
    },
  ],
})

const reviewPanel = async (width: number, height: number, active = true) => {
  const broker = new WizardBroker()
  const asked = broker.ask(review())
  const { text, press } = await show(
    createElement(WizardRequestPanel, { broker, width, height, close: vi.fn(), active }),
    height + 2
  )
  const lines = (): string[] =>
    text()
      .split('\n')
      .map((line) => line.trimEnd())
  return { asked, broker, press, lines, text }
}

describe('a question that shows a change to read', () => {
  it('shouldShowTheWholeChangeAboveBothChoicesAndTheButtonsWhenThePanelHasTheRoom', async () => {
    const { lines, text } = await reviewPanel(76, 34)

    expect(text()).toContain('  agent.ts · +3 -1 lines')
    expect(lines()).toContain('  + 3. After the prefix, give the answer first, then at most one sentence of')
    expect(lines()).toContain('    - Do not add a sign-off.')
    expect(text()).toContain('○ Apply this change')
    expect(text()).toContain('○ Leave it as it is')
    expect(text()).toContain('[ OK ]')
    expect(text()).not.toMatch(/↓ \d+ more/u)
    expect(text().indexOf('agent.ts ·')).toBeLessThan(text().indexOf('○ Apply this change'))
  })

  it.each([
    [76, 12],
    [56, 11],
  ])('shouldKeepTheChoicesAndScrollTheChangeAt%ix%i', async (width, height) => {
    const { text } = await reviewPanel(width, height)

    expect(text()).toContain('○ Apply this change')
    expect(text()).toContain('○ Leave it as it is')
    expect(text()).toContain('@@ -1,5 +1,7 @@')
    expect(text()).toMatch(/↓ \d+ more · PgUp\/PgDn scroll/u)
  })

  it('shouldScrollWithPageDownAndPageUpAndLeaveTheChoiceWhereItIs', async () => {
    const { asked, press, text } = await reviewPanel(76, 14)
    expect(text()).not.toContain('Closing:')

    await press(DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN, PAGE_DOWN)
    expect(text()).toContain('- Do not add a sign-off.')
    expect(text()).toMatch(/↑ \d+ previous · PgUp\/PgDn scroll/u)
    await press(PAGE_UP, PAGE_UP, PAGE_UP, PAGE_UP)
    expect(text()).not.toContain('previous')
    await press(ENTER, DOWN, ENTER)

    await expect(asked).resolves.toEqual({ verdict: 'reject' })
  })

  it('shouldNotScrollWithTheKeysWhileTheChatInputHoldsTheKeyboard', async () => {
    const { press, text } = await reviewPanel(76, 14, false)

    await press(PAGE_DOWN)

    expect(text()).toContain('@@ -1,5 +1,7 @@')
    expect(text()).not.toContain('PgUp/PgDn scroll')
  })

  it('shouldKeepTheSpacingInsideALineAndWrapALongLineBetweenWords', async () => {
    const wide = await reviewPanel(76, 34)
    expect(wide.lines()).toContain('        2. An indented   line   with   inner spacing.')
    const narrow = await reviewPanel(52, 34)

    expect(narrow.lines()).toContain('  + Required reply format (highest priority, applies')
    expect(narrow.lines()).toContain('    to every reply, including one-word answers):')
  })

  it('shouldCloseAStandingQuestionOnEscWithoutAnswer', async () => {
    const { asked, press, text } = await reviewPanel(76, 34)

    expect(text()).toContain('Esc close')
    await press(ESCAPE)

    await expect(asked).resolves.toBeUndefined()
  })

  it('shouldCountTheWrappedLinesOfTheChangeInTheRowsItNeeds', () => {
    const short = new WizardBroker()
    void short.ask(review('one\n', 'two\n'))
    const wide = new WizardBroker()
    void wide.ask(review())

    const rows = wizardRequestRows(wide.pending(), 76)!
    expect(wizardRequestRows(short.pending(), 76)).toBeLessThan(rows)
    expect(wizardRequestRows(wide.pending(), 40)).toBeGreaterThan(rows)
  })
})

const pickOne = (key: string, labels: readonly string[]): WizardFieldSpec => ({
  kind: 'select',
  key,
  multiple: false,
  options: labels.map((label) => ({ value: label, label, detail: '5 cases' })),
})

const walked = (...steps: (readonly WizardFieldSpec[])[]): WizardRequestSpec => ({
  ...question([]),
  steps: steps.map((fields, index) => ({ key: `step${index}`, title: `step${index}`, fields })),
})

describe('wizardRequestRows', () => {
  it('shouldCountTheQuestionItsOptionsAndOnePaddingRow', () => {
    expect(wizardRequestRows(undefined)).toBeUndefined()
    expect(wizardRequestRows({ ...question([pickOne('mode', ['a', 'b'])]), id: 'r1' })).toBe(8)
  })

  it('shouldGrowWithTheOptionCount', () => {
    expect(wizardRequestRows({ ...question([pickOne('mode', ['a', 'b', 'c', 'd', 'e'])]), id: 'r2' })).toBe(11)
  })

  it('shouldSizeAWalkedFormToItsTallestStepPlusItsStepBar', () => {
    const request = walked([pickOne('mode', ['a', 'b'])], [pickOne('more', ['a', 'b', 'c', 'd'])])

    expect(wizardRequestRows({ ...request, id: 'r4' })).toBe(8 + 2 + 2)
  })
})

describe('wizardRequestHasDiff', () => {
  it('shouldBeFalseForAQuestionWithNoDiff', () => {
    expect(wizardRequestHasDiff({ ...question([tune]), id: 'r1' })).toBe(false)
    expect(wizardRequestHasDiff(undefined)).toBe(false)
  })

  it('shouldBeTrueOnlyWhenAFieldIsADiff', () => {
    expect(wizardRequestHasDiff({ ...review(), id: 'r2' })).toBe(true)
  })
})

// The command as the dev chat registers it: the panel in the chat, sized and docked by the question it shows.
const askCommand = (broker: WizardBroker): DevChatCommand => ({
  spec: { name: 'ask', usage: '/ask', description: 'Ask' },
  sticky: true,
  dock: () => wizardRequestHasDiff(broker.pending()),
  wideDock: () => wizardRequestHasDiff(broker.pending()),
  dropPending: () => broker.dropForTurn(),
  contentRows: (width) => wizardRequestRows(broker.pending(), width),
  attach: (context) => broker.attachOpener(() => context.openPanel('ask')),
  open: () => (props) => createElement(WizardRequestPanel, { ...props, broker }),
})

describe('the panel around one question', () => {
  const ask = async (spec: WizardRequestSpec, rows: number) => {
    const broker = new WizardBroker()
    void broker.ask(spec)
    const view = await mountChat({ devCommands: [askCommand(broker)], columns: 110, rows })
    await view.press('/ask')
    await view.press(ENTER)
    return view
  }

  it('shouldFitTheQuestionRatherThanHalfTheScreen', async () => {
    const { row } = await ask(question([pickOne('mode', ['Step by step', 'Describe it'])]), 30)

    expect(row('╭')).toBeGreaterThanOrEqual(0)
    expect(row('╰') - row('╭')).toBeLessThanOrEqual(9)
  })

  it.each([
    ['one step', 1],
    ['a walked form', 2],
  ])('shouldShowEveryOptionOfALongListIn%s', async (_name, stepCount) => {
    const labels = Array.from({ length: 10 }, (_, index) => `experiment-${index + 1}`)
    const steps = Array.from({ length: stepCount }, (_, index) => [pickOne(`step${index}`, labels)])
    const { screen } = await ask(walked(...steps), 50)

    for (const label of labels) expect(screen()).toContain(label)
    expect(screen()).not.toMatch(/↓ \d+ more/u)
  })
})

describe('a real ask call with its question on screen', () => {
  const asked: WizardRequestSpec = {
    ...question([{ kind: 'text', key: 'request', label: 'request' }]),
    question: 'Describe the optimization you want, or answer "step by step".',
  }
  const call = (toolUseId: string, name: string, input = {}): never =>
    ({ type: 'toolStart', toolUseId, name, input }) as never
  const result = (toolUseId: string, text: string): never =>
    ({ type: 'toolResult', toolUseId, status: 'success', content: [{ type: 'text', text }] }) as never

  // Streams the question call and holds the turn open on it, the way the real tool does.
  const askingBackend = (broker: WizardBroker, answered: Promise<unknown>): ChatBackend =>
    idleBackend({
      async *stream() {
        // Two finished calls first, so the pending ask lands inside a tool group, not alone.
        yield call('use-a', 'strands_dev_status')
        yield result('use-a', '{}')
        yield call('use-b', 'strands_dev_status')
        yield result('use-b', '{}')
        yield call('use-1', 'strands_dev_confirm', { question: asked.question })
        void broker.ask(asked)
        await answered
        yield result('use-1', '{"status":"answered"}')
        return { stopReason: 'endTurn' }
      },
    })

  const openQuestion = async () => {
    const broker = new WizardBroker()
    let resolve = (): void => {}
    const answered = new Promise<void>((done) => {
      resolve = done
    })
    const view = await mountChat({
      devCommands: [askCommand(broker)],
      rows: 30,
      backend: askingBackend(broker, answered),
    })
    for (const character of 'optimize') await view.press(character)
    await view.press(ENTER)
    await new Promise((done) => setTimeout(done, 50))
    return { ...view, resolve }
  }

  it('shouldShowTheCursorOnlyOnceFocusMovesIntoTheQuestion', async () => {
    const { press, screen, resolve } = await openQuestion()

    expect(screen()).not.toContain('›')
    expect(screen()).toContain('↑ answer this')

    await press(UP)

    expect(screen()).toContain('›')
    expect(screen()).not.toContain('↑ answer this')
    resolve()
  })

  it('shouldShowOnlyTheQuestion', async () => {
    const { screen, resolve } = await openQuestion()
    const shown = screen()

    expect(shown).toContain('Describe the optimization you want')
    expect(shown).not.toContain('Ask ×')
    expect(shown).not.toContain('3 tool calls')
    expect(shown).not.toContain('Waiting for your answer')
    expect(shown).not.toContain('Viewing /ask')
    expect(shown).toContain('Enter to send')
    expect(shown).toContain('↑ answer this')
    expect(shown).not.toContain('›')
    resolve()
  })
})

describe('a finished run’s review in the chat', () => {
  const WHEEL_DOWN = 65
  const RULES = Array.from({ length: 24 }, (_, index) => `Rule ${index + 1}: keep the answer short.`).join('\n')
  const CHANGED = RULES.replace('Rule 2:', 'Rule 2 (first):').replace('Rule 23:', 'Rule 23 (last):')

  const mount = async (columns: number, rows: number) => {
    const broker = new WizardBroker()
    const view = await mountChat({ devCommands: [askCommand(broker)], columns, rows })
    void broker.ask(review(RULES, CHANGED))
    await view.instance.waitUntilRenderFlush()
    return view
  }

  it.each([
    [80, 24, '+ Rule 2 (first): keep the answer short.'],
    [89, 30, '+ Rule 2 (first): keep the answer short.'],
    [60, 20, '@@ -1,5 +1,5 @@'],
  ])('shouldShowTheChangeAndBothChoicesAboveTheInputAt%ix%i', async (columns, rows, line) => {
    const { lines, screen, row } = await mount(columns, rows)

    expect(screen()).toContain('agent.ts · +2 -2 lines')
    expect(screen()).toContain('@@ -1,5 +1,5 @@')
    expect(screen()).toContain(line)
    expect(screen()).toContain('○ Apply this change')
    expect(screen()).toContain('○ Leave it as it is')
    expect(screen()).toMatch(/↓ \d+ more/u)
    expect(row('○ Leave it as it is')).toBeLessThan(row('Enter to send'))
    expect(lines().length).toBeLessThanOrEqual(rows)
  })

  it('shouldScrollTheChangeWithPageDownOnceTheQuestionHoldsTheKeyboard', async () => {
    const { press, screen } = await mount(80, 24)
    expect(screen()).not.toContain('Rule 23 (last)')

    await press(UP)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)
    await press(PAGE_DOWN)

    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(screen()).toContain('› ○ Apply this change')
  })

  it('shouldScrollTheChangeWithTheWheelWhileTheChatHoldsTheKeyboard', async () => {
    const { press, row, screen } = await mount(80, 24)
    const over = row('- Rule 2: keep the answer short.')
    expect(over).toBeGreaterThan(0)

    for (let turn = 0; turn < 8; turn++) await press(mouseInputSequence(WHEEL_DOWN, 10, over, 'M'))

    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(screen()).toContain('↑ answer this')
  })

  it('shouldShowTheChangeBesideTheChatOnAWideTerminal', async () => {
    const { lines, row, screen } = await mount(120, 40)

    expect(screen()).toContain('+ Rule 2 (first): keep the answer short.')
    expect(screen()).toContain('+ Rule 23 (last): keep the answer short.')
    expect(lines()[row('○ Apply this change')]!.indexOf('○')).toBeGreaterThan(40)
    expect(screen()).not.toMatch(/↓ \d+ more/u)
  })
})
