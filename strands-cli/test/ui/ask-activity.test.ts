import { describe, expect, it } from 'vitest'

import type { ChatTurn } from '../../src/agent/types.js'
import { turnActivity, turnActivityText, TURN_ACTIVITY } from '../../src/ui/chat/transcript-turn.js'
import { isOnScreenQuestionTool } from '../../src/ui/chat/state.js'

const turn = (name: string, status: 'running' | 'success'): ChatTurn => ({
  id: 'turn-1',
  prompt: 'optimize my agent',
  agentName: 'agent',
  entries: [{ id: 'tool-1', type: 'tool', toolUseId: 'use-1', name, status, input: {} }],
  status: 'running',
})

describe('isOnScreenQuestionTool', () => {
  it.each(['strands_dev_ask', 'strands-dev-ask', 'STRANDS_DEV_ASK'])('shouldMatch%s', (name) => {
    expect(isOnScreenQuestionTool(name)).toBe(true)
  })

  it.each(['strands_dev_optimize', 'strands_config', 'shell'])('shouldNotMatch%s', (name) => {
    expect(isOnScreenQuestionTool(name)).toBe(false)
  })
})

describe('the turn line while a question is on screen', () => {
  it('shouldSayItWaitsForTheDeveloperRatherThanWorking', () => {
    expect(turnActivity(turn('strands_dev_ask', 'running'), false)).toBe('awaitingAnswer')
  })

  it('shouldKeepWorkingWhenTheQuestionIsAnswered', () => {
    expect(turnActivity(turn('strands_dev_ask', 'success'), false)).toBe('working')
  })

  it('shouldLeaveApprovalAhead', () => {
    expect(turnActivity(turn('strands_dev_ask', 'running'), true)).toBe('awaitingApproval')
  })

  it('shouldNotOfferEscBecauseTheQuestionOwnsIt', () => {
    expect(TURN_ACTIVITY.awaitingAnswer.interruptible).toBe(false)
    expect(turnActivityText('awaitingAnswer', turn('strands_dev_ask', 'running'), '|')).toBe(
      '◆ Waiting for your answer'
    )
  })
})
