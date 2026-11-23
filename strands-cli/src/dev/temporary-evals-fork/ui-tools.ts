import type { JSONSchema, JSONValue } from '@strands-agents/sdk'

import {
  numberProblem,
  type WizardFieldSpec,
  type WizardNumberSpec,
  type WizardOption,
  type WizardOutcome,
  type WizardRequestSpec,
} from '../../ui/panels/wizard-request.js'
import type { DevChatTool } from '../chat-extension.js'

type Input = Readonly<Record<string, JSONValue>>

export interface UiToolsBroker {
  ask(spec: WizardRequestSpec): Promise<WizardOutcome>
}

const ANSWER = 'answer'
const MAX_FIELDS = 24
const CONFIRM_OPTIONS: readonly WizardOption[] = [
  { value: 'yes', label: 'yes' },
  { value: 'no', label: 'no' },
]

const isObject = (value: JSONValue | undefined): value is { [key: string]: JSONValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringAt = (value: JSONValue | undefined, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be text.`)
  return value.trim()
}

const optionalString = (value: JSONValue | undefined, what: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${what} must be text.`)
  return value.trim() || undefined
}

const optionalWhole = (value: JSONValue | undefined, what: string): number | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error(`${what} must be a whole number of 0 or more.`)
  return value
}

const optionAt = (value: JSONValue, what: string, typed: boolean): WizardOption => {
  if (!isObject(value)) throw new Error(`${what} must be an object with value and label.`)
  const detail = optionalString(value.detail, `${what}.detail`)
  const unavailable = optionalString(value.unavailable, `${what}.unavailable`)
  if (value.input !== undefined && value.input !== null && typeof value.input !== 'boolean')
    throw new Error(`${what}.input must be true or false.`)
  const input = value.input === true
  if (input && !typed) throw new Error(`${what}.input works only in strands_dev_single_select.`)
  return {
    value: stringAt(value.value, `${what}.value`),
    label: stringAt(value.label, `${what}.label`),
    ...(detail === undefined ? {} : { detail }),
    ...(unavailable === undefined ? {} : { unavailable }),
    ...(input ? { input } : {}),
  }
}

const optionsAt = (value: JSONValue | undefined, typed: boolean): readonly WizardOption[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('options must list at least one option.')
  const options = value.map((option, index) => optionAt(option, `options[${index}]`, typed))
  const values = options.map(({ value: name }) => name)
  if (new Set(values).size !== values.length) throw new Error('options must not repeat a value.')
  return options
}

const selectedAt = (value: JSONValue | undefined, options: readonly WizardOption[]): string[] => {
  if (value === undefined || value === null) return []
  const picked = (Array.isArray(value) ? value : [value]).map((item, index) => stringAt(item, `selected[${index}]`))
  const unknown = picked.filter((item) => !options.some(({ value: name }) => name === item))
  if (unknown.length > 0) throw new Error(`selected names no such option: ${unknown.join(', ')}.`)
  const typed = options.find(({ value: name, input }) => input && picked.includes(name))
  if (typed) throw new Error(`selected cannot name an input row: ${typed.value} starts empty.`)
  return picked
}

const selectField = (input: Input, multiple: boolean): WizardFieldSpec => {
  const options = optionsAt(input.options, !multiple)
  // A single select is numbered like the skill's list and starts with nothing picked.
  if (!multiple) {
    if (input.selected !== undefined && input.selected !== null)
      throw new Error('A single select starts with nothing picked; leave out selected and keep (Default) in its label.')
    return {
      kind: 'select',
      key: ANSWER,
      options: options.map((option, index) => ({ ...option, label: `${index + 1}. ${option.label}` })),
      multiple,
    }
  }
  const selected = selectedAt(input.selected, options)
  return { kind: 'select', key: ANSWER, options, multiple, ...(selected.length === 0 ? {} : { selected }) }
}

const numberAt = (value: JSONValue, what: string): WizardNumberSpec => {
  if (!isObject(value)) throw new Error(`${what} must be an object with key, label, and value.`)
  const current = optionalWhole(value.value, `${what}.value`)
  const min = optionalWhole(value.min, `${what}.min`)
  const max = optionalWhole(value.max, `${what}.max`)
  const detail = optionalString(value.detail, `${what}.detail`)
  const field: WizardNumberSpec = {
    kind: 'number',
    key: stringAt(value.key, `${what}.key`),
    label: stringAt(value.label, `${what}.label`),
    ...(current === undefined ? {} : { value: current }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(detail === undefined ? {} : { detail }),
  }
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${what}.min must not be above its max.`)
  const problem = current === undefined ? undefined : numberProblem(field, current)
  if (problem) throw new Error(`${what}.value does not fit: ${problem}`)
  return field
}

const numberFields = (value: JSONValue | undefined): WizardNumberSpec[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error('fields must list at least one field.')
  if (value.length > MAX_FIELDS) throw new Error(`fields can hold at most ${MAX_FIELDS} fields.`)
  const fields = value.map((field, index) => numberAt(field, `fields[${index}]`))
  const keys = fields.map(({ key }) => key)
  if (new Set(keys).size !== keys.length) throw new Error('fields must not repeat a key.')
  return fields
}

/** One question, one component: the request the panel renders. */
const uiRequest = (input: Input, fields: readonly WizardFieldSpec[]): WizardRequestSpec => ({
  name: optionalString(input.title, 'title') ?? 'question',
  question: stringAt(input.question, 'question'),
  steps: [{ key: 'question', title: 'Question', fields }],
  finishLabel: '[ OK ]',
  back: true,
})

const reply = (value: unknown): string => JSON.stringify(value, null, 2)

const CANCELLED = reply({
  status: 'cancelled',
  detail: 'The developer closed the question without answering. Treat this as a no.',
})

const BACK = reply({
  status: 'back',
  detail:
    'The developer went back. Ask the previous question again with their earlier answer selected; at the first question, stop.',
})

const COMMON: Record<string, JSONSchema> = {
  question: { type: 'string', description: 'What you are asking, in one plain line.' },
  title: { type: 'string', description: 'The name on the top line, such as optimize. Default: question.' },
}

const OPTION: JSONSchema = {
  type: 'object',
  properties: {
    value: { type: 'string', description: 'What the answer holds when this row is picked.' },
    label: { type: 'string', description: 'The row as the developer reads it.' },
    detail: { type: 'string', description: 'The facts beside the label that decide the pick, such as the default.' },
    unavailable: { type: 'string', description: 'Why this row cannot be picked; it shows and refuses the pick.' },
  },
  required: ['value', 'label'],
  additionalProperties: false,
}

const TYPED_OPTION: JSONSchema = {
  ...OPTION,
  properties: {
    ...(OPTION.properties as Record<string, JSONSchema>),
    input: {
      type: 'boolean',
      description:
        'Makes the row a text field, such as a last "something else" or "Your own" row: the developer types in ' +
        'it, and the answer is the typed text instead of the value. It starts empty and cannot be selected.',
    },
  },
}

interface UiTool {
  readonly name: string
  readonly description: string
  readonly properties: Record<string, JSONSchema>
  readonly required: readonly string[]
  readonly fields: (input: Input) => readonly WizardFieldSpec[]
  readonly answer: (outcome: Exclude<WizardOutcome, 'back' | undefined>) => JSONValue
}

const UI_TOOLS: readonly UiTool[] = [
  {
    name: 'strands_dev_single_select',
    description:
      'Show the developer a radio list and wait for one pick. Use it when a skill asks to pick one option, such as ' +
      'a numbered list with a (Default). The rows are numbered for you and none starts picked; keep (Default) in the ' +
      'default row\'s label. For "Your own" or "something else", add a last row with input true; the answer is then ' +
      'the typed text, so ask no follow-up.',
    properties: {
      options: { type: 'array', items: TYPED_OPTION, description: 'The rows, in the order the skill lists them.' },
    },
    required: ['options'],
    fields: (input) => [selectField(input, false)],
    answer: (outcome) => outcome[ANSWER] as JSONValue,
  },
  {
    name: 'strands_dev_multi_select',
    description:
      'Show the developer a checkbox list and wait for their picks. Use it when a skill says pick any, pick several, ' +
      'or accepts replies such as "1, 3". Put the defaults in selected. Returns the list of picked values.',
    properties: {
      options: { type: 'array', items: OPTION, description: 'The rows, in the order the skill lists them.' },
      selected: { type: 'array', items: { type: 'string' }, description: 'The values that start checked.' },
    },
    required: ['options'],
    fields: (input) => [selectField(input, true)],
    answer: (outcome) => outcome[ANSWER] as JSONValue,
  },
  {
    name: 'strands_dev_number_input',
    description:
      'Show the developer one whole-number field per setting, all in this one question, and wait for the values. ' +
      'Use it when a skill asks for numbers, such as several budget settings in one message. The fields take digits ' +
      'only, and finishing waits until every value fits its min and max. Returns {key: number} for every field.',
    properties: {
      fields: {
        type: 'array',
        description: 'One row per setting, in the order the skill lists them.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The name this value comes back under. Unique.' },
            label: { type: 'string', description: 'The short name shown on the left, about 12 characters.' },
            value: { type: 'integer', minimum: 0, description: 'The current value.' },
            min: { type: 'integer', minimum: 0, description: 'The smallest value allowed.' },
            max: { type: 'integer', minimum: 0, description: 'The largest value allowed.' },
            detail: { type: 'string', description: 'What the setting does, shown after the value.' },
          },
          required: ['key', 'label'],
          additionalProperties: false,
        },
      },
    },
    required: ['fields'],
    fields: (input) => numberFields(input.fields),
    answer: (outcome) => outcome as JSONValue,
  },
  {
    name: 'strands_dev_confirm',
    description:
      'Ask the developer a yes-or-no question and wait. Use it when a skill asks yes or no. Returns true or false. ' +
      'It is not the approval of a paid run: ask that in chat and wait for the reply in a later turn.',
    properties: {},
    required: [],
    fields: () => [{ kind: 'select', key: ANSWER, options: CONFIRM_OPTIONS, multiple: false, selected: ['yes'] }],
    answer: (outcome) => outcome[ANSWER] === 'yes',
  },
]

/** The tools that put a skill's questions on screen, one component per question. */
export const uiTools = (broker: () => UiToolsBroker): DevChatTool[] =>
  UI_TOOLS.map((tool): DevChatTool => ({
    name: tool.name,
    description: `${tool.description} A cancelled question is a no: do not ask it again or act as if they agreed. Back means ask the previous question again.`,
    inputSchema: {
      type: 'object',
      properties: { ...COMMON, ...tool.properties },
      required: ['question', ...tool.required],
      additionalProperties: false,
    },
    run: async (input): Promise<string> => {
      const outcome = await broker().ask(uiRequest(input, tool.fields(input)))
      if (outcome === undefined) return CANCELLED
      return outcome === 'back' ? BACK : reply({ status: 'answered', answer: tool.answer(outcome) })
    },
  }))
