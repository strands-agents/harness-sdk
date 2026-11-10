import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { createCancellableAgent } from '../../__fixtures__/agent-helpers.js'
import { BeforeNodeCallEvent, MultiAgentInitializedEvent } from '../events.js'
import type { JSONValue } from '../../types/json.js'
import { TextBlock } from '../../types/messages.js'
import { Status, MultiAgentState } from '../state.js'
import { AgentNode } from '../nodes.js'
import { Swarm } from '../swarm.js'
import { SessionManager } from '../../session/session-manager.js'
import { MockSnapshotStorage } from '../../__fixtures__/mock-storage-provider.js'
import type { MultiAgentPlugin } from '../plugins.js'

/**
 * Creates an agent that produces a structured output handoff via the strands_structured_output tool.
 * The agent exits after the structured output tool succeeds (early-exit behavior).
 */
function createHandoffAgent(
  agentId: string,
  handoff: { agentId?: string; message: string; context?: Record<string, unknown> },
  description: string = `Agent ${agentId}`
): Agent {
  const model = new MockMessageModel().addTurn({
    type: 'toolUseBlock',
    name: 'strands_structured_output',
    toolUseId: 'tool-1',
    input: handoff as JSONValue,
  })
  return new Agent({ model, printer: false, id: agentId, description })
}

/**
 * Creates a simple agent that produces a final response (no handoff).
 */
function createFinalAgent(agentId: string, message: string, description: string = `Agent ${agentId}`): Agent {
  return createHandoffAgent(agentId, { message }, description)
}

/**
 * Creates an agent with a finite sequence of structured handoff decisions.
 */
function createHandoffSequenceAgent(
  agentId: string,
  handoffs: { agentId?: string; message: string; context?: Record<string, unknown> }[]
): Agent {
  const model = new MockMessageModel()
  for (const [index, handoff] of handoffs.entries()) {
    model.addTurn({
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: `tool-${index + 1}`,
      input: handoff as JSONValue,
    })
  }
  return new Agent({ model, printer: false, id: agentId, description: `Agent ${agentId}` })
}

describe('Swarm', () => {
  describe('constructor', () => {
    it('defaults id to "swarm"', () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })
      expect(swarm.id).toBe('swarm')
    })

    it('accepts a custom id', () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
        id: 'my-swarm',
      })
      expect(swarm.id).toBe('my-swarm')
    })

    it('accepts AgentNodeOptions with per-node config', () => {
      const swarm = new Swarm({
        nodes: [{ agent: createFinalAgent('a', 'hi') }],
        start: 'a',
      })
      expect(swarm.nodes.get('a')).toBeInstanceOf(AgentNode)
    })

    it('defaults start to the first node when not specified', () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('first', 'hi'), createFinalAgent('second', 'bye')],
      })

      expect(swarm.start.id).toBe('first')
    })

    it('throws when start references unknown agent', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'hi')],
            start: 'missing',
          })
      ).toThrow('start=<missing> | start references unknown agent')
    })

    it('throws when nodes list is empty', () => {
      expect(() => new Swarm({ nodes: [] })).toThrow('nodes list is empty')
    })

    it('throws on duplicate agent ids', () => {
      const agent = createFinalAgent('a', 'hi')
      expect(
        () =>
          new Swarm({
            nodes: [agent, agent],
            start: 'a',
          })
      ).toThrow('agent_id=<a> | duplicate agent id')
    })

    it('throws when maxSteps < 1', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'hi')],
            start: 'a',
            maxSteps: 0,
          })
      ).toThrow('max_steps=<0> | must be at least 1')
    })

    it('defaults execution limits and disables repetitive handoff detection', () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })
      expect(swarm.config.maxSteps).toBe(Infinity)
      expect(swarm.config.repetitiveHandoffDetectionWindow).toBe(0)
      expect(swarm.config.repetitiveHandoffMinUniqueAgents).toBe(0)
      expect(swarm.config.timeout).toBe(Infinity)
      expect(swarm.config.nodeTimeout).toBe(Infinity)
    })

    it.each([-1, 1.5, Number.NaN, Infinity])(
      'throws when repetitiveHandoffDetectionWindow is not a non-negative integer (%s)',
      (window) => {
        expect(
          () =>
            new Swarm({
              nodes: [createFinalAgent('a', 'hi')],
              repetitiveHandoffDetectionWindow: window,
              repetitiveHandoffMinUniqueAgents: 1,
            })
        ).toThrow(`repetitive_handoff_detection_window=<${window}> | must be a non-negative integer`)
      }
    )

    it.each([-1, 1.5, Number.NaN, Infinity])(
      'throws when repetitiveHandoffMinUniqueAgents is not a non-negative integer (%s)',
      (minimumUniqueAgents) => {
        expect(
          () =>
            new Swarm({
              nodes: [createFinalAgent('a', 'hi')],
              repetitiveHandoffDetectionWindow: 4,
              repetitiveHandoffMinUniqueAgents: minimumUniqueAgents,
            })
        ).toThrow(`repetitive_handoff_min_unique_agents=<${minimumUniqueAgents}> | must be a non-negative integer`)
      }
    )

    it.each([{ repetitiveHandoffDetectionWindow: 4 }, { repetitiveHandoffMinUniqueAgents: 2 }])(
      'throws when only one repetitive handoff setting is enabled',
      (config) => {
        expect(
          () =>
            new Swarm({
              nodes: [createFinalAgent('a', 'hi'), createFinalAgent('b', 'bye')],
              ...config,
            })
        ).toThrow('must both be 0 or both be positive')
      }
    )

    it('throws when the uniqueness threshold exceeds the detection window', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'a'), createFinalAgent('b', 'b'), createFinalAgent('c', 'c')],
            repetitiveHandoffDetectionWindow: 2,
            repetitiveHandoffMinUniqueAgents: 3,
          })
      ).toThrow('minimum unique agents cannot exceed detection window')
    })

    it('throws when the uniqueness threshold exceeds the swarm node count', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'a'), createFinalAgent('b', 'b')],
            repetitiveHandoffDetectionWindow: 4,
            repetitiveHandoffMinUniqueAgents: 3,
          })
      ).toThrow('minimum unique agents cannot exceed node count')
    })

    it('throws when timeout < 1', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'hi')],
            start: 'a',
            timeout: 0,
          })
      ).toThrow('timeout=<0> | must be at least 1')
    })

    it('throws when nodeTimeout < 1', () => {
      expect(
        () =>
          new Swarm({
            nodes: [createFinalAgent('a', 'hi')],
            start: 'a',
            nodeTimeout: 0,
          })
      ).toThrow('node_timeout=<0> | must be at least 1')
    })
  })

  describe('invoke', () => {
    it('returns completed result with content and duration', async () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'final answer')],
        start: 'a',
      })

      const result = await swarm.invoke('hello')

      expect(result).toEqual(
        expect.objectContaining({
          status: Status.COMPLETED,
          duration: expect.any(Number),
          content: [expect.objectContaining({ type: 'textBlock', text: 'final answer' })],
        })
      )
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a'])
      expect(result.results[0]?.structuredOutput).toEqual({ message: 'final answer' })
    })

    it('hands off from A to B and returns final output', async () => {
      const swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'please handle this' }),
          createFinalAgent('b', 'done by b'),
        ],
        start: 'a',
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('chains handoffs across multiple agents (A → B → C)', async () => {
      const swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'go to b' }),
          createHandoffAgent('b', { agentId: 'c', message: 'go to c' }),
          createFinalAgent('c', 'final from c'),
        ],
        start: 'a',
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b', 'c'])
    })

    it('passes serialized context in handoff input', async () => {
      const contextData = { key: 'value', num: 42 }
      const agentB = createFinalAgent('b', 'done')
      const streamSpy = vi.spyOn(agentB, 'stream')

      const swarm = new Swarm({
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'handle this', context: contextData }), agentB],
        start: 'a',
      })

      await swarm.invoke('start')

      expect(streamSpy).toHaveBeenCalled()
      const args = streamSpy.mock.calls[0]![0] as TextBlock[]
      const texts = args.map((b) => b.text)
      expect(texts).toContainEqual('handle this')
      expect(texts).toContainEqual(expect.stringContaining(JSON.stringify(contextData, null, 2)))
    })

    it('excludes current agent from handoff schema', async () => {
      const agentA = createHandoffAgent('a', { agentId: 'b', message: 'go to b' })
      const agentB = createFinalAgent('b', 'done')
      const streamSpyA = vi.spyOn(agentA, 'stream')
      const streamSpyB = vi.spyOn(agentB, 'stream')

      const swarm = new Swarm({
        nodes: [agentA, agentB],
        start: 'a',
      })

      await swarm.invoke('start')

      // Agent A's handoff schema allows B but rejects A
      const schemaA = streamSpyA.mock.calls[0]![1]!.structuredOutputSchema!
      expect(schemaA.parse({ agentId: 'b', message: 'ok' })).toStrictEqual({ agentId: 'b', message: 'ok' })
      expect(() => schemaA.parse({ agentId: 'a', message: 'ok' })).toThrow()

      // Agent B's handoff schema allows A but rejects B
      const schemaB = streamSpyB.mock.calls[0]![1]!.structuredOutputSchema!
      expect(schemaB.parse({ agentId: 'a', message: 'ok' })).toStrictEqual({ agentId: 'a', message: 'ok' })
      expect(() => schemaB.parse({ agentId: 'b', message: 'ok' })).toThrow()
    })

    it('throws when maxSteps is exceeded', async () => {
      const swarm = new Swarm({
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'to b' }), createFinalAgent('b', 'done')],
        start: 'a',
        maxSteps: 1,
      })

      await expect(swarm.invoke('start')).rejects.toThrow('swarm reached step limit')
    })

    it('does not throw when swarm completes normally using exactly maxSteps', async () => {
      const swarm = new Swarm({
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'to b' }), createFinalAgent('b', 'done by b')],
        start: 'a',
        maxSteps: 2,
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('returns a failed result when recent handoffs do not meet the uniqueness threshold', async () => {
      const swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'to b' }),
          createHandoffAgent('b', { agentId: 'a', message: 'to a' }),
          createFinalAgent('c', 'unused'),
        ],
        start: 'a',
        repetitiveHandoffDetectionWindow: 4,
        repetitiveHandoffMinUniqueAgents: 3,
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.FAILED)
      expect(result.error).toEqual(new Error('Repetitive handoff: 2 unique nodes out of 4 recent iterations'))
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b', 'a', 'b'])
      // Detection is an aggregate failure; each node execution completed successfully.
      expect(result.results.every((nodeResult) => nodeResult.status === Status.COMPLETED)).toBe(true)
    })

    it('checks the trailing window after earlier diverse handoffs', async () => {
      const swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'to b' }),
          createHandoffSequenceAgent('b', [
            { agentId: 'c', message: 'to c' },
            { agentId: 'a', message: 'to a' },
          ]),
          createHandoffAgent('c', { agentId: 'a', message: 'to a' }),
        ],
        start: 'a',
        repetitiveHandoffDetectionWindow: 3,
        repetitiveHandoffMinUniqueAgents: 3,
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.FAILED)
      expect(result.error).toEqual(new Error('Repetitive handoff: 2 unique nodes out of 3 recent iterations'))
      expect(result.results.map((nodeResult) => nodeResult.nodeId)).toStrictEqual(['a', 'b', 'c', 'a', 'b', 'a'])
    })

    it('continues when recent handoffs meet the uniqueness threshold', async () => {
      const swarm = new Swarm({
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'to b' }),
          createHandoffAgent('b', { agentId: 'c', message: 'to c' }),
          createFinalAgent('c', 'done'),
        ],
        start: 'a',
        repetitiveHandoffDetectionWindow: 2,
        repetitiveHandoffMinUniqueAgents: 2,
      })

      const result = await swarm.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b', 'c'])
    })

    it('throws when a node exceeds nodeTimeout', async () => {
      const swarm = new Swarm({
        nodes: [{ agent: createCancellableAgent('slow', 100) }],
        start: 'slow',
        nodeTimeout: 20,
      })

      await expect(swarm.invoke('go')).rejects.toThrow(/node_timeout=<20>, node_id=<slow>/)
    })

    it('applies per-node timeout over nodeTimeout', async () => {
      const swarm = new Swarm({
        nodes: [{ agent: createCancellableAgent('slow', 100), timeout: 15 }],
        start: 'slow',
        nodeTimeout: 10_000,
      })

      await expect(swarm.invoke('go')).rejects.toThrow(/node_timeout=<15>, node_id=<slow>/)
    })

    it('does not throw when nodeTimeout is Infinity', async () => {
      const swarm = new Swarm({
        nodes: [{ agent: createCancellableAgent('a', 20) }],
        start: 'a',
        nodeTimeout: Infinity,
      })

      const result = await swarm.invoke('go')
      expect(result.status).toBe(Status.COMPLETED)
    })

    it('per-node timeout of Infinity disables a finite nodeTimeout', async () => {
      const swarm = new Swarm({
        nodes: [{ agent: createCancellableAgent('slow', 30), timeout: Infinity }],
        start: 'slow',
        nodeTimeout: 10,
      })

      const result = await swarm.invoke('go')
      expect(result.status).toBe(Status.COMPLETED)
    })

    it('throws when timeout is exceeded between steps', async () => {
      const swarm = new Swarm({
        nodes: [
          { agent: createCancellableAgent('a', 30, { agentId: 'b', message: 'to b' }) },
          { agent: createCancellableAgent('b', 30) },
        ],
        start: 'a',
        timeout: 20,
      })

      await expect(swarm.invoke('go')).rejects.toThrow(/timeout=<20>/)
    })

    it('aborts an in-flight node when the swarm timeout expires mid-step', async () => {
      const swarm = new Swarm({
        nodes: [{ agent: createCancellableAgent('slow', 200) }],
        start: 'slow',
        timeout: 20,
      })

      await expect(swarm.invoke('go')).rejects.toThrow(/timeout=<20>/)
    })

    it('returns cancelled result with custom message when cancel is a string', async () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })

      swarm.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        event.cancel = 'agent not ready'
      })

      const { items, result } = await collectGenerator(swarm.stream('go'))

      expect(result.status).toBe(Status.CANCELLED)

      const cancelEvent = items.find((e) => e.type === 'nodeCancelEvent')
      expect(cancelEvent).toEqual(
        expect.objectContaining({ nodeId: 'a', state: expect.any(MultiAgentState), message: 'agent not ready' })
      )
    })

    it('returns failed result when agent throws', async () => {
      const model = new MockMessageModel().addTurn(new Error('agent exploded'))
      const agent = new Agent({ model, printer: false, id: 'a', description: 'Agent a' })

      const swarm = new Swarm({
        nodes: [{ agent }],
        start: 'a',
      })

      const result = await swarm.invoke('go')

      expect(result.status).toBe(Status.FAILED)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({ nodeId: 'a', status: Status.FAILED }))
    })

    it('calls initialize only once across invocations', async () => {
      let callCount = 0

      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })

      swarm.addHook(MultiAgentInitializedEvent, () => {
        callCount++
      })

      await swarm.invoke('first')
      await swarm.invoke('second')

      expect(callCount).toBe(1)
    })

    it('preserves agent messages and state after execution', async () => {
      const agent = createFinalAgent('a', 'reply')
      const messagesBefore = [...agent.messages]
      const stateBefore = agent.appState.getAll()

      const swarm = new Swarm({
        nodes: [agent],
        start: 'a',
      })

      await swarm.invoke('hello')

      expect(agent.messages).toStrictEqual(messagesBefore)
      expect(agent.appState.getAll()).toStrictEqual(stateBefore)
    })
  })

  describe('stream', () => {
    it('yields lifecycle events in correct order for single agent', async () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'reply')],
        start: 'a',
      })

      const { items, result } = await collectGenerator(swarm.stream('go'))
      const eventTypes = items.map((e) => e.type)

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a'])
      expect(eventTypes).toStrictEqual([
        'beforeMultiAgentInvocationEvent',
        'beforeNodeCallEvent',
        // nodeStreamUpdateEvents from agent execution
        ...eventTypes.filter((t) => t === 'nodeStreamUpdateEvent'),
        'nodeResultEvent',
        'afterNodeCallEvent',
        'afterMultiAgentInvocationEvent',
        'multiAgentResultEvent',
      ])
    })

    it('yields handoff event between agents', async () => {
      const swarm = new Swarm({
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'go' }), createFinalAgent('b', 'done')],
        start: 'a',
      })

      const { items } = await collectGenerator(swarm.stream('start'))
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

    it('returns cancelled result with default message when cancel is true', async () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })

      swarm.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        event.cancel = true
      })

      const { items, result } = await collectGenerator(swarm.stream('go'))

      expect(result.status).toBe(Status.CANCELLED)
      expect(result.results).toHaveLength(1)
      expect(result.results[0]).toEqual(expect.objectContaining({ nodeId: 'a', status: Status.CANCELLED, duration: 0 }))

      const cancelEvent = items.find((e) => e.type === 'nodeCancelEvent')
      expect(cancelEvent).toEqual(
        expect.objectContaining({ nodeId: 'a', state: expect.any(MultiAgentState), message: 'node cancelled by hook' })
      )
    })

    it('returns cancelled result with custom message when cancel is a string', async () => {
      const swarm = new Swarm({
        nodes: [createFinalAgent('a', 'hi')],
        start: 'a',
      })

      swarm.addHook(BeforeNodeCallEvent, (event: BeforeNodeCallEvent) => {
        event.cancel = 'agent not ready'
      })

      const { items, result } = await collectGenerator(swarm.stream('go'))

      expect(result.status).toBe(Status.CANCELLED)

      const cancelEvent = items.find((e) => e.type === 'nodeCancelEvent')
      expect(cancelEvent).toEqual(
        expect.objectContaining({ nodeId: 'a', state: expect.any(MultiAgentState), message: 'agent not ready' })
      )
    })
  })

  describe('resume with session manager', () => {
    function makeResumeSwarm(storage: MockSnapshotStorage, options: { maxSteps?: number } = {}): Swarm {
      const sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
      const swarm = new Swarm({
        id: 'my-swarm',
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'go to b' }), createFinalAgent('b', 'done by b')],
        start: 'a',
        plugins: [sessionManager],
        ...options,
      })
      return swarm
    }

    it('resumes from the pending handoff target after a crash (A→B stopped, resumes at B)', async () => {
      const storage = new MockSnapshotStorage()

      const swarm1 = makeResumeSwarm(storage, { maxSteps: 1 })
      await expect(swarm1.invoke('start')).rejects.toThrow('swarm reached step limit')

      const swarm2 = makeResumeSwarm(storage)
      const result = await swarm2.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('starts fresh when the previous run completed normally (no pending handoff)', async () => {
      const storage = new MockSnapshotStorage()
      const sessionManager1 = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })

      const swarm1 = new Swarm({
        id: 'my-swarm',
        nodes: [createFinalAgent('a', 'all done'), createFinalAgent('b', 'done by b')],
        start: 'a',
        plugins: [sessionManager1],
      })

      const result1 = await swarm1.invoke('start')
      expect(result1.status).toBe(Status.COMPLETED)
      expect(result1.results.map((r) => r.nodeId)).toStrictEqual(['a'])

      const result2 = await swarm1.invoke('start')

      expect(result2.status).toBe(Status.COMPLETED)
      expect(result2.results.map((r) => r.nodeId)).toStrictEqual(['a'])
    })

    it('does not apply restored completed history to a new invocation', async () => {
      const storage = new MockSnapshotStorage()
      const priorSwarm = new Swarm({
        id: 'my-swarm',
        nodes: [
          createHandoffSequenceAgent('a', [
            { agentId: 'b', message: 'to b' },
            { agentId: 'b', message: 'to b again' },
          ]),
          createHandoffSequenceAgent('b', [{ agentId: 'a', message: 'to a' }, { message: 'prior run complete' }]),
          createFinalAgent('c', 'unused'),
        ],
        start: 'a',
        plugins: [new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })],
      })

      const priorResult = await priorSwarm.invoke('start')
      expect(priorResult.results.map((nodeResult) => nodeResult.nodeId)).toStrictEqual(['a', 'b', 'a', 'b'])

      const resumedSwarm = new Swarm({
        id: 'my-swarm',
        nodes: [createFinalAgent('a', 'a'), createFinalAgent('b', 'b'), createFinalAgent('c', 'fresh result')],
        start: 'c',
        repetitiveHandoffDetectionWindow: 4,
        repetitiveHandoffMinUniqueAgents: 3,
        plugins: [new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })],
      })

      const result = await resumedSwarm.invoke('new request')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.error).toBeUndefined()
      expect(result.results.map((nodeResult) => nodeResult.nodeId)).toStrictEqual(['a', 'b', 'a', 'b', 'c'])
    })

    it('carries forward steps count from the previous invocation', async () => {
      const storage = new MockSnapshotStorage()

      const swarm1 = makeResumeSwarm(storage, { maxSteps: 1 })
      await expect(swarm1.invoke('start')).rejects.toThrow('swarm reached step limit')

      const swarm2 = makeResumeSwarm(storage, { maxSteps: 2 })
      const result = await swarm2.invoke('start')

      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'b'])
    })

    it('passes the last handoff context to the resumed node', async () => {
      const storage = new MockSnapshotStorage()
      const handoffContext = { research: 'quantum computing basics' }

      const sessionManager1 = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      const swarm1 = new Swarm({
        id: 'my-swarm',
        nodes: [
          createHandoffAgent('a', { agentId: 'b', message: 'write this up', context: handoffContext }),
          createFinalAgent('b', 'done'),
        ],
        start: 'a',
        maxSteps: 1,
        plugins: [sessionManager1],
      })

      await expect(swarm1.invoke('start')).rejects.toThrow('swarm reached step limit')

      const sessionManager2 = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      const agentB = createFinalAgent('b', 'done')
      const streamSpy = vi.spyOn(agentB, 'stream')

      const swarm2 = new Swarm({
        id: 'my-swarm',
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'write this up', context: handoffContext }), agentB],
        start: 'a',
        plugins: [sessionManager2],
      })

      await swarm2.invoke('start')

      expect(streamSpy).toHaveBeenCalled()
      const args = streamSpy.mock.calls[0]![0] as TextBlock[]
      const texts = args.map((b) => b.text)
      expect(texts).toContainEqual('write this up')
      expect(texts).toContainEqual(expect.stringContaining(JSON.stringify(handoffContext, null, 2)))
    })

    it('starts fresh when the resume target agent was removed from the swarm', async () => {
      const storage = new MockSnapshotStorage()

      // First invocation: A hands off to B, maxSteps=1 stops
      const sessionManager1 = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      const swarm1 = new Swarm({
        id: 'my-swarm',
        nodes: [createHandoffAgent('a', { agentId: 'b', message: 'go to b' }), createFinalAgent('b', 'done by b')],
        start: 'a',
        maxSteps: 1,
        plugins: [sessionManager1],
      })

      await expect(swarm1.invoke('start')).rejects.toThrow('swarm reached step limit')

      // Second invocation: swarm reconfigured — B removed, C added
      const sessionManager2 = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      const swarm2 = new Swarm({
        id: 'my-swarm',
        nodes: [createFinalAgent('a', 'fresh start'), createFinalAgent('c', 'done by c')],
        start: 'a',
        plugins: [sessionManager2],
      })

      const result = await swarm2.invoke('start')

      // B no longer exists, so _findResumeNode falls back to start node A
      expect(result.status).toBe(Status.COMPLETED)
      expect(result.results.map((r) => r.nodeId)).toStrictEqual(['a', 'a'])
    })
  })

  describe('plugin initialization failure', () => {
    it('keeps a plugin initialization failure fail-closed across retries', async () => {
      const initializationError = new Error('plugin initialization failed')
      const plugin: MultiAgentPlugin = {
        name: 'failing-plugin',
        initMultiAgent: () => {
          throw initializationError
        },
      }
      const agent = new Agent({
        model: new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' }),
        printer: false,
        id: 'a',
      })
      const swarm = new Swarm({ nodes: [agent], start: 'a', plugins: [plugin] })

      await expect(swarm.initialize()).rejects.toBe(initializationError)
      await expect(swarm.initialize()).rejects.toBe(initializationError)
    })
  })
})
