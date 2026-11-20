import { describe, expect, it } from 'vitest'

import { askRequestFrom } from '../../../src/dev/temporary-evals-fork/ask-tool.js'

const CHANGE = { path: 'agent/agent.ts', before: 'one\ntwo\n', after: 'one\nthree\n' }

const confirmWithDiff = (diff: Record<string, unknown>) =>
  askRequestFrom({ ask: 'confirm', question: 'Apply this change?', diff } as never)

describe('a question that carries a file change', () => {
  it('shouldHoldTheVerdictAndTheDiffInOneStep', () => {
    const request = confirmWithDiff(CHANGE)

    expect(request.steps[0]!.fields.map(({ kind }) => kind)).toEqual(['select', 'diff'])
  })

  it('shouldShowTheChangeAsAddedAndRemovedLines', () => {
    const request = confirmWithDiff(CHANGE)

    const field = request.steps[0]!.fields.find((candidate) => candidate.kind === 'diff')!
    expect(field.kind === 'diff' && field.diff.lines.some((line) => line.kind === 'add' && line.text === 'three')).toBe(
      true
    )
    expect(
      field.kind === 'diff' && field.diff.lines.some((line) => line.kind === 'remove' && line.text === 'two')
    ).toBe(true)
  })

  it('shouldCarryTheWholeProposedTextSoTheWriteCanBePreApproved', () => {
    const request = confirmWithDiff(CHANGE)

    const field = request.steps[0]!.fields.find((candidate) => candidate.kind === 'diff')!
    expect(field).toMatchObject({ path: CHANGE.path, proposed: CHANGE.after })
  })

  it('shouldNameTheChangeAfterTheFileWhenNoLabelIsSent', () => {
    expect(confirmWithDiff(CHANGE).steps[0]!.fields[1]).toMatchObject({ label: 'agent.ts' })
  })

  it('shouldKeepASentLabel', () => {
    expect(confirmWithDiff({ ...CHANGE, label: 'instructions' }).steps[0]!.fields[1]).toMatchObject({
      label: 'instructions',
    })
  })

  it('shouldRefuseAChangeThatChangesNothing', () => {
    expect(() => confirmWithDiff({ path: 'a.ts', before: 'same', after: 'same' })).toThrow('nothing to show')
  })

  it.each(['before', 'after'])('shouldRefuseWhen%sIsMissing', (missing) => {
    const diff: Record<string, unknown> = { ...CHANGE }
    delete diff[missing]

    expect(() => confirmWithDiff(diff)).toThrow('must both be text')
  })

  it('shouldRefuseWhenThePathIsMissing', () => {
    expect(() => confirmWithDiff({ before: 'one', after: 'two' })).toThrow('diff.path')
  })

  it('shouldAskWithoutADiffWhenNoneIsSent', () => {
    const request = askRequestFrom({ ask: 'confirm', question: 'Go ahead?' } as never)

    expect(request.steps[0]!.fields.map(({ kind }) => kind)).toEqual(['select'])
  })
})
