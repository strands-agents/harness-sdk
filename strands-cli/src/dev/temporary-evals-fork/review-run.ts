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
          selected: [ACCEPT],
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
export const reviewOptimizeRun = async (sessions: TemporaryDevSessions, runId: string): Promise<void> => {
  const { optimize, ask } = sessions
  optimize.openRun(runId)
  const run = optimize.snapshot().runs?.find((candidate) => candidate.id === runId)
  if (run?.state.step !== 'review') return
  const open = run.state.review.edits.flatMap((edit, index) => (edit.unavailable ? [] : [{ edit, index }]))
  let accepted = 0
  for (const [at, { edit, index }] of open.entries()) {
    const outcome = await ask.ask(question(edit, run.state.review.run, at, open.length))
    if (outcome === undefined) {
      optimize.accept(index, false)
      break
    }
    const verdict = outcome.verdict === ACCEPT
    optimize.accept(index, verdict)
    if (verdict) accepted += 1
  }
  if (accepted > 0) optimize.apply()
}
