import { sanitizeTerminalText } from '../../terminal/text.js'
import type { ChatDiffPreview } from '../../agent/types.js'
import { wrappedDiffLines } from '../diff-rows.js'
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

/**
 * A file change to read, not answer: the panel draws it and steps over it, and a sibling field holds the verdict.
 * `proposed` is the whole new text of `path`, so accepting it pre-approves the write that applies it.
 */
export interface WizardDiffSpec {
  readonly kind: 'diff'
  readonly key: string
  readonly label: string
  readonly path: string
  readonly proposed: string
  readonly diff: ChatDiffPreview
}

export type WizardFieldSpec = WizardChoiceSpec | WizardToggleSpec | WizardTextSpec | WizardSelectSpec | WizardDiffSpec

export type WizardAnswerableFieldSpec = Exclude<WizardFieldSpec, WizardDiffSpec>

/** A diff carries no answer, so the focus walk and the outcome record both step over it. */
export const isAnswerableField = (field: WizardFieldSpec): field is WizardAnswerableFieldSpec => field.kind !== 'diff'

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
  /** Asked outside a turn, so no turn waits on it: a chat message leaves it on screen instead of dropping it. */
  readonly standing?: boolean
  /** What the question is about, so whoever asked can bring it back in front of the others that wait. */
  readonly topic?: string
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

const DIFF_INDENT = 2
const DIFF_MARK_COLUMNS = 2
// The file and its counts above the lines, and the row that sets them apart from the answer below.
const DIFF_FRAME_ROWS = 2

/** The columns the text of a diff line gets in a panel `width` columns wide, after its indent and its +/- mark. */
export const wizardDiffTextWidth = (width: number): number => Math.max(1, width - DIFF_INDENT - DIFF_MARK_COLUMNS)

const fieldRows = (field: WizardFieldSpec, width: number | undefined): number => {
  if (field.kind === 'select') return field.options.length + (field.listLabel === undefined ? 0 : 1)
  if (field.kind !== 'diff') return 1
  const lines = width === undefined ? field.diff.lines : wrappedDiffLines(field.diff, wizardDiffTextWidth(width))
  return DIFF_FRAME_ROWS + lines.length
}

/** A diff needs the dock's width; everything else fits above the chat input. */
export const wizardRequestHasDiff = (request: WizardRequest | undefined): boolean =>
  request?.steps.some((step) => step.fields.some((field) => field.kind === 'diff')) === true

/**
 * The rows one question needs, so its panel is not half the terminal with the rest empty. `width` is the panel's inner
 * width, which a change needs to know how many rows its long lines wrap onto.
 */
export const wizardRequestRows = (request: WizardRequest | undefined, width?: number): number | undefined => {
  if (!request || request.steps.length !== 1) return undefined
  const step = request.steps[0]!
  const fields = step.fields.reduce((rows, field) => rows + fieldRows(field, width), 0)
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
      if (!isAnswerableField(field)) continue
      if (field.kind === 'select') {
        const open = field.options.filter(({ unavailable }) => unavailable === undefined).map(({ value }) => value)
        const picked = (field.selected ?? []).filter((value) => open.includes(value))
        // A pick-one list starts with nothing picked, so the answer is the developer's own choice.
        answers[field.key] = field.multiple === false ? '' : picked
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
    // Autofill hands the agent's own questions back to it. A standing question is the developer's to answer.
    if (this._autofill && !request.standing) return Promise.resolve(defaultAnswers(request.steps))
    return new Promise((resolve) => {
      this._queue.push({ request, resolve })
      this._yieldToTurn()
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

  /** Puts the waiting question about `topic` on screen, ahead of the one that is there. False when none waits. */
  bringForward(topic: string): boolean {
    if (this._active?.request.topic === topic) return true
    const at = this._queue.findIndex(({ request }) => request.topic === topic)
    if (at < 0) return false
    const [wanted] = this._queue.splice(at, 1)
    if (this._active) this._queue.unshift(this._active)
    this._active = wanted
    this._notify(wanted?.request)
    return true
  }

  /**
   * Makes way for a chat message: cancels the questions a turn is waiting on and keeps the standing ones.
   * Says whether it cancelled any, so the caller knows if a turn was let go.
   */
  dropForMessage(): boolean {
    const held = (wizard: PendingWizard): boolean => wizard.request.standing !== true
    const queued = this._queue.filter(held)
    const active = this._active && held(this._active) ? this._active : undefined
    if (!active && queued.length === 0) return false
    this._queue.splice(0, this._queue.length, ...this._queue.filter((wizard) => !held(wizard)))
    if (active) this._active = undefined
    for (const wizard of [...(active ? [active] : []), ...queued]) wizard.resolve(undefined)
    if (!active) return true
    if (this._queue.length > 0) this._activateNext()
    else this._notify(undefined)
    return true
  }

  dispose(): void {
    this._disposed = true
    this.cancelAll()
    this._listeners.clear()
  }

  /** A turn is stopped until its question is answered, so that question shows before a standing one, which returns after. */
  private _yieldToTurn(): void {
    const active = this._active
    if (!active?.request.standing || this._queue.every(({ request }) => request.standing)) return
    this._active = undefined
    this._queue.unshift(active)
  }

  private _activateNext(): void {
    if (this._active || this._queue.length === 0) return
    const held = this._queue.findIndex(({ request }) => !request.standing)
    this._active = this._queue.splice(Math.max(held, 0), 1)[0]
    this._notify(this._active?.request)
    this._open?.()
  }

  private _notify(request: WizardRequest | undefined): void {
    for (const listener of this._listeners) listener(request)
  }
}
