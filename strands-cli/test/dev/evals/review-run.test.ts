import { describe, expect, it, vi } from 'vitest'

import { reviewOptimizeRun } from '../../../src/dev/evals/review-run.js'
import type { EvalsDevSessions } from '../../../src/dev/evals/sessions.js'
import type { WizardOutcome, WizardRequestSpec } from '../../../src/ui/panels/wizard-request.js'

const edit = (label: string, unavailable?: string, answered?: boolean) => ({
  knob: 'instructions' as const,
  kind: 'text' as const,
  label,
  target: `${label}.ts`,
  before: 'before',
  after: 'after',
  accepted: answered === true,
  ...(answered === undefined ? {} : { decided: true }),
  ...(unavailable === undefined ? {} : { unavailable }),
})

const sessions = (
  edits: readonly ReturnType<typeof edit>[],
  answers: readonly WizardOutcome[]
): {
  sessions: EvalsDevSessions
  asked: WizardRequestSpec[]
  accept: ReturnType<typeof vi.fn>
  apply: ReturnType<typeof vi.fn>
  finishReview: ReturnType<typeof vi.fn>
  leaveReview: ReturnType<typeof vi.fn>
} => {
  const asked: WizardRequestSpec[] = []
  const accept = vi.fn()
  const apply = vi.fn()
  const finishReview = vi.fn()
  const leaveReview = vi.fn()
  const queue = [...answers]
  const optimize = {
    focusRun: vi.fn(() => true),
    snapshot: () => ({ runs: [{ id: 'run-1', state: { step: 'review', review: { run: 'r1', edits } } }] }),
    accept,
    apply,
    finishReview,
    leaveReview,
  }
  const ask = {
    ask: (spec: WizardRequestSpec): Promise<WizardOutcome> => {
      asked.push(spec)
      return Promise.resolve(queue.shift())
    },
  }
  return {
    sessions: { optimize, ask } as unknown as EvalsDevSessions,
    asked,
    accept,
    apply,
    finishReview,
    leaveReview,
  }
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

  it('shouldLeaveTheRunWaitingWhenAQuestionIsClosedWithoutAnAnswer', async () => {
    const {
      sessions: devSessions,
      asked,
      accept,
      apply,
      finishReview,
      leaveReview,
    } = sessions([edit('one'), edit('two')], [undefined, { verdict: 'accept' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(asked).toHaveLength(1)
    expect(accept).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(finishReview).not.toHaveBeenCalled()
    expect(leaveReview.mock.calls).toEqual([['run-1']])
  })

  it('shouldWriteNothingWhenAQuestionIsClosedAfterAnEarlierEditWasAccepted', async () => {
    const {
      sessions: devSessions,
      accept,
      apply,
      finishReview,
    } = sessions([edit('one'), edit('two')], [{ verdict: 'accept' }, undefined])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(accept.mock.calls).toEqual([[0, true, 'run-1']])
    expect(apply).not.toHaveBeenCalled()
    expect(finishReview).not.toHaveBeenCalled()
  })

  it('shouldCarryOnFromTheFirstEditWithoutAnAnswerWhenTheRunIsOpenedAgain', async () => {
    const {
      sessions: devSessions,
      asked,
      accept,
      apply,
      finishReview,
    } = sessions([edit('one', undefined, true), edit('two')], [{ verdict: 'reject' }])

    await reviewOptimizeRun(devSessions, 'run-1')

    expect(asked.map(({ question, titleParts }) => [question, titleParts?.[0]])).toEqual([
      ['Apply this change to two?', 'edit 2 of 2'],
    ])
    expect(accept.mock.calls).toEqual([[1, false, 'run-1']])
    expect(apply.mock.calls).toEqual([['run-1']])
    expect(finishReview.mock.calls).toEqual([['run-1']])
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

    const field = asked[0]!.fields.find((candidate) => candidate.kind === 'diff')!
    expect(field).toMatchObject({ kind: 'diff', path: 'one.ts' })
  })
})
