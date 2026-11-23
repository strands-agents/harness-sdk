import type { ChatDiffPreview } from '../../agent/types.js'
import { sanitizeTerminalText } from '../../terminal/text.js'
import { wrappedDiffLines } from '../diff-rows.js'

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

/** A file change to read, not answer: the panel draws it above the fields, and a sibling field holds the verdict. */
export interface WizardDiffSpec {
  readonly kind: 'diff'
  readonly key: string
  readonly label: string
  readonly path: string
  readonly diff: ChatDiffPreview
}

export type WizardFieldSpec = WizardTextSpec | WizardSelectSpec | WizardNumberSpec | WizardDiffSpec

export interface WizardStepSpec {
  readonly key: string
  readonly title: string
  readonly fields: readonly WizardFieldSpec[]
}

export interface WizardRequest {
  readonly id: string
  readonly name: string
  readonly question?: string
  readonly titleParts?: readonly string[]
  readonly steps: readonly WizardStepSpec[]
  readonly finishLabel?: string
  /** Offer Back instead of Cancel; picking it resolves the request with 'back'. */
  readonly back?: boolean
  /** Asked outside a turn, so no turn waits on it: a chat message or a cancelled turn leaves it on screen. */
  readonly standing?: boolean
  /** What the question is about, so whoever asked can bring it back in front of the others that wait. */
  readonly topic?: string
}

export type WizardRequestSpec = Omit<WizardRequest, 'id'>

/** `undefined` means the user cancelled instead of finishing; 'back' means they asked for the previous question. */
/** The developer sent a chat message instead of finishing; `entered` is what the question held on screen then. */
export class WizardInterruption {
  constructor(readonly entered: Readonly<Record<string, WizardAnswer>>) {}
}

export type WizardOutcome = Readonly<Record<string, WizardAnswer>> | 'back' | WizardInterruption | undefined

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
  if (field.kind === 'diff') return { ...field, label, path: cleanText(field.path) }
  if (field.kind === 'number')
    return { ...field, label, ...(field.detail === undefined ? {} : { detail: cleanText(field.detail) }) }
  return { ...field, label }
}

const cleanRequest = (request: WizardRequest): WizardRequest => ({
  ...request,
  name: cleanText(request.name),
  ...(request.question === undefined ? {} : { question: cleanText(request.question) }),
  ...(request.titleParts === undefined ? {} : { titleParts: request.titleParts.map(cleanText) }),
  steps: request.steps.map((step) => ({
    ...step,
    title: cleanText(step.title),
    fields: step.fields.map(cleanField),
  })),
})

const DIFF_INDENT = 2
const DIFF_MARK_COLUMNS = 2
// The title, the question, the gap under it, the row under the fields, the buttons, and the key hints.
const CHROME_ROWS = 5
// The file and its counts above the lines, and the gap that sets the change apart from the fields.
const DIFF_FRAME_ROWS = 2

/** The columns the text of a diff line gets in a panel `width` columns wide, after its indent and its +/- mark. */
export const wizardDiffTextWidth = (width: number): number => Math.max(1, width - DIFF_INDENT - DIFF_MARK_COLUMNS)

const fieldRows = (field: WizardFieldSpec, width: number | undefined): number => {
  if (field.kind === 'select') return field.options.length
  if (field.kind !== 'diff') return 1
  const lines = width === undefined ? field.diff.lines : wrappedDiffLines(field.diff, wizardDiffTextWidth(width))
  return DIFF_FRAME_ROWS + lines.length
}

/** A question that carries a change needs the wide dock to be read; everything else fits above the chat input. */
export const wizardRequestHasDiff = (request: WizardRequest | undefined): boolean =>
  request?.steps.some((step) => step.fields.some((field) => field.kind === 'diff')) === true

/** The rows a question needs at a panel `width` wide, so its panel is not half the terminal with the rest empty. */
export const wizardRequestRows = (request: WizardRequest | undefined, width?: number): number | undefined => {
  if (!request) return undefined
  // A walked request sizes to its tallest step, plus its step bar, so moving between steps keeps one frame.
  const fields = Math.max(
    ...request.steps.map((step) => step.fields.reduce((rows, field) => rows + fieldRows(field, width), 0))
  )
  return CHROME_ROWS - (request.question === undefined ? 1 : 0) + (request.steps.length > 1 ? 1 : 0) + fields
}

export const defaultAnswers = (steps: readonly WizardStepSpec[]): Record<string, WizardAnswer> => {
  const answers: Record<string, WizardAnswer> = {}
  for (const step of steps)
    for (const field of step.fields) {
      if (field.kind === 'diff') continue
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
  private _autofill: boolean
  private _next = 1
  private _disposed = false
  // What each shown question holds on screen, so a chat message that drops it can pass the inputs on.
  private readonly _drafts = new Map<string, Readonly<Record<string, WizardAnswer>>>()

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

  /** Records what the question `id` holds on screen. */
  draft(id: string, answers: Readonly<Record<string, WizardAnswer>>): void {
    if (this._active?.request.id === id) this._drafts.set(id, answers)
  }

  respond(id: string, outcome: WizardOutcome): boolean {
    const active = this._active
    if (!active || active.request.id !== id) return false
    this._active = undefined
    this._drafts.delete(id)
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

  /** Puts the waiting question about `topic` on screen, ahead of the one there, and opens the panel. False when none waits. */
  bringForward(topic: string): boolean {
    if (this._active?.request.topic !== topic) {
      const at = this._queue.findIndex(({ request }) => request.topic === topic)
      if (at < 0) return false
      const [wanted] = this._queue.splice(at, 1)
      if (this._active) this._queue.unshift(this._active)
      this._active = wanted
      this._notify(wanted?.request)
    }
    this._open?.()
    return true
  }

  /** Cancels the questions a turn waits on and keeps the standing ones; says whether it cancelled any. */
  dropForTurn(): boolean {
    return this._cancelWhere(({ request }) => request.standing !== true)
  }

  /** As dropForTurn, for a chat message sent instead: each dropped question answers with what it held on screen. */
  interruptForTurn(): boolean {
    return this._cancelWhere(({ request }) => request.standing !== true, true)
  }

  /** Cancels the questions about `topic`, on screen or waiting: whoever asked has its answer from elsewhere. */
  withdraw(topic: string): void {
    this._cancelWhere(({ request }) => request.topic === topic)
  }

  dispose(): void {
    this._disposed = true
    this.cancelAll()
    this._listeners.clear()
  }

  private _cancelWhere(matches: (wizard: PendingWizard) => boolean, interrupted = false): boolean {
    const queued = this._queue.filter(matches)
    const active = this._active && matches(this._active) ? this._active : undefined
    if (!active && queued.length === 0) return false
    this._queue.splice(0, this._queue.length, ...this._queue.filter((wizard) => !matches(wizard)))
    if (active) this._active = undefined
    for (const wizard of [...(active ? [active] : []), ...queued]) {
      const entered = this._drafts.get(wizard.request.id) ?? {}
      this._drafts.delete(wizard.request.id)
      wizard.resolve(interrupted ? new WizardInterruption(entered) : undefined)
    }
    if (!active) return true
    if (this._queue.length > 0) this._activateNext()
    else this._notify(undefined)
    return true
  }

  // A turn is stopped until its question is answered, so that question shows before a standing one, which returns after.
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
