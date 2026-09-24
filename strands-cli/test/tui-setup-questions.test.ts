import type { AgentStreamEvent } from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { SetupQuestionBroker, SetupQuestionTextStream } from '../src/tui/setup/questions.js'

describe('setup questions', () => {
  it('accepts a custom answer and cancels a pending question', async () => {
    const broker = new SetupQuestionBroker()
    const listener = vi.fn()
    broker.subscribe(listener)

    const answer = broker.request('What should the agent do?', [{ label: 'Code' }, { label: 'Research' }])
    const request = listener.mock.calls[0]![0]
    expect(broker.respondText(request.id, 'Review pull requests')).toBe(true)
    await expect(answer).resolves.toEqual({ id: 'custom', label: 'Review pull requests', custom: true })

    const controller = new AbortController()
    const cancelled = broker.request('Choose a style', [{ label: 'Concise' }, { label: 'Detailed' }], controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
  })

  it('streams tool-only question text incrementally without duplicating normal assistant text', () => {
    const streamed = new SetupQuestionTextStream()
    streamed.project(modelEvent({ type: 'modelMessageStartEvent', role: 'assistant' }))
    streamed.project(
      modelEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'setup_question', toolUseId: 'question' },
      })
    )
    const deltas = [
      streamed.project(
        modelEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"question":"Pick' },
        })
      ),
      streamed.project(
        modelEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: ' a model' } })
      ),
      streamed.project(
        modelEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '","choices":[{"label":"Claude"},{"label":"GPT"}]}' },
        })
      ),
    ]
    expect(deltas.join('')).toBe('Pick a model')

    const deduplicated = new SetupQuestionTextStream()
    deduplicated.project(modelEvent({ type: 'modelMessageStartEvent', role: 'assistant' }))
    deduplicated.project(
      modelEvent({ type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Pick a model' } })
    )
    deduplicated.project(
      modelEvent({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'setup_question', toolUseId: 'question' },
      })
    )
    expect(
      deduplicated.project(
        modelEvent({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"question":"Pick a model"' },
        })
      )
    ).toBe('')
  })
})

function modelEvent(event: unknown): AgentStreamEvent {
  return { type: 'modelStreamUpdateEvent', event } as AgentStreamEvent
}
