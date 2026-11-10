import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { TextBlock } from '../../types/messages.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../../types/snapshot.js'
import type { Snapshot } from '../../types/snapshot.js'
import { takeSnapshot, loadSnapshot } from '../snapshot.js'
import { Graph } from '../graph.js'
import { Swarm } from '../swarm.js'
import { MultiAgentState, NodeResult, Status } from '../state.js'

const MOCK_TIMESTAMP = '2026-01-15T12:00:00.000Z'

function makeAgent(id: string, text = 'reply'): Agent {
  const model = new MockMessageModel().addTurn(new TextBlock(text))
  return new Agent({ model, printer: false, id })
}

function makeGraph(id: string, agentIds: string[]): Graph {
  return new Graph({
    id,
    nodes: agentIds.map((aid) => makeAgent(aid)),
    edges: agentIds.length > 1 ? [[agentIds[0]!, agentIds[1]!]] : [],
  })
}

function makeSwarm(id: string, agentIds: string[]): Swarm {
  return new Swarm({
    id,
    nodes: agentIds.map((aid) => makeAgent(aid)),
  })
}

function makeState(nodeIds: string[]): MultiAgentState {
  return new MultiAgentState({ nodeIds })
}

describe('multiagent snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(MOCK_TIMESTAMP))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('takeSnapshot', () => {
    it('captures orchestratorId, serialized state, and appData', () => {
      const graph = makeGraph('my-graph', ['a'])
      const state = makeState(['a'])
      state.steps = 3
      state.app.set('key', 'val')

      const snapshot = takeSnapshot(graph, state, { appData: { userId: 'u-1' } })

      expect(snapshot).toEqual({
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: {
          orchestratorId: 'my-graph',
          state: expect.objectContaining({ steps: 3, app: { key: 'val' } }),
        },
        appData: { userId: 'u-1' },
      })
    })

    it('omits state when state parameter is undefined', () => {
      const graph = makeGraph('g', ['a'])

      const snapshot = takeSnapshot(graph, undefined)

      expect(snapshot).toEqual({
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: { orchestratorId: 'g' },
        appData: {},
      })
    })

    it('works with Swarm orchestrator', () => {
      const swarm = makeSwarm('my-swarm', ['a', 'b'])

      const snapshot = takeSnapshot(swarm, makeState(['a', 'b']))

      expect(snapshot).toEqual({
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: {
          orchestratorId: 'my-swarm',
          state: expect.any(Object),
        },
        appData: {},
      })
    })
  })

  describe('loadSnapshot', () => {
    it('restores MultiAgentState for both Graph and Swarm', () => {
      for (const [orchestrator, nodeIds] of [
        [makeGraph('g', ['a', 'b']), ['a', 'b']],
        [makeSwarm('s', ['a', 'b']), ['a', 'b']],
      ] as const) {
        const state = makeState(nodeIds as unknown as string[])
        state.steps = 5
        state.results.push(
          new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 100, content: [new TextBlock('done')] })
        )

        const snapshot = takeSnapshot(orchestrator, state)
        const restored = makeState([])
        loadSnapshot(orchestrator, snapshot, restored)

        expect(restored.steps).toBe(5)
        expect(restored.results).toHaveLength(1)
        expect(restored.results[0]!.nodeId).toBe('a')
      }
    })

    it('does not modify state when snapshot has no state data', () => {
      const graph = makeGraph('g', ['a'])

      const snapshotNoState = takeSnapshot(graph, undefined)
      const state = makeState(['a'])
      state.steps = 99
      loadSnapshot(graph, snapshotNoState, state)
      expect(state.steps).toBe(99)
    })

    it('throws on wrong scope', () => {
      const graph = makeGraph('g', ['a'])
      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: { orchestratorId: 'g' },
        appData: {},
      }

      expect(() => loadSnapshot(graph, snapshot)).toThrow("Expected snapshot scope 'multiAgent', got 'agent'")
    })

    it('throws on unsupported schema version', () => {
      const graph = makeGraph('g', ['a'])
      const snapshot: Snapshot = {
        scope: 'multiAgent',
        schemaVersion: '99.0',
        createdAt: MOCK_TIMESTAMP,
        data: { orchestratorId: 'g' },
        appData: {},
      }

      expect(() => loadSnapshot(graph, snapshot)).toThrow('Unsupported snapshot schema version: 99.0')
    })

    it('throws on orchestratorId mismatch', () => {
      const graph = makeGraph('g', ['a'])
      const snapshot: Snapshot = {
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: { orchestratorId: 'different-id' },
        appData: {},
      }

      expect(() => loadSnapshot(graph, snapshot)).toThrow(
        "Snapshot orchestrator ID mismatch: expected 'g', got 'different-id'"
      )
    })
  })

  describe('round-trip', () => {
    it('snapshot survives JSON.stringify/JSON.parse round-trip', () => {
      const graph = makeGraph('g', ['a', 'b'])
      const state = makeState(['a', 'b'])
      state.steps = 7
      state.app.set('counter', 42)
      state.results.push(
        new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 200, content: [new TextBlock('result')] })
      )

      const snapshot = takeSnapshot(graph, state, { appData: { key: 'value' } })
      const parsed = JSON.parse(JSON.stringify(snapshot)) as Snapshot

      const restored = makeState([])
      loadSnapshot(graph, parsed, restored)

      expect(restored.steps).toBe(7)
      expect(restored.app.get('counter')).toBe(42)
      expect(restored.results).toHaveLength(1)
      expect(restored.results[0]!.nodeId).toBe('a')
      expect((restored.results[0]!.content[0] as TextBlock).text).toBe('result')
    })
  })
})
