import type { JSONSchema, JSONValue } from '@strands-agents/sdk'

import type {
  WizardFieldSpec,
  WizardOption,
  WizardOutcome,
  WizardRequestSpec,
  WizardStepSpec,
} from '../../ui/panels/wizard-request.js'
import type { Tone } from '../../ui/panels/kit.js'
import type { DevChatTool } from '../chat-extension.js'

type Input = Readonly<Record<string, JSONValue>>

const FIELD_KINDS = ['choice', 'toggle', 'text'] as const
const ASK_KINDS = ['selectMany', 'selectOne', 'text', 'confirm'] as const
const CONFIRM_OPTIONS = [
  { value: 'yes', label: 'yes' },
  { value: 'no', label: 'no' },
]
// 'error' is left out on purpose: a static error notice blocks finishing with no way to clear it.
const TONES: readonly Tone[] = ['success', 'warning', 'muted']
const MAX_STEPS = 8
const MAX_FIELDS = 24

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

const optionalFlag = (value: JSONValue | undefined, what: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`${what} must be true or false.`)
  return value
}

const noticeAt = (value: JSONValue | undefined, what: string): WizardStepSpec['notice'] => {
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) throw new Error(`${what} must be an object with tone and text.`)
  const tone = stringAt(value.tone, `${what}.tone`)
  if (!TONES.includes(tone as Tone)) throw new Error(`${what}.tone must be one of ${TONES.join(', ')}.`)
  return { tone: tone as Tone, text: stringAt(value.text, `${what}.text`) }
}

const optionAt = (value: JSONValue, what: string): WizardOption => {
  if (!isObject(value)) throw new Error(`${what} must be an object with value and label.`)
  const detail = optionalString(value.detail, `${what}.detail`)
  const unavailable = optionalString(value.unavailable, `${what}.unavailable`)
  return {
    value: stringAt(value.value, `${what}.value`),
    label: stringAt(value.label, `${what}.label`),
    ...(detail === undefined ? {} : { detail }),
    ...(unavailable === undefined ? {} : { unavailable }),
  }
}

const optionsAt = (value: JSONValue | undefined, what: string): readonly WizardOption[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${what} must list at least one option.`)
  const options = value.map((option, index) => optionAt(option, `${what}[${index}]`))
  const values = options.map(({ value: name }) => name)
  if (new Set(values).size !== values.length) throw new Error(`${what} must not repeat a value.`)
  return options
}

const selectAt = (value: { [key: string]: JSONValue }, what: string, key: string): WizardFieldSpec => {
  const options = optionsAt(value.options, `${what}.options`)
  const selected = value.selected
  if (selected !== undefined && selected !== null && !Array.isArray(selected))
    throw new Error(`${what}.selected must be a list of option values.`)
  const picked = Array.isArray(selected)
    ? selected.map((item, index) => stringAt(item, `${what}.selected[${index}]`))
    : []
  const unknown = picked.filter((item) => !options.some(({ value: name }) => name === item))
  if (unknown.length > 0) throw new Error(`${what}.selected names no such option: ${unknown.join(', ')}.`)
  const multiple = optionalFlag(value.multiple, `${what}.multiple`)
  const listLabel = optionalString(value.listLabel, `${what}.listLabel`)
  return {
    kind: 'select',
    key,
    options,
    ...(multiple === undefined ? {} : { multiple }),
    ...(picked.length === 0 ? {} : { selected: picked }),
    ...(listLabel === undefined ? {} : { listLabel }),
  }
}

const fieldAt = (value: JSONValue, what: string): WizardFieldSpec => {
  if (!isObject(value)) throw new Error(`${what} must be an object.`)
  const kind = stringAt(value.kind, `${what}.kind`)
  const key = stringAt(value.key, `${what}.key`)
  if (kind === 'select') return selectAt(value, what, key)
  const label = stringAt(value.label, `${what}.label`)
  if (kind === 'toggle') {
    if (value.checked === true && optionalString(value.unavailable, `${what}.unavailable`) !== undefined)
      throw new Error(`${what} cannot be checked and unavailable at once.`)
    return {
      kind: 'toggle',
      key,
      label,
      ...(optionalString(value.detail, `${what}.detail`) === undefined
        ? {}
        : { detail: optionalString(value.detail, `${what}.detail`)! }),
      ...(optionalString(value.unavailable, `${what}.unavailable`) === undefined
        ? {}
        : { unavailable: optionalString(value.unavailable, `${what}.unavailable`)! }),
      ...(optionalFlag(value.checked, `${what}.checked`) === undefined
        ? {}
        : { checked: optionalFlag(value.checked, `${what}.checked`)! }),
    }
  }
  if (kind === 'text')
    return {
      kind: 'text',
      key,
      label,
      ...(optionalString(value.value, `${what}.value`) === undefined
        ? {}
        : { value: optionalString(value.value, `${what}.value`)! }),
      ...(optionalString(value.placeholder, `${what}.placeholder`) === undefined
        ? {}
        : { placeholder: optionalString(value.placeholder, `${what}.placeholder`)! }),
    }
  if (kind !== 'choice') throw new Error(`${what}.kind must be one of ${FIELD_KINDS.join(', ')}.`)
  const options = value.options
  if (!Array.isArray(options) || options.length === 0) throw new Error(`${what}.options must list at least one choice.`)
  const choices = options.map((option, index) => stringAt(option, `${what}.options[${index}]`))
  if (new Set(choices).size !== choices.length) throw new Error(`${what}.options must not repeat a choice.`)
  const picked = optionalString(value.value, `${what}.value`)
  if (picked !== undefined && !choices.includes(picked))
    throw new Error(`${what}.value must be one of its own options: ${choices.join(', ')}.`)
  return {
    kind: 'choice',
    key,
    label,
    options: choices,
    ...(picked === undefined ? {} : { value: picked }),
    ...(optionalString(value.hint, `${what}.hint`) === undefined
      ? {}
      : { hint: optionalString(value.hint, `${what}.hint`)! }),
  }
}

const stepAt = (value: JSONValue, what: string): WizardStepSpec => {
  if (!isObject(value)) throw new Error(`${what} must be an object.`)
  const fields = value.fields
  if (!Array.isArray(fields)) throw new Error(`${what}.fields must be a list, and it can be empty.`)
  if (fields.length > MAX_FIELDS) throw new Error(`${what}.fields can hold at most ${MAX_FIELDS} fields.`)
  const notice = noticeAt(value.notice, `${what}.notice`)
  const listLabel = optionalString(value.listLabel, `${what}.listLabel`)
  const footnote = optionalString(value.footnote, `${what}.footnote`)
  return {
    key: stringAt(value.key, `${what}.key`),
    title: stringAt(value.title, `${what}.title`),
    fields: fields.map((field, index) => fieldAt(field, `${what}.fields[${index}]`)),
    ...(notice ? { notice } : {}),
    ...(listLabel === undefined ? {} : { listLabel }),
    ...(footnote === undefined ? {} : { footnote }),
  }
}

const duplicateKey = (steps: readonly WizardStepSpec[]): string | undefined => {
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.key)) return step.key
    seen.add(step.key)
    for (const field of step.fields) {
      if (seen.has(field.key)) return field.key
      seen.add(field.key)
    }
  }
  return undefined
}

/** One component, one answer: the shape a skill uses to ask a single thing. */
const oneQuestion = (input: Input): WizardRequestSpec => {
  const kind = stringAt(input.ask, 'ask')
  if (!ASK_KINDS.includes(kind as (typeof ASK_KINDS)[number]))
    throw new Error(`ask must be one of ${ASK_KINDS.join(', ')}.`)
  const question = stringAt(input.question, 'question')
  const key = optionalString(input.key, 'key') ?? 'answer'
  const field = ((): WizardFieldSpec => {
    if (kind === 'text') {
      const value = optionalString(input.value, 'value')
      const placeholder = optionalString(input.placeholder, 'placeholder')
      return {
        kind: 'text',
        key,
        label: optionalString(input.label, 'label') ?? key,
        ...(value === undefined ? {} : { value }),
        ...(placeholder === undefined ? {} : { placeholder }),
      }
    }
    if (kind === 'confirm') return { kind: 'select', key, options: CONFIRM_OPTIONS, multiple: false, selected: ['yes'] }
    // ask names the component, so it decides how many answers the list takes.
    const list = selectAt({ ...input, multiple: kind === 'selectMany' }, 'this question', key)
    if (kind === 'selectOne' && list.kind === 'select' && list.options.length < 2)
      throw new Error('selectOne needs at least two options: with one there is nothing to choose.')
    return list
  })()
  const status = optionalString(input.status, 'status')
  const footer = optionalString(input.footer, 'footer')
  return {
    name: optionalString(input.title, 'title') ?? 'setup',
    question,
    steps: [{ key: 'question', title: 'Question', fields: [field] }],
    finishLabel: optionalString(input.finishLabel, 'finishLabel') ?? '[ OK ]',
    ...(status === undefined ? {} : { status }),
    ...(footer === undefined ? {} : { footer }),
  }
}

export const askRequestFrom = (input: Input): WizardRequestSpec => {
  if (input.ask !== undefined && input.ask !== null) {
    if (input.steps !== undefined && input.steps !== null)
      throw new Error('Send ask for one question, or steps for a walked form, not both.')
    return oneQuestion(input)
  }
  const steps = input.steps
  if (!Array.isArray(steps) || steps.length === 0)
    throw new Error('Send ask with a question for one question, or steps for a walked form.')
  if (steps.length > MAX_STEPS) throw new Error(`steps can hold at most ${MAX_STEPS} steps.`)
  const parsed = steps.map((step, index) => stepAt(step, `steps[${index}]`))
  const clash = duplicateKey(parsed)
  if (clash) throw new Error(`The key ${clash} is used twice. Every step key and field key must be unique.`)
  if (parsed.every((step) => step.fields.length === 0))
    throw new Error('At least one step must have a field, or there is nothing to answer.')
  const subtitle = input.subtitle
  if (subtitle !== undefined && subtitle !== null && !Array.isArray(subtitle))
    throw new Error('subtitle must be a list of short strings.')
  const titleParts = Array.isArray(subtitle)
    ? subtitle.map((part, index) => stringAt(part, `subtitle[${index}]`))
    : undefined
  const status = optionalString(input.status, 'status')
  const footer = optionalString(input.footer, 'footer')
  const finishLabel = optionalString(input.finishLabel, 'finishLabel')
  return {
    name: optionalString(input.title, 'title') ?? 'setup',
    steps: parsed,
    ...(titleParts && titleParts.length > 0 ? { titleParts } : {}),
    ...(status === undefined ? {} : { status }),
    ...(footer === undefined ? {} : { footer }),
    ...(finishLabel === undefined ? {} : { finishLabel }),
  }
}

const FIELD_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...FIELD_KINDS], description: 'choice is a slider, toggle is a checkbox.' },
    key: { type: 'string', description: 'The name this field answers under. Unique across every step.' },
    label: { type: 'string', description: 'The short name shown on the left, about 12 characters.' },
    options: { type: 'array', items: { type: 'string' }, description: 'With choice: the values, in order.' },
    value: { type: 'string', description: 'With choice: the starting option. With text: the starting text.' },
    checked: { type: 'boolean', description: 'With toggle: whether it starts checked.' },
    detail: { type: 'string', description: 'With toggle: the explanation shown beside the label.' },
    unavailable: {
      type: 'string',
      description: 'With toggle: why this one cannot be picked. It shows the reason and refuses to check.',
    },
    placeholder: { type: 'string', description: 'With text: the grey hint shown while the field is empty.' },
    hint: { type: 'string', description: 'With choice: the key hint, such as "←→ budget".' },
  },
  required: ['kind', 'key', 'label'],
  additionalProperties: false,
}

export const askTool = (broker: () => { ask: (spec: WizardRequestSpec) => Promise<WizardOutcome> }): DevChatTool => ({
  name: 'strands_dev_ask',
  description:
    'Ask the developer one question on screen and wait for their answer. Guide them through a setup one question ' +
    'at a time: ask, read the answer, then ask the next thing. Send ask with one of selectMany, selectOne, text, ' +
    'or confirm, and a question that says what you need. Keep each question about one decision, and skip the ones ' +
    'the developer already answered or that do not matter for this request. ' +
    'Use steps instead only for a form the developer walks with Next and Back, which is heavier and rarely what ' +
    'they want. Returns cancelled when they decline, and that is a no: do not ask again with the same question ' +
    'and do not act as if they agreed.',
  inputSchema: {
    type: 'object',
    properties: {
      ask: {
        type: 'string',
        enum: [...ASK_KINDS],
        description:
          'One question: selectMany is a checkbox list, selectOne is a radio list, text types a value, and ' +
          'confirm is yes or no. With ask, send question and (for the lists) options.',
      },
      question: { type: 'string', description: 'With ask: what you are asking, in one plain line.' },
      key: { type: 'string', description: 'With ask: the name the answer comes back under. Default: answer.' },
      label: { type: 'string', description: 'With ask text: the short name beside the field. Default: the key.' },
      options: {
        type: 'array',
        description: 'With ask selectMany or selectOne: the rows to choose from.',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string', description: 'What the answer holds when this row is picked.' },
            label: { type: 'string', description: 'The row as the developer reads it.' },
            detail: { type: 'string', description: 'The explanation shown beside the label.' },
            unavailable: {
              type: 'string',
              description: 'Why this row cannot be picked. It shows the reason and refuses to pick.',
            },
          },
          required: ['value', 'label'],
          additionalProperties: false,
        },
      },
      selected: {
        type: 'array',
        items: { type: 'string' },
        description: 'With ask selectMany or selectOne: the option values that start picked.',
      },
      multiple: { type: 'boolean', description: 'Overrides whether the list takes more than one answer.' },
      listLabel: { type: 'string', description: 'With ask selectMany or selectOne: the heading above the rows.' },
      value: { type: 'string', description: 'With ask text: the starting text.' },
      placeholder: { type: 'string', description: 'With ask text: the grey hint while the field is empty.' },
      title: { type: 'string', description: 'The name on the top line, such as optimize. Default: setup.' },
      subtitle: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short facts after the title, such as the experiment name and the case count.',
      },
      steps: {
        type: 'array',
        description:
          'A form the developer walks with Next and Back, in this order. Prefer ask for one question. ' +
          `At most ${MAX_STEPS} steps.`,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'A short name for this step.' },
            title: { type: 'string', description: 'The tab title, one word.' },
            fields: { type: 'array', items: FIELD_SCHEMA, description: 'The fields of this step.' },
            listLabel: {
              type: 'string',
              description: 'With toggle fields: the heading above the list, such as knobs.',
            },
            footnote: { type: 'string', description: 'One dim line of help under the fields.' },
            notice: {
              type: 'object',
              properties: {
                tone: { type: 'string', enum: [...TONES] },
                text: { type: 'string' },
              },
              required: ['tone', 'text'],
              additionalProperties: false,
              description: 'A problem or warning for this step. An error tone blocks finishing.',
            },
          },
          required: ['key', 'title', 'fields'],
          additionalProperties: false,
        },
      },
      status: { type: 'string', description: 'The top-right line, such as the rollout count.' },
      footer: { type: 'string', description: 'The bottom-right line, such as the token and time estimate.' },
      finishLabel: { type: 'string', description: 'The finish button text. Default: [ Start ].' },
    },
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const one = input.ask !== undefined && input.ask !== null
    const outcome = await broker().ask(askRequestFrom(input))
    if (outcome === undefined)
      return JSON.stringify(
        {
          status: 'cancelled',
          detail: `The developer closed the ${one ? 'question' : 'form'} without answering. Treat this as a no.`,
        },
        null,
        2
      )
    const key = typeof input.key === 'string' && input.key.trim() ? input.key.trim() : 'answer'
    const answer = outcome[key]
    if (!one) return JSON.stringify({ status: 'answered', answers: outcome }, null, 2)
    return JSON.stringify({ status: 'answered', answer: input.ask === 'confirm' ? answer === 'yes' : answer }, null, 2)
  },
})
