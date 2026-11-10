import type { AfterInvocationEvent, AfterModelCallEvent, LocalAgent, Message } from '@strands-agents/sdk'
import { describe, expect, it } from 'vitest'

import { LiveSteering } from '../src/tui/steering.js'

describe('LiveSteering', () => {
  it('batches pending user updates at the next model boundary for their target agent', () => {
    const steering = new LiveSteering()
    const messages: Message[] = []
    const agent = { messages } as unknown as LocalAgent
    const event = {
      type: 'afterModelCallEvent',
      agent,
    } as unknown as AfterModelCallEvent
    const child = { messages: [] } as unknown as LocalAgent
    const childEvent = {
      type: 'afterModelCallEvent',
      agent: child,
    } as unknown as AfterModelCallEvent

    expect(steering.enqueue(agent, 'focus on the parser')).toBe(true)
    expect(steering.enqueue(agent, 'and keep the API stable')).toBe(true)
    expect(steering.afterModelCall(childEvent)).toMatchObject({ type: 'proceed' })
    const action = steering.afterModelCall(event)

    expect(action).toMatchObject({ type: 'transform', reason: 'Additional user message' })
    if (action.type !== 'transform') {
      throw new Error('Expected steering to transform the model event.')
    }
    action.apply(event)
    expect(event.retry).toBe(true)
    expect(child.messages).toEqual([])
    expect(messages).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'textBlock', text: 'focus on the parser\n\nand keep the API stable' }],
      },
    ])
  })

  it('resumes the same agent when an update arrives at the final invocation boundary', () => {
    const steering = new LiveSteering()
    type FinalEvent = Pick<AfterInvocationEvent, 'agent' | 'resume'>
    let afterInvocation: ((event: FinalEvent) => void) | undefined
    const agent = {
      addHook(_event: unknown, callback: (event: FinalEvent) => void) {
        afterInvocation = callback
      },
    } as unknown as LocalAgent
    steering.observeAgent(agent)
    steering.enqueue(agent, 'check the final result')
    const event = {
      agent,
      resume: undefined,
    }

    afterInvocation?.(event)

    expect(event.resume).toBe('check the final result')
  })
})
