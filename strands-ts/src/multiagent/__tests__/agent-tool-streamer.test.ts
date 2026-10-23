import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { textMessage } from '../../__fixtures__/agent-helpers.js'
import { collectGenerator } from '../../__fixtures__/model-test-helpers.js'
import { Interrupt, InterruptState } from '../../interrupt.js'
import { logger } from '../../logging/logger.js'
import { AgentResult } from '../../types/agent.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import type { JSONValue } from '../../types/json.js'
import { serializeStateSerializable } from '../../types/serializable.js'
import {
  AgentToolStreamer,
  ChildAgentAdapter,
  ChildMultiAgentAdapter,
  type ChildAdapter,
} from '../agent-tool-streamer.js'
import { MultiAgentResult, MultiAgentState, Status } from '../state.js'
import { Swarm } from '../swarm.js'
import type { StopReason } from '../../types/messages.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../../types/snapshot.js'

const TURNS_KEY = 'subAgentInterruptedTurns'

const AGENT_ADAPTER = new ChildAgentAdapter({ label: 'Child', name: 'child' })
const MULTI_AGENT_ADAPTER = new ChildMultiAgentAdapter({ label: 'Swarm', render: () => 'partial' })

function agentResult(stopReason: StopReason, interrupts?: Interrupt[]): AgentResult {
  return new AgentResult({
    stopReason,
    lastMessage: textMessage('assistant', 'done'),
    invocationState: {},
    ...(interrupts && { interrupts }),
  })
}

async function* events<T>(result: T | undefined, ...progress: string[]): AsyncGenerator<string, T | undefined> {
  yield* progress
  return result
}

function streamer(interruptState?: InterruptState): AgentToolStreamer<AgentResult> {
  return new AgentToolStreamer({ interruptState, toolUseId: 't', namespace: 'test' })
}

function swarm(): Swarm {
  return new Swarm({ id: 'swarm', nodes: [new Agent({ id: 'a', model: new MockMessageModel(), printer: false })] })
}

/** A serialized agent interrupt state awaiting `approval`. */
function awaitedAgentState(): JSONValue {
  const state = new InterruptState()
  state.registerInterrupt(new Interrupt({ id: 'approval', name: 'confirm' }))
  state.activate()
  return state.toJSON() as unknown as JSONValue
}

/** A serialized multi-agent state whose node `a` awaits `approval`. */
function awaitedMultiAgentState(): JSONValue {
  const state = new MultiAgentState({ nodeIds: ['a'] })
  state.node('a')!.status = Status.INTERRUPTED
  state.node('a')!.interrupts = [new Interrupt({ id: 'approval', name: 'confirm' })]
  return serializeStateSerializable(state)
}

/** A parent resuming with an answer to `test:t:approval`, holding `turn` as the stored child turn. */
function resumingParent(turn?: unknown): InterruptState {
  const state = new InterruptState()
  state.registerInterrupt(new Interrupt({ id: 'test:t:approval', name: 'confirm' }))
  state.context[TURNS_KEY] = turn === undefined ? {} : { t: turn as JSONValue }
  state.activate()
  state.resume([new InterruptResponseContent({ interruptId: 'test:t:approval', response: 'approved' })])
  return state
}

describe('ChildMultiAgentAdapter', () => {
  it('classifies interrupts', () => {
    const interrupt = new Interrupt({ id: 'approval', name: 'confirm' })
    const result = new MultiAgentResult({
      status: Status.INTERRUPTED,
      results: [],
      duration: 0,
      interrupts: [interrupt],
    })

    expect(MULTI_AGENT_ADAPTER.classify(swarm(), result)).toEqual([interrupt])
  })

  it('reports an incomplete result with its label', () => {
    const result = new MultiAgentResult({ status: Status.FAILED, results: [], duration: 0, error: new Error('boom') })

    expect(MULTI_AGENT_ADAPTER.classify(swarm(), result)).toBe(
      'Swarm stopped before completing (status=FAILED: boom). Partial output:\npartial'
    )
  })

  it('round-trips the orchestrator state', async () => {
    const source = swarm()
    const pending = new MultiAgentState({ nodeIds: ['a'] })
    pending.node('a')!.status = Status.INTERRUPTED
    ;(source as unknown as { _pendingInterruptState: MultiAgentState })._pendingInterruptState = pending
    const target = swarm()

    const snapshot = JSON.parse(JSON.stringify(MULTI_AGENT_ADAPTER.takeSnapshot(source)))
    const awaitingResponses = await MULTI_AGENT_ADAPTER.restore(target, snapshot)

    expect(awaitingResponses).toBe(true)
    const restored = (target as unknown as { _pendingInterruptState: MultiAgentState })._pendingInterruptState
    expect(serializeStateSerializable(restored)).toEqual(serializeStateSerializable(pending))
  })
})

describe('AgentToolStreamer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('yields progress events and retains the terminal result', async () => {
    const result = agentResult('endTurn')
    const tool = streamer()

    const { items } = await collectGenerator(tool.stream(AGENT_ADAPTER, {} as Agent, events(result, 'progress')))

    expect(items).toEqual(['progress'])
    expect(tool.result).toBe(result)
  })

  it('stores the child turn and namespaces its interrupts', async () => {
    const child = new Agent({ model: new MockMessageModel(), printer: false })
    const parentState = new InterruptState()
    const tool = streamer(parentState)
    const result = agentResult('interrupt', [new Interrupt({ id: 'approval', name: 'confirm' })])

    const { items } = await collectGenerator(tool.stream(AGENT_ADAPTER, child, events(result)))

    expect(items).toEqual([])
    expect(tool.interrupts).toEqual([new Interrupt({ id: 'test:t:approval', name: 'confirm', source: 'tool' })])
    expect(Object.keys(parentState.context[TURNS_KEY] as object)).toEqual(['t'])
  })

  it('sets an error when the child does not produce a result', async () => {
    const tool = streamer()

    const { items } = await collectGenerator(tool.stream(AGENT_ADAPTER, {} as Agent, events(undefined, 'progress')))

    expect(items).toEqual(['progress'])
    expect(tool.error).toBe('Child did not produce a result.')
  })

  it('clears the completed child turn and preserves siblings', async () => {
    const parentState = new InterruptState()
    parentState.context[TURNS_KEY] = { t: { snapshot: 'child' }, t2: {} }

    await collectGenerator(streamer(parentState).stream(AGENT_ADAPTER, {} as Agent, events(agentResult('endTurn'))))

    expect(parentState.context[TURNS_KEY]).toEqual({ t2: {} })
  })

  it.each([
    [
      'an unloadable agent turn',
      AGENT_ADAPTER,
      { scope: 'agent', schemaVersion: '0.0', data: { interrupts: awaitedAgentState() }, appData: {} },
      (): unknown => new Agent({ model: new MockMessageModel(), printer: false }),
    ],
    [
      'an unloadable multiAgent turn',
      MULTI_AGENT_ADAPTER,
      { scope: 'multiAgent', schemaVersion: '0.0', data: { state: awaitedMultiAgentState() }, appData: {} },
      swarm,
    ],
    [
      'a multiAgent turn whose nodes the rebuilt swarm lacks',
      MULTI_AGENT_ADAPTER,
      {
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        data: { orchestratorId: 'swarm', state: awaitedMultiAgentState() },
        appData: {},
      },
      (): unknown =>
        new Swarm({ id: 'swarm', nodes: [new Agent({ id: 'b', model: new MockMessageModel(), printer: false })] }),
    ],
  ] as const)('raises the interrupts %s still awaits again and keeps the turn', async (_, adapter, turn, child) => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const parentState = resumingParent(turn)
    const tool = new AgentToolStreamer({ interruptState: parentState, toolUseId: 't', namespace: 'test' })

    const responses = await tool.resume(adapter as ChildAdapter<unknown, unknown>, child(), 'unavailable')

    expect(responses).toBeUndefined()
    expect(tool.interrupts).toEqual([new Interrupt({ id: 'test:t:approval', name: 'confirm' })])
    expect(parentState.context[TURNS_KEY]).toEqual({ t: turn })
  })

  it('restores the stored turn and returns the responses for this call without the prefix', async () => {
    const child = new Agent({ model: new MockMessageModel(), printer: false })
    child._interruptState.registerInterrupt(new Interrupt({ id: 'approval', name: 'confirm' }))
    child._interruptState.activate()
    const parentState = resumingParent(child.takeSnapshot({ preset: 'session' }))
    const tool = streamer(parentState)

    const responses = await tool.resume(
      AGENT_ADAPTER,
      new Agent({ model: new MockMessageModel(), printer: false }),
      'x'
    )

    expect(responses).toEqual([new InterruptResponseContent({ interruptId: 'approval', response: 'approved' })])
    expect(parentState.context[TURNS_KEY]).toEqual({})
  })

  it.each([
    ['missing', undefined],
    ['not an object', 'garbage'],
    ['missing its data', { data: 'x' }],
    ['without interrupts', { data: { interrupts: { interrupts: 1 } } }],
  ])('sets an error when the stored turn is %s', async (_, turn) => {
    vi.spyOn(logger, 'error').mockImplementation(() => {})
    const tool = streamer(resumingParent(turn))
    const child = new Agent({ model: new MockMessageModel(), printer: false })

    const responses = await tool.resume(AGENT_ADAPTER, child, 'unavailable')

    expect(responses).toBeUndefined()
    expect(tool.error).toBe('unavailable')
  })
})
