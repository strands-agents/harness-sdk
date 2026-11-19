import type { JSONSchema, JSONValue } from '@strands-agents/sdk'

import type { WizardFieldSpec, WizardRequestSpec, WizardStepSpec } from '../../ui/panels/wizard-request.js'
import type { Tone } from '../../ui/panels/kit.js'
import type { DevChatTool } from '../chat-extension.js'

type Input = Readonly<Record<string, JSONValue>>

const FIELD_KINDS = ['choice', 'toggle', 'text'] as const
const TONES: readonly Tone[] = ['success', 'error', 'warning', 'muted']
const MAX_STEPS = 8
const MAX_FIELDS = 24

const isObject = (value: JSONValue | undefined): value is { [key: string]: JSONValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringAt = (value: JSONValue | undefined, what: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} must be text.`)
  return value.trim()
}

const optionalString = (value: JSONValue | undefined, what: string): string | undefined =>
  value === undefined || value === null ? undefined : stringAt(value, what)

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

const fieldAt = (value: JSONValue, what: string): WizardFieldSpec => {
  if (!isObject(value)) throw new Error(`${what} must be an object.`)
  const kind = stringAt(value.kind, `${what}.kind`)
  const key = stringAt(value.key, `${what}.key`)
  const label = stringAt(value.label, `${what}.label`)
  if (kind === 'toggle')
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
  if (kind === 'text')
    return {
      kind: 'text',
      key,
      label,
      ...(value.value === undefined || value.value === null ? {} : { value: stringAt(value.value, `${what}.value`) }),
      ...(optionalString(value.placeholder, `${what}.placeholder`) === undefined
        ? {}
        : { placeholder: optionalString(value.placeholder, `${what}.placeholder`)! }),
    }
  if (kind !== 'choice') throw new Error(`${what}.kind must be one of ${FIELD_KINDS.join(', ')}.`)
  const options = value.options
  if (!Array.isArray(options) || options.length === 0) throw new Error(`${what}.options must list at least one choice.`)
  const choices = options.map((option, index) => stringAt(option, `${what}.options[${index}]`))
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
  for (const step of steps)
    for (const field of step.fields) {
      if (seen.has(field.key)) return field.key
      seen.add(field.key)
    }
  return undefined
}

export const askRequestFrom = (input: Input): WizardRequestSpec => {
  const steps = input.steps
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps must list at least one step.')
  if (steps.length > MAX_STEPS) throw new Error(`steps can hold at most ${MAX_STEPS} steps.`)
  const parsed = steps.map((step, index) => stepAt(step, `steps[${index}]`))
  const clash = duplicateKey(parsed)
  if (clash) throw new Error(`Two fields use the key ${clash}. Every field key must be unique.`)
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

export const askTool = (broker: () => { ask: (spec: WizardRequestSpec) => Promise<unknown> }): DevChatTool => ({
  name: 'strands_dev_ask',
  description:
    'Ask the developer to fill in a setup form on screen, and wait for their answers. Use it to guide them ' +
    'through the settings of a run before you start it, one step at a time or all steps at once. ' +
    'It asks nothing by itself: you declare the steps and the fields, and it returns what they picked. ' +
    'The numbers you put in status and footer are fixed text, so compute them before the call and keep them ' +
    'honest, or leave them out. Returns cancelled when the developer declines, and that is a no: do not ask ' +
    'again with the same question or start the run anyway.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The name on the top line, such as optimize. Default: setup.' },
      subtitle: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short facts after the title, such as the experiment name and the case count.',
      },
      steps: {
        type: 'array',
        description: `The steps, in the order the developer walks them. At most ${MAX_STEPS}.`,
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
    required: ['steps'],
    additionalProperties: false,
  },
  run: async (input): Promise<string> => {
    const outcome = await broker().ask(askRequestFrom(input))
    if (outcome === undefined)
      return JSON.stringify(
        {
          status: 'cancelled',
          detail: 'The developer closed the form without finishing it. Treat this as a no.',
        },
        null,
        2
      )
    return JSON.stringify({ status: 'answered', answers: outcome }, null, 2)
  },
})
