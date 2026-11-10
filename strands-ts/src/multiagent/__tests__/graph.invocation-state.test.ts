import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { BeforeModelCallEvent } from '../../hooks/events.js'
import { TextBlock } from '../../types/messages.js'
import { Graph } from '../graph.js'
import {
  AfterMultiAgentInvocationEvent,
  AfterNodeCallEvent,
  BeforeMultiAgentInvocationEvent,
  BeforeNodeCallEvent,
  MultiAgentHandoffEvent,
  MultiAgentResultEvent,
  NodeResultEvent,
  NodeStreamUpdateEvent,
} from '../events.js'
import type { InvocationState } from '../../types/agent.js'

describe('Graph invocationState forwarding', () => {
  it('forwards invocationState to every node and mutations from one node are visible to the next', async () => {
    const nodeAObserved: InvocationState[] = []
    const nodeBObserved: InvocationState[] = []

    const agentA = new Agent({
      model: new MockMessageModel().addTurn(new TextBlock('A done')),
      printer: false,
      id: 'a',
    })
    agentA.addHook(BeforeModelCallEvent, (event) => {
      nodeAObserved.push(event.invocationState)
      event.invocationState.touchedByA = true
    })

    const agentB = new Agent({
      model: new MockMessageModel().addTurn(new TextBlock('B done')),
      printer: false,
      id: 'b',
    })
    agentB.addHook(BeforeModelCallEvent, (event) => {
      nodeBObserved.push(event.invocationState)
    })

    const graph = new Graph({
      nodes: [agentA, agentB],
      edges: [{ source: 'a', target: 'b' }],
    })

    const state: InvocationState = { requestId: 'r-1' }
    await graph.invoke('hello', { invocationState: state })

    // Both nodes observe the same object reference.
    expect(nodeAObserved[0]).toBe(state)
    expect(nodeBObserved[0]).toBe(state)

    // Node B sees node A's mutation.
    expect(nodeBObserved[0]?.touchedByA).toBe(true)
    expect(state.touchedByA).toBe(true)
  })

  it('defaults invocationState to {} when none is passed', async () => {
    let observed: InvocationState | undefined

    const agentA = new Agent({
      model: new MockMessageModel().addTurn(new TextBlock('A done')),
      printer: false,
      id: 'a',
    })
    agentA.addHook(BeforeModelCallEvent, (event) => {
      observed = event.invocationState
    })

    const graph = new Graph({
      nodes: [agentA],
      edges: [],
    })

    await graph.invoke('hello')

    expect(observed).toEqual({})
  })

  it('every orchestrator and node event in a run carries the same invocationState reference', async () => {
    const agentA = new Agent({
      model: new MockMessageModel().addTurn(new TextBlock('A done')),
      printer: false,
      id: 'a',
    })
    const agentB = new Agent({
      model: new MockMessageModel().addTurn(new TextBlock('B done')),
      printer: false,
      id: 'b',
    })

    const graph = new Graph({
      nodes: [agentA, agentB],
      edges: [{ source: 'a', target: 'b' }],
    })

    const state: InvocationState = { requestId: 'r-1' }
    const observed: { label: string; ref: InvocationState }[] = []

    const record = (label: string, ref: InvocationState): void => {
      observed.push({ label, ref })
    }
    graph.addHook(BeforeMultiAgentInvocationEvent, (e) => record('BeforeMultiAgentInvocation', e.invocationState))
    graph.addHook(AfterMultiAgentInvocationEvent, (e) => record('AfterMultiAgentInvocation', e.invocationState))
    graph.addHook(BeforeNodeCallEvent, (e) => record(`BeforeNodeCall:${e.nodeId}`, e.invocationState))
    graph.addHook(AfterNodeCallEvent, (e) => record(`AfterNodeCall:${e.nodeId}`, e.invocationState))
    graph.addHook(NodeStreamUpdateEvent, (e) => record(`NodeStreamUpdate:${e.nodeId}`, e.invocationState))
    graph.addHook(NodeResultEvent, (e) => record(`NodeResult:${e.nodeId}`, e.invocationState))
    graph.addHook(MultiAgentHandoffEvent, (e) => record('MultiAgentHandoff', e.invocationState))
    graph.addHook(MultiAgentResultEvent, (e) => record('MultiAgentResult', e.invocationState))

    await graph.invoke('hello', { invocationState: state })

    // Every event observed at the orchestrator level must share the caller's reference.
    expect(observed.length).toBeGreaterThan(0)
    for (const { label, ref } of observed) {
      expect(ref, `event=${label} saw a different invocationState object`).toBe(state)
    }
  })
})
