import {
  Agent,
  Model,
  type BeforeModelCallEvent,
  type LocalAgent,
  type Message,
  type ModelStreamEvent,
} from '@strands-agents/sdk'
import { describe, expect, it, vi } from 'vitest'

import { LiveSteering } from '../src/tui/steering.js'

describe('LiveSteering', () => {
  it('batches pending user updates at the next model boundary for their target agent', () => {
    const steering = new LiveSteering()
    const messages: Message[] = []
    const agent = { messages } as unknown as LocalAgent
    const event = {
      type: 'beforeModelCallEvent',
      agent,
    } as unknown as BeforeModelCallEvent
    const child = { messages: [] } as unknown as LocalAgent
    const childEvent = {
      type: 'beforeModelCallEvent',
      agent: child,
    } as unknown as BeforeModelCallEvent
    const consumed = vi.fn()

    expect(steering.enqueue(agent, 'focus on the parser', consumed)).toBe(true)
    expect(steering.enqueue(agent, 'and keep the API stable')).toBe(true)
    expect(steering.beforeModelCall(childEvent)).toMatchObject({ type: 'proceed' })
    const action = steering.beforeModelCall(event)

    expect(action).toMatchObject({ type: 'transform', reason: 'Additional user message' })
    if (action.type !== 'transform') {
      throw new Error('Expected steering to transform the model event.')
    }
    expect(consumed).not.toHaveBeenCalled()
    action.apply(event)
    expect(consumed).toHaveBeenCalledOnce()
    expect(child.messages).toEqual([])
    expect(messages).toMatchObject([
      {
        role: 'user',
        content: [{ type: 'textBlock', text: 'focus on the parser\n\nand keep the API stable' }],
      },
    ])
  })

  it('preserves the completed response before continuing with steering', async () => {
    const steering = new LiveSteering()
    const requests: string[][] = []
    const consumed = vi.fn()
    let agent!: Agent

    class SteeringModel extends Model {
      private callCount = 0

      getConfig() {
        return { modelId: 'steering-test', contextWindowLimit: 10_000 }
      }

      updateConfig(): void {}

      async *stream(messages: readonly Message[]): AsyncIterable<ModelStreamEvent> {
        requests.push(messages.map(messageText))
        this.callCount += 1
        if (this.callCount === 1) {
          steering.enqueue(agent, 'steering message', consumed)
        }
        const response = this.callCount === 1 ? 'first response' : 'steered response'
        yield { type: 'modelMessageStartEvent', role: 'assistant' }
        yield { type: 'modelContentBlockStartEvent' }
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: response } }
        yield { type: 'modelContentBlockStopEvent' }
        yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
        yield {
          type: 'modelMetadataEvent',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          metrics: { latencyMs: 1 },
        }
      }
    }

    agent = new Agent({ model: new SteeringModel(), interventions: [steering], printer: false })
    steering.observeAgent(agent)
    await agent.invoke('message 1')

    expect(consumed).toHaveBeenCalledOnce()
    expect(requests).toEqual([['message 1'], ['message 1', 'first response', 'steering message']])
    expect(agent.messages.map(messageText)).toEqual([
      'message 1',
      'first response',
      'steering message',
      'steered response',
    ])
  })
})

function messageText(message: Message): string {
  return message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('')
}
