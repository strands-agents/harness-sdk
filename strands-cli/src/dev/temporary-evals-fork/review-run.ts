import { createDiffPreview } from '../../agent/file-changes.js'
import type { WizardRequestSpec } from '../../ui/panels/wizard-request.js'
import type { ProposedEdit } from '../panels/model.js'
import type { TemporaryDevSessions } from './sessions.js'

const ACCEPT = 'accept'

const target = (edit: ProposedEdit): string => edit.target ?? edit.label

const question = (edit: ProposedEdit, run: string, at: number, of: number): WizardRequestSpec => ({
  name: 'optimize',
  titleParts: of > 1 ? [run, `edit ${at + 1} of ${of}`] : [run],
  question: `Apply this change to ${edit.label}?`,
  // The run is over and no turn waits on this, so asking the agent about the change must not answer it.
  standing: true,
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
 * Walks a finished run's edits one at a time and applies only the accepted ones.
 * Cancelling a question rejects that edit and stops, so the rest stay unapplied.
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

const walkRun = async ({ optimize, ask }: TemporaryDevSessions, runId: string): Promise<void> => {
  if (!optimize.focusRun(runId)) return
  const run = optimize.snapshot().runs?.find((candidate) => candidate.id === runId)
  if (run?.state.step !== 'review') return
  const open = run.state.review.edits.flatMap((edit, index) => (edit.unavailable ? [] : [{ edit, index }]))
  let accepted = 0
  for (const [at, { edit, index }] of open.entries()) {
    const outcome = await ask.ask(question(edit, run.state.review.run, at, open.length))
    if (outcome === undefined) {
      optimize.accept(index, false, runId)
      break
    }
    const verdict = outcome.verdict === ACCEPT
    optimize.accept(index, verdict, runId)
    if (verdict) accepted += 1
  }
  if (accepted > 0) optimize.apply(runId)
  optimize.finishReview(runId)
}
