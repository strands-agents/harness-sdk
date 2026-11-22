import { createDiffPreview } from '../../agent/file-changes.js'
import type { WizardRequestSpec } from '../../ui/panels/wizard-request.js'
import type { OptimizeReview, ProposedEdit } from '../panels/model.js'
import type { TemporaryDevSessions } from './sessions.js'

const ACCEPT = 'accept'

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
  steps: [
    {
      key: 'review',
      title: 'Review',
      fields: [
        {
          kind: 'select',
          key: 'verdict',
          options: [
            { value: ACCEPT, label: 'Apply this change' },
            { value: 'reject', label: 'Leave it as it is' },
          ],
          multiple: false,
        },
        {
          kind: 'diff',
          key: 'change',
          label: edit.label,
          path: target(edit),
          proposed: edit.after,
          diff: createDiffPreview(target(edit), edit.before, edit.after),
        },
      ],
    },
  ],
})

/**
 * Asks about a finished run's edits one at a time, and writes the accepted ones once every edit has an answer.
 * Closing a question is not an answer: the edit keeps waiting, the run stays on the status line, and opening it
 * again carries on from the first edit without one.
 */
const reviewing = new WeakMap<object, Set<string>>()

export const reviewOptimizeRun = async (sessions: TemporaryDevSessions, runId: string): Promise<void> => {
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

/**
 * Puts a run's waiting edits in front of the developer, ahead of another question that is on screen, for when they
 * or the agent ask for that run. False when it has nothing to ask.
 */
export const showOptimizeReview = (sessions: TemporaryDevSessions, runId: string): boolean => {
  void reviewOptimizeRun(sessions, runId)
  return sessions.ask.bringForward(runId)
}

const waitingReview = ({ optimize }: TemporaryDevSessions, runId: string): OptimizeReview | undefined => {
  const run = optimize.snapshot().runs?.find((candidate) => candidate.id === runId)
  return run?.state.step === 'review' && !run.state.review.reviewed ? run.state.review : undefined
}

const walkRun = async (sessions: TemporaryDevSessions, runId: string): Promise<void> => {
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
    const outcome = await ask.ask(question(next.edit, { id: runId, run: review.run }, at, offered.length))
    if (outcome === undefined) return optimize.leaveReview(runId)
    const verdict = outcome.verdict === ACCEPT
    optimize.accept(next.index, verdict, runId)
    if (verdict) accepted += 1
  }
  if (accepted > 0) optimize.apply(runId)
  optimize.finishReview(runId)
}
