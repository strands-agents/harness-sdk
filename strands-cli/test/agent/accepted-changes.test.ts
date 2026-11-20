import { describe, expect, it } from 'vitest'

import { AcceptedChanges } from '../../src/agent/accepted-changes.js'

const WORKSPACE = '/workspace'

describe('AcceptedChanges', () => {
  it('shouldSpendTheTicketWhenTheWriteMatchesTheAcceptedText', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')

    expect(accepted.spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'after' })).toBe(true)
  })

  it('shouldSpendOnlyOnceSoASecondWriteStillAsks', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')
    accepted.spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'after' })

    expect(accepted.spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'after' })).toBe(false)
  })

  it('shouldMatchTheSamePathWrittenRelativelyOrAbsolutely', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')

    expect(accepted.spend(WORKSPACE, 'write', { path: '/workspace/agent.ts', content: 'after' })).toBe(true)
  })

  it('shouldRefuseWhenTheContentDiffersFromWhatWasShown', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')

    expect(accepted.spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'something else' })).toBe(false)
  })

  it('shouldRefuseWhenThePathDiffersFromWhatWasShown', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')

    expect(accepted.spend(WORKSPACE, 'write', { path: 'other.ts', content: 'after' })).toBe(false)
  })

  it.each(['edit', 'shell', 'read'])('shouldRefuse%sBecauseOnlyWriteCarriesTheWholeText', (toolName) => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')

    expect(accepted.spend(WORKSPACE, toolName, { path: 'agent.ts', content: 'after' })).toBe(false)
  })

  it('shouldRefuseWhenNothingWasAccepted', () => {
    expect(new AcceptedChanges().spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'after' })).toBe(false)
  })

  it('shouldRefuseAfterClear', () => {
    const accepted = new AcceptedChanges()
    accepted.accept(WORKSPACE, 'agent.ts', 'after')
    accepted.clear()

    expect(accepted.spend(WORKSPACE, 'write', { path: 'agent.ts', content: 'after' })).toBe(false)
  })
})
