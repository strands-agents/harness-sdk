import { describe, expect, it, vi } from 'vitest'

import { askRequestFrom, askTool } from '../../src/dev/temporary-evals-fork/ask-tool.js'
import { WizardBroker } from '../../src/ui/panels/wizard-request.js'

const knobStep = {
  key: 'tune',
  title: 'Tune',
  listLabel: 'knobs',
  fields: [
    { kind: 'toggle', key: 'instructions', label: 'instructions', detail: 'the system prompt', checked: true },
    { kind: 'toggle', key: 'tools', label: 'tools', unavailable: 'cannot tune tools yet' },
  ],
}

const budgetStep = {
  key: 'budget',
  title: 'Budget',
  fields: [{ kind: 'choice', key: 'iterations', label: 'budget', options: ['4', '8'], value: '8' }],
}

describe('askRequestFrom', () => {
  it('shouldBuildTheRequestFromTheDeclaredSteps', () => {
    const request = askRequestFrom({
      title: 'optimize',
      subtitle: ['refunds', '20 cases'],
      status: '~57 rollouts',
      footer: '~25M tokens',
      steps: [knobStep, budgetStep],
    })

    expect(request.name).toBe('optimize')
    expect(request.titleParts).toEqual(['refunds', '20 cases'])
    expect(request.status).toBe('~57 rollouts')
    expect(request.steps).toHaveLength(2)
    expect(request.steps[0]?.listLabel).toBe('knobs')
  })

  it('shouldDefaultTheTitleWhenTheCallerOmitsIt', () => {
    expect(askRequestFrom({ steps: [budgetStep] }).name).toBe('setup')
  })

  it.each([
    [{ steps: [] }, 'Send ask with a question for one question, or steps for a walked form.'],
    [{ steps: [{ ...knobStep, fields: [] }] }, 'At least one step must have a field'],
    [
      { steps: [knobStep, { ...budgetStep, fields: knobStep.fields }] },
      'The key instructions is used twice. Every step key and field key must be unique.',
    ],
    [
      { steps: [{ key: 'a', title: 'A', fields: [{ kind: 'slider', key: 'x', label: 'x' }] }] },
      'kind must be one of choice, toggle, text.',
    ],
    [
      { steps: [{ key: 'a', title: 'A', fields: [{ kind: 'choice', key: 'x', label: 'x', options: [] }] }] },
      'options must list at least one choice.',
    ],
  ])('shouldRefuseABadRequest', (input, message) => {
    expect(() => askRequestFrom(input as never)).toThrow(message)
  })

  it('shouldRefuseTwoStepsThatShareAKey', () => {
    const steps = [budgetStep, { ...budgetStep, fields: [] }]

    expect(() => askRequestFrom({ steps } as never)).toThrow('The key budget is used twice')
  })

  it('shouldRefuseAChoiceThatRepeatsAnOption', () => {
    const steps = [{ key: 'a', title: 'A', fields: [{ kind: 'choice', key: 'x', label: 'x', options: ['f', 'f'] }] }]

    expect(() => askRequestFrom({ steps } as never)).toThrow('options must not repeat a choice.')
  })

  it('shouldRefuseAToggleThatIsCheckedAndUnavailableAtOnce', () => {
    const steps = [
      { key: 'a', title: 'A', fields: [{ kind: 'toggle', key: 'x', label: 'x', checked: true, unavailable: 'no' }] },
    ]

    expect(() => askRequestFrom({ steps } as never)).toThrow('cannot be checked and unavailable at once.')
  })

  it('shouldRefuseAnErrorNoticeBecauseItCouldNeverBeCleared', () => {
    const steps = [{ ...budgetStep, notice: { tone: 'error', text: 'pick one' } }]

    expect(() => askRequestFrom({ steps } as never)).toThrow('tone must be one of success, warning, muted.')
  })

  it.each(['value', 'placeholder'])('shouldTreatAnEmpty%sAsAbsentRatherThanAnError', (field) => {
    const steps = [{ key: 'a', title: 'A', fields: [{ kind: 'text', key: 'notes', label: 'notes', [field]: '' }] }]

    expect(() => askRequestFrom({ steps } as never)).not.toThrow()
  })

  it('shouldTreatAnEmptyStatusAsAbsentRatherThanAnError', () => {
    expect(askRequestFrom({ steps: [budgetStep], status: '' }).status).toBeUndefined()
  })

  it('shouldRefuseAChoiceWhoseValueIsNotOneOfItsOptions', () => {
    const steps = [
      { key: 'a', title: 'A', fields: [{ kind: 'choice', key: 'x', label: 'x', options: ['1'], value: '9' }] },
    ]

    expect(() => askRequestFrom({ steps } as never)).toThrow('must be one of its own options')
  })

  it('shouldRefuseANoticeWithAnUnknownTone', () => {
    const steps = [{ ...budgetStep, notice: { tone: 'loud', text: 'hm' } }]

    expect(() => askRequestFrom({ steps } as never)).toThrow('tone must be one of')
  })
})

describe('one question', () => {
  const knobs = {
    ask: 'selectMany',
    key: 'tune',
    question: 'What should the run tune?',
    listLabel: 'knobs',
    options: [
      { value: 'instructions', label: 'instructions', detail: 'the system prompt' },
      { value: 'tools', label: 'tools', unavailable: 'cannot tune tools yet' },
    ],
    selected: ['instructions'],
  }

  it('shouldBuildOneStepWithNoTabsFromASelectMany', () => {
    const request = askRequestFrom(knobs)

    expect(request.steps).toHaveLength(1)
    expect(request.question).toBe('What should the run tune?')
    expect(request.finishLabel).toBe('[ OK ]')
    expect(request.steps[0]?.fields[0]).toMatchObject({ kind: 'select', key: 'tune', selected: ['instructions'] })
  })

  it('shouldMakeASelectOnePickOnlyOne', () => {
    const field = askRequestFrom({
      ask: 'selectOne',
      key: 'iterations',
      question: 'How many steps?',
      options: [
        { value: '4', label: '4' },
        { value: '8', label: '8' },
      ],
    }).steps[0]?.fields[0]

    expect(field).toMatchObject({ kind: 'select', multiple: false })
  })

  it('shouldRefuseASelectOneWithNothingToChoose', () => {
    expect(() =>
      askRequestFrom({ ask: 'selectOne', question: 'which?', options: [{ value: 'a', label: 'A' }] })
    ).toThrow('selectOne needs at least two options')
  })

  it('shouldAllowASelectManyWithOneOption', () => {
    const field = askRequestFrom({
      ask: 'selectMany',
      question: 'tune?',
      options: [{ value: 'a', label: 'A' }],
    }).steps[0]?.fields[0]

    expect(field).toMatchObject({ kind: 'select', multiple: true })
  })

  it('shouldTurnAConfirmIntoAYesOrNoPick', () => {
    const field = askRequestFrom({ ask: 'confirm', question: 'Start the run?' }).steps[0]?.fields[0]

    expect(field).toMatchObject({ kind: 'select', multiple: false, selected: ['yes'] })
  })

  it('shouldAskForTextWithItsPlaceholder', () => {
    const field = askRequestFrom({
      ask: 'text',
      key: 'objective',
      question: 'What should it optimize?',
      placeholder: 'Minimize(tokens)',
    }).steps[0]?.fields[0]

    expect(field).toMatchObject({ kind: 'text', key: 'objective', placeholder: 'Minimize(tokens)' })
  })

  it.each([
    [{ ask: 'slider', question: 'how much?' }, 'ask must be one of selectMany, selectOne, text, confirm.'],
    [{ ask: 'selectMany', question: 'pick' }, 'options must list at least one option.'],
    [
      { ask: 'selectMany', question: 'pick', options: [{ value: 'a', label: 'A' }], selected: ['b'] },
      'selected names no such option: b.',
    ],
    [
      {
        ask: 'selectOne',
        question: 'pick',
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'again' },
        ],
      },
      'must not repeat a value.',
    ],
    [{ ask: 'selectMany', question: 'pick', steps: [] }, 'not both.'],
    [{ question: 'pick' }, 'Send ask with a question for one question'],
  ])('shouldRefuseABadQuestion', (input, message) => {
    expect(() => askRequestFrom(input as never)).toThrow(message)
  })

  it('shouldReturnTheAnswerUnwrappedUnderItsOwnKey', async () => {
    const broker = new WizardBroker()
    const answered = askTool(() => broker).run(knobs)

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, { tune: ['instructions', 'caching'] })

    expect(JSON.parse(await answered)).toEqual({ status: 'answered', answer: ['instructions', 'caching'] })
  })

  it('shouldReturnABooleanForAConfirm', async () => {
    const broker = new WizardBroker()
    const answered = askTool(() => broker).run({ ask: 'confirm', question: 'Start?' })

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, { answer: 'no' })

    expect(JSON.parse(await answered)).toEqual({ status: 'answered', answer: false })
  })

  it('shouldAnswerASelectOneWithOneOptionWithoutShowingIt', async () => {
    const broker = new WizardBroker()
    const answered = await askTool(() => broker).run({
      ask: 'selectOne',
      question: 'Which case?',
      options: [{ value: 'refunds', label: 'refunds' }],
    })

    expect(broker.pending()).toBeUndefined()
    expect(JSON.parse(answered).answer).toBe('refunds')
  })

  it('shouldShowASelectOneWhoseOnlyOptionCannotBePicked', async () => {
    const broker = new WizardBroker()
    const answered = askTool(() => broker).run({
      ask: 'selectOne',
      question: 'Which case?',
      options: [{ value: 'refunds', label: 'refunds', unavailable: 'no rollouts left' }],
    })

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, undefined)

    expect(JSON.parse(await answered).status).toBe('cancelled')
  })

  it('shouldStillShowASelectManyWithOneOption', async () => {
    const broker = new WizardBroker()
    const answered = askTool(() => broker).run({
      ask: 'selectMany',
      question: 'Which knobs?',
      options: [{ value: 'instructions', label: 'instructions' }],
    })

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, { answer: [] })

    expect(JSON.parse(await answered)).toEqual({ status: 'answered', answer: [] })
  })
})

describe('askTool', () => {
  it('shouldReturnTheAnswersWhenTheFormIsFinished', async () => {
    const broker = new WizardBroker()
    const tool = askTool(() => broker)
    const answered = tool.run({ steps: [knobStep, budgetStep] })

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, { instructions: true, iterations: '8' })

    expect(JSON.parse(await answered)).toEqual({
      status: 'answered',
      answers: { instructions: true, iterations: '8' },
    })
  })

  it('shouldSayCancelledWhenTheDeveloperDeclines', async () => {
    const broker = new WizardBroker()
    const tool = askTool(() => broker)
    const answered = tool.run({ steps: [budgetStep] })

    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    broker.respond(broker.pending()!.id, undefined)

    expect(JSON.parse(await answered).status).toBe('cancelled')
  })

  it('shouldOpenThePanelWhenItAsks', async () => {
    const broker = new WizardBroker()
    const open = vi.fn(() => true)
    broker.attachOpener(open)
    const tool = askTool(() => broker)
    const answered = tool.run({ steps: [budgetStep] })

    await vi.waitFor(() => expect(open).toHaveBeenCalled())
    broker.respond(broker.pending()!.id, {})
    await answered
  })

  it('shouldFailWithoutAskingWhenTheStepsAreBad', async () => {
    const broker = new WizardBroker()

    await expect(askTool(() => broker).run({ steps: [] })).rejects.toThrow('Send ask with a question')
    expect(broker.pending()).toBeUndefined()
  })
})
