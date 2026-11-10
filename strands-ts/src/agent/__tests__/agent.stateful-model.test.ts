import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { MockSnapshotStorage } from '../../__fixtures__/mock-storage-provider.js'
import { SlidingWindowConversationManager } from '../../conversation-manager/sliding-window-conversation-manager.js'
import { NullConversationManager } from '../../conversation-manager/null-conversation-manager.js'
import { SessionManager } from '../../session/session-manager.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../../types/snapshot.js'
import { Message } from '../../types/messages.js'
import type { StreamOptions } from '../../index.js'
import type { ModelStreamEvent } from '../../models/streaming.js'
import type { JSONValue } from '../../types/json.js'

/**
 * Mock model that advertises itself as stateful and records the modelState
 * object it receives, so tests can verify the agent's modelState flows through.
 */
class StatefulMockModel extends MockMessageModel {
  readonly receivedOptions: StreamOptions[] = []
  private readonly _responseIds: string[]

  constructor(responseIds: string[] = ['resp_1', 'resp_2', 'resp_3']) {
    super()
    this._responseIds = responseIds
  }

  override get stateful(): boolean {
    return true
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncGenerator<ModelStreamEvent> {
    this.receivedOptions.push(options ?? {})
    // Simulate that the provider captured a fresh response id on the wire.
    if (options?.modelState) {
      const next = this._responseIds[this.receivedOptions.length - 1]
      if (next !== undefined) {
        options.modelState.set('responseId', next)
      }
    }
    yield* super.stream(messages, options)
  }
}

describe('Agent with stateful model', () => {
  describe('constructor', () => {
    it('throws when a conversationManager is supplied alongside a stateful model', () => {
      const model = new StatefulMockModel()
      expect(
        () => new Agent({ model, conversationManager: new SlidingWindowConversationManager({ windowSize: 5 }) })
      ).toThrow(/stateful model/)
    })

    it('assigns NullConversationManager when the model is stateful', () => {
      const model = new StatefulMockModel()
      const agent = new Agent({ model, printer: false })
      // Private field; access through bracket notation to avoid making it public.
      expect((agent as unknown as { _conversationManager: unknown })._conversationManager).toBeInstanceOf(
        NullConversationManager
      )
    })

    it('initializes modelState as an empty store', () => {
      const model = new StatefulMockModel()
      const agent = new Agent({ model, printer: false })
      expect(agent.modelState.getAll()).toEqual({})
    })

    it('hydrates modelState from AgentConfig.modelState', () => {
      const model = new StatefulMockModel()
      const agent = new Agent({ model, printer: false, modelState: { responseId: 'resp_restored' } })
      expect(agent.modelState.getAll()).toEqual({ responseId: 'resp_restored' })
    })
  })

  describe('invocation', () => {
    it('passes modelState snapshot to the model and writes back changes', async () => {
      const model = new StatefulMockModel(['resp_first']).addTurn({ type: 'textBlock', text: 'Hi' })
      const agent = new Agent({ model, printer: false })
      await agent.invoke('Hello')
      expect(model.receivedOptions[0]?.modelState).not.toBe(agent.modelState)
      expect(agent.modelState.getAll()).toEqual({ responseId: 'resp_first' })
    })

    it('clears messages after invocation since the server holds history', async () => {
      const model = new StatefulMockModel().addTurn({ type: 'textBlock', text: 'Hi there' })
      const agent = new Agent({ model, printer: false })
      await agent.invoke('First turn')
      expect(agent.messages).toEqual([])
    })

    it('clears messages before SessionManager snapshots on AfterInvocationEvent', async () => {
      // Guards the ordering of ModelPlugin vs SessionManager hooks on
      // AfterInvocationEvent: ModelPlugin must clear messages *before*
      // SessionManager persists the snapshot, otherwise the stored snapshot
      // would duplicate history that the server already owns.
      const storage = new MockSnapshotStorage()
      const sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
      const model = new StatefulMockModel().addTurn({ type: 'textBlock', text: 'reply' })
      const agent = new Agent({ id: 'agent-1', model, sessionManager, printer: false })

      await agent.invoke('hi')

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent-1' },
      })
      expect(snapshot).not.toBeNull()
      expect((snapshot!.data as { messages: unknown[] }).messages).toEqual([])
    })

    it('preserves modelState across invocations so previous_response_id chains', async () => {
      const model = new StatefulMockModel(['resp_1', 'resp_2'])
        .addTurn({ type: 'textBlock', text: 'one' })
        .addTurn({ type: 'textBlock', text: 'two' })
      const agent = new Agent({ model, printer: false })

      await agent.invoke('turn 1')
      expect(agent.modelState.getAll()).toEqual({ responseId: 'resp_1' })

      await agent.invoke('turn 2')
      expect(agent.modelState.getAll()).toEqual({ responseId: 'resp_2' })

      // Both turns should have seen the state at invocation time.
      expect(model.receivedOptions).toHaveLength(2)
    })
  })

  describe('stateless model (default)', () => {
    it('does not clear messages after invocation', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const agent = new Agent({ model, printer: false })
      await agent.invoke('Hi')
      // user message + assistant reply
      expect(agent.messages.length).toBe(2)
    })

    it('uses the caller-provided conversationManager', () => {
      const model = new MockMessageModel()
      const convo = new SlidingWindowConversationManager({ windowSize: 7 })
      const agent = new Agent({ model, conversationManager: convo })
      expect((agent as unknown as { _conversationManager: unknown })._conversationManager).toBe(convo)
    })
  })

  describe('SessionManager restore guard', () => {
    // Pre-seeds a session snapshot with messages, then verifies that SessionManager
    // discards those messages on restore when the model is stateful.
    async function setupStorageWithMessages(agentId: string, sessionId: string): Promise<MockSnapshotStorage> {
      const storage = new MockSnapshotStorage()
      await storage.saveSnapshot({
        location: { sessionId, scope: 'agent', scopeId: agentId },
        snapshotId: 'latest',
        isLatest: true,
        snapshot: {
          scope: 'agent',
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          createdAt: new Date().toISOString(),
          data: {
            messages: [{ role: 'user', content: [{ text: 'old turn' }] }] as unknown as JSONValue,
            state: {},
            systemPrompt: null,
            modelState: {},
          },
          appData: {},
        },
      })
      return storage
    }

    it('discards restored messages when the model is stateful', async () => {
      const storage = await setupStorageWithMessages('agent-1', 'session-stateful')
      const sessionManager = new SessionManager({
        sessionId: 'session-stateful',
        storage: { snapshot: storage },
      })
      const model = new StatefulMockModel()
      const agent = new Agent({ id: 'agent-1', model, sessionManager, printer: false })
      await agent.initialize()
      expect(agent.messages).toEqual([])
    })

    it('restores messages when the model is stateless', async () => {
      const storage = await setupStorageWithMessages('agent-2', 'session-stateless')
      const sessionManager = new SessionManager({
        sessionId: 'session-stateless',
        storage: { snapshot: storage },
      })
      const model = new MockMessageModel()
      const agent = new Agent({ id: 'agent-2', model, sessionManager, printer: false })
      await agent.initialize()
      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]!.role).toBe('user')
    })
  })
})
