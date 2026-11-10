import { describe, expect, it } from 'vitest'
import { A2AStreamUpdateEvent, A2AResultEvent } from '../events.js'
import { AgentResult } from '../../types/agent.js'
import { Message, TextBlock } from '../../types/messages.js'
import { AgentMetrics } from '../../telemetry/meter.js'
import type { A2AEventData } from '../events.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

describe('A2AStreamUpdateEvent', () => {
  it('creates instance with correct properties', () => {
    const eventData = { kind: 'status-update', taskId: 'task-1', status: { state: 'working' } } as A2AEventData
    const event = new A2AStreamUpdateEvent(eventData)

    expect(event.type).toBe('a2aStreamUpdateEvent')
    expect(event.event).toBe(eventData)
  })

  describe('toJSON', () => {
    const event = new A2AStreamUpdateEvent({
      kind: 'status-update',
      taskId: 'task-1',
      status: { state: 'working' },
    } as A2AEventData)

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'a2aStreamUpdateEvent',
        event: { kind: 'status-update', taskId: 'task-1', status: { state: 'working' } },
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual([])
    })
  })
})

describe('A2AResultEvent', () => {
  it('creates instance with correct properties', () => {
    const result = new AgentResult({
      stopReason: 'endTurn',
      lastMessage: new Message({ role: 'assistant', content: [new TextBlock('Done')] }),
      metrics: new AgentMetrics(),
      invocationState: {},
    })
    const event = new A2AResultEvent({ result })

    expect(event.type).toBe('a2aResultEvent')
    expect(event.result).toBe(result)
  })

  describe('toJSON', () => {
    const event = new A2AResultEvent({
      result: new AgentResult({
        stopReason: 'endTurn',
        lastMessage: new Message({ role: 'assistant', content: [new TextBlock('Done')] }),
        metrics: new AgentMetrics(),
        invocationState: {},
      }),
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'a2aResultEvent',
        result: {
          type: 'agentResult',
          stopReason: 'endTurn',
          lastMessage: {
            role: 'assistant',
            content: [{ text: 'Done' }],
            trackingId: anyTrackingId,
          },
        },
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual([])
    })
  })
})
