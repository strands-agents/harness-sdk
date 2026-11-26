import { createDiffPreview } from '../../../agent/file-changes.js'
import { WizardInterruption, type WizardRequestSpec } from '../../../ui/panels/wizard-request.js'
import type { OptimizeReview, ProposedEdit } from '../model.js'
import type { EvalsDevSessions } from './sessions.js'

const ACCEPT = 'accept'
const REJECT = 'reject'

const target = (edit: ProposedEdit): string => edit.target ?? edit.label

const question = (
  edit: ProposedEdit,
  { id, run }: { id: string; run: string },
  at: number,
  of: number
): WizardRequestSpec => ({
  name: 'optimize',
  // The count comes first: a narrow panel cuts the title from its end, and the run's name is the part to lose.
  titleParts: of > 1 ? [`edit ${at + 1} of ${of}`, run] : [run],
  question: `Apply this change to ${edit.label}?`,
  // The run is over and no turn waits on this, so asking the agent about the change must not answer it.
  standing: true,
  topic: id,
  fields: [
    {
      kind: 'select',
      key: 'verdict',
      options: [
        { value: ACCEPT, label: 'Apply this change' },
        { value: REJECT, label: 'Leave it as it is' },
      ],
      multiple: false,
    },
    {
      kind: 'diff',
      key: 'change',
      label: edit.label,
      path: target(edit),
      diff: createDiffPreview(target(edit), edit.before, edit.after),
    },
  ],
})

// Walks a finished run's edits one at a time and writes the accepted ones once every edit has an answer.
const reviewing = new WeakMap<object, Set<string>>()

// The edit that each run's walk is asking about now, so a chat message and the agent can tell which diff is showing.
const asking = new WeakMap<object, Map<string, number>>()

const askingIn = ({ optimize }: EvalsDevSessions): Map<string, number> => {
  const runs = asking.get(optimize) ?? new Map<string, number>()
  asking.set(optimize, runs)
  return runs
}

export const reviewOptimizeRun = async (sessions: EvalsDevSessions, runId: string): Promise<void> => {
  // One walk per run and workspace: the finish opens it, and the progress line's click must not start a second.
  const walks = reviewing.get(sessions.optimize) ?? new Set<string>()
  reviewing.set(sessions.optimize, walks)
  if (walks.has(runId)) return
  walks.add(runId)
  try {
    await walkRun(sessions, runId)
  } finally {
    walks.delete(runId)
  }
}

/** Puts a run's waiting edits on screen ahead of another question; false when it has nothing to ask. */
export const showOptimizeReview = (sessions: EvalsDevSessions, runId: string): boolean => {
  void reviewOptimizeRun(sessions, runId)
  return sessions.ask.bringForward(runId)
}

const waitingReview = ({ optimize }: EvalsDevSessions, runId: string): OptimizeReview | undefined => {
  const run = optimize.snapshot().runs?.find((candidate) => candidate.id === runId)
  return run?.state.step === 'review' && !run.state.review.reviewed ? run.state.review : undefined
}

const walkRun = async (sessions: EvalsDevSessions, runId: string): Promise<void> => {
  const { optimize, ask } = sessions
  if (!optimize.focusRun(runId)) return
  // An edit is asked once per walk, whatever the session then says of it, so a walk always ends.
  const asked = new Set<number>()
  let accepted = 0
  for (;;) {
    const review = waitingReview(sessions, runId)
    if (!review) return
    const offered = review.edits.flatMap((edit, index) => (edit.unavailable ? [] : [{ edit, index }]))
    const at = offered.findIndex(({ edit, index }) => !edit.decided && !asked.has(index))
    const next = offered[at]
    if (!next) {
      accepted += offered.filter(({ edit, index }) => edit.decided && edit.accepted && !asked.has(index)).length
      break
    }
    asked.add(next.index)
    askingIn(sessions).set(runId, next.index)
    const outcome = await ask
      .ask(question(next.edit, { id: runId, run: review.run }, at, offered.length))
      .finally(() => askingIn(sessions).delete(runId))
    // Closing the question, or finishing it with nothing picked, is not an answer: the edit keeps waiting.
    if (
      outcome === undefined ||
      outcome === 'back' ||
      outcome instanceof WizardInterruption ||
      (outcome.verdict !== ACCEPT && outcome.verdict !== REJECT)
    )
      return optimize.leaveReview(runId)
    const verdict = outcome.verdict === ACCEPT
    optimize.accept(next.index, verdict, runId)
    if (verdict) accepted += 1
  }
  if (accepted > 0) optimize.apply(runId)
  optimize.finishReview(runId)
}

interface OptimizeReviewOnScreen {
  readonly runId: string
  readonly review: OptimizeReview
  /** The edit that the diff shows, as its index in the review. */
  readonly index: number
  /** Its place among the edits that the screen offers, and how many those are. */
  readonly at: number
  readonly of: number
  /** The question on screen, to answer it. */
  readonly request: string
}

/** The diff of a finished run that is on the developer's screen with its question unanswered, when one is. */
const optimizeReviewOnScreen = (sessions: EvalsDevSessions): OptimizeReviewOnScreen | undefined => {
  const pending = sessions.ask.pending()
  if (!pending?.standing || pending.topic === undefined) return undefined
  const index = askingIn(sessions).get(pending.topic)
  const review = waitingReview(sessions, pending.topic)
  if (index === undefined || !review?.edits[index]) return undefined
  const offered = review.edits.flatMap((edit, position) => (edit.unavailable ? [] : [position]))
  return { runId: pending.topic, review, index, at: offered.indexOf(index), of: offered.length, request: pending.id }
}

const CONTEXT_TEXT_LIMIT = 600

const quoted = (text: string): string =>
  JSON.stringify(text.length <= CONTEXT_TEXT_LIMIT ? text : `${text.slice(0, CONTEXT_TEXT_LIMIT)}…`)

const change = (edit: ProposedEdit): string =>
  edit.kind === 'text'
    ? `${edit.label} in ${target(edit)}: now ${quoted(edit.before)}, would become ${quoted(edit.after)}`
    : `${edit.label} in ${target(edit)}: ${edit.before} → ${edit.after}`

const answerSoFar = (edit: ProposedEdit): string => {
  if (edit.unavailable !== undefined) return `cannot be written from strands dev (${edit.unavailable})`
  if (!edit.decided) return 'not answered yet'
  return edit.accepted ? 'answered on screen: apply' : 'answered on screen: leave as it is'
}

/**
 * What the developer is looking at when a diff is on their screen, said for the agent. It goes with a chat message
 * sent while the diff shows, so that "approve this" has a this.
 */
export const optimizeReviewContext = (sessions: EvalsDevSessions): string | undefined => {
  const shown = optimizeReviewOnScreen(sessions)
  if (!shown) return undefined
  const { review, index, at, of } = shown
  const edit = review.edits[index]!
  const others = review.edits.flatMap((other, position) =>
    position === index ? [] : [`- edit ${position}, ${change(other)}: ${answerSoFar(other)}`]
  )
  return [
    `On the developer's screen as they sent this message: a diff from the finished optimization run ${review.run}. ` +
      `It asks "Apply this change to ${edit.label}?" with the choices "Apply this change" and "Leave it as it is", ` +
      'and they have picked neither.',
    `The diff shows edit ${index}${of > 1 ? ` (${at + 1} of the ${of} that this run offers)` : ''}: ${change(edit)}`,
    `The run measured ${review.baseline} for the agent as it is and ${review.best} for the new version, on the ${review.measuredOn}.`,
    ...(others.length > 0 ? ['The other edits of this run:', ...others] : []),
    'When the message is their answer to this diff, such as "approve this", "apply it", "yes", or "no, leave it", ' +
      `pick for them: call strands_dev_answer_review with run "${review.run}", edit ${index}, and answer "apply" or ` +
      '"leave". That does what picking the choice on their screen does, and the diff closes. Do not ask them to ' +
      'confirm an answer they just gave, and do not use strands_dev_apply_optimization for it. When the message is ' +
      'about something else, or you cannot tell whether it answers this diff, leave the diff alone and reply to ' +
      'the message.',
  ].join('\n')
}

interface SettledOptimizeReview {
  readonly run: string
  /** Every edit of the run has its answer, so the review is over, its diff is closed, and what it accepted is written. */
  readonly settled: boolean
  /** What the run wrote, once it was settled with an edit to apply. */
  readonly applied?: readonly string[]
  readonly applyError?: string
}

export interface AnsweredOptimizeReview extends SettledOptimizeReview {
  /** The diff that took the place of the answered one on screen, when the run has another edit to answer. */
  readonly next?: { readonly edit: number; readonly change: string; readonly at: number; readonly of: number }
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** What a settled run wrote, once the edits it accepted are written or the run is gone. */
const written = ({ optimize }: EvalsDevSessions, runId: string, run: string): Promise<SettledOptimizeReview> =>
  new Promise((resolve) => {
    const look = (): boolean => {
      const found = optimize.snapshot().runs?.find((candidate) => candidate.id === runId)
      const review = found?.state.step === 'review' ? found.state.review : undefined
      const writes = review?.edits.some((edit) => edit.decided && edit.accepted && edit.unavailable === undefined)
      if (review && writes && !review.applied) return false
      resolve({
        run,
        settled: true,
        ...(review?.applied ? { applied: review.applied } : {}),
        ...(review?.applyError ? { applyError: review.applyError } : {}),
      })
      return true
    }
    if (look()) return
    const stop = optimize.subscribe(() => {
      if (look()) stop()
    })
  })

/**
 * Picks a choice of the diff on screen in the developer's place, when they answered it in a chat message. It is the
 * same answer as theirs on screen: the walk moves to the next edit, or writes what was accepted and ends the review.
 * Refuses when that diff is not the one showing, so a late answer cannot land on another question.
 */
export const answerOptimizeReview = async (
  sessions: EvalsDevSessions,
  answer: { readonly run: string; readonly edit: number; readonly apply: boolean }
): Promise<AnsweredOptimizeReview> => {
  const shown = optimizeReviewOnScreen(sessions)
  if (!shown || shown.review.run !== answer.run || shown.index !== answer.edit) {
    const showing = shown
      ? `The diff on screen is edit ${shown.index} of run ${shown.review.run}.`
      : 'No optimization diff is on screen.'
    throw new Error(
      `Edit ${answer.edit} of run ${answer.run} is not the diff on the developer's screen now, so nothing was ` +
        `picked. ${showing} strands_dev_status says what still waits.`
    )
  }
  const { runId, review } = shown
  sessions.ask.respond(shown.request, { verdict: answer.apply ? ACCEPT : REJECT })
  // The walk carries on from the answer before anything else runs: it asks about the next edit, or ends the review.
  await nextTurn()
  if (waitingReview(sessions, runId)) {
    const next = optimizeReviewOnScreen(sessions)
    return {
      run: review.run,
      settled: false,
      ...(next?.runId === runId
        ? { next: { edit: next.index, change: change(next.review.edits[next.index]!), at: next.at, of: next.of } }
        : {}),
    }
  }
  return written(sessions, runId, review.run)
}

export interface AppliedOptimizeEdits extends SettledOptimizeReview {
  /** How many edits of the run still wait for the developer's answer. Nothing is written while one does. */
  readonly waiting?: number
  /** The diff of a waiting edit is on the developer's screen. */
  readonly shown?: boolean
}

/**
 * Answers the edits `edits` of the run `run` with apply, for a developer who named them in chat. Every other edit
 * keeps the answer it has: the one given on screen, or none yet. As on screen, the run is written once every edit
 * has its answer, so while one still waits its diff goes on screen and nothing is written.
 */
export const applyOptimizeEdits = async (
  sessions: EvalsDevSessions,
  { run, edits }: { readonly run: string; readonly edits: readonly number[] }
): Promise<AppliedOptimizeEdits> => {
  const { optimize, ask } = sessions
  const found = optimize.snapshot().runs?.find(({ state }) => state.step === 'review' && state.review.run === run)
  if (found?.state.step !== 'review')
    throw new Error(`No finished optimization is named ${run}. strands_dev_status names the runs.`)
  const { review } = found.state
  if (review.applied)
    throw new Error(`The edits of run ${run} were written already: ${review.applied.join(', ') || 'none of them'}.`)
  if (edits.length === 0) throw new Error('Name at least one edit to apply.')
  for (const index of edits) {
    const edit = review.edits[index]
    if (!edit) throw new Error(`Run ${run} has no edit ${index}.`)
    if (edit.unavailable) throw new Error(`Edit ${index} cannot be written: ${edit.unavailable}`)
  }
  for (const index of edits) optimize.accept(index, true, found.id)
  const waiting = waitingReview(sessions, found.id)
  const left = waiting ? waiting.edits.filter((edit) => edit.unavailable === undefined && !edit.decided).length : 0
  if (left > 0) {
    // A diff that asks about an edit which now has its answer makes way for the one that still waits.
    const showing = optimizeReviewOnScreen(sessions)
    if (showing?.runId === found.id && edits.includes(showing.index)) {
      ask.withdraw(found.id)
      await nextTurn()
    }
    return { run, settled: false, waiting: left, shown: showOptimizeReview(sessions, found.id) }
  }
  optimize.apply(found.id)
  return written(sessions, found.id, run)
}
