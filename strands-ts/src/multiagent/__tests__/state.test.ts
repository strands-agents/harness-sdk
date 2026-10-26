import { describe, expect, it } from 'vitest'
import { NodeResult, NodeState, MultiAgentResult, MultiAgentState, Status } from '../state.js'
import { TextBlock, ToolUseBlock } from '../../types/messages.js'
import type { JSONValue } from '../../types/json.js'
import {
  stateToJSONSymbol,
  loadStateFromJSONSymbol,
  serializeStateSerializable,
  loadStateSerializable,
} from '../../types/serializable.js'
import { Interrupt } from '../../interrupt.js'
import { InvocationContextImpl } from '../../agent/invocation-context.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { extractResumeResponses, groupInterruptResponsesByNode } from '../multiagent.js'

describe('NodeResult', () => {
  describe('toJSON / fromJSON', () => {
    it('round-trips a completed result with text content', () => {
      const original = new NodeResult({
        nodeId: 'agent-1',
        status: Status.COMPLETED,
        duration: 150,
        content: [new TextBlock('hello world')],
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({
        nodeId: 'agent-1',
        status: Status.COMPLETED,
        duration: 150,
      })
      expect(restored.content).toHaveLength(1)
      expect(restored.content[0]).toBeInstanceOf(TextBlock)
      expect((restored.content[0] as TextBlock).text).toBe('hello world')
      expect(restored.error).toBeUndefined()
      expect(restored.structuredOutput).toBeUndefined()
    })

    it('round-trips a failed result with error', () => {
      const original = new NodeResult({
        nodeId: 'agent-2',
        status: Status.FAILED,
        duration: 50,
        error: new Error('something broke'),
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({
        status: Status.FAILED,
        content: [],
      })
      expect(restored.error).toBeInstanceOf(Error)
      expect(restored.error!.message).toBe('something broke')
    })

    it('round-trips structuredOutput with nested objects', () => {
      const output = { name: 'Alice', scores: [1, 2, 3], nested: { deep: true } }
      const original = new NodeResult({
        nodeId: 'agent-3',
        status: Status.COMPLETED,
        duration: 100,
        structuredOutput: output,
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored.structuredOutput).toEqual(output)
    })

    it('preserves structuredOutput when value is null', () => {
      const original = new NodeResult({
        nodeId: 'agent-4',
        status: Status.COMPLETED,
        duration: 10,
        structuredOutput: null,
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored.structuredOutput).toBeNull()
    })

    it('preserves structuredOutput when value is a primitive', () => {
      const original = new NodeResult({
        nodeId: 'agent-5',
        status: Status.COMPLETED,
        duration: 10,
        structuredOutput: 42,
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored.structuredOutput).toBe(42)
    })

    it('round-trips multiple content blocks including tool use', () => {
      const original = new NodeResult({
        nodeId: 'agent-6',
        status: Status.COMPLETED,
        duration: 200,
        content: [
          new TextBlock('thinking...'),
          new ToolUseBlock({ toolUseId: 'tu-1', name: 'calculator', input: { expr: '2+2' } }),
        ],
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored.content).toHaveLength(2)
      expect(restored.content[0]).toBeInstanceOf(TextBlock)
      expect(restored.content[1]).toBeInstanceOf(ToolUseBlock)
      expect((restored.content[1] as ToolUseBlock).name).toBe('calculator')
    })

    it('round-trips a cancelled result with empty content', () => {
      const original = new NodeResult({
        nodeId: 'agent-7',
        status: Status.CANCELLED,
        duration: 0,
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({
        status: Status.CANCELLED,
        content: [],
        duration: 0,
      })
    })

    it('omits error from JSON when not present', () => {
      const original = new NodeResult({
        nodeId: 'n',
        status: Status.COMPLETED,
        duration: 1,
      })

      const json = original.toJSON() as Record<string, JSONValue>

      expect('error' in json).toBe(false)
    })

    it('omits structuredOutput from JSON when not present', () => {
      const original = new NodeResult({
        nodeId: 'n',
        status: Status.COMPLETED,
        duration: 1,
      })

      const json = original.toJSON() as Record<string, JSONValue>

      expect('structuredOutput' in json).toBe(false)
    })

    it('round-trips usage with all fields', () => {
      const original = new NodeResult({
        nodeId: 'a',
        status: Status.COMPLETED,
        duration: 100,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cacheReadInputTokens: 5,
          cacheWriteInputTokens: 3,
        },
      })

      const restored = NodeResult.fromJSON(original.toJSON())

      expect(restored.usage).toEqual(original.usage)
    })

    it('omits usage from JSON when not present', () => {
      const original = new NodeResult({
        nodeId: 'n',
        status: Status.COMPLETED,
        duration: 1,
      })

      const json = original.toJSON() as Record<string, JSONValue>

      expect('usage' in json).toBe(false)
    })
  })
})

describe('NodeState', () => {
  describe('stateToJSONSymbol / loadStateFromJSONSymbol', () => {
    it('round-trips a fresh node state', () => {
      const original = new NodeState()

      const restored = new NodeState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored).toMatchObject({
        status: Status.PENDING,
        terminus: false,
        startTime: original.startTime,
        results: [],
      })
    })

    it('round-trips a node state with results', () => {
      const original = new NodeState()
      original.status = Status.COMPLETED
      original.terminus = true
      original.results.push(
        new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 100, content: [new TextBlock('done')] })
      )
      original.results.push(
        new NodeResult({ nodeId: 'a', status: Status.FAILED, duration: 50, error: new Error('retry failed') })
      )

      const restored = new NodeState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored).toMatchObject({
        status: Status.COMPLETED,
        terminus: true,
      })
      expect(restored.results).toHaveLength(2)
      expect(restored.results[0]).toMatchObject({ status: Status.COMPLETED })
      expect(restored.results[1]).toMatchObject({ status: Status.FAILED })
      expect(restored.results[1]!.error!.message).toBe('retry failed')
    })

    it('preserves content accessor after round-trip', () => {
      const original = new NodeState()
      original.results.push(
        new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 10, content: [new TextBlock('last')] })
      )

      const restored = new NodeState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored.content).toHaveLength(1)
      expect((restored.content[0] as TextBlock).text).toBe('last')
    })

    it('loads state into existing instance via loadStateFromJSONSymbol', () => {
      const original = new NodeState()
      original.status = Status.COMPLETED
      original.terminus = true
      original.results.push(new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 100 }))

      const target = new NodeState()
      target[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(target).toMatchObject({
        status: Status.COMPLETED,
        terminus: true,
        startTime: original.startTime,
      })
      expect(target.results).toHaveLength(1)
    })

    it('round-trips interrupts and interruptedSnapshot on an INTERRUPTED node', () => {
      const original = new NodeState()
      original.status = Status.INTERRUPTED
      original.interrupts = [new Interrupt({ id: 'tool:1:confirm', name: 'confirm', reason: 'need it' })]
      original.interruptedSnapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: '2026-01-01T00:00:00Z',
        data: { messages: [], interrupts: { activated: true, interrupts: {} } },
        appData: {},
      }

      const restored = new NodeState()
      loadStateSerializable(restored, serializeStateSerializable(original))

      expect(restored).toEqual(original)
    })

    it('clears interruptedSnapshot when it is absent from the serialized state', () => {
      const original = new NodeState()
      original.status = Status.COMPLETED

      const restored = new NodeState()
      restored.interruptedSnapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: '2026-01-01T00:00:00Z',
        data: {},
        appData: {},
      }
      loadStateSerializable(restored, serializeStateSerializable(original))

      expect(restored).toEqual(original)
    })
  })
})

describe('MultiAgentResult', () => {
  describe('toJSON / fromJSON', () => {
    it('round-trips a completed result', () => {
      const nodeResult = new NodeResult({
        nodeId: 'writer',
        status: Status.COMPLETED,
        duration: 300,
        content: [new TextBlock('final answer')],
      })
      const original = new MultiAgentResult({
        results: [nodeResult],
        content: [new TextBlock('final answer')],
        duration: 500,
      })

      const restored = MultiAgentResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({
        status: Status.COMPLETED,
        duration: 500,
      })
      expect(restored.results).toHaveLength(1)
      expect(restored.results[0]).toMatchObject({ nodeId: 'writer' })
      expect(restored.content).toHaveLength(1)
      expect((restored.content[0] as TextBlock).text).toBe('final answer')
      expect(restored.error).toBeUndefined()
    })

    it('round-trips a failed result with error', () => {
      const original = new MultiAgentResult({
        status: Status.FAILED,
        results: [],
        duration: 10,
        error: new Error('orchestration failed'),
      })

      const restored = MultiAgentResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({ status: Status.FAILED })
      expect(restored.error).toBeInstanceOf(Error)
      expect(restored.error!.message).toBe('orchestration failed')
    })

    it('preserves explicit status override', () => {
      const nodeResult = new NodeResult({
        nodeId: 'a',
        status: Status.COMPLETED,
        duration: 10,
      })
      const original = new MultiAgentResult({
        status: Status.CANCELLED,
        results: [nodeResult],
        duration: 20,
      })

      const restored = MultiAgentResult.fromJSON(original.toJSON())

      expect(restored.status).toBe(Status.CANCELLED)
    })

    it('round-trips with empty results and content', () => {
      const original = new MultiAgentResult({
        results: [],
        duration: 0,
      })

      const restored = MultiAgentResult.fromJSON(original.toJSON())

      expect(restored).toMatchObject({
        status: Status.COMPLETED,
        results: [],
        content: [],
      })
    })

    it('preserves aggregated usage after round-trip', () => {
      const original = new MultiAgentResult({
        results: [
          new NodeResult({
            nodeId: 'a',
            status: Status.COMPLETED,
            duration: 10,
            usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
          }),
          new NodeResult({
            nodeId: 'b',
            status: Status.COMPLETED,
            duration: 20,
            usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
          }),
        ],
        duration: 30,
      })

      expect(original.usage).toMatchObject({ inputTokens: 8, outputTokens: 17 })

      const restored = MultiAgentResult.fromJSON(original.toJSON())

      expect(restored.usage).toMatchObject({ inputTokens: 8, outputTokens: 17, totalTokens: 25 })
    })
  })
})

describe('MultiAgentState', () => {
  describe('_bindInvocationContext', () => {
    it('exposes the last bound request without enumerating or serializing it', () => {
      const state = new MultiAgentState({ nodeIds: ['a'] })
      const latest = new InvocationContextImpl()

      state._bindInvocationContext(new InvocationContextImpl())
      state._bindInvocationContext(latest)

      expect(state.invocationContext).toBe(latest)
      expect({
        enumerated: Object.keys(state).includes('invocationContext'),
        serialized: Object.keys(state[stateToJSONSymbol]() as Record<string, JSONValue>).includes('invocationContext'),
      }).toEqual({ enumerated: false, serialized: false })
    })
  })

  describe('stateToJSONSymbol / loadStateFromJSONSymbol', () => {
    it('round-trips a fresh state with node IDs', () => {
      const original = new MultiAgentState({ nodeIds: ['a', 'b', 'c'] })

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored).toMatchObject({
        startTime: original.startTime,
        steps: 0,
        results: [],
      })
      expect(restored.nodes.size).toBe(3)
      expect(restored.node('a')).toBeDefined()
      expect(restored.node('b')).toBeDefined()
      expect(restored.node('c')).toBeDefined()
    })

    it('round-trips state with steps and results', () => {
      const original = new MultiAgentState({ nodeIds: ['researcher', 'writer'] })
      original.steps = 3
      original.results.push(
        new NodeResult({
          nodeId: 'researcher',
          status: Status.COMPLETED,
          duration: 200,
          content: [new TextBlock('research findings')],
        })
      )
      original.results.push(
        new NodeResult({
          nodeId: 'writer',
          status: Status.COMPLETED,
          duration: 150,
          content: [new TextBlock('polished output')],
        })
      )

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored.steps).toBe(3)
      expect(restored.results).toHaveLength(2)
      expect(restored.results[0]).toMatchObject({ nodeId: 'researcher' })
      expect(restored.results[1]).toMatchObject({ nodeId: 'writer' })
    })

    it('round-trips app state', () => {
      const original = new MultiAgentState()
      original.app.set('counter', 42)
      original.app.set('config', { nested: { key: 'value' }, list: [1, 2, 3] })

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored.app.get('counter')).toBe(42)
      expect(restored.app.get('config')).toEqual({ nested: { key: 'value' }, list: [1, 2, 3] })
    })

    it('round-trips node states with modified status and results', () => {
      const original = new MultiAgentState({ nodeIds: ['agent-1'] })
      const ns = original.node('agent-1')!
      ns.status = Status.COMPLETED
      ns.terminus = true
      ns.results.push(new NodeResult({ nodeId: 'agent-1', status: Status.COMPLETED, duration: 100 }))

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      const restoredNs = restored.node('agent-1')!
      expect(restoredNs).toMatchObject({
        status: Status.COMPLETED,
        terminus: true,
      })
      expect(restoredNs.results).toHaveLength(1)
    })

    it('round-trips an empty state (no node IDs)', () => {
      const original = new MultiAgentState()

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](original[stateToJSONSymbol]())

      expect(restored).toMatchObject({
        steps: 0,
        results: [],
      })
      expect(restored.nodes.size).toBe(0)
    })

    it('handles loadStateFromJSONSymbol with missing nodes key gracefully', () => {
      const json = {
        startTime: 1000,
        steps: 0,
        results: [],
        app: {},
      } as JSONValue

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](json)

      expect(restored).toMatchObject({ startTime: 1000 })
      expect(restored.nodes.size).toBe(0)
    })

    it('preserves startTime exactly (no re-initialization)', () => {
      const json = {
        startTime: 1234567890,
        steps: 5,
        results: [],
        app: {},
        nodes: {},
      } as JSONValue

      const restored = new MultiAgentState()
      restored[loadStateFromJSONSymbol](json)

      expect(restored).toMatchObject({
        startTime: 1234567890,
        steps: 5,
      })
    })

    it('round-trips _pendingInput as a string', () => {
      const original = new MultiAgentState()
      original._pendingInput = 'hello'
      const restored = new MultiAgentState()
      loadStateSerializable(restored, JSON.parse(JSON.stringify(serializeStateSerializable(original))) as JSONValue)
      expect(restored._pendingInput).toBe('hello')
    })

    it('rehydrates _pendingInput ContentBlock[] to ContentBlock instances', () => {
      // Round-trips through JSON.stringify/parse to simulate FileStorage persistence,
      // then asserts the restored entries are real ContentBlock instances rather than
      // raw data objects — agent message construction depends on instance shape for
      // some downstream code paths.
      const original = new MultiAgentState()
      original._pendingInput = [new TextBlock('question')]
      const serialized = JSON.parse(JSON.stringify(serializeStateSerializable(original))) as JSONValue
      const restored = new MultiAgentState()
      loadStateSerializable(restored, serialized)

      expect(restored._pendingInput).toEqual([new TextBlock('question')])
      expect((restored._pendingInput as TextBlock[])[0]).toBeInstanceOf(TextBlock)
    })
  })
})

describe('MultiAgentResult._resolveStatus precedence', () => {
  function makeResult(
    status: typeof Status.COMPLETED | typeof Status.FAILED | typeof Status.CANCELLED | typeof Status.INTERRUPTED,
    nodeId = 'n'
  ): NodeResult {
    return new NodeResult({ nodeId, status, duration: 1 })
  }

  it('returns COMPLETED when all node results are completed', () => {
    const r = new MultiAgentResult({
      results: [makeResult(Status.COMPLETED), makeResult(Status.COMPLETED)],
      duration: 10,
    })
    expect(r.status).toBe(Status.COMPLETED)
  })

  it('FAILED outranks INTERRUPTED', () => {
    const r = new MultiAgentResult({
      results: [makeResult(Status.INTERRUPTED), makeResult(Status.FAILED)],
      duration: 10,
    })
    expect(r.status).toBe(Status.FAILED)
  })

  it('INTERRUPTED outranks CANCELLED', () => {
    const r = new MultiAgentResult({
      results: [makeResult(Status.CANCELLED), makeResult(Status.INTERRUPTED)],
      duration: 10,
    })
    expect(r.status).toBe(Status.INTERRUPTED)
  })

  it('CANCELLED outranks COMPLETED', () => {
    const r = new MultiAgentResult({
      results: [makeResult(Status.COMPLETED), makeResult(Status.CANCELLED)],
      duration: 10,
    })
    expect(r.status).toBe(Status.CANCELLED)
  })

  it('FAILED outranks CANCELLED', () => {
    const r = new MultiAgentResult({ results: [makeResult(Status.CANCELLED), makeResult(Status.FAILED)], duration: 10 })
    expect(r.status).toBe(Status.FAILED)
  })
})

describe('groupInterruptResponsesByNode', () => {
  function makeState(nodeInterrupts: Record<string, Interrupt[]>): MultiAgentState {
    const state = new MultiAgentState({ nodeIds: Object.keys(nodeInterrupts) })
    for (const [id, interrupts] of Object.entries(nodeInterrupts)) {
      state.node(id)!.interrupts = interrupts
    }
    return state
  }

  it('groups responses by the node whose interrupts match each id', () => {
    const state = makeState({
      a: [new Interrupt({ id: 'tool:1:confirm', name: 'confirm' })],
      b: [new Interrupt({ id: 'tool:2:approve', name: 'approve' })],
    })
    const responses = [
      new InterruptResponseContent({ interruptId: 'tool:1:confirm', response: 'yes' }),
      new InterruptResponseContent({ interruptId: 'tool:2:approve', response: 'ok' }),
    ]

    const grouped = groupInterruptResponsesByNode(responses, state)

    expect(grouped.get('a')).toHaveLength(1)
    expect(grouped.get('b')).toHaveLength(1)
    expect(grouped.get('a')?.[0]?.interruptResponse.interruptId).toBe('tool:1:confirm')
  })

  it('throws when a response id does not match any node interrupt', () => {
    const state = makeState({ a: [new Interrupt({ id: 'tool:1:confirm', name: 'confirm' })] })
    const responses = [new InterruptResponseContent({ interruptId: 'tool:missing:xyz', response: 'yes' })]

    expect(() => groupInterruptResponsesByNode(responses, state)).toThrow(/tool:missing:xyz/)
  })

  it('returns an empty map for empty responses', () => {
    const state = makeState({ a: [new Interrupt({ id: 'tool:1:confirm', name: 'confirm' })] })
    const grouped = groupInterruptResponsesByNode([], state)
    expect(grouped.size).toBe(0)
  })
})

describe('extractResumeResponses', () => {
  it('throws when interrupt responses are mixed with other content', () => {
    // Cast through `unknown` since the public type rejects mixed arrays at compile-time;
    // this test pins the runtime guard for callers that bypass typing.
    const mixed = [
      new InterruptResponseContent({ interruptId: 'tool:1:confirm', response: 'ok' }),
      new TextBlock('stray content'),
    ] as unknown as InterruptResponseContent[]
    expect(() => extractResumeResponses(mixed)).toThrow(TypeError)
  })

  it('returns undefined for empty input or non-response arrays', () => {
    expect(extractResumeResponses([])).toBeUndefined()
    expect(extractResumeResponses('hello')).toBeUndefined()
    expect(extractResumeResponses([new TextBlock('hi')])).toBeUndefined()
  })
})
