import { describe, expect, it, vi } from 'vitest'
import { A2AExecutor } from '../executor.js'
import type { AgentExecutionEvent, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server'
import type { TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from '@a2a-js/sdk'
import { Agent } from '../../agent/agent.js'
import type { InvokableAgent } from '../../types/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockAgent } from '../../__fixtures__/agent-helpers.js'
import { TextBlock } from '../../types/messages.js'
import { ImageBlock, encodeBase64 } from '../../types/media.js'
import { ContentBlockEvent, ModelStreamUpdateEvent } from '../../hooks/events.js'
import { AgentResult } from '../../types/agent.js'
import { Message } from '../../types/messages.js'
import type { ModelStreamEvent } from '../../models/streaming.js'

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
})
