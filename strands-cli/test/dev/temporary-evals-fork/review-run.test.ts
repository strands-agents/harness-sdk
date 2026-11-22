import { describe, expect, it, vi } from 'vitest'

import { reviewOptimizeRun } from '../../../src/dev/temporary-evals-fork/review-run.js'
import type { TemporaryDevSessions } from '../../../src/dev/temporary-evals-fork/sessions.js'
import type { WizardOutcome, WizardRequestSpec } from '../../../src/ui/panels/wizard-request.js'

const edit = (label: string, unavailable?: string) => ({
  knob: 'instructions' as const,
  kind: 'text' as const,
  label,
  target: `${label}.ts`,
  before: 'before',
  after: 'after',
  accepted: false,
  ...(unavailable === undefined ? {} : { unavailable }),
})

const sessions = (
  edits: readonly ReturnType<typeof edit>[],
  answers: readonly WizardOutcome[]
): {
  sessions: TemporaryDevSessions
  asked: WizardRequestSpec[]
  accept: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
} => {
  const asked: WizardRequestSpec[] = []
  const accept = vi.fn()
  const apply = vi.fn()
  const queue = [...answers]
  const optimize = {
    focusRun: vi.fn(() => true),
    snapshot: () => ({ runs: [{ id: 'run-1', state: { step: 'review', review: { run: 'r1', edits } } }] }),
    accept,
    apply,
    finishReview: vi.fn(),
  }
  const ask = {
    ask: (spec: WizardRequestSpec): Promise<WizardOutcome> => {
      asked.push(spec)
      return Promise.resolve(queue.shift())
    },
  }
  return { sessions: { optimize, ask } as unknown as TemporaryDevSessions, asked, accept, apply }
}

describe('reviewOptimizeRun', () => {
  it('shouldApplyOnlyTheEditTheDeveloperAccepted', async () => {
    const {
      sessions: devSessions,
      accept,
      apply,
    } = sessions([edit('one'), edit('two')], [{ verdict: 'accept' }, { verdict: 'reject' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(accept.mock.calls).toEqual([
      [0, true, 'run-1'],
      [1, false, 'run-1'],
    ])
    expect(apply.mock.calls).toEqual([['run-1']])
  })

  it('shouldNotApplyAnythingWhenEveryEditIsRejected', async () => {
    const { sessions: devSessions, apply } = sessions([edit('one')], [{ verdict: 'reject' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(apply).not.toHaveBeenCalled()
  })

  it('shouldStopAtACancelAndLeaveTheRestUnapplied', async () => {
    const {
      sessions: devSessions,
      asked,
      accept,
      apply,
    } = sessions([edit('one'), edit('two')], [undefined, { verdict: 'accept' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(asked).toHaveLength(1)
    expect(accept.mock.calls).toEqual([[0, false, 'run-1']])
    expect(apply).not.toHaveBeenCalled()
  })

  it('shouldSkipAnEditThatCannotBeApplied', async () => {
    const { sessions: devSessions, asked } = sessions(
      [edit('one', 'the file moved'), edit('two')],
      [{ verdict: 'accept' }]
    )

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(asked).toHaveLength(1)
    expect(asked[0]!.question).toContain('two')
  })

  it('shouldShowTheChangeAsADiffOfTheEditTarget', async () => {
    const { sessions: devSessions, asked } = sessions([edit('one')], [{ verdict: 'accept' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    const field = asked[0]!.steps[0]!.fields.find((candidate) => candidate.kind === 'diff')!
    expect(field).toMatchObject({ kind: 'diff', path: 'one.ts', proposed: 'after' })
  })
})
