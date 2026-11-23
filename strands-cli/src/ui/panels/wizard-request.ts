import { sanitizeTerminalText } from '../../terminal/text.js'

export type WizardAnswer = string | number | boolean | readonly string[]

export interface WizardOption {
  readonly value: string
  readonly label: string
  readonly detail?: string
  readonly unavailable?: string
  // The row is a text field: picking it answers with the typed text instead of the value.
  readonly input?: boolean
}

/** One question, many rows: checkboxes when multiple, radio buttons when not. */
export interface WizardSelectSpec {
  readonly kind: 'select'
  readonly key: string
  readonly options: readonly WizardOption[]
  readonly multiple?: boolean
  readonly selected?: readonly string[]
}

export interface WizardTextSpec {
  readonly kind: 'text'
  readonly key: string
  readonly label: string
  readonly value?: string
}

/** A whole number typed in its own row; finishing waits until it fits min and max. */
export interface WizardNumberSpec {
  readonly kind: 'number'
  readonly key: string
  readonly label: string
  readonly value?: number
  readonly min?: number
  readonly max?: number
  readonly detail?: string
}

export type WizardFieldSpec = WizardTextSpec | WizardSelectSpec | WizardNumberSpec

export interface WizardStepSpec {
  readonly key: string
  readonly title: string
  readonly fields: readonly WizardFieldSpec[]
}

export interface WizardRequest {
  readonly id: string
  readonly name: string
  readonly question?: string
  readonly steps: readonly WizardStepSpec[]
  readonly finishLabel?: string
  /** Offer Back instead of Cancel; picking it resolves the request with 'back'. */
  readonly back?: boolean
}

export type WizardRequestSpec = Omit<WizardRequest, 'id'>

/** `undefined` means the user cancelled instead of finishing; 'back' means they asked for the previous question. */
export type WizardOutcome = Readonly<Record<string, WizardAnswer>> | 'back' | undefined

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
    }
  const label = cleanText(field.label)
  if (field.kind === 'number')
    return { ...field, label, ...(field.detail === undefined ? {} : { detail: cleanText(field.detail) }) }
  return { ...field, label }
}

const cleanRequest = (request: WizardRequest): WizardRequest => ({
  ...request,
  name: cleanText(request.name),
  ...(request.question === undefined ? {} : { question: cleanText(request.question) }),
  steps: request.steps.map((step) => ({
    ...step,
    title: cleanText(step.title),
    fields: step.fields.map(cleanField),
  })),
})

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
      answers[field.key] = field.value ?? ''
    }
  return answers
}

/** Why a number answer cannot finish, or undefined when it fits its field. */
export const numberProblem = (field: WizardNumberSpec, answer: WizardAnswer | undefined): string | undefined => {
  if (typeof answer !== 'number') return `${field.label} needs a whole number.`
  if (field.min !== undefined && answer < field.min) return `${field.label} must be at least ${field.min}.`
  if (field.max !== undefined && answer > field.max) return `${field.label} must be at most ${field.max}.`
  return undefined
}

/** The answers as the asker reads them: a picked input row answers with its typed text. */
export const finishedAnswers = (
  steps: readonly WizardStepSpec[],
  answers: Readonly<Record<string, WizardAnswer>>,
  typed: Readonly<Record<string, string>>
): Record<string, WizardAnswer> => {
  const done: Record<string, WizardAnswer> = { ...answers }
  for (const step of steps)
    for (const field of step.fields) {
      if (field.kind !== 'select' || !field.options.some(({ input }) => input)) continue
      const typedOf = (value: string): string =>
        field.options.find((option) => option.value === value)?.input
          ? (typed[inputKey(field.key, value)] ?? '')
          : value
      const answer = answers[field.key]
      done[field.key] = Array.isArray(answer)
        ? answer.map(typedOf)
        : typeof answer === 'string' && answer
          ? typedOf(answer)
          : ''
    }
  return done
}

export const inputKey = (field: string, option: string): string => `${field}.${option}`

/**
 * One wizard at a time, so a second request waits instead of replacing the screen.
 * Mirrors ToolPermissionBroker: the caller awaits, the panel answers.
 */
export class WizardBroker {
  private readonly _listeners = new Set<WizardListener>()
  private readonly _queue: PendingWizard[] = []
  private _active: PendingWizard | undefined
  private _open: (() => boolean) | undefined
  private _next = 1
  private _disposed = false

  /** The panel command registers this, so asking also brings the panel on screen. */
  attachOpener(open: () => boolean): void {
    this._open = open
  }

  ask(spec: WizardRequestSpec): Promise<WizardOutcome> {
    if (this._disposed || spec.steps.length === 0) return Promise.resolve(undefined)
    const request = cleanRequest({ ...spec, id: `strands-wizard-${this._next++}` })
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
