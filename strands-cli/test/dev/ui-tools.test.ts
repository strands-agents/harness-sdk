import type { JSONValue } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { DevChatTool } from '../../src/dev/chat-extension.js'
import { uiTools } from '../../src/dev/temporary-evals-fork/ui-tools.js'
import { WizardBroker, type WizardOutcome } from '../../src/ui/panels/wizard-request.js'

const setup = () => {
  const broker = new WizardBroker()
  const tools = uiTools(() => broker)
  const tool = (name: string): DevChatTool => tools.find((candidate) => candidate.name === name)!
  const ask = async (name: string, input: Record<string, JSONValue>, answer: WizardOutcome): Promise<unknown> => {
    const asked = tool(name).run(input)
    await vi.waitFor(() => expect(broker.pending()).toBeDefined())
    const pending = broker.pending()!
    broker.respond(pending.id, answer)
    return { request: pending, reply: JSON.parse(await asked) as unknown }
  }
  return { broker, tools, tool, ask }
}

const OPTIONS = [
  { value: 'mean', label: 'the mean of every evaluator', detail: 'Default' },
  { value: 'other', label: 'something else', input: true },
]

describe('strands dev UI tools', () => {
  it('shouldOfferOneToolPerComponentEachTakingOneQuestion', () => {
    const { tools } = setup()

    expect(tools.map(({ name }) => name)).toEqual([
      'strands_dev_single_select',
      'strands_dev_multi_select',
      'strands_dev_text_input',
      'strands_dev_number_input',
      'strands_dev_confirm',
    ])
    for (const { inputSchema, description } of tools) {
      expect(inputSchema).toMatchObject({ required: expect.arrayContaining(['question']) })
      expect(description).toContain('A cancelled question is a no')
    }
  })

  it('shouldRenderASingleSelectWithAnInlineInputRowAndReturnTheTypedText', async () => {
    const { ask } = setup()

    const { request, reply } = (await ask(
      'strands_dev_single_select',
      { question: 'What should the optimizer improve?', title: 'optimize', options: OPTIONS, selected: 'mean' },
      { answer: 'fewer tokens' }
    )) as { request: { name: string; steps: { fields: unknown[] }[] }; reply: unknown }

    expect(request.name).toBe('optimize')
    expect(request.steps[0]!.fields).toEqual([
      { kind: 'select', key: 'answer', multiple: false, selected: ['mean'], options: OPTIONS },
    ])
    expect(reply).toEqual({ status: 'answered', answer: 'fewer tokens' })
  })

  it('shouldReturnEveryPickOfAMultiSelectTheTextOfATextInputAndABooleanForAConfirm', async () => {
    const { ask } = setup()
    const options = [
      { value: 'instructions', label: 'instructions' },
      { value: 'effort', label: 'effort' },
    ]

    const picks = await ask(
      'strands_dev_multi_select',
      { question: 'What may change?', options, selected: ['instructions'] },
      { answer: ['instructions', 'effort'] }
    )
    const typed = await ask(
      'strands_dev_text_input',
      { question: 'Which path?', value: 'a.json' },
      { answer: 'b.json' }
    )
    const confirmed = await ask('strands_dev_confirm', { question: 'Fix it?' }, { answer: 'no' })

    expect(picks).toMatchObject({ reply: { status: 'answered', answer: ['instructions', 'effort'] } })
    expect(typed).toMatchObject({
      request: { steps: [{ fields: [{ kind: 'text', key: 'answer', value: 'a.json' }] }] },
      reply: { answer: 'b.json' },
    })
    expect(confirmed).toMatchObject({ reply: { status: 'answered', answer: false } })
  })

  it('shouldShowEveryNumberFieldInOneQuestionAndReturnTheValuesByKey', async () => {
    const { ask } = setup()
    const fields = [
      { key: 'iterations', label: 'steps', value: 4, min: 0, detail: 'rounds' },
      { key: 'workers', label: 'parallel', value: 4, min: 1, max: 16 },
    ]

    const { request, reply } = (await ask(
      'strands_dev_number_input',
      { question: 'Budget', fields },
      { iterations: 2, workers: 8 }
    )) as { request: { steps: { fields: unknown[] }[] }; reply: unknown }

    expect(request.steps[0]!.fields).toEqual(fields.map((field) => ({ kind: 'number', ...field })))
    expect(reply).toEqual({ status: 'answered', answer: { iterations: 2, workers: 8 } })
  })

  it.each([
    [undefined, 'cancelled'],
    ['back', 'back'],
  ] as const)('shouldSayWhatTheDeveloperDidWhenTheyLeaveTheQuestionWith%s', async (outcome, status) => {
    const { ask } = setup()

    expect(await ask('strands_dev_confirm', { question: 'Fix it?' }, outcome)).toMatchObject({
      request: { back: true },
      reply: { status },
    })
  })

  it.each<[string, string, Record<string, JSONValue>, string]>([
    ['no question', 'strands_dev_confirm', {}, 'question must be text.'],
    ['no options', 'strands_dev_single_select', { question: 'q' }, 'options must list at least one option.'],
    [
      'a repeated value',
      'strands_dev_single_select',
      {
        question: 'q',
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'again' },
        ],
      },
      'options must not repeat a value.',
    ],
    [
      'an unknown pick',
      'strands_dev_multi_select',
      { question: 'q', options: [{ value: 'a', label: 'A' }], selected: ['b'] },
      'selected names no such option: b.',
    ],
    [
      'a picked input row',
      'strands_dev_single_select',
      { question: 'q', options: OPTIONS, selected: 'other' },
      'cannot name an input row: other starts empty.',
    ],
    [
      'an input row in a multi select',
      'strands_dev_multi_select',
      { question: 'q', options: OPTIONS },
      'input works only in strands_dev_single_select.',
    ],
    ['no number fields', 'strands_dev_number_input', { question: 'q', fields: [] }, 'fields must list at least one'],
    [
      'a fraction',
      'strands_dev_number_input',
      { question: 'q', fields: [{ key: 's', label: 's', value: 1.5 }] },
      'whole number of 0 or more',
    ],
    [
      'a min above the max',
      'strands_dev_number_input',
      { question: 'q', fields: [{ key: 's', label: 's', min: 3, max: 1 }] },
      'min must not be above its max.',
    ],
    [
      'a value below its min',
      'strands_dev_number_input',
      { question: 'q', fields: [{ key: 's', label: 'steps', value: 0, min: 1 }] },
      'value does not fit: steps must be at least 1.',
    ],
    [
      'a repeated key',
      'strands_dev_number_input',
      {
        question: 'q',
        fields: [
          { key: 's', label: 's' },
          { key: 's', label: 't' },
        ],
      },
      'fields must not repeat a key.',
    ],
  ])('shouldRefuseAQuestionWith%sWithoutAsking', async (_case, name, input, message) => {
    const { tool, broker } = setup()

    await expect(tool(name).run(input)).rejects.toThrow(message)
    expect(broker.pending()).toBeUndefined()
  })
})
