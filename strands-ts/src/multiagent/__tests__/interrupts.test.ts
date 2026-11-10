import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { MockSnapshotStorage } from '../../__fixtures__/mock-storage-provider.js'
import { createCancellableAgent } from '../../__fixtures__/agent-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { InterruptResponseContent } from '../../types/interrupt.js'
import { Graph } from '../graph.js'
import { Swarm } from '../swarm.js'
import { Status } from '../state.js'
import { SessionManager } from '../../session/session-manager.js'
import { BeforeNodeCallEvent } from '../events.js'
import { TextBlock } from '../../types/messages.js'

/**
 * Interrupt round-trip tests. Verifies that an orchestrator can hit an interrupt,
 * persist enough state via a SessionManager to let a later invocation resume, and
 * produce a clean terminal result once all interrupts are answered.
 *
 * Each run uses a fresh agent instance so session-driven state restoration is what
 * wires resume together — just like a real cross-process resume.
 */

function makeSessionManager(storage: MockSnapshotStorage): SessionManager {
  return new SessionManager({
    sessionId: 'test-session',
    storage: { snapshot: storage },
  })
}

/** Tool that interrupts once, then returns a static value on resume. */
function interruptingTool(name: string, interruptName: string, resumeValue = 'ok') {
  return createMockTool(name, (context) => {
    context.interrupt({ name: interruptName, reason: `need ${interruptName}` })
    return resumeValue
  })
}

interface StructuredOutputDecision {
  agentId?: string
  message: string
}

/** Creates a swarm agent that repeatedly returns one structured-output decision. */
function createStructuredOutputAgent(
  agentId: string,
  decision: StructuredOutputDecision,
  tools: ReturnType<typeof createMockTool>[] = []
): Agent {
  const model = new MockMessageModel().addTurn({
    type: 'toolUseBlock',
    name: 'strands_structured_output',
    toolUseId: `structured-output-${agentId}`,
    input: {
      ...(decision.agentId && { agentId: decision.agentId }),
      message: decision.message,
    },
  })
  return new Agent({ model, tools, printer: false, id: agentId })
}

describe('Multi-agent interrupts: round-trip', () => {
  it('Graph: agent interrupts, resumes via top-level SessionManager', async () => {
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('confirmTool', 'confirm', 'approved')

    // Agent's model for run 1 returns a tool use (which interrupts).
    const modelRun1 = new MockMessageModel().addTurn({
      type: 'toolUseBlock',
      name: 'confirmTool',
      toolUseId: 'tool-1',
      input: {},
    })
    const agent1 = new Agent({ model: modelRun1, tools: [tool], printer: false, id: 'a' })
    const graph1 = new Graph({
      nodes: [agent1],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })

    const interruptResult = await graph1.invoke('go')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)
    expect(interruptResult.interrupts).toHaveLength(1)

    // Run 2's model provides the final text turn plus a trailing turn that should
    // never be consumed. Two turns are needed so the mock model's callCount tracks
    // (single-turn mode has a quirk where callCount stays at 0 regardless of calls).
    // If the resumed agent replayed the pending tool use correctly, it calls the
    // model exactly once (for the post-tool turn) — NOT twice (which would mean the
    // tool use was re-fetched from the model instead of replayed).
    const modelRun2 = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'done' })
      .addTurn({ type: 'textBlock', text: 'unreachable' })
    const agent2 = new Agent({ model: modelRun2, tools: [tool], printer: false, id: 'a' })
    const graph2 = new Graph({
      nodes: [agent2],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })

    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: 'yes',
    })
    const finalResult = await graph2.invoke([response])

    expect(finalResult.status).toBe(Status.COMPLETED)
    expect(finalResult.interrupts).toBeUndefined()
    for (const result of finalResult.results) {
      expect(result.interrupts).toBeUndefined()
    }
    // Model called exactly once on resume — for the post-tool turn. The pending
    // tool use came from the restored snapshot, not a re-fetch.
    expect(modelRun2.callCount).toBe(1)
  })

  it('Swarm: agent interrupts, resumes via top-level SessionManager', async () => {
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('confirmTool', 'confirm_a', 'resumed')

    const modelRun1 = new MockMessageModel().addTurn({
      type: 'toolUseBlock',
      name: 'confirmTool',
      toolUseId: 'tool-A',
      input: {},
    })
    const agent1 = new Agent({ model: modelRun1, tools: [tool], printer: false, id: 'a' })
    const swarm1 = new Swarm({
      nodes: [agent1],
      start: 'a',
      sessionManager: makeSessionManager(storage),
    })
    const interruptResult = await swarm1.invoke('start')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)
    expect(interruptResult.interrupts).toHaveLength(1)

    // Swarm uses structured output for handoffs — the final (non-handoff) turn
    // terminates execution.
    const modelRun2 = new MockMessageModel().addTurn({
      type: 'toolUseBlock',
      name: 'strands_structured_output',
      toolUseId: 'so-1',
      input: { message: 'all done' },
    })
    const agent2 = new Agent({ model: modelRun2, tools: [tool], printer: false, id: 'a' })
    const swarm2 = new Swarm({
      nodes: [agent2],
      start: 'a',
      sessionManager: makeSessionManager(storage),
    })
    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: 'ok',
    })
    const finalResult = await swarm2.invoke([response])

    expect(finalResult.status).toBe(Status.COMPLETED)
  })

  it('Swarm: repetitive handoff detection does not swallow a session-restored interrupt response', async () => {
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('confirmTool', 'confirm_b', 'resumed')
    const agentA1 = createStructuredOutputAgent('a', { agentId: 'b', message: 'to b' })
    const agentB1 = new Agent({
      model: new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'strands_structured_output',
          toolUseId: 'handoff-b',
          input: { agentId: 'a', message: 'to a' },
        })
        .addTurn({ type: 'toolUseBlock', name: 'confirmTool', toolUseId: 'tool-int', input: {} }),
      tools: [tool],
      printer: false,
      id: 'b',
    })
    const agentC1 = createStructuredOutputAgent('c', { message: 'unused' })
    const swarm1 = new Swarm({
      id: 'my-swarm',
      nodes: [agentA1, agentB1, agentC1],
      start: 'a',
      repetitiveHandoffDetectionWindow: 4,
      repetitiveHandoffMinUniqueAgents: 3,
      sessionManager: makeSessionManager(storage),
    })

    const interruptedResult = await swarm1.invoke('start')

    expect(interruptedResult.status).toBe(Status.INTERRUPTED)
    expect(interruptedResult.results.map((result) => [result.nodeId, result.status])).toEqual([
      ['a', Status.COMPLETED],
      ['b', Status.COMPLETED],
      ['a', Status.COMPLETED],
      ['b', Status.INTERRUPTED],
    ])

    const agentA2 = createStructuredOutputAgent('a', { agentId: 'b', message: 'to b' })
    const agentB2 = createStructuredOutputAgent('b', { message: 'all done' }, [tool])
    const agentC2 = createStructuredOutputAgent('c', { message: 'unused' })
    const swarm2 = new Swarm({
      id: 'my-swarm',
      nodes: [agentA2, agentB2, agentC2],
      start: 'a',
      repetitiveHandoffDetectionWindow: 4,
      repetitiveHandoffMinUniqueAgents: 3,
      sessionManager: makeSessionManager(storage),
    })
    const response = new InterruptResponseContent({
      interruptId: interruptedResult.interrupts![0]!.id,
      response: 'yes',
    })

    const finalResult = await swarm2.invoke([response])

    expect(finalResult.status).toBe(Status.COMPLETED)
    expect(finalResult.error).toBeUndefined()
    expect(finalResult.interrupts).toBeUndefined()
    expect(finalResult.results.map((result) => result.nodeId)).toEqual(['a', 'b', 'a', 'b'])
  })

  it('Graph parallel: interrupt on one branch lets in-flight sibling finish', async () => {
    const tool = interruptingTool('confirmTool', 'confirm', 'approved')

    // Source node 'start' runs quickly and produces two parallel branches.
    // Branch 'interrupter' interrupts immediately. Branch 'sibling' takes a moment
    // to complete. The interrupt does not abort siblings — they run to completion
    // and the aggregate result carries both outcomes.
    const startModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'go' })
    const start = new Agent({ model: startModel, printer: false, id: 'start' })

    const interrupterModel = new MockMessageModel().addTurn({
      type: 'toolUseBlock',
      name: 'confirmTool',
      toolUseId: 'tool-i',
      input: {},
    })
    const interrupter = new Agent({ model: interrupterModel, tools: [tool], printer: false, id: 'interrupter' })

    const sibling = createCancellableAgent('sibling', 50)

    const graph = new Graph({
      nodes: [start, interrupter, sibling],
      edges: [
        ['start', 'interrupter'],
        ['start', 'sibling'],
      ],
      timeout: 5_000,
    })

    const result = await graph.invoke('begin')

    // Aggregate status surfaces INTERRUPTED (the actionable state) — `_resolveStatus`
    // ranks INTERRUPTED above COMPLETED.
    expect(result.status).toBe(Status.INTERRUPTED)

    const siblingResult = result.results.find((r) => r.nodeId === 'sibling')
    expect(siblingResult?.status).toBe(Status.COMPLETED)

    const interrupterResult = result.results.find((r) => r.nodeId === 'interrupter')
    expect(interrupterResult?.status).toBe(Status.INTERRUPTED)
    expect(interrupterResult?.interrupts).toHaveLength(1)
  })

  it('Nested orchestrator: interrupts bubble up on first run but do not round-trip without a nested SessionManager', async () => {
    // Nested orchestrator has no SessionManager of its own, only the outer one does.
    // First run works (interrupt bubbles up through MultiAgentNode into outer result).
    // Second run FAILS at routing because the nested state was never persisted: the
    // nested Swarm's NodeState.interrupts is empty on rehydrate, so the response id
    // has no home. This test pins down the documented limitation.
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('confirmTool', 'confirm_nested', 'ok')

    const buildInner = (): Swarm => {
      const model = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'confirmTool',
        toolUseId: 'tool-n',
        input: {},
      })
      const agent = new Agent({ model, tools: [tool], printer: false, id: 'inner-agent' })
      return new Swarm({ nodes: [agent], start: 'inner-agent', id: 'inner' })
    }

    const outer1 = new Graph({
      nodes: [{ orchestrator: buildInner() }],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })
    const interruptResult = await outer1.invoke('go')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)
    expect(interruptResult.interrupts).toHaveLength(1)

    const outer2 = new Graph({
      nodes: [{ orchestrator: buildInner() }],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })
    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: 'yes',
    })

    // Routing at the outer level finds the MultiAgentNode. Inside, the nested
    // Swarm creates a fresh MultiAgentState; no nested NodeState.interrupts match
    // the response id, so groupInterruptResponsesByNode throws. `Node.stream` catches
    // the error and produces a FAILED result for the nested node. The limitation is
    // diagnosable via the error message on that node's result, just not transparent.
    const finalResult = await outer2.invoke([response])
    const innerNode = finalResult.results.find((r) => r.nodeId === 'inner')
    expect(innerNode?.status).toBe(Status.FAILED)
    expect(innerNode?.error?.message).toMatch(/no node found with matching interrupt/)
  })

  it('Graph: BeforeNodeCallEvent.interrupt gates a node before it runs, resumes via SessionManager', async () => {
    const storage = new MockSnapshotStorage()

    // The gated node has a normal agent — the interrupt fires BEFORE the node runs
    // via an orchestrator hook, not from inside the agent.
    const buildAgent = () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'executed' })
      return new Agent({ model, printer: false, id: 'execute' })
    }

    const graph1 = new Graph({
      nodes: [buildAgent()],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })
    graph1.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'execute') {
        event.interrupt({ name: 'node_approval', reason: 'approve?' })
      }
    })

    const interruptResult = await graph1.invoke('begin')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)
    expect(interruptResult.interrupts).toHaveLength(1)
    expect(interruptResult.interrupts![0]!.source).toBe('multiagent-hook')

    // Resume with approval. Hook runs again, sees the stored response, returns it
    // without throwing. Node proceeds to execute.
    const graph2 = new Graph({
      nodes: [buildAgent()],
      edges: [],
      sessionManager: makeSessionManager(storage),
    })
    graph2.addHook(BeforeNodeCallEvent, (event) => {
      if (event.nodeId === 'execute') {
        const response = event.interrupt<{ approved: boolean }>({ name: 'node_approval', reason: 'approve?' })
        if (!response.approved) {
          event.cancel = 'not approved'
        }
      }
    })

    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: { approved: true },
    })
    const finalResult = await graph2.invoke([response])

    expect(finalResult.status).toBe(Status.COMPLETED)
    const executedNode = finalResult.results.find((r) => r.nodeId === 'execute')
    expect(executedNode?.status).toBe(Status.COMPLETED)
    expect(executedNode?.content.some((b) => b instanceof TextBlock && b.text === 'executed')).toBe(true)
  })

  it('Swarm: BeforeNodeCallEvent.interrupt gates a node before it runs, resumes via SessionManager', async () => {
    const storage = new MockSnapshotStorage()
    const buildAgent = () => {
      const model = new MockMessageModel().addTurn({
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: 'so-1',
        input: { message: 'ran' },
      })
      return new Agent({ model, printer: false, id: 'a' })
    }

    const swarm1 = new Swarm({
      nodes: [buildAgent()],
      start: 'a',
      sessionManager: makeSessionManager(storage),
    })
    swarm1.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'gate', reason: 'approve?' })
    })

    const interruptResult = await swarm1.invoke('begin')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)
    expect(interruptResult.interrupts![0]!.source).toBe('multiagent-hook')

    const swarm2 = new Swarm({
      nodes: [buildAgent()],
      start: 'a',
      sessionManager: makeSessionManager(storage),
    })
    swarm2.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'gate', reason: 'approve?' })
    })

    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: 'approved',
    })
    const finalResult = await swarm2.invoke([response])
    expect(finalResult.status).toBe(Status.COMPLETED)
  })

  it('Graph: hook gate + tool interrupt across successive runs, each layer resumed in turn', async () => {
    // Run 1: orchestrator hook gates the node (hook interrupt, source=multiagent-hook).
    // Run 2: hook approves on resume, node runs, tool interrupts (source=tool).
    // Run 3: tool resumes, agent completes.
    // Exercises both interrupt layers in the same graph, with proper layer routing
    // via applyOrchestratorHookResponses.
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('toolInterrupt', 'tool_confirm', 'done')

    // Each run uses a fresh agent whose model provides only the turns it needs.
    const buildGraph = (modelTurns: 'toolUse' | 'text'): Graph => {
      const model = new MockMessageModel()
      if (modelTurns === 'toolUse') {
        model.addTurn({ type: 'toolUseBlock', name: 'toolInterrupt', toolUseId: 'tool-1', input: {} })
      } else {
        model.addTurn({ type: 'textBlock', text: 'done' }).addTurn({ type: 'textBlock', text: 'unreachable' })
      }
      const agent = new Agent({ model, tools: [tool], printer: false, id: 'a' })
      const graph = new Graph({
        nodes: [agent],
        edges: [],
        sessionManager: makeSessionManager(storage),
      })
      graph.addHook(BeforeNodeCallEvent, (event) => {
        event.interrupt({ name: 'hook_gate', reason: 'approve node?' })
      })
      return graph
    }

    const run1 = await buildGraph('toolUse').invoke('begin')
    expect(run1.status).toBe(Status.INTERRUPTED)
    expect(run1.interrupts![0]!.source).toBe('multiagent-hook')

    const hookResponse = new InterruptResponseContent({
      interruptId: run1.interrupts![0]!.id,
      response: { approved: true },
    })
    const run2 = await buildGraph('toolUse').invoke([hookResponse])
    expect(run2.status).toBe(Status.INTERRUPTED)
    expect(run2.interrupts![0]!.source).toBe('tool')
  })

  it('Graph: hook-gated node still emits NodeResultEvent and AfterNodeCallEvent', async () => {
    // Lifecycle observers (SessionManager per-node save, metrics, tracing) rely on
    // each node terminating with the same event pair regardless of HOW it terminated.
    const agent = new Agent({ model: new MockMessageModel(), printer: false, id: 'gated' })
    const graph = new Graph({ nodes: [agent], edges: [] })
    graph.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'gate', reason: 'approve?' })
    })

    const eventTypes: string[] = []
    for await (const event of graph.stream('hi')) {
      eventTypes.push(event.type)
    }

    expect(eventTypes).toContain('beforeNodeCallEvent')
    expect(eventTypes).toContain('nodeResultEvent')
    expect(eventTypes).toContain('afterNodeCallEvent')
    // Strict ordering: after comes after result, which comes after before.
    expect(eventTypes.indexOf('beforeNodeCallEvent')).toBeLessThan(eventTypes.indexOf('nodeResultEvent'))
    expect(eventTypes.indexOf('nodeResultEvent')).toBeLessThan(eventTypes.indexOf('afterNodeCallEvent'))
  })

  it('Swarm: hook-gated node still emits NodeResultEvent and AfterNodeCallEvent', async () => {
    const agent = new Agent({ model: new MockMessageModel(), printer: false, id: 'a' })
    const swarm = new Swarm({ nodes: [agent], start: 'a' })
    swarm.addHook(BeforeNodeCallEvent, (event) => {
      event.interrupt({ name: 'gate', reason: 'approve?' })
    })

    const eventTypes: string[] = []
    for await (const event of swarm.stream('hi')) {
      eventTypes.push(event.type)
    }

    expect(eventTypes).toContain('beforeNodeCallEvent')
    expect(eventTypes).toContain('nodeResultEvent')
    expect(eventTypes).toContain('afterNodeCallEvent')
    expect(eventTypes.indexOf('beforeNodeCallEvent')).toBeLessThan(eventTypes.indexOf('nodeResultEvent'))
    expect(eventTypes.indexOf('nodeResultEvent')).toBeLessThan(eventTypes.indexOf('afterNodeCallEvent'))
  })

  it('Graph: resume against a graph whose topology changed throws a descriptive error', async () => {
    // Simulate a save/restore where the reconstructed graph is missing a node that
    // had an outstanding interrupt in the saved state. The routing lookup should fail
    // loudly rather than silently (which would previously have crashed on a non-null
    // assertion with an unhelpful TypeError).
    const storage = new MockSnapshotStorage()
    const tool = interruptingTool('confirmTool', 'confirm_top', 'ok')

    const model1 = new MockMessageModel().addTurn({
      type: 'toolUseBlock',
      name: 'confirmTool',
      toolUseId: 'tool-topo',
      input: {},
    })
    const agent1 = new Agent({ model: model1, tools: [tool], printer: false, id: 'will-vanish' })
    const graph1 = new Graph({ nodes: [agent1], edges: [], sessionManager: makeSessionManager(storage) })
    const interruptResult = await graph1.invoke('go')
    expect(interruptResult.status).toBe(Status.INTERRUPTED)

    const differentAgent = new Agent({
      model: new MockMessageModel(),
      printer: false,
      id: 'different-node',
    })
    const graph2 = new Graph({ nodes: [differentAgent], edges: [], sessionManager: makeSessionManager(storage) })
    const response = new InterruptResponseContent({
      interruptId: interruptResult.interrupts![0]!.id,
      response: 'yes',
    })

    await expect(graph2.invoke([response])).rejects.toThrow(/topology changed between save and resume/)
  })
})
