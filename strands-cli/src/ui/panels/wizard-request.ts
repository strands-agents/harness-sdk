import { sanitizeTerminalText } from '../../terminal/text.js'
import type { Tone } from './kit.js'

export type WizardAnswer = string | boolean | readonly string[]

export interface WizardOption {
  readonly value: string
  readonly label: string
  readonly detail?: string
  readonly unavailable?: string
}

/** One question, many rows: checkboxes when multiple, radio buttons when not. */
export interface WizardSelectSpec {
  readonly kind: 'select'
  readonly key: string
  readonly options: readonly WizardOption[]
  readonly multiple?: boolean
  readonly selected?: readonly string[]
  readonly listLabel?: string
}

export interface WizardChoiceSpec {
  readonly kind: 'choice'
  readonly key: string
  readonly label: string
  readonly options: readonly string[]
  readonly value?: string
  readonly hint?: string
}

export interface WizardToggleSpec {
  readonly kind: 'toggle'
  readonly key: string
  readonly label: string
  readonly detail?: string
  readonly checked?: boolean
  readonly unavailable?: string
}

export interface WizardTextSpec {
  readonly kind: 'text'
  readonly key: string
  readonly label: string
  readonly value?: string
  readonly placeholder?: string
}

export type WizardFieldSpec = WizardChoiceSpec | WizardToggleSpec | WizardTextSpec | WizardSelectSpec

export interface WizardStepSpec {
  readonly key: string
  readonly title: string
  readonly fields: readonly WizardFieldSpec[]
  readonly notice?: { readonly tone: Tone; readonly text: string }
  readonly listLabel?: string
  readonly footnote?: string
}

export interface WizardRequest {
  readonly id: string
  readonly name: string
  readonly question?: string
  readonly titleParts?: readonly string[]
  readonly steps: readonly WizardStepSpec[]
  readonly status?: string
  readonly footer?: string
  readonly finishLabel?: string
}

export type WizardRequestSpec = Omit<WizardRequest, 'id'>

/** `undefined` means the user cancelled instead of finishing. */
export type WizardOutcome = Readonly<Record<string, WizardAnswer>> | undefined

type WizardListener = (request: WizardRequest | undefined) => void

interface PendingWizard {
  readonly request: WizardRequest
  readonly resolve: (outcome: WizardOutcome) => void
}

const cleanText = (text: string): string => sanitizeTerminalText(text)

const cleanField = (field: WizardFieldSpec): WizardFieldSpec => {
  if (field.kind === 'select')
    return {
      ...field,
      options: field.options.map((option) => ({
        ...option,
        label: cleanText(option.label),
        ...(option.detail === undefined ? {} : { detail: cleanText(option.detail) }),
        ...(option.unavailable === undefined ? {} : { unavailable: cleanText(option.unavailable) }),
      })),
      ...(field.listLabel === undefined ? {} : { listLabel: cleanText(field.listLabel) }),
    }
  const label = cleanText(field.label)
  if (field.kind === 'choice') return { ...field, label, options: field.options.map(cleanText) }
  if (field.kind === 'toggle')
    return {
      ...field,
      label,
      ...(field.detail === undefined ? {} : { detail: cleanText(field.detail) }),
      ...(field.unavailable === undefined ? {} : { unavailable: cleanText(field.unavailable) }),
    }
  return { ...field, label }
}

const cleanRequest = (request: WizardRequest): WizardRequest => ({
  ...request,
  name: cleanText(request.name),
  steps: request.steps.map((step) => ({
    ...step,
    title: cleanText(step.title),
    fields: step.fields.map(cleanField),
  })),
})

const TITLE_ROWS = 1
const QUESTION_ROWS = 1
const GAP_ROWS = 1
const HINT_ROWS = 1
const LAST_ROW_PADDING = 1

const fieldRows = (field: WizardFieldSpec): number => {
  if (field.kind === 'select') return field.options.length + (field.listLabel === undefined ? 0 : 1)
  return 1
}

/** The rows one question needs, so its panel is not half the terminal with the rest empty. */
export const wizardRequestRows = (request: WizardRequest | undefined): number | undefined => {
  if (!request || request.steps.length !== 1) return undefined
  const step = request.steps[0]!
  const fields = step.fields.reduce((rows, field) => rows + fieldRows(field), 0)
  return (
    TITLE_ROWS +
    (request.question === undefined ? 0 : QUESTION_ROWS) +
    GAP_ROWS +
    fields +
    (step.notice ? 1 : 0) +
    (step.footnote === undefined ? 0 : 1) +
    (request.footer ? 1 : 0) +
    LAST_ROW_PADDING +
    HINT_ROWS
  )
}

export const defaultAnswers = (steps: readonly WizardStepSpec[]): Record<string, WizardAnswer> => {
  const answers: Record<string, WizardAnswer> = {}
  for (const step of steps)
    for (const field of step.fields) {
      if (field.kind === 'select') {
        const open = field.options.filter(({ unavailable }) => unavailable === undefined).map(({ value }) => value)
        const picked = (field.selected ?? []).filter((value) => open.includes(value))
        answers[field.key] = field.multiple === false ? (picked[0] ?? '') : picked
        continue
      }
      // An unavailable toggle renders unchecked and refuses to flip, so it must not answer true.
      if (field.kind === 'toggle') answers[field.key] = field.unavailable === undefined && field.checked === true
      else if (field.kind === 'text') answers[field.key] = field.value ?? ''
      else answers[field.key] = field.value ?? field.options[0] ?? ''
    }
  return answers
}

/**
 * One wizard at a time, so a second request waits instead of replacing the screen.
 * Mirrors ToolPermissionBroker: the caller awaits, the panel answers.
 */
export class WizardBroker {
  private readonly _listeners = new Set<WizardListener>()
  private readonly _queue: PendingWizard[] = []
  private _active: PendingWizard | undefined
  private _open: (() => boolean) | undefined
  private _autofill: boolean
  private _next = 1
  private _disposed = false

  /** `autofill` starts from the saved setting and lasts for this session only. */
  constructor(autofill = false) {
    this._autofill = autofill
  }

  /** The panel command registers this, so asking also brings the panel on screen. */
  attachOpener(open: () => boolean): void {
    this._open = open
  }

  autofill(): boolean {
    return this._autofill
  }

  setAutofill(on: boolean): void {
    this._autofill = on
    this._notify(this._active?.request)
  }

  ask(spec: WizardRequestSpec): Promise<WizardOutcome> {
    if (this._disposed || spec.steps.length === 0) return Promise.resolve(undefined)
    const request = cleanRequest({ ...spec, id: `strands-wizard-${this._next++}` })
    if (this._autofill) return Promise.resolve(defaultAnswers(request.steps))
    return new Promise((resolve) => {
      this._queue.push({ request, resolve })
      this._activateNext()
    })
  }

  pending(): WizardRequest | undefined {
    return this._active?.request
  }

  respond(id: string, outcome: WizardOutcome): boolean {
    const active = this._active
    if (!active || active.request.id !== id) return false
    this._active = undefined
    active.resolve(outcome)
    // Activating before notifying keeps a queued request on screen: the panel closes itself on undefined.
    if (this._queue.length > 0) this._activateNext()
    else this._notify(undefined)
    return true
  }

  subscribe(listener: WizardListener): () => void {
    this._listeners.add(listener)
    if (this._active) listener(this._active.request)
    return () => {
      this._listeners.delete(listener)
    }
  }

  cancelAll(): void {
    const pending = [...(this._active ? [this._active] : []), ...this._queue.splice(0)]
    const hadActive = this._active !== undefined
    this._active = undefined
    for (const wizard of pending) wizard.resolve(undefined)
    if (hadActive) this._notify(undefined)
  }

  dispose(): void {
    this._disposed = true
    this.cancelAll()
    this._listeners.clear()
  }

  private _activateNext(): void {
    if (this._active || this._queue.length === 0) return
    this._active = this._queue.shift()
    this._notify(this._active?.request)
    this._open?.()
  }

  private _notify(request: WizardRequest | undefined): void {
    for (const listener of this._listeners) listener(request)
  }
}
