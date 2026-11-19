import { sanitizeTerminalText } from '../../terminal/text.js'
import type { Tone } from './kit.js'

export type WizardAnswer = string | boolean

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

export type WizardFieldSpec = WizardChoiceSpec | WizardToggleSpec | WizardTextSpec

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

export const defaultAnswers = (steps: readonly WizardStepSpec[]): Record<string, WizardAnswer> => {
  const answers: Record<string, WizardAnswer> = {}
  for (const step of steps)
    for (const field of step.fields) {
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
