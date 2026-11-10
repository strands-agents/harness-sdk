import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { AgentPrinter } from '../../agent/printer.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { MockSnapshotStorage } from '../../__fixtures__/mock-storage-provider.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createCancellableAgent } from '../../__fixtures__/agent-helpers.js'
import { AfterNodeCallEvent, BeforeNodeCallEvent, MultiAgentInitializedEvent } from '../events.js'
import { ReasoningBlock, TextBlock, type ContentBlockData } from '../../types/messages.js'
import { Status, MultiAgentState } from '../state.js'
import { AgentNode, MultiAgentNode } from '../nodes.js'
import { Graph } from '../graph.js'
import { SessionManager } from '../../session/session-manager.js'

function makeAgent(id: string, text = 'reply'): Agent {
  const model = new MockMessageModel().addTurn(new TextBlock(text))
  return new Agent({ model, printer: false, id })
}

describe('Graph', () => {
  describe('constructor', () => {
    it('defaults id to "graph"', () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })
      expect(graph.id).toBe('graph')
    })

    it('accepts a custom id', () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
        id: 'my-graph',
      })
      expect(graph.id).toBe('my-graph')
    })

    it('accepts agent node options', () => {
      const graph = new Graph({
        nodes: [{ agent: makeAgent('a') }],
        edges: [],
      })
      expect(graph.nodes.get('a')).toBeInstanceOf(AgentNode)
    })

    it('accepts multiAgent node options', () => {
      const inner = new Graph({
        id: 'inner',
        nodes: [makeAgent('x')],
        edges: [],
      })

      const graph = new Graph({
        nodes: [{ type: 'multiAgent', orchestrator: inner }],
        edges: [],
      })
      expect(graph.nodes.get('inner')).toBeInstanceOf(MultiAgentNode)
    })

    it('accepts pre-built Node instances', () => {
      const node = new AgentNode({ agent: makeAgent('a') })
      const graph = new Graph({
        nodes: [node],
        edges: [],
      })
      expect(graph.nodes.get('a')).toBe(node)
    })

    it('accepts edge options', () => {
      const graph = new Graph({
        nodes: [makeAgent('a'), makeAgent('b')],
        edges: [{ source: 'a', target: 'b' }],
      })
      expect(graph.edges).toHaveLength(1)
      expect(graph.edges[0]).toEqual(
        expect.objectContaining({
          source: expect.objectContaining({ id: 'a' }),
          target: expect.objectContaining({ id: 'b' }),
        })
      )
    })

    it('throws on duplicate node IDs', () => {
      const agent = makeAgent('a')
      expect(
        () =>
          new Graph({
            nodes: [agent, agent],
            edges: [],
          })
      ).toThrow('node_id=<a> | duplicate node id')
    })

    it('throws on edge referencing unknown source node', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [['missing', 'a']],
          })
      ).toThrow('source=<missing> | edge references unknown source node')
    })

    it('throws on edge referencing unknown target node', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [['a', 'missing']],
          })
      ).toThrow('target=<missing> | edge references unknown target node')
    })

    it('throws when graph has no source nodes', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a'), makeAgent('b')],
            edges: [
              ['a', 'b'],
              ['b', 'a'],
            ],
          })
      ).toThrow('graph has no source nodes')
    })

    it('throws on unreachable nodes', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a'), makeAgent('b'), makeAgent('island1'), makeAgent('island2')],
            edges: [
              ['a', 'b'],
              ['island1', 'island2'],
              ['island2', 'island1'],
            ],
          })
      ).toThrow('node_id=<island1> | unreachable from any source node')
    })

    it('throws when explicit source references unknown node', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            sources: ['missing'],
          })
      ).toThrow('source=<missing> | source references unknown node')
    })

    it('throws when maxSteps < 1', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            maxSteps: 0,
          })
      ).toThrow('max_steps=<0> | must be at least 1')
    })

    it('throws when maxConcurrency < 1', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            maxConcurrency: 0,
          })
      ).toThrow('max_concurrency=<0> | must be at least 1')
    })

    it('defaults maxConcurrency, maxSteps, timeout, and nodeTimeout to Infinity', () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })
      expect(graph.config.maxConcurrency).toBe(Infinity)
      expect(graph.config.maxSteps).toBe(Infinity)
      expect(graph.config.timeout).toBe(Infinity)
      expect(graph.config.nodeTimeout).toBe(Infinity)
    })

    it('throws when timeout < 1', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            timeout: 0,
          })
      ).toThrow('timeout=<0> | must be at least 1')
    })

    it('throws when nodeTimeout < 1', () => {
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            nodeTimeout: 0,
          })
      ).toThrow('node_timeout=<0> | must be at least 1')
    })
  })

  describe('invoke', () => {
    it('executes linear graph (A -> B -> C) in order', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['b', 'c'],
        ],
      })

      const result = await graph.invoke('start')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'c-reply' })]),
          duration: expect.any(Number),
        })
      )
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b', 'c'])
    })

    it('executes parallel graph (A -> B, A -> C) with B and C after A', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['a', 'c'],
        ],
      })

      const result = await graph.invoke('start')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'textBlock', text: 'b-reply' }),
            expect.objectContaining({ type: 'textBlock', text: 'c-reply' }),
          ]),
          duration: expect.any(Number),
        })
      )
      expect(result.results.map((r) => r.nodeId).sort()).toStrictEqual(['a', 'b', 'c'])
    })

    it('waits for all dependencies before executing join node (A -> C, B -> C)', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'c'],
          ['b', 'c'],
        ],
        maxConcurrency: 1,
      })

      const result = await graph.invoke('start')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'c-reply' })]),
          duration: expect.any(Number),
        })
      )
      expect(result.results).toHaveLength(3)
    })

    it('executes nested graph through MultiAgentNode', async () => {
      const inner = new Graph({
        id: 'inner',
        nodes: [makeAgent('x', 'inner-reply')],
        edges: [],
      })

      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), inner],
        edges: [['a', 'inner']],
      })

      const result = await graph.invoke('start')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          content: expect.arrayContaining([expect.objectContaining({ type: 'textBlock', text: 'inner-reply' })]),
          duration: expect.any(Number),
        })
      )
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'inner'])
    })

    it('uses explicit sources instead of auto-detection', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a'), makeAgent('b')],
        edges: [['a', 'b'], { source: 'b', target: 'a', handler: () => false }],
        sources: ['a'],
      })

      const result = await graph.invoke('go')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          duration: expect.any(Number),
        })
      )
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('evaluates conditional edges', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          { source: 'a', target: 'b', handler: () => true },
          { source: 'a', target: 'c', handler: () => false },
        ],
      })

      const result = await graph.invoke('start')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          duration: expect.any(Number),
        })
      )
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('evaluates conditional edges on join node (A -> C false, B -> C)', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [{ source: 'a', target: 'c', handler: () => false }, ['b', 'c']],
      })

      const result = await graph.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId).sort()).toStrictEqual(['a', 'b'])
    })

    it('evaluates conditional edges on join node (A -> C true, B -> C true)', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          { source: 'a', target: 'c', handler: () => true },
          { source: 'b', target: 'c', handler: () => true },
        ],
      })

      const result = await graph.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId).sort()).toStrictEqual(['a', 'b', 'c'])
    })

    it('passes task + dependency content to downstream nodes', async () => {
      const agentB = makeAgent('b')
      const streamSpy = vi.spyOn(agentB, 'stream')

      const graph = new Graph({
        nodes: [makeAgent('a', 'from-a'), agentB],
        edges: [['a', 'b']],
      })

      await graph.invoke('task-input')

      expect(streamSpy).toHaveBeenCalled()
      const input = streamSpy.mock.calls[0]![0] as TextBlock[]
      expect(input.map((b) => b.text)).toStrictEqual(['task-input', '[node: a]', 'from-a'])
    })

    it('does not pass dependency reasoning blocks to downstream nodes', async () => {
      const agentA = new Agent({
        model: new MockMessageModel().addTurn([
          new ReasoningBlock({ text: 'private reasoning' }),
          new TextBlock('from-a'),
        ]),
        printer: false,
        id: 'a',
      })
      const agentB = makeAgent('b')
      const streamSpy = vi.spyOn(agentB, 'stream')

      const graph = new Graph({
        nodes: [agentA, agentB],
        edges: [['a', 'b']],
      })

      await graph.invoke('task-input')

      expect(streamSpy).toHaveBeenCalled()
      const input = streamSpy.mock.calls[0]![0] as TextBlock[]
      expect(input.map((b) => b.text)).toStrictEqual(['task-input', '[node: a]', 'from-a'])
      expect(input.map((b) => b.type)).toStrictEqual(['textBlock', 'textBlock', 'textBlock'])
    })

    it('converts ContentBlockData[] input to ContentBlock instances for downstream nodes', async () => {
      const agentB = makeAgent('b')
      const streamSpy = vi.spyOn(agentB, 'stream')

      const graph = new Graph({
        nodes: [makeAgent('a', 'from-a'), agentB],
        edges: [['a', 'b']],
      })

      const dataInput: ContentBlockData[] = [{ text: 'data-input' }]
      await graph.invoke(dataInput)

      expect(streamSpy).toHaveBeenCalled()
      const input = streamSpy.mock.calls[0]![0] as TextBlock[]
      expect(input[0]).toBeInstanceOf(TextBlock)
      expect(input.map((b) => b.text)).toStrictEqual(['data-input', '[node: a]', 'from-a'])
    })

    it('returns failed result when agent throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('agent exploded'))
      const agent = new Agent({ model, printer: false, id: 'a' })

      const graph = new Graph({
        nodes: [agent, makeAgent('b', 'b-reply')],
        edges: [['a', 'b']],
      })

      const result = await graph.invoke('go')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.FAILED,
          duration: expect.any(Number),
        })
      )
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({ nodeId: 'a', status: Status.FAILED }))
    })

    it('propagates unexpected errors from node execution', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })

      const node = graph.nodes.get('a')!
      // eslint-disable-next-line require-yield
      vi.spyOn(node, 'stream').mockImplementation(async function* () {
        throw new Error('unexpected failure')
      })

      await expect(graph.invoke('go')).rejects.toThrow('unexpected failure')
    })

    it('throws when maxSteps is exceeded', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a'), makeAgent('b'), makeAgent('c')],
        edges: [
          ['a', 'b'],
          ['b', 'c'],
        ],
        maxSteps: 2,
      })

      await expect(graph.invoke('go')).rejects.toThrow('max steps reached')
    })

    it('throws when a node exceeds nodeTimeout', async () => {
      const graph = new Graph({
        nodes: [{ agent: createCancellableAgent('slow', 100) }],
        edges: [],
        nodeTimeout: 20,
      })

      await expect(graph.invoke('go')).rejects.toThrow(/node_timeout=<20>, node_id=<slow>/)
    })

    it('applies per-node timeout over nodeTimeout', async () => {
      const graph = new Graph({
        nodes: [{ agent: createCancellableAgent('slow', 100), timeout: 15 }],
        edges: [],
        nodeTimeout: 10_000,
      })

      await expect(graph.invoke('go')).rejects.toThrow(/node_timeout=<15>, node_id=<slow>/)
    })

    it('does not throw when nodeTimeout is Infinity', async () => {
      const graph = new Graph({
        nodes: [{ agent: createCancellableAgent('a', 20) }],
        edges: [],
        nodeTimeout: Infinity,
      })

      const result = await graph.invoke('go')
      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.status).toBe(Status.COMPLETED)
    })

    it('per-node timeout of Infinity disables a finite nodeTimeout', async () => {
      const graph = new Graph({
        nodes: [{ agent: createCancellableAgent('slow', 30), timeout: Infinity }],
        edges: [],
        nodeTimeout: 10,
      })

      const result = await graph.invoke('go')
      expect(result.results).toHaveLength(1)
      expect(result.results[0]?.status).toBe(Status.COMPLETED)
    })

    it('throws when timeout is exceeded', async () => {
      const graph = new Graph({
        nodes: [{ agent: createCancellableAgent('a', 30) }, { agent: createCancellableAgent('b', 30) }],
        edges: [['a', 'b']],
        timeout: 20,
      })

      await expect(graph.invoke('go')).rejects.toThrow(/timeout=<20>/)
    })

    it('calls initialize only once across invocations', async () => {
      let callCount = 0

      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })

      graph.addHook(MultiAgentInitializedEvent, () => {
        callCount++
      })

      await graph.invoke('first')
      await graph.invoke('second')

      expect(callCount).toBe(1)
    })

    it('respects maxConcurrency limit', async () => {
      let concurrent = 0
      let maxConcurrent = 0

      const graph = new Graph({
        nodes: [makeAgent('a'), makeAgent('b'), makeAgent('c')],
        edges: [
          ['a', 'b'],
          ['a', 'c'],
        ],
        maxConcurrency: 1,
      })

      graph.addHook(BeforeNodeCallEvent, () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
      })
      graph.addHook(AfterNodeCallEvent, () => {
        concurrent--
      })

      const result = await graph.invoke('go')

      expect(result.status).toBe(Status.COMPLETED)
      expect(maxConcurrent).toBe(1)
    })

    it('preserves agent messages and state after execution', async () => {
      const agent = makeAgent('a', 'reply')
      const messagesBefore = [...agent.messages]
      const stateBefore = agent.appState.getAll()

      const graph = new Graph({
        nodes: [agent],
        edges: [],
      })

      await graph.invoke('hello')

      expect(agent.messages).toStrictEqual(messagesBefore)
      expect(agent.appState.getAll()).toStrictEqual(stateBefore)
    })

    it('executes join node exactly once when all parents complete concurrently', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'c'],
          ['b', 'c'],
        ],
      })

      const nodeC = graph.nodes.get('c')!
      const streamSpy = vi.spyOn(nodeC, 'stream')

      const result = await graph.invoke('go')

      expect(result.status).toBe(Status.COMPLETED)
      expect(streamSpy).toHaveBeenCalledTimes(1)
    })

    it('re-executes node in a cycle when conditional edge allows re-entry', async () => {
      let visits = 0

      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply')],
        edges: [
          {
            source: 'a',
            target: 'a',
            handler: () => {
              visits++
              return visits < 2
            },
          },
        ],
        sources: ['a'],
      })

      const result = await graph.invoke('go')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results).toHaveLength(2)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'a'])
      expect(visits).toBe(2)
    })
  })

  describe('stream', () => {
    it('yields lifecycle events in correct order for single node', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply')],
        edges: [],
      })

      const { items, result } = await collectGenerator(graph.stream('go'))
      const eventTypes = items.map((e) => e.type)

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a'])
      expect(eventTypes).toStrictEqual([
        'beforeMultiAgentInvocationEvent',
        'beforeNodeCallEvent',
        ...eventTypes.filter((t) => t === 'nodeStreamUpdateEvent'),
        'nodeResultEvent',
        'afterNodeCallEvent',
        'afterMultiAgentInvocationEvent',
        'multiAgentResultEvent',
      ])
    })

    it('yields handoff events on transitions between nodes', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply')],
        edges: [['a', 'b']],
      })

      const { items } = await collectGenerator(graph.stream('go'))

      const handoffEvents = items.filter((e) => e.type === 'multiAgentHandoffEvent')
      expect(handoffEvents).toHaveLength(1)

      expect(handoffEvents[0]).toEqual(
        expect.objectContaining({
          type: 'multiAgentHandoffEvent',
          source: 'a',
          targets: ['b'],
          state: expect.any(MultiAgentState),
        })
      )
    })

    it('returns cancelled result when cancel is true', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })

      graph.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        event.cancel = true
      })

      const { items, result } = await collectGenerator(graph.stream('go'))

      expect(result.status).toBe(Status.CANCELLED)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({ nodeId: 'a', status: Status.CANCELLED, duration: 0 }))

      const cancelEvent = items.find((e) => e.type === 'nodeCancelEvent')
      expect(cancelEvent).toEqual(
        expect.objectContaining({ nodeId: 'a', state: expect.any(MultiAgentState), message: 'node cancelled by hook' })
      )
    })

    it('returns cancelled result with custom message when cancel is a string', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a')],
        edges: [],
      })

      graph.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        event.cancel = 'node not ready'
      })

      const { items, result } = await collectGenerator(graph.stream('go'))

      expect(result.status).toBe(Status.CANCELLED)

      const cancelEvent = items.find((e) => e.type === 'nodeCancelEvent')
      expect(cancelEvent).toEqual(
        expect.objectContaining({ nodeId: 'a', state: expect.any(MultiAgentState), message: 'node not ready' })
      )
    })

    it('does not buffer agent printer output for sequential graphs', async () => {
      const a = makeAgent('a', 'a-reply')
      const b = makeAgent('b', 'b-reply')
      const printerA = new AgentPrinter(() => {})
      const printerB = new AgentPrinter(() => {})
      ;(a as unknown as { _printer: AgentPrinter })._printer = printerA
      ;(b as unknown as { _printer: AgentPrinter })._printer = printerB

      const graph = new Graph({
        nodes: [a, b],
        edges: [['a', 'b']],
      })

      const seenA: unknown[] = []
      const seenB: unknown[] = []
      const gen = graph.stream('go')
      for await (const event of gen) {
        if (event.type === 'nodeStreamUpdateEvent') {
          if (event.nodeId === 'a') seenA.push((a as unknown as { _printer: AgentPrinter })._printer)
          if (event.nodeId === 'b') seenB.push((b as unknown as { _printer: AgentPrinter })._printer)
        }
      }

      expect(seenA.length).toBeGreaterThan(0)
      expect(seenB.length).toBeGreaterThan(0)
      expect(seenA.every((p) => p === printerA)).toBe(true)
      expect(seenB.every((p) => p === printerB)).toBe(true)
    })

    it('buffers agent printer output when topology allows parallel execution', async () => {
      const a = makeAgent('a', 'a-reply')
      const b = makeAgent('b', 'b-reply')
      const printerA = new AgentPrinter(() => {})
      const printerB = new AgentPrinter(() => {})
      ;(a as unknown as { _printer: AgentPrinter })._printer = printerA
      ;(b as unknown as { _printer: AgentPrinter })._printer = printerB

      // Two sources with no edges between them — both can run concurrently.
      const graph = new Graph({
        nodes: [a, b],
        edges: [],
      })

      const seenA: unknown[] = []
      const seenB: unknown[] = []
      const gen = graph.stream('go')
      for await (const event of gen) {
        if (event.type === 'nodeStreamUpdateEvent') {
          if (event.nodeId === 'a') seenA.push((a as unknown as { _printer: AgentPrinter })._printer)
          if (event.nodeId === 'b') seenB.push((b as unknown as { _printer: AgentPrinter })._printer)
        }
      }

      expect(seenA.some((p) => p !== printerA)).toBe(true)
      expect(seenB.some((p) => p !== printerB)).toBe(true)
      expect((a as unknown as { _printer: AgentPrinter })._printer).toBe(printerA)
      expect((b as unknown as { _printer: AgentPrinter })._printer).toBe(printerB)
    })

    it('does not interleave output from parallel nodes on a shared writer', async () => {
      // Fan-out graph (A -> B, A -> C). B and C run in parallel after A completes.
      // Each emits several TextBlocks so their printer writes are naturally
      // interleavable; the buffering behavior guarantees each node's writes
      // land as a contiguous run on the shared writer.
      const a = makeAgent('a', 'a-reply')
      const b = new Agent({
        model: new MockMessageModel().addTurn(['b-1 ', 'b-2 ', 'b-3'].map((text) => new TextBlock(text))),
        printer: false,
        id: 'b',
      })
      const c = new Agent({
        model: new MockMessageModel().addTurn(['c-1 ', 'c-2 ', 'c-3'].map((text) => new TextBlock(text))),
        printer: false,
        id: 'c',
      })

      const writes: string[] = []
      ;(b as unknown as { _printer: AgentPrinter })._printer = new AgentPrinter((text) => writes.push('b:' + text))
      ;(c as unknown as { _printer: AgentPrinter })._printer = new AgentPrinter((text) => writes.push('c:' + text))

      const graph = new Graph({
        nodes: [a, b, c],
        edges: [
          ['a', 'b'],
          ['a', 'c'],
        ],
      })

      await graph.invoke('go')

      // Each node's writes form one contiguous slice — no other node's writes appear between them.
      const bIndices = writes.map((w, i) => (w.startsWith('b:') ? i : -1)).filter((i) => i !== -1)
      const cIndices = writes.map((w, i) => (w.startsWith('c:') ? i : -1)).filter((i) => i !== -1)
      expect(bIndices.length).toBeGreaterThan(0)
      expect(cIndices.length).toBeGreaterThan(0)
      const isContiguous = (indices: number[]): boolean => indices.every((v, i) => i === 0 || v === indices[i - 1]! + 1)
      expect(isContiguous(bIndices)).toBe(true)
      expect(isContiguous(cIndices)).toBe(true)
    })

    it('cleans up running nodes when consumer breaks mid-stream', async () => {
      const graph = new Graph({
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply')],
        edges: [['a', 'b']],
      })

      const gen = graph.stream('go')
      const first = await gen.next()
      expect(first.done).toBe(false)

      // Simulates consumer break — should not hang waiting for node streams
      const result = await gen.return(undefined as never)
      expect(result.done).toBe(true)
    })
  })

  describe('resume with session manager', () => {
    function makeSessionManager(storage: MockSnapshotStorage): SessionManager {
      return new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
    }

    it('throws when sessionManager appears in both constructor arg and plugins', () => {
      const sm = makeSessionManager(new MockSnapshotStorage())
      expect(
        () =>
          new Graph({
            nodes: [makeAgent('a')],
            edges: [],
            sessionManager: sm,
            plugins: [sm],
          })
      ).toThrow('sessionManager was provided as both a constructor argument and in the plugins array')
    })

    it('resumes from the next ready node after a linear graph stops (A→B→C, A done, resumes at B)', async () => {
      const storage = new MockSnapshotStorage()

      const graph1 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['b', 'c'],
        ],
        maxSteps: 1,
        sessionManager: makeSessionManager(storage),
      })

      await expect(graph1.invoke('start')).rejects.toThrow('max steps reached')

      const graph2 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['b', 'c'],
        ],
        sessionManager: makeSessionManager(storage),
      })

      const result = await graph2.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      const completedIds = result.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
      expect(completedIds).toStrictEqual(['a', 'b', 'c'])
    })

    it('resumes parallel branches independently (A→B, A→C, B done, C cancelled, resumes at C)', async () => {
      const storage = new MockSnapshotStorage()

      const graph1 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['a', 'c'],
        ],
        plugins: [makeSessionManager(storage)],
        maxConcurrency: 1,
      })

      graph1.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        if (event.nodeId === 'c') event.cancel = 'simulated stop'
      })

      await graph1.invoke('start')

      const graph2 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          ['a', 'b'],
          ['a', 'c'],
        ],
        plugins: [makeSessionManager(storage)],
      })

      const result = await graph2.invoke('start')

      const completedIds = result.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
      expect(completedIds).toContain('a')
      expect(completedIds).toContain('b')
      expect(completedIds).toContain('c')
      // A and B should appear once each (not re-executed)
      expect(completedIds.filter((id) => id === 'a')).toHaveLength(1)
      expect(completedIds.filter((id) => id === 'b')).toHaveLength(1)
    })

    it('starts fresh when all nodes completed in the previous run', async () => {
      const storage = new MockSnapshotStorage()

      const graph1 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply')],
        edges: [['a', 'b']],
        plugins: [makeSessionManager(storage)],
      })

      const result1 = await graph1.invoke('start')
      expect(result1.status).toBe(Status.COMPLETED)

      const graph2 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply')],
        edges: [['a', 'b']],
        plugins: [makeSessionManager(storage)],
      })

      const result2 = await graph2.invoke('start')

      expect(result2.status).toBe(Status.COMPLETED)
      // A should appear twice — once from restored state, once from fresh execution
      const aCount = result2.results.filter((r) => r.nodeId === 'a' && r.status === Status.COMPLETED).length
      expect(aCount).toBe(2)
    })

    it('respects conditional edges on resume', async () => {
      const storage = new MockSnapshotStorage()

      // A → B (always), A → C (condition: false)
      // First run: A completes, B completes, C blocked by condition
      // maxSteps=2 allows A and B but graph completes normally since C is blocked
      const graph1 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          { source: 'a', target: 'b', handler: () => true },
          { source: 'a', target: 'c', handler: () => false },
        ],
        plugins: [makeSessionManager(storage)],
      })

      const result1 = await graph1.invoke('start')
      expect(result1.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])

      // Resume: C should still be blocked by the false condition
      const graph2 = new Graph({
        id: 'my-graph',
        nodes: [makeAgent('a', 'a-reply'), makeAgent('b', 'b-reply'), makeAgent('c', 'c-reply')],
        edges: [
          { source: 'a', target: 'b', handler: () => true },
          { source: 'a', target: 'c', handler: () => false },
        ],
        plugins: [makeSessionManager(storage)],
      })

      const result2 = await graph2.invoke('start')

      // C should not appear — condition still blocks it
      const completedIds = result2.results.filter((r) => r.status === Status.COMPLETED).map((r) => r.nodeId)
      expect(completedIds).not.toContain('c')
    })
  })
})
