import { describe, expect, it } from 'vitest'
import {
  MultiAgentInitializedEvent,
  BeforeMultiAgentInvocationEvent,
  AfterMultiAgentInvocationEvent,
  BeforeNodeCallEvent,
  AfterNodeCallEvent,
  NodeStreamUpdateEvent,
  NodeResultEvent,
  NodeCancelEvent,
  MultiAgentHandoffEvent,
  MultiAgentResultEvent,
} from '../events.js'
import { MultiAgentResult, MultiAgentState, NodeResult, Status } from '../state.js'
import type { MultiAgent } from '../multiagent.js'
import type { AgentStreamEvent } from '../../types/agent.js'

const mockOrchestrator: MultiAgent = {
  id: 'test-orchestrator',
  invoke: async () => new MultiAgentResult({ results: [], duration: 0 }),
  // eslint-disable-next-line require-yield
  async *stream() {
    return new MultiAgentResult({ results: [], duration: 0 })
  },
  addHook: () => () => {},
}

describe('MultiAgentInitializedEvent', () => {
  it('creates instance with correct properties', () => {
    const event = new MultiAgentInitializedEvent({ orchestrator: mockOrchestrator })

    expect(event).toEqual({
      type: 'multiAgentInitializedEvent',
      orchestrator: mockOrchestrator,
    })
    // @ts-expect-error verifying that property is readonly
    event.orchestrator = mockOrchestrator
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const event = new MultiAgentInitializedEvent({ orchestrator: mockOrchestrator })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  describe('toJSON', () => {
    const event = new MultiAgentInitializedEvent({ orchestrator: mockOrchestrator })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({ type: 'multiAgentInitializedEvent' })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['orchestrator'])
    })
  })
})

describe('BeforeMultiAgentInvocationEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const event = new BeforeMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'beforeMultiAgentInvocationEvent',
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.orchestrator = mockOrchestrator
    // @ts-expect-error verifying that property is readonly
    event.state = state
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const state = new MultiAgentState()
    const event = new BeforeMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  describe('toJSON', () => {
    const event = new BeforeMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state: new MultiAgentState(),
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({ type: 'beforeMultiAgentInvocationEvent' })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['orchestrator', 'state', 'invocationState'])
    })
  })
})

describe('AfterMultiAgentInvocationEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const event = new AfterMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'afterMultiAgentInvocationEvent',
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.orchestrator = mockOrchestrator
    // @ts-expect-error verifying that property is readonly
    event.state = state
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const state = new MultiAgentState()
    const event = new AfterMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state,
      invocationState: {},
    })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  describe('toJSON', () => {
    const event = new AfterMultiAgentInvocationEvent({
      orchestrator: mockOrchestrator,
      state: new MultiAgentState(),
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({ type: 'afterMultiAgentInvocationEvent' })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['orchestrator', 'state', 'invocationState'])
    })
  })
})

describe('BeforeNodeCallEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const event = new BeforeNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'beforeNodeCallEvent',
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      cancel: false,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.orchestrator = mockOrchestrator
    // @ts-expect-error verifying that property is readonly
    event.state = state
    // @ts-expect-error verifying that property is readonly
    event.nodeId = 'node-1'
  })

  it('returns false for _shouldReverseCallbacks', () => {
    const state = new MultiAgentState()
    const event = new BeforeNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
    })
    expect(event._shouldReverseCallbacks()).toBe(false)
  })

  it('allows cancel to be set to true', () => {
    const state = new MultiAgentState()
    const event = new BeforeNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
    })

    expect(event.cancel).toBe(false)
    event.cancel = true
    expect(event.cancel).toBe(true)
  })

  it('allows cancel to be set to a string message', () => {
    const state = new MultiAgentState()
    const event = new BeforeNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
    })

    event.cancel = 'node is not ready'
    expect(event.cancel).toBe('node is not ready')
  })

  describe('toJSON', () => {
    const event = new BeforeNodeCallEvent({
      orchestrator: mockOrchestrator,
      state: new MultiAgentState(),
      nodeId: 'node-1',
      invocationState: {},
    })
    event.cancel = true

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'beforeNodeCallEvent',
        nodeId: 'node-1',
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual([
        'orchestrator',
        'state',
        'invocationState',
        'cancel',
      ])
    })
  })
})

describe('AfterNodeCallEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const error = new Error('node failed')
    const event = new AfterNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
      error,
    })

    expect(event).toEqual({
      type: 'afterNodeCallEvent',
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
      error,
    })
    // @ts-expect-error verifying that property is readonly
    event.orchestrator = mockOrchestrator
    // @ts-expect-error verifying that property is readonly
    event.state = state
    // @ts-expect-error verifying that property is readonly
    event.nodeId = 'node-1'
  })

  it('returns true for _shouldReverseCallbacks', () => {
    const state = new MultiAgentState()
    const event = new AfterNodeCallEvent({
      orchestrator: mockOrchestrator,
      state,
      nodeId: 'node-1',
      invocationState: {},
    })
    expect(event._shouldReverseCallbacks()).toBe(true)
  })

  describe('toJSON', () => {
    const event = new AfterNodeCallEvent({
      orchestrator: mockOrchestrator,
      state: new MultiAgentState(),
      nodeId: 'node-1',
      invocationState: {},
      error: new Error('node failed'),
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'afterNodeCallEvent',
        nodeId: 'node-1',
        error: { message: 'node failed' },
      })
    })

    it('serializes without error', () => {
      const event = new AfterNodeCallEvent({
        orchestrator: mockOrchestrator,
        state: new MultiAgentState(),
        nodeId: 'node-1',
        invocationState: {},
      })

      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'afterNodeCallEvent',
        nodeId: 'node-1',
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['orchestrator', 'state', 'invocationState'])
    })
  })
})

describe('NodeStreamUpdateEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const innerEvent = { source: 'agent', event: { type: 'beforeInvocationEvent' } as AgentStreamEvent } as const
    const event = new NodeStreamUpdateEvent({
      nodeId: 'node-1',
      nodeType: 'agentNode',
      state,
      inner: innerEvent,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'nodeStreamUpdateEvent',
      nodeId: 'node-1',
      nodeType: 'agentNode',
      state,
      inner: innerEvent,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.nodeId = 'node-1'
    // @ts-expect-error verifying that property is readonly
    event.nodeType = 'agentNode'
    // @ts-expect-error verifying that property is readonly
    event.state = state
    // @ts-expect-error verifying that property is readonly
    event.inner = innerEvent
  })

  describe('toJSON', () => {
    const innerEvent = { source: 'agent', event: { type: 'beforeInvocationEvent' } as AgentStreamEvent } as const
    const event = new NodeStreamUpdateEvent({
      nodeId: 'node-1',
      nodeType: 'agentNode',
      state: new MultiAgentState(),
      inner: innerEvent,
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'nodeStreamUpdateEvent',
        nodeId: 'node-1',
        nodeType: 'agentNode',
        inner: { source: 'agent', event: { type: 'beforeInvocationEvent' } },
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['state', 'invocationState'])
    })
  })
})

describe('NodeResultEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const result = new NodeResult({ nodeId: 'node-1', status: Status.COMPLETED, duration: 100 })
    const event = new NodeResultEvent({ nodeId: 'node-1', nodeType: 'agentNode', state, result, invocationState: {} })

    expect(event).toEqual({
      type: 'nodeResultEvent',
      nodeId: 'node-1',
      nodeType: 'agentNode',
      state,
      result,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.nodeId = 'node-1'
    // @ts-expect-error verifying that property is readonly
    event.nodeType = 'agentNode'
    // @ts-expect-error verifying that property is readonly
    event.state = state
    // @ts-expect-error verifying that property is readonly
    event.result = result
  })

  describe('toJSON', () => {
    const event = new NodeResultEvent({
      nodeId: 'node-1',
      nodeType: 'agentNode',
      state: new MultiAgentState(),
      result: new NodeResult({ nodeId: 'node-1', status: Status.COMPLETED, duration: 100 }),
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'nodeResultEvent',
        nodeId: 'node-1',
        nodeType: 'agentNode',
        result: {
          type: 'nodeResult',
          nodeId: 'node-1',
          status: 'COMPLETED',
          duration: 100,
          content: [],
        },
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['state', 'invocationState'])
    })
  })
})

describe('NodeCancelEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const event = new NodeCancelEvent({ nodeId: 'node-1', state, message: 'cancelled by hook', invocationState: {} })

    expect(event).toEqual({
      type: 'nodeCancelEvent',
      nodeId: 'node-1',
      state,
      message: 'cancelled by hook',
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.nodeId = 'node-1'
    // @ts-expect-error verifying that property is readonly
    event.state = state
    // @ts-expect-error verifying that property is readonly
    event.message = 'cancelled by hook'
  })

  describe('toJSON', () => {
    const event = new NodeCancelEvent({
      nodeId: 'node-1',
      state: new MultiAgentState(),
      message: 'cancelled by hook',
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'nodeCancelEvent',
        nodeId: 'node-1',
        message: 'cancelled by hook',
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['state', 'invocationState'])
    })
  })
})

describe('MultiAgentHandoffEvent', () => {
  it('creates instance with correct properties', () => {
    const state = new MultiAgentState()
    const event = new MultiAgentHandoffEvent({
      source: 'node-a',
      targets: ['node-b', 'node-c'],
      state,
      invocationState: {},
    })

    expect(event).toEqual({
      type: 'multiAgentHandoffEvent',
      source: 'node-a',
      targets: ['node-b', 'node-c'],
      state,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.source = 'node-a'
    // @ts-expect-error verifying that property is readonly
    event.targets = []
    // @ts-expect-error verifying that property is readonly
    event.state = state
  })

  describe('toJSON', () => {
    const event = new MultiAgentHandoffEvent({
      source: 'node-a',
      targets: ['node-b', 'node-c'],
      state: new MultiAgentState(),
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'multiAgentHandoffEvent',
        source: 'node-a',
        targets: ['node-b', 'node-c'],
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['state', 'invocationState'])
    })
  })
})

describe('MultiAgentResultEvent', () => {
  it('creates instance with correct properties', () => {
    const result = new MultiAgentResult({ results: [], duration: 0 })
    const event = new MultiAgentResultEvent({ result, invocationState: {} })

    expect(event).toEqual({
      type: 'multiAgentResultEvent',
      result,
      invocationState: {},
    })
    // @ts-expect-error verifying that property is readonly
    event.result = result
  })

  describe('toJSON', () => {
    const event = new MultiAgentResultEvent({
      result: new MultiAgentResult({ results: [], duration: 500 }),
      invocationState: {},
    })

    it('serializes', () => {
      expect(JSON.parse(JSON.stringify(event))).toStrictEqual({
        type: 'multiAgentResultEvent',
        result: {
          type: 'multiAgentResult',
          status: 'COMPLETED',
          results: [],
          content: [],
          duration: 500,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      })
    })

    it('only excludes expected fields', () => {
      const json = event.toJSON()
      expect(Object.keys(event).filter((k) => !(k in json))).toStrictEqual(['invocationState'])
    })
  })
})
