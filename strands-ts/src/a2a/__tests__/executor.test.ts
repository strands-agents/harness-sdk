import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { A2AExecutor } from '../executor.js'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type {
  AgentCard,
  Message as A2AMessage,
  Part,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import { Agent } from '../../agent/agent.js'
import type { InvokableAgent } from '../../types/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { TextBlock } from '../../types/messages.js'
import { ImageBlock, encodeBase64 } from '../../types/media.js'
import { ContentBlockEvent, ModelStreamUpdateEvent } from '../../hooks/events.js'
import { AgentResult } from '../../types/agent.js'
import { Interrupt } from '../../interrupt.js'
import { Message } from '../../types/messages.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import type { JSONValue } from '../../types/json.js'

function createMockEventBus(): ExecutionEventBus & { events: AgentExecutionEvent[] } {
  const events: AgentExecutionEvent[] = []
  return {
    events,
    publish: vi.fn((event) => {
      events.push(event)
    }),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    finished: vi.fn(),
  }
}

function createRequestContext(text: string, taskId: string = 'task-1'): RequestContext {
  return {
    taskId,
    contextId: 'ctx-1',
    userMessage: {
      kind: 'message',
      messageId: 'msg-1',
      role: 'user',
      parts: [{ kind: 'text', text }],
    },
  }
}

describe('A2AExecutor', () => {
  describe('execute', () => {
    it('streams text deltas as artifact chunks and publishes completed status', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Agent response' })
      const agent = new Agent({ model, printer: false })
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      await executor.execute(createRequestContext('Hello agent'), eventBus)

      // First event registers the task with the ResultManager
      expect(eventBus.events[0]).toStrictEqual({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'working' },
      })

      const artifactEvents = eventBus.events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update')
      const statusEvents = eventBus.events.filter((e): e is TaskStatusUpdateEvent => e.kind === 'status-update')

      // Should have at least 2 artifact events (text delta + lastChunk)
      expect(artifactEvents.length).toBeGreaterThanOrEqual(2)

      // First artifact: text delta, creates new artifact
      expect(artifactEvents[0]).toStrictEqual({
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        append: false,
        artifact: { artifactId: expect.any(String), parts: [{ kind: 'text', text: 'Agent response' }] },
      })

      // Last artifact: lastChunk marker, appends to existing artifact
      expect(artifactEvents[artifactEvents.length - 1]).toStrictEqual(
        expect.objectContaining({ append: true, lastChunk: true })
      )

      // All artifact events share the same artifactId
      const artifactId = artifactEvents[0]!.artifact.artifactId
      for (const event of artifactEvents) {
        expect(event.artifact.artifactId).toBe(artifactId)
      }

      // Only completed status — no working status (A2A-compliant streaming)
      expect(statusEvents).toStrictEqual([
        { kind: 'status-update', taskId: 'task-1', contextId: 'ctx-1', status: { state: 'completed' }, final: true },
      ])
    })

    it('sets append to true for subsequent chunks after the first', async () => {
      const model = new MockMessageModel().addTurn([
        { type: 'textBlock', text: 'First' },
        { type: 'textBlock', text: 'Second' },
      ])
      const agent = new Agent({ model, printer: false })
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      await executor.execute(createRequestContext('Hello'), eventBus)

      const artifactEvents = eventBus.events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update')

      // 2 text deltas + 1 lastChunk
      expect(artifactEvents).toHaveLength(3)
      expect(artifactEvents.map((e) => e.append)).toStrictEqual([false, true, true])
      expect(artifactEvents[2]!.lastChunk).toBe(true)
    })

    it('converts A2A parts to content blocks and passes to stream', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, printer: false })
      vi.spyOn(agent, 'stream')
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      const context: RequestContext = {
        taskId: 'task-1',
        contextId: 'ctx-1',
        userMessage: {
          kind: 'message',
          messageId: 'msg-1',
          role: 'user',
          parts: [
            { kind: 'text', text: 'Line 1' },
            { kind: 'file', file: { uri: 'file://test.txt' } },
            { kind: 'text', text: 'Line 2' },
          ],
        },
      }

      await executor.execute(context, eventBus)

      expect(agent.stream).toHaveBeenCalledWith(
        [new TextBlock('Line 1'), new TextBlock('[File: file (file://test.txt)]'), new TextBlock('Line 2')],
        { invocationState: { a2aRequestContext: context } }
      )
    })

    it('forwards the A2A request context to the agent via invocationState', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, printer: false })
      const streamSpy = vi.spyOn(agent, 'stream')
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()
      const context = createRequestContext('hello', 'task-42')

      await executor.execute(context, eventBus)

      expect(streamSpy).toHaveBeenCalledTimes(1)
      const [, options] = streamSpy.mock.calls[0]!
      expect(options?.invocationState).toEqual({ a2aRequestContext: context })
    })

    it('re-throws when agent throws, publishing only the initial task event', async () => {
      const model = new MockMessageModel().addTurn(new Error('Agent failed'))
      const agent = new Agent({ model, printer: false })
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      await expect(executor.execute(createRequestContext('Hello'), eventBus)).rejects.toThrow('Agent failed')

      // Only the initial task registration event is published before the error
      expect(eventBus.events).toStrictEqual([
        { kind: 'task', id: 'task-1', contextId: 'ctx-1', status: { state: 'working' } },
      ])
    })

    it('publishes image content blocks as separate file artifacts', async () => {
      const imageBytes = new Uint8Array([137, 80, 78, 71])
      const mockAgent: InvokableAgent = {
        id: 'test-agent',
        name: 'Test Agent',
        invoke: vi.fn(),
        async *stream() {
          const agent = createMockAgent()
          // Text delta
          yield new ModelStreamUpdateEvent({
            agent,
            event: { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Here is the image:' } },
            invocationState: {},
          })
          // Image content block
          yield new ContentBlockEvent({
            agent,
            contentBlock: new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
            invocationState: {},
          })
          return new AgentResult({
            stopReason: 'endTurn',
            lastMessage: new Message({ role: 'assistant', content: [new TextBlock('Here is the image:')] }),
            invocationState: {},
          })
        },
      }

      const executor = new A2AExecutor({ agentFactory: () => mockAgent })
      const eventBus = createMockEventBus()

      await executor.execute(createRequestContext('Generate an image'), eventBus)

      const artifactEvents = eventBus.events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update')

      // text delta + image artifact + final text lastChunk = 3
      expect(artifactEvents).toHaveLength(3)

      // First: text delta
      expect(artifactEvents[0]!.artifact.parts).toStrictEqual([{ kind: 'text', text: 'Here is the image:' }])

      // Second: image as file part with its own artifactId
      expect(artifactEvents[1]!.artifact.artifactId).not.toBe(artifactEvents[0]!.artifact.artifactId)
      expect(artifactEvents[1]!.lastChunk).toBe(true)
      expect(artifactEvents[1]!.append).toBe(false)
      expect(artifactEvents[1]!.artifact.parts).toStrictEqual([
        { kind: 'file', file: { bytes: encodeBase64(imageBytes), mimeType: 'image/png' } },
      ])

      // Third: final text lastChunk
      expect(artifactEvents[2]!.lastChunk).toBe(true)
    })

    it('throws A2AError.invalidRequest when parts produce no content blocks', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Response' })
      const agent = new Agent({ model, printer: false })
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      const context: RequestContext = {
        taskId: 'task-1',
        contextId: 'ctx-1',
        userMessage: { kind: 'message', messageId: 'msg-1', role: 'user', parts: [] },
      }

      await expect(executor.execute(context, eventBus)).rejects.toThrow('No content blocks available')
      expect(eventBus.events).toStrictEqual([])
    })
  })

  describe('cancelTask', () => {
    it('throws A2AError.unsupportedOperation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: '' })
      const agent = new Agent({ model, printer: false })
      const executor = new A2AExecutor({ agent })
      const eventBus = createMockEventBus()

      await expect(executor.cancelTask('task-1', eventBus)).rejects.toThrow('Task cancellation is not supported')
      expect(eventBus.events).toStrictEqual([])
    })
  })
})

// ============================================================================
// Per-context conversation isolation
//
// These tests drive a real Agent (with a deterministic echo model) through a
// single executor across two distinct A2A contextIds, asserting that no
// conversation state leaks between contexts, while a single context still
// accumulates its own history across turns.
// ============================================================================

/**
 * Deterministic, network-free model that echoes the latest user text prefixed
 * with `ECHO[<history-length>]`, so tests can observe per-context history growth.
 */
class EchoModel extends MockMessageModel {
  override async *stream(messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const lastText = lastUser?.content.find((b): b is TextBlock => b.type === 'textBlock')?.text ?? ''
    const reply = `ECHO[${messages.length}]: ${lastText}`
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    yield { type: 'modelContentBlockStartEvent' }
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: reply } }
    yield { type: 'modelContentBlockStopEvent' }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' }
  }
}

function makeEchoAgent(): Agent {
  return new Agent({ model: new EchoModel(), printer: false })
}

function ctxRequest(contextId: string, taskId: string, text: string): RequestContext {
  return {
    taskId,
    contextId,
    userMessage: {
      kind: 'message',
      messageId: `msg-${taskId}`,
      role: 'user',
      parts: [{ kind: 'text', text }],
    },
  }
}

function artifactTexts(eventBus: ReturnType<typeof createMockEventBus>): string[] {
  return eventBus.events
    .filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update')
    .flatMap((e) => e.artifact.parts)
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text)
}

describe('A2AExecutor context isolation', () => {
  describe('constructor validation', () => {
    it('throws when neither agent nor agentFactory is provided', () => {
      expect(() => new A2AExecutor()).toThrow("Provide exactly one of 'agent' or 'agentFactory'.")
    })

    it('throws when both agent and agentFactory are provided', () => {
      const agent = new Agent({ model: new MockMessageModel(), printer: false })
      expect(() => new A2AExecutor({ agent, agentFactory: () => agent })).toThrow(
        "Provide exactly one of 'agent' or 'agentFactory'."
      )
    })

    it('throws when maxContexts is less than 1', () => {
      expect(() => new A2AExecutor({ agentFactory: makeEchoAgent, maxContexts: 0 })).toThrow(
        'maxContexts must be at least 1'
      )
    })
  })

  describe('factory mode', () => {
    it('builds one agent per context and reuses it within a context', async () => {
      const built: string[] = []
      const agentsByContext = new Map<string, Agent>()
      const executor = new A2AExecutor({
        agentFactory: (contextId) => {
          built.push(contextId)
          const agent = makeEchoAgent()
          agentsByContext.set(contextId, agent)
          return agent
        },
      })

      await executor.execute(ctxRequest('ctx-A', 'a-1', 'first'), createMockEventBus())
      await executor.execute(ctxRequest('ctx-A', 'a-2', 'second'), createMockEventBus())
      await executor.execute(ctxRequest('ctx-B', 'b-1', 'first'), createMockEventBus())

      // Factory invoked once per distinct context, not per request.
      expect(built).toStrictEqual(['ctx-A', 'ctx-B'])
      // Distinct Agent instances per context.
      expect(agentsByContext.get('ctx-A')).not.toBe(agentsByContext.get('ctx-B'))
    })

    it('isolates history across contexts and continues it within one', async () => {
      const executor = new A2AExecutor({ agentFactory: makeEchoAgent })

      // ctx-A turn 1: just the user message in history -> ECHO[1].
      let bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-A', 'a-1', 'SECRET-AAAA'), bus)
      expect(artifactTexts(bus).some((t) => t.includes('ECHO[1]:') && t.includes('SECRET-AAAA'))).toBe(true)

      // ctx-A turn 2: history now has user1, assistant1, user2 -> ECHO[3].
      bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-A', 'a-2', 'again'), bus)
      expect(artifactTexts(bus).some((t) => t.includes('ECHO[3]:'))).toBe(true)

      // ctx-B is independent -> starts fresh, never sees ctx-A's secret.
      bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-B', 'b-1', 'hello'), bus)
      const textsB = artifactTexts(bus)
      expect(textsB.some((t) => t.includes('ECHO[1]:'))).toBe(true)
      expect(textsB.some((t) => t.includes('SECRET-AAAA'))).toBe(false)
    })

    it('evicts the least-recently-used context beyond maxContexts', async () => {
      const built: string[] = []
      const executor = new A2AExecutor({
        agentFactory: (contextId) => {
          built.push(contextId)
          return makeEchoAgent()
        },
        maxContexts: 2,
      })

      await executor.execute(ctxRequest('ctx-A', 'a-1', 'hi'), createMockEventBus())
      await executor.execute(ctxRequest('ctx-B', 'b-1', 'hi'), createMockEventBus())
      await executor.execute(ctxRequest('ctx-A', 'a-2', 'again'), createMockEventBus()) // touch A
      await executor.execute(ctxRequest('ctx-C', 'c-1', 'hi'), createMockEventBus()) // evicts B

      // B was evicted, so reusing it rebuilds a fresh agent (factory called again for B).
      await executor.execute(ctxRequest('ctx-B', 'b-2', 'hi'), createMockEventBus())
      expect(built).toStrictEqual(['ctx-A', 'ctx-B', 'ctx-C', 'ctx-B'])
    })
  })

  describe('single-agent mode (deprecated)', () => {
    it('isolates history across contexts via snapshot swapping', async () => {
      const executor = new A2AExecutor({ agent: makeEchoAgent() })

      let bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-A', 'a-1', 'SECRET-AAAA'), bus)
      expect(artifactTexts(bus).some((t) => t.includes('ECHO[1]:') && t.includes('SECRET-AAAA'))).toBe(true)

      // ctx-A continues -> ECHO[3].
      bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-A', 'a-2', 'again'), bus)
      expect(artifactTexts(bus).some((t) => t.includes('ECHO[3]:'))).toBe(true)

      // ctx-B starts fresh and never sees ctx-A's secret.
      bus = createMockEventBus()
      await executor.execute(ctxRequest('ctx-B', 'b-1', 'hello'), bus)
      const textsB = artifactTexts(bus)
      expect(textsB.some((t) => t.includes('ECHO[1]:'))).toBe(true)
      expect(textsB.some((t) => t.includes('SECRET-AAAA'))).toBe(false)
    })

    it('throws when a single agent has a sessionManager', () => {
      const agent = makeEchoAgent()
      ;(agent as unknown as { sessionManager: unknown }).sessionManager = {}
      expect(() => new A2AExecutor({ agent })).toThrow('sessionManager is not supported')
    })
  })

  describe('interrupts', () => {
    function interruptingAgent(interrupts?: Interrupt[]): InvokableAgent {
      return {
        id: 'test-agent',
        name: 'Test Agent',
        invoke: vi.fn(),
        // An agent that stops on an interrupt emits no stream events, only the result.
        // eslint-disable-next-line require-yield
        async *stream() {
          return new AgentResult({
            stopReason: 'interrupt',
            lastMessage: new Message({ role: 'assistant', content: [new TextBlock('')] }),
            invocationState: {},
            ...(interrupts !== undefined && { interrupts }),
          })
        },
      }
    }

    async function runInterrupting(interrupts?: Interrupt[]) {
      const executor = new A2AExecutor({ agentFactory: () => interruptingAgent(interrupts) })
      const eventBus = createMockEventBus()
      await executor.execute(createRequestContext('create the spring campaign'), eventBus)
      return eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
    }

    it('parks the task instead of reporting it completed', async () => {
      const statuses = await runInterrupting([new Interrupt({ id: 'int-1', name: 'approve', source: 'tool' })])

      expect(statuses.map((event) => event.status.state)).toStrictEqual(['input-required'])
    })

    it('advertises each interrupt id so a client can answer it', async () => {
      const statuses = await runInterrupting([
        new Interrupt({ id: 'int-1', name: 'approve', reason: { campaign: 'spring' }, source: 'tool' }),
        new Interrupt({ id: 'int-2', name: 'confirm', source: 'tool' }),
      ])

      const dataParts = (statuses[0]!.status.message?.parts ?? []).filter((part) => part.kind === 'data')
      expect(dataParts).toHaveLength(1)
      expect(dataParts[0]).toStrictEqual({
        kind: 'data',
        data: {
          interrupts: [
            { interruptId: 'int-1', name: 'approve', reason: { campaign: 'spring' } },
            { interruptId: 'int-2', name: 'confirm', reason: null },
          ],
        },
      })
      expect(statuses[0]!.status.message?.parts?.[0]).toStrictEqual({
        kind: 'text',
        text: 'Agent requires input:\n- approve: {"campaign":"spring"}\n- confirm',
      })
    })

    it('keeps the human-readable text part first', async () => {
      const statuses = await runInterrupting([
        new Interrupt({ id: 'int-1', name: 'approve', reason: 'needs sign-off', source: 'tool' }),
      ])

      const parts = statuses[0]!.status.message?.parts ?? []
      expect(parts[0]).toStrictEqual({ kind: 'text', text: 'Agent requires input:\n- approve: "needs sign-off"' })
    })

    it.each([
      { desc: 'a BigInt reason as a string', reason: 10n, wire: '10', text: 'Agent requires input:\n- approve: "10"' },
      { desc: 'a function reason as null', reason: () => 'x', wire: null, text: 'Agent requires input:\n- approve' },
    ])('advertises $desc', async ({ reason, wire, text }) => {
      const statuses = await runInterrupting([
        new Interrupt({ id: 'int-1', name: 'approve', reason: reason as unknown as JSONValue, source: 'tool' }),
      ])

      expect(statuses[0]!.status.message?.parts).toStrictEqual([
        { kind: 'text', text },
        { kind: 'data', data: { interrupts: [{ interruptId: 'int-1', name: 'approve', reason: wire }] } },
      ])
    })

    it.each([
      { desc: 'an empty interrupt list', interrupts: [] },
      { desc: 'no interrupt list', interrupts: undefined },
    ])('still parks the task when the result has $desc', async ({ interrupts }) => {
      const statuses = await runInterrupting(interrupts)

      expect(statuses.map((event) => event.status.state)).toStrictEqual(['input-required'])
      expect(statuses[0]!.status.message?.parts).toStrictEqual([
        { kind: 'text', text: 'Agent requires additional input to continue' },
      ])
    })

    it('reports a normal completion as completed', async () => {
      const executor = new A2AExecutor({ agentFactory: () => makeEchoAgent() })
      const eventBus = createMockEventBus()

      await executor.execute(createRequestContext('hello'), eventBus)

      const statuses = eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
      expect(statuses.map((event) => event.status.state)).toStrictEqual(['completed'])
    })

    it('advertises the id a real agent is actually waiting on', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'createCampaign', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Campaign is live.' })
      const tool = createMockTool('createCampaign', (context) => {
        context.interrupt({ name: 'approveCampaign', reason: { campaign: 'spring-launch' } })
      })
      const agent = new Agent({ model, tools: [tool], printer: false })

      const executor = new A2AExecutor({ agentFactory: () => agent })
      const eventBus = createMockEventBus()
      await executor.execute(createRequestContext('create the spring-launch campaign'), eventBus)

      const statuses = eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
      expect(statuses.map((event) => event.status.state)).toStrictEqual(['input-required'])

      // The interrupts reach the client only in the status message, never as an artifact.
      expect(eventBus.events.map((event) => event.kind)).toStrictEqual(['task', 'status-update'])

      // Read the advertised interrupts the way a client would, with no access to server internals.
      const dataParts = (statuses[0]!.status.message?.parts ?? []).filter((part) => part.kind === 'data')
      const advertised = (dataParts[0] as unknown as { data: { interrupts: { interruptId: string }[] } }).data
        .interrupts

      // The advertised id must be the one the agent parked, or the client cannot answer it.
      const parked = (agent as unknown as { _interruptState: { interrupts: Record<string, unknown> } })._interruptState
      expect(Object.keys(parked.interrupts)).toStrictEqual([advertised[0]!.interruptId])
    })

    beforeEach(() => {
      resumedWith.length = 0
    })

    function resumeContext(interruptId: string, response: unknown): RequestContext {
      return {
        taskId: 'task-1',
        contextId: 'ctx-1',
        userMessage: {
          kind: 'message',
          messageId: 'msg-2',
          role: 'user',
          parts: [{ kind: 'data', data: { interruptResponse: { interruptId, response } } }],
        },
      }
    }

    /** Records what the paused tool receives when it resumes, so the payload can be asserted. */
    const resumedWith: unknown[] = []

    function campaignAgent(): Agent {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'createCampaign', toolUseId: 'tool-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'Campaign is live.' })
      const tool = createMockTool('createCampaign', (context) => {
        const approval = context.interrupt({ name: 'approveCampaign', reason: { campaign: 'spring-launch' } })
        resumedWith.push(approval)
      })
      return new Agent({ model, tools: [tool], printer: false })
    }

    /** Runs the first turn and returns the interrupt id a client would read off the wire. */
    async function parkAndReadId(executor: A2AExecutor): Promise<string> {
      const eventBus = createMockEventBus()
      await executor.execute(createRequestContext('create the spring-launch campaign'), eventBus)
      const statuses = eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
      const dataParts = (statuses[0]!.status.message?.parts ?? []).filter((part) => part.kind === 'data')
      return (dataParts[0] as unknown as { data: { interrupts: { interruptId: string }[] } }).data.interrupts[0]!
        .interruptId
    }

    it('completes the round trip when the advertised id is answered', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      const interruptId = await parkAndReadId(executor)

      const eventBus = createMockEventBus()
      await executor.execute(resumeContext(interruptId, { approved: true }), eventBus)

      const statuses = eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
      expect(statuses.map((event) => event.status.state)).toStrictEqual(['completed'])

      // The paused tool resumed with the client's answer, not merely with the task marked done.
      expect(resumedWith).toStrictEqual([{ approved: true }])
    })

    it('refuses an id the agent is not waiting on and still accepts the right one', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      const interruptId = await parkAndReadId(executor)

      await expect(
        executor.execute(resumeContext('guessed-id', { approved: true }), createMockEventBus())
      ).rejects.toThrow('No pending interrupt matches id(s): guessed-id')

      // The refused answer must not have consumed the interrupt.
      const eventBus = createMockEventBus()
      await executor.execute(resumeContext(interruptId, { approved: true }), eventBus)
      const statuses = eventBus.events.filter((event): event is TaskStatusUpdateEvent => event.kind === 'status-update')
      expect(statuses.map((event) => event.status.state)).toStrictEqual(['completed'])
    })

    it('refuses an answer on a new task, publishing only the initial task event', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      await parkAndReadId(executor)

      const eventBus = createMockEventBus()
      await expect(executor.execute(resumeContext('guessed-id', { approved: true }), eventBus)).rejects.toThrow(
        'No pending interrupt matches id(s): guessed-id'
      )

      expect(eventBus.events).toStrictEqual([
        { kind: 'task', id: 'task-1', contextId: 'ctx-1', status: { state: 'working' } },
      ])
    })

    it('rethrows a failed run even when the task was waiting for input', async () => {
      const model = new MockMessageModel().addTurn(new Error('Agent failed'))
      const executor = new A2AExecutor({ agentFactory: () => new Agent({ model, printer: false }) })
      const task: Task = { kind: 'task', id: 'task-1', contextId: 'ctx-1', status: { state: 'input-required' } }

      await expect(executor.execute({ ...createRequestContext('Hello'), task }, createMockEventBus())).rejects.toThrow(
        'Agent failed'
      )
    })

    it('refuses a null response', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      const interruptId = await parkAndReadId(executor)

      await expect(executor.execute(resumeContext(interruptId, null), createMockEventBus())).rejects.toThrow(
        `Interrupt response for '${interruptId}' must provide a non-null 'response'`
      )
    })

    it('refuses a fresh conversational turn while the task is parked', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      await parkAndReadId(executor)

      await expect(executor.execute(createRequestContext('never mind'), createMockEventBus())).rejects.toThrow(
        'Task is awaiting an interrupt response and cannot accept a new message'
      )
    })

    it('refuses interrupt responses when nothing is pending', async () => {
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })

      await expect(executor.execute(resumeContext('int-1', { approved: true }), createMockEventBus())).rejects.toThrow(
        'Received interrupt responses but no interrupt is pending'
      )
    })

    it('refuses an interrupt id that only exists on Object.prototype', async () => {
      onTestFinished(() => {
        delete (Object.prototype as { response?: unknown }).response
      })
      const executor = new A2AExecutor({ agentFactory: () => campaignAgent() })
      await parkAndReadId(executor)

      await expect(
        executor.execute(resumeContext('__proto__', { approved: true }), createMockEventBus())
      ).rejects.toThrow('No pending interrupt matches id(s): __proto__')
      expect(({} as { response?: unknown }).response).toBeUndefined()
    })

    it('leaves an ordinary data part on the generic content path', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'ok' })
      const agent = new Agent({ model, printer: false })
      vi.spyOn(agent, 'stream')
      const executor = new A2AExecutor({ agent })

      await executor.execute(
        {
          taskId: 'task-1',
          contextId: 'ctx-1',
          userMessage: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'user',
            parts: [{ kind: 'data', data: { campaign: 'spring', budget: 100 } }],
          },
        },
        createMockEventBus()
      )

      expect(agent.stream).toHaveBeenCalledWith(
        [new TextBlock('[Structured Data]\n' + JSON.stringify({ campaign: 'spring', budget: 100 }, null, 2))],
        expect.anything()
      )
    })

    describe('behind the A2A request handler', () => {
      const card: AgentCard = {
        name: 'Campaign Agent',
        description: '',
        version: '0.0.1',
        protocolVersion: '0.2.0',
        url: '',
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        capabilities: { streaming: true },
      }

      function userMessage(messageId: string, parts: Part[], taskId?: string): A2AMessage {
        return {
          kind: 'message',
          messageId,
          role: 'user',
          contextId: 'ctx-1',
          parts,
          ...(taskId !== undefined && { taskId }),
        }
      }

      function answer(interruptId: string, response: unknown): Part {
        return { kind: 'data', data: { interruptResponse: { interruptId, response } } }
      }

      /** Sends the first turn, which parks the task on the campaign approval. */
      async function park(handler: DefaultRequestHandler): Promise<Task> {
        const text = 'create the spring-launch campaign'
        return (await handler.sendMessage({ message: userMessage('msg-1', [{ kind: 'text', text }]) })) as Task
      }

      /** The data parts of a parked task's status message, read the way a client would. */
      function advertisement(task: Task): Part[] {
        return (task.status.message?.parts ?? []).filter((part) => part.kind === 'data')
      }

      function advertisedId(task: Task): string {
        const [dataPart] = advertisement(task)
        return (dataPart as unknown as { data: { interrupts: { interruptId: string }[] } }).data.interrupts[0]!
          .interruptId
      }

      /** Builds a handler whose first run holds the context until the test finishes. */
      async function createBusyHandler(): Promise<DefaultRequestHandler> {
        let finishRun!: () => void
        const runCanFinish = new Promise<void>((resolve) => {
          finishRun = resolve
        })
        onTestFinished(() => finishRun())
        const agent: InvokableAgent = {
          id: 'busy-agent',
          name: 'Busy Agent',
          invoke: vi.fn(),
          // eslint-disable-next-line require-yield
          async *stream() {
            await runCanFinish
            return new AgentResult({
              stopReason: 'endTurn',
              lastMessage: new Message({ role: 'assistant', content: [new TextBlock('done')] }),
              invocationState: {},
            })
          },
        }
        const handler = new DefaultRequestHandler(
          card,
          new InMemoryTaskStore(),
          new A2AExecutor({ agentFactory: () => agent })
        )
        await handler.sendMessage({
          message: userMessage('msg-1', [{ kind: 'text', text: 'first' }]),
          configuration: { blocking: false },
        })
        return handler
      }

      it.each([
        ['an unknown id', (_interruptId: string) => [answer('guessed-id', { approved: true })]],
        ['a null response', (interruptId: string) => [answer(interruptId, null)]],
        ['a duplicate answer', (interruptId: string) => [answer(interruptId, true), answer(interruptId, false)]],
        ['a new conversational turn', (_interruptId: string): Part[] => [{ kind: 'text', text: 'never mind' }]],
      ])('keeps the task answerable after refusing %s', async (_refusal, refusedParts) => {
        const handler = new DefaultRequestHandler(
          card,
          new InMemoryTaskStore(),
          new A2AExecutor({ agentFactory: () => campaignAgent() })
        )
        const parked = await park(handler)
        const interruptId = advertisedId(parked)

        const refused = (await handler.sendMessage({
          message: userMessage('msg-2', refusedParts(interruptId), parked.id),
        })) as Task
        expect(refused.status).toStrictEqual({
          state: 'input-required',
          message: {
            kind: 'message',
            role: 'agent',
            messageId: expect.any(String),
            taskId: parked.id,
            contextId: 'ctx-1',
            parts: [{ kind: 'text', text: expect.stringMatching(/^Message refused: /) }, ...advertisement(parked)],
          },
        })

        const resumed = (await handler.sendMessage({
          message: userMessage('msg-3', [answer(interruptId, { approved: true })], parked.id),
        })) as Task
        expect(resumed.status).toStrictEqual({ state: 'completed' })
        expect(resumedWith).toStrictEqual([{ approved: true }])
      })

      it('keeps the task history when an answer resumes it', async () => {
        const taskStore = new InMemoryTaskStore()
        const handler = new DefaultRequestHandler(
          card,
          taskStore,
          new A2AExecutor({ agentFactory: () => campaignAgent() })
        )
        const parked = await park(handler)

        await handler.sendMessage({
          message: userMessage('msg-2', [answer(advertisedId(parked), { approved: true })], parked.id),
        })

        const stored = await taskStore.load(parked.id)
        expect(stored?.status).toStrictEqual({ state: 'completed' })
        expect(stored?.history?.map((message) => message.messageId)).toStrictEqual([
          'msg-1',
          parked.status.message?.messageId,
          'msg-2',
        ])
      })

      it('acknowledges a new message while an earlier run holds the context', async () => {
        const handler = await createBusyHandler()
        const message = userMessage('msg-2', [{ kind: 'text', text: 'second' }])

        let acknowledgement: unknown
        void handler.sendMessage({ message, configuration: { blocking: false } }).then((result) => {
          acknowledgement = result
        })

        await expect.poll(() => acknowledgement).toBeDefined()
        expect(acknowledgement).toStrictEqual({
          kind: 'task',
          id: expect.any(String),
          contextId: 'ctx-1',
          status: { state: 'working' },
          history: [message],
        })
      })

      it('streams the task event first while an earlier run holds the context', async () => {
        const handler = await createBusyHandler()
        const stream = handler.sendMessageStream({ message: userMessage('msg-2', [{ kind: 'text', text: 'second' }]) })

        let firstEvent: unknown
        void stream.next().then((result) => {
          firstEvent = result.value
        })

        await expect.poll(() => firstEvent).toBeDefined()
        expect(firstEvent).toStrictEqual({
          kind: 'task',
          id: expect.any(String),
          contextId: 'ctx-1',
          status: { state: 'working' },
        })
      })
    })
  })
})
