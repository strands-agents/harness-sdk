import { describe, expect, it, beforeEach, vi } from 'vitest'
import { SessionManager } from '../session-manager.js'
import { MockSnapshotStorage, createTestSnapshot } from '../../__fixtures__/mock-storage-provider.js'
import {
  InitializedEvent,
  MessageAddedEvent,
  AfterInvocationEvent,
  AfterModelCallEvent,
  HookableEvent,
  type HookableEventConstructor,
  type HookCallback,
  type HookCleanup,
} from '../../hooks/index.js'
import { Agent } from '../../agent/agent.js'
import { Message, TextBlock } from '../../types/messages.js'
import {
  createMockAgent as createMockAgentWithHooks,
  invokeTrackedHook,
  type TrackedHook,
} from '../../__fixtures__/agent-helpers.js'
import { loadStateFromJSONSymbol, stateToJSONSymbol } from '../../types/serializable.js'
import { StateStore } from '../../state-store.js'
import { logger } from '../../logging/logger.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { ContextManager } from '../../context-manager/context-manager.js'
import { Stash } from '../../context-manager/stash.js'
import { STASH_PREFIX } from '../../context-manager/stash.js'
import {
  AfterMultiAgentInvocationEvent,
  AfterNodeCallEvent,
  BeforeMultiAgentInvocationEvent,
  Graph,
  type MultiAgent,
  MultiAgentState,
  NodeResult,
  Status,
} from '../../multiagent/index.js'
import { takeSnapshot, loadSnapshot } from '../../agent/snapshot.js'
import type { Snapshot } from '../../types/snapshot.js'
import type { JSONValue } from '../../types/json.js'
import type { TakeSnapshotOptions } from '../../agent/snapshot.js'

// Test fixtures
function createMockAgent(id = 'agent'): Agent {
  const agent = {
    id,
    messages: [],
    appState: {
      _m: new Map(),
      get(k: string) {
        return this._m.get(k)
      },
      set(k: string, v: unknown) {
        this._m.set(k, v)
      },
      [stateToJSONSymbol]() {
        return Object.fromEntries(this._m)
      },
      [loadStateFromJSONSymbol](json: Record<string, unknown>) {
        Object.entries(json).forEach(([k, v]) => this._m.set(k, v))
      },
    } as any,
    modelState: new StateStore(),
    systemPrompt: 'Test prompt',
    takeSnapshot(options: TakeSnapshotOptions): Snapshot {
      return takeSnapshot(agent as any, options)
    },
    loadSnapshot(snapshot: Snapshot): void {
      loadSnapshot(agent as any, snapshot)
    },
  } as unknown as Agent
  return agent
}

const MOCK_MESSAGE = new Message({ role: 'user', content: [new TextBlock('test')] })

function createMockEvent(agent: Agent) {
  return { agent, invocationState: {} }
}

function createMockMessageEvent(agent: Agent) {
  return { agent, message: MOCK_MESSAGE, invocationState: {} }
}

async function initPluginAndInvokeHook<T extends HookableEvent>(
  sessionManager: SessionManager,
  event: T
): Promise<void> {
  const pluginAgent = createMockAgentWithHooks()
  sessionManager.initAgent(pluginAgent)
  await invokeTrackedHook(pluginAgent, event)
}

describe('SessionManager', () => {
  let storage: MockSnapshotStorage
  let sessionManager: SessionManager
  let mockAgent: Agent

  beforeEach(() => {
    storage = new MockSnapshotStorage()
    mockAgent = createMockAgent()
  })

  describe('constructor', () => {
    it('defaults saveLatestOn to invocation', async () => {
      sessionManager = new SessionManager({ sessionId: 'test-default', storage: { snapshot: storage } })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-default', scope: 'agent', scopeId: 'agent' },
      })
      expect(snapshot).not.toBeNull()
    })
  })

  describe('saveSnapshot', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
    })

    it('saves snapshot_latest when isLatest is true', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: true })

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot?.scope).toBe('agent')
    })

    it('saves immutable snapshot when isLatest is false', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBeGreaterThan(0)
    })

    it('allocates unique snapshot IDs', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(3)
    })
  })

  describe('listSnapshotIds', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
    })

    it('returns empty array when no snapshots exist', async () => {
      const ids = await sessionManager.listSnapshotIds({ target: mockAgent })
      expect(ids).toStrictEqual([])
    })

    it('returns snapshot IDs for the target agent', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })

      const ids = await sessionManager.listSnapshotIds({ target: mockAgent })
      expect(ids).toHaveLength(2)
    })

    it('does not return latest snapshot ID', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: true })

      const ids = await sessionManager.listSnapshotIds({ target: mockAgent })
      expect(ids).toStrictEqual([])
    })

    it('forwards limit parameter', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })

      const ids = await sessionManager.listSnapshotIds({ target: mockAgent, limit: 2 })
      expect(ids).toHaveLength(2)
    })

    it('forwards startAfter parameter', async () => {
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })
      await sessionManager.saveSnapshot({ target: mockAgent, isLatest: false })

      const allIds = await sessionManager.listSnapshotIds({ target: mockAgent })
      const page2 = await sessionManager.listSnapshotIds({ target: mockAgent, startAfter: allIds[0]! })
      expect(page2).toHaveLength(1)
      expect(page2[0]).toBe(allIds[1])
    })
  })

  describe('restoreSnapshot', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
    })

    it('restores snapshot_latest when no snapshotId provided', async () => {
      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      const result = await sessionManager.restoreSnapshot({ target: mockAgent })

      expect(result).toBe(true)
    })

    it('restores specific snapshot by ID', async () => {
      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        snapshotId: '5',
        isLatest: false,
        snapshot,
      })

      const result = await sessionManager.restoreSnapshot({ target: mockAgent, snapshotId: '5' })

      expect(result).toBe(true)
    })

    it('returns false when snapshot not found', async () => {
      const result = await sessionManager.restoreSnapshot({ target: mockAgent, snapshotId: '999' })

      expect(result).toBe(false)
    })
  })

  describe('InitializedEvent handling', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
    })

    it('loads snapshot_latest on initialization', async () => {
      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })

      await initPluginAndInvokeHook(sessionManager, new InitializedEvent(createMockEvent(mockAgent)))

      expect(mockAgent.messages).toEqual(snapshot.data.messages)
    })

    it('handles missing snapshot gracefully', async () => {
      sessionManager = new SessionManager({
        sessionId: 'new-session',
        storage: { snapshot: storage },
      })

      await expect(
        initPluginAndInvokeHook(sessionManager, new InitializedEvent(createMockEvent(mockAgent)))
      ).resolves.not.toThrow()
    })

    it('warns when snapshot restore overwrites existing messages', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')

      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      mockAgent.messages.push(MOCK_MESSAGE)

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })

      await initPluginAndInvokeHook(sessionManager, new InitializedEvent(createMockEvent(mockAgent)))

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('overwritten by session restore'))
      warnSpy.mockRestore()
    })

    it('does not warn when restoring into agent with no messages', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')

      const snapshot = createTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })

      await initPluginAndInvokeHook(sessionManager, new InitializedEvent(createMockEvent(mockAgent)))

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('MessageAddedEvent handling', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
    })

    it('saves snapshot_latest when saveLatestOn is message', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'message',
      })

      await initPluginAndInvokeHook(sessionManager, new MessageAddedEvent(createMockMessageEvent(mockAgent)))

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).not.toBeNull()
    })

    it('does not save when saveLatestOn is invocation', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'invocation',
      })

      // MessageAddedEvent is not registered when saveLatestOn is 'invocation'
      // So we need to call initAgent and check that no hook is registered for MessageAddedEvent
      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)

      // Verify MessageAddedEvent hook is not registered
      const messageHook = pluginAgent.trackedHooks.find((h) => h.eventType === MessageAddedEvent)
      expect(messageHook).toBeUndefined()

      // Even if we try to invoke (nothing should happen)
      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).toBeNull()
    })
  })

  describe('AfterInvocationEvent handling', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
    })

    it('saves snapshot_latest when saveLatestOn is invocation', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'invocation',
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).not.toBeNull()
    })

    it('saves snapshot_latest when saveLatestOn is message', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'message',
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).not.toBeNull()
    })

    it('does not save snapshot_latest when saveLatestOn is trigger', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).toBeNull()
    })
  })

  describe('snapshotTrigger', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
    })

    it('creates immutable snapshot when trigger returns true', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: () => true,
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(1)
    })

    it('does not create immutable snapshot when trigger returns false', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: () => false,
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(0)
    })

    it('provides agentData to trigger', async () => {
      const triggerSpy = vi.fn(() => false)
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: triggerSpy,
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      expect(triggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          agentData: expect.objectContaining({
            appState: mockAgent.appState,
            messages: mockAgent.messages,
          }),
        })
      )
    })

    it('saves both immutable and latest when trigger fires', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: () => true,
      })

      await initPluginAndInvokeHook(sessionManager, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const immutableIds = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      const latest = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })

      expect(immutableIds.length).toBe(1)
      expect(latest).not.toBeNull()
    })

    it('trigger based on message count via agentData', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: ({ agentData }) => agentData.messages.length >= 2,
      })

      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)

      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      let ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(0) // 0 messages — no snapshot

      mockAgent.messages.push(MOCK_MESSAGE, MOCK_MESSAGE)
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(1) // 2 messages — snapshot taken
    })

    it('trigger based on agent state via agentData', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: ({ agentData }) => (agentData.appState as any).get('checkpoint') === true,
      })

      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)

      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      let ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(0) // state not set — no snapshot

      mockAgent.appState.set('checkpoint', true)
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(ids.length).toBe(1) // state set — snapshot taken
    })
  })

  describe('integration scenarios', () => {
    it('handles complete session lifecycle', async () => {
      sessionManager = new SessionManager({
        sessionId: 'lifecycle-test',
        storage: { snapshot: storage },
        saveLatestOn: 'invocation',
        snapshotTrigger: () => true,
      })

      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)

      await invokeTrackedHook(pluginAgent, new InitializedEvent(createMockEvent(mockAgent)))
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const latest = await storage.loadSnapshot({
        location: { sessionId: 'lifecycle-test', scope: 'agent', scopeId: 'agent' },
      })
      const immutableIds = await storage.listSnapshotIds({
        location: { sessionId: 'lifecycle-test', scope: 'agent', scopeId: 'agent' },
      })

      expect(latest).not.toBeNull()
      expect(immutableIds.length).toBe(3)
    })

    it('supports resuming from immutable snapshot', async () => {
      // First session - snapshot fires when messages.length === 2 (after turn 1)
      sessionManager = new SessionManager({
        sessionId: 'resume-test',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        snapshotTrigger: ({ agentData }) => agentData.messages.length === 2,
      })

      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)

      await invokeTrackedHook(pluginAgent, new InitializedEvent(createMockEvent(mockAgent)))
      mockAgent.messages.push(MOCK_MESSAGE, MOCK_MESSAGE)
      await invokeTrackedHook(pluginAgent, new AfterInvocationEvent(createMockEvent(mockAgent)))

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'resume-test', scope: 'agent', scopeId: 'agent' },
      })
      expect(ids.length).toBe(1)

      // Second session - resume from that snapshot
      const newAgent = createMockAgent()
      const newSessionManager = new SessionManager({
        sessionId: 'resume-test',
        storage: { snapshot: storage },
        saveLatestOn: 'invocation',
      })

      const newAgentData = createMockAgentWithHooks()
      newSessionManager.initAgent(newAgentData)

      await invokeTrackedHook(newAgentData, new InitializedEvent(createMockEvent(newAgent)))
      await newSessionManager.restoreSnapshot({ target: newAgent, snapshotId: ids[0]! })

      expect(newAgent.messages).toEqual(mockAgent.messages)
    })
  })

  describe('AfterModelCallEvent with redaction handling', () => {
    beforeEach(() => {
      mockAgent = createMockAgent('test-agent')
    })

    it('saves snapshot_latest when saveLatestOn is message and redaction occurred', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'message',
      })

      const assistantMessage = new Message({ role: 'assistant', content: [new TextBlock('Response')] })
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        stopData: {
          message: assistantMessage,
          stopReason: 'endTurn' as const,
          redaction: { userMessage: '[User input redacted.]' },
        },
      } as any)

      await initPluginAndInvokeHook(sessionManager, event)

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).not.toBeNull()
    })

    it('does not save when saveLatestOn is message but no redaction occurred', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'message',
      })

      const assistantMessage = new Message({ role: 'assistant', content: [new TextBlock('Response')] })
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        stopData: { message: assistantMessage, stopReason: 'endTurn' as const },
      } as any)

      await initPluginAndInvokeHook(sessionManager, event)

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).toBeNull()
    })

    it.each(['invocation', 'message'] as const)(
      'saves snapshot_latest on redaction when saveLatestOn is %s',
      async (saveLatestOn) => {
        sessionManager = new SessionManager({
          sessionId: 'test-session',
          storage: { snapshot: storage },
          saveLatestOn,
        })

        const assistantMessage = new Message({ role: 'assistant', content: [new TextBlock('Response')] })
        const event = new AfterModelCallEvent({
          agent: mockAgent,
          model: {} as any,
          stopData: {
            message: assistantMessage,
            stopReason: 'endTurn' as const,
            redaction: { userMessage: '[User input redacted.]' },
          },
        } as any)

        await initPluginAndInvokeHook(sessionManager, event)

        const snapshot = await storage.loadSnapshot({
          location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
        })
        expect(snapshot).not.toBeNull()
      }
    )

    it('does not register AfterModelCallEvent hook when saveLatestOn is trigger', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
      })

      const pluginAgent = createMockAgentWithHooks()
      sessionManager.initAgent(pluginAgent)
      const afterModelHook = pluginAgent.trackedHooks.find((h) => h.eventType === AfterModelCallEvent)
      expect(afterModelHook).toBeUndefined()
    })

    it('does not save on AfterModelCallEvent without redaction under saveLatestOn=invocation', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'invocation',
      })

      const assistantMessage = new Message({ role: 'assistant', content: [new TextBlock('Response')] })
      const event = new AfterModelCallEvent({
        agent: mockAgent,
        model: {} as any,
        stopData: { message: assistantMessage, stopReason: 'endTurn' as const },
      } as any)

      await initPluginAndInvokeHook(sessionManager, event)

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'test-agent' },
      })
      expect(snapshot).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// Stash integration tests
// ---------------------------------------------------------------------------

describe('SessionManager — stash integration', () => {
  let rootStorage: InMemoryStorage
  let snapshotStorage: MockSnapshotStorage
  let sessionManager: SessionManager

  function createAgentWithStash(
    sessionId: string,
    agentId = 'agent',
    stashStorage?: InMemoryStorage
  ): { agent: Agent; stash: Stash } {
    const storage = stashStorage ?? rootStorage
    const stash = new Stash(storage, sessionId, agentId)
    const contextManager = { stash } as unknown as ContextManager
    const agent = {
      ...createMockAgent(agentId),
      contextManager,
    } as unknown as Agent
    return { agent, stash }
  }

  beforeEach(() => {
    rootStorage = new InMemoryStorage()
    snapshotStorage = new MockSnapshotStorage()
  })

  describe('saveSnapshot', () => {
    it('includes stash data in the snapshot', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent, stash } = createAgentWithStash('test-session')
      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'hello' })))

      await sessionManager.saveSnapshot({ target: agent, isLatest: true })

      const snapshot = await snapshotStorage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot!.data.stash).toBeDefined()
      const stashData = snapshot!.data.stash as Record<string, unknown>
      expect(stashData).toEqual({
        location: 'inline',
        entries: { 'tool-1_0': { text: 'hello' } },
      })
    })

    it('omits stash key when agent has no context manager', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const agent = createMockAgent('agent')
      await sessionManager.saveSnapshot({ target: agent, isLatest: true })

      const snapshot = await snapshotStorage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
      })
      expect(snapshot).not.toBeNull()
      expect('stash' in snapshot!.data).toBe(false)
    })

    it('omits stash key when stash is empty', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent } = createAgentWithStash('test-session')
      await sessionManager.saveSnapshot({ target: agent, isLatest: true })

      const snapshot = await snapshotStorage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
      })
      expect(snapshot).not.toBeNull()
      expect('stash' in snapshot!.data).toBe(false)
    })

    it('writes external ref when storage is durable', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const stash = new Stash(rootStorage, 'test-session', 'agent')
      const contextManager = { stash, stashIsDurable: true } as unknown as ContextManager
      const agent = { ...createMockAgent('agent'), contextManager } as unknown as Agent
      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'hello' })))

      await sessionManager.saveSnapshot({ target: agent, isLatest: true })

      const snapshot = await snapshotStorage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot!.data.stash).toEqual({ location: 'external', storageType: 'InMemoryStorage' })
    })
  })

  describe('restoreSnapshot', () => {
    it('restores stash data from snapshot', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent, stash } = createAgentWithStash('test-session')
      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'hello' })))
      await stash.store('tool-2', 0, new TextEncoder().encode(JSON.stringify({ text: 'world' })))

      await sessionManager.saveSnapshot({ target: agent, isLatest: true })

      // Create a fresh stash and agent to restore into
      const { agent: freshAgent, stash: freshStash } = createAgentWithStash('test-session')
      const result = await sessionManager.restoreSnapshot({ target: freshAgent })

      expect(result).toBe(true)
      const restored1 = await freshStash.retrieve('tool-1_0')
      const restored2 = await freshStash.retrieve('tool-2_0')
      expect(restored1?.data).toEqual({ text: 'hello' })
      expect(restored2?.data).toEqual({ text: 'world' })
    })

    it('skips stash restore when location is external', async () => {
      const snapshot = createTestSnapshot()
      snapshot.data.stash = { location: 'external' } as JSONValue
      await snapshotStorage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent, stash } = createAgentWithStash('test-session')
      const result = await sessionManager.restoreSnapshot({ target: agent })

      expect(result).toBe(true)
      const keys = await stash.list()
      expect(keys).toHaveLength(0)
    })

    it('warns when stash storage type changed since snapshot', async () => {
      const snapshot = createTestSnapshot()
      snapshot.data.stash = { location: 'external', storageType: 'S3Storage' } as JSONValue
      await snapshotStorage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent } = createAgentWithStash('test-session')
      const warnSpy = vi.spyOn(logger, 'warn')
      await sessionManager.restoreSnapshot({ target: agent })

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('stash storage type changed since snapshot was created')
      )
      warnSpy.mockRestore()
    })

    it('handles snapshot without stash data', async () => {
      const snapshot = createTestSnapshot()
      await snapshotStorage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'agent', scopeId: 'agent' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      const { agent } = createAgentWithStash('test-session')
      const result = await sessionManager.restoreSnapshot({ target: agent })

      expect(result).toBe(true)
    })
  })

  describe('deleteSession', () => {
    it('deletes stash data via stash reference', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: rootStorage,
      })
      const stash = new Stash(rootStorage, 'test-session', 'agent')
      const mockAgent = createMockAgentWithHooks({
        extra: {
          storage: rootStorage,
          contextManager: { stash },
        } as unknown as Partial<Agent>,
      })
      sessionManager.initAgent(mockAgent)

      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('data1')))
      await stash.store('tool-2', 0, new TextEncoder().encode(JSON.stringify('data2')))

      const keysBefore = await stash.list()
      expect(keysBefore).toHaveLength(2)

      await sessionManager.deleteSession()

      const keysAfter = await stash.list()
      expect(keysAfter).toHaveLength(0)
    })

    it('deletes stash data from custom stash storage', async () => {
      const customStashStorage = new InMemoryStorage()
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: rootStorage,
      })
      const stash = new Stash(customStashStorage, 'test-session', 'agent')
      const mockAgent = createMockAgentWithHooks({
        extra: {
          storage: rootStorage,
          contextManager: { stash },
        } as unknown as Partial<Agent>,
      })
      sessionManager.initAgent(mockAgent)

      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('data1')))

      const keysBefore = await stash.list()
      expect(keysBefore).toHaveLength(1)

      await sessionManager.deleteSession()

      const keysAfter = await stash.list()
      expect(keysAfter).toHaveLength(0)
    })

    it('deletes stash data when storage is pre-namespaced', async () => {
      const shared = new InMemoryStorage()
      const namespacedStorage = shared.namespace('my-prefix')
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: rootStorage,
      })
      const stash = new Stash(namespacedStorage, 'test-session', 'agent')
      const mockAgent = createMockAgentWithHooks({
        extra: {
          storage: rootStorage,
          contextManager: { stash },
        } as unknown as Partial<Agent>,
      })
      sessionManager.initAgent(mockAgent)

      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('data1')))

      const keysBefore = await stash.list()
      expect(keysBefore).toHaveLength(1)

      await sessionManager.deleteSession()

      const keysAfter = await stash.list()
      expect(keysAfter).toHaveLength(0)
    })

    it('does not over-delete when rootStorage is pre-namespaced', async () => {
      const shared = new InMemoryStorage()
      const namespacedRoot = shared.namespace('tenant-a')
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: namespacedRoot,
      })
      const stash = new Stash(namespacedRoot, 'test-session', 'agent')
      const mockAgent = createMockAgentWithHooks({
        extra: {
          storage: namespacedRoot,
          contextManager: { stash },
        } as unknown as Partial<Agent>,
      })
      sessionManager.initAgent(mockAgent)

      await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('data1')))

      // Write unrelated data under the same namespace but outside the session's stash prefix
      await namespacedRoot.write('other-data/important', new TextEncoder().encode('keep-me'))

      await sessionManager.deleteSession()

      const stashKeys = await stash.list()
      expect(stashKeys).toHaveLength(0)

      // Unrelated data must survive
      const preserved = await namespacedRoot.read('other-data/important')
      expect(preserved).not.toBeNull()
    })

    it('clearSession cleans up stash data from other agents in the session', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: rootStorage,
      })
      const stashA = new Stash(rootStorage, 'test-session', 'agent-a')
      const stashB = new Stash(rootStorage, 'test-session', 'agent-b')
      const mockAgent = createMockAgentWithHooks({
        extra: {
          storage: rootStorage,
          contextManager: { stash: stashA },
        } as unknown as Partial<Agent>,
      })
      sessionManager.initAgent(mockAgent)

      await stashA.store('tool-1', 0, new TextEncoder().encode(JSON.stringify('from-a')))
      await stashB.store('tool-2', 0, new TextEncoder().encode(JSON.stringify('from-b')))

      await sessionManager.deleteSession()

      const keysA = await stashA.list()
      const keysB = await stashB.list()
      expect(keysA).toHaveLength(0)
      expect(keysB).toHaveLength(0)
    })

    it('succeeds when no stash is available', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: snapshotStorage },
      })
      sessionManager.initAgent(createMockAgentWithHooks())

      await expect(sessionManager.deleteSession()).resolves.not.toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// Stash integration test — real Agent + ContextManager + SessionManager
// ---------------------------------------------------------------------------

describe('SessionManager — stash with real Agent wiring', () => {
  let storage: InMemoryStorage
  let snapshotStorage: MockSnapshotStorage

  beforeEach(() => {
    storage = new InMemoryStorage()
    snapshotStorage = new MockSnapshotStorage()
  })

  it('round-trips stash data through save and restore with real Agent', async () => {
    const sessionManager = new SessionManager({
      sessionId: 'test-session',
      storage: { snapshot: snapshotStorage },
    })
    const agent = new Agent({
      model: {} as any,
      storage,
      contextManager: new ContextManager(),
      sessionManager,
      printer: false,
    })
    await agent.initialize()

    const stash = agent.contextManager!.stash!
    await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'hello' })))
    await stash.store('tool-2', 0, new TextEncoder().encode(JSON.stringify({ text: 'world' })))

    await sessionManager.saveSnapshot({ target: agent, isLatest: true })

    const freshSessionManager = new SessionManager({
      sessionId: 'test-session',
      storage: { snapshot: snapshotStorage },
    })
    const freshAgent = new Agent({
      model: {} as any,
      storage,
      contextManager: new ContextManager(),
      sessionManager: freshSessionManager,
      printer: false,
    })
    await freshAgent.initialize()

    const freshStash = freshAgent.contextManager!.stash!
    const restored1 = await freshStash.retrieve('tool-1_0')
    const restored2 = await freshStash.retrieve('tool-2_0')
    expect(restored1?.data).toEqual({ text: 'hello' })
    expect(restored2?.data).toEqual({ text: 'world' })
  })

  it('deleteSession cleans up stash data with real Agent', async () => {
    const sessionManager = new SessionManager({
      sessionId: 'test-session',
      storage,
    })
    const agent = new Agent({
      model: {} as any,
      storage,
      contextManager: new ContextManager(),
      sessionManager,
      printer: false,
    })
    await agent.initialize()

    const stash = agent.contextManager!.stash!
    await stash.store('tool-1', 0, new TextEncoder().encode(JSON.stringify({ text: 'hello' })))

    const keysBefore = await storage.list(`${STASH_PREFIX}/`)
    expect(keysBefore.length).toBeGreaterThan(0)

    await sessionManager.deleteSession()

    const keysAfter = await storage.list(`${STASH_PREFIX}/`)
    expect(keysAfter).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Multi-agent tests
// ---------------------------------------------------------------------------

type MockOrchestrator = MultiAgent & {
  trackedHooks: TrackedHook[]
  nodes: ReadonlyMap<string, unknown>
}

function createMockOrchestrator(id = 'graph'): MockOrchestrator {
  const trackedHooks: TrackedHook[] = []
  return {
    id,
    nodes: new Map(),
    invoke: vi.fn(),
    stream: vi.fn(),
    addHook: <T extends HookableEvent>(
      eventType: HookableEventConstructor<T>,
      callback: HookCallback<T>
    ): HookCleanup => {
      trackedHooks.push({
        eventType: eventType as HookableEventConstructor<HookableEvent>,
        callback: callback as HookCallback<HookableEvent>,
      })
      return () => {}
    },
    trackedHooks,
  } as unknown as MockOrchestrator
}

function invokeOrchestratorHook<T extends HookableEvent>(orchestrator: MockOrchestrator, event: T): Promise<void> {
  const hook = orchestrator.trackedHooks.find((h) => h.eventType === event.constructor)
  if (!hook) throw new Error(`No hook registered for event type: ${event.constructor.name}`)
  return hook.callback(event) as Promise<void>
}

function createMultiAgentTestSnapshot(orchestratorId = 'test-graph'): ReturnType<typeof createTestSnapshot> {
  return createTestSnapshot({ scope: 'multiAgent', data: { orchestratorId } })
}

describe('SessionManager — multi-agent', () => {
  let storage: MockSnapshotStorage
  let sessionManager: SessionManager
  let orchestrator: MockOrchestrator

  beforeEach(() => {
    storage = new MockSnapshotStorage()
    orchestrator = createMockOrchestrator('test-graph')
  })

  describe('initMultiAgent', () => {
    it('registers BeforeMultiAgentInvocationEvent hook', () => {
      sessionManager = new SessionManager({ sessionId: 'test', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestrator)

      const hook = orchestrator.trackedHooks.find((h) => h.eventType === BeforeMultiAgentInvocationEvent)
      expect(hook).toBeDefined()
    })

    it('registers AfterNodeCallEvent hook by default (node strategy)', () => {
      sessionManager = new SessionManager({ sessionId: 'test', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestrator)

      const hook = orchestrator.trackedHooks.find((h) => h.eventType === AfterNodeCallEvent)
      expect(hook).toBeDefined()
    })

    it('registers AfterMultiAgentInvocationEvent hook when strategy is invocation', () => {
      sessionManager = new SessionManager({
        sessionId: 'test',
        storage: { snapshot: storage },
        multiAgentSaveLatestOn: 'invocation',
      })
      sessionManager.initMultiAgent(orchestrator)

      const hook = orchestrator.trackedHooks.find((h) => h.eventType === AfterMultiAgentInvocationEvent)
      expect(hook).toBeDefined()
    })
  })

  describe('saveSnapshot — multi-agent', () => {
    beforeEach(() => {
      sessionManager = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
    })

    it('saves orchestrator snapshot as latest', async () => {
      await sessionManager.saveSnapshot({ target: orchestrator as unknown as Graph, isLatest: true })

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot?.scope).toBe('multiAgent')
    })

    it('saves orchestrator snapshot with state', async () => {
      const state = new MultiAgentState({ nodeIds: ['a'] })
      state.steps = 3

      await sessionManager.saveSnapshot({ target: orchestrator as unknown as Graph, state, isLatest: true })

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot?.data.state).toBeDefined()
    })

    it('saves immutable orchestrator snapshot', async () => {
      await sessionManager.saveSnapshot({ target: orchestrator as unknown as Graph, isLatest: false })

      const ids = await storage.listSnapshotIds({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(ids.length).toBe(1)
    })
  })

  describe('restoreSnapshot — multi-agent', () => {
    beforeEach(() => {
      sessionManager = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
    })

    it('restores orchestrator snapshot', async () => {
      const snapshot = createMultiAgentTestSnapshot()
      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      const result = await sessionManager.restoreSnapshot({ target: orchestrator as unknown as Graph })
      expect(result).toBe(true)
    })

    it('returns false when no snapshot exists', async () => {
      const result = await sessionManager.restoreSnapshot({ target: orchestrator as unknown as Graph })
      expect(result).toBe(false)
    })
  })

  describe('AfterMultiAgentInvocationEvent handling', () => {
    it('saves snapshot after node call when multiAgentSaveLatestOn is node (default)', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
      })
      sessionManager.initMultiAgent(orchestrator)

      const state = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new AfterNodeCallEvent({ orchestrator, state, nodeId: 'a', invocationState: {} })
      )

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot?.scope).toBe('multiAgent')
    })

    it('saves snapshot after invocation when multiAgentSaveLatestOn is invocation', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        multiAgentSaveLatestOn: 'invocation',
      })
      sessionManager.initMultiAgent(orchestrator)

      const state = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new AfterMultiAgentInvocationEvent({ orchestrator, state, invocationState: {} })
      )

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(snapshot).not.toBeNull()
      expect(snapshot?.scope).toBe('multiAgent')
    })

    it('saves snapshot independently of agent saveLatestOn setting', async () => {
      sessionManager = new SessionManager({
        sessionId: 'test-session',
        storage: { snapshot: storage },
        saveLatestOn: 'trigger',
        multiAgentSaveLatestOn: 'invocation',
      })
      sessionManager.initMultiAgent(orchestrator)

      const state = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new AfterMultiAgentInvocationEvent({ orchestrator, state, invocationState: {} })
      )

      const snapshot = await storage.loadSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })
      expect(snapshot).not.toBeNull()
    })
  })

  describe('scope isolation', () => {
    it('agent and multi-agent snapshots use separate storage paths', async () => {
      const mockAgent = createMockAgent('test-agent')
      sessionManager = new SessionManager({
        sessionId: 'shared-session',
        storage: { snapshot: storage },
      })

      await sessionManager.saveSnapshot({ target: mockAgent as unknown as Agent, isLatest: true })
      await sessionManager.saveSnapshot({ target: orchestrator as unknown as Graph, isLatest: true })

      const agentSnapshot = await storage.loadSnapshot({
        location: { sessionId: 'shared-session', scope: 'agent', scopeId: 'test-agent' },
      })
      const multiAgentSnapshot = await storage.loadSnapshot({
        location: { sessionId: 'shared-session', scope: 'multiAgent', scopeId: 'test-graph' },
      })

      expect(agentSnapshot).not.toBeNull()
      expect(multiAgentSnapshot).not.toBeNull()
      expect(agentSnapshot?.scope).toBe('agent')
      expect(multiAgentSnapshot?.scope).toBe('multiAgent')
    })
  })

  describe('BeforeMultiAgentInvocationEvent — state restore', () => {
    it('restores state into event.state when snapshot exists', async () => {
      const snapshot = createMultiAgentTestSnapshot()
      // Build state with a completed node and result
      const state = new MultiAgentState({ nodeIds: ['a'] })
      state.steps = 7
      const nodeState = state.node('a')!
      nodeState.status = Status.COMPLETED
      nodeState.results.push(
        new NodeResult({ nodeId: 'a', status: Status.COMPLETED, duration: 100, content: [new TextBlock('done')] })
      )
      const { serializeStateSerializable } = await import('../../types/serializable.js')
      snapshot.data.state = serializeStateSerializable(state)

      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestrator)

      const freshState = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new BeforeMultiAgentInvocationEvent({ orchestrator, state: freshState, invocationState: {} })
      )

      expect(freshState.steps).toBe(7)
      expect(freshState.node('a')?.status).toBe(Status.COMPLETED)
      expect(freshState.node('a')?.results).toHaveLength(1)
      expect(freshState.node('a')?.results[0]?.nodeId).toBe('a')
      expect(freshState.node('a')?.results[0]?.status).toBe(Status.COMPLETED)
      expect(freshState.node('a')?.content[0]).toEqual(expect.objectContaining({ text: 'done' }))
    })

    it('does not modify state when no snapshot exists', async () => {
      sessionManager = new SessionManager({ sessionId: 'empty-session', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestrator)

      const freshState = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new BeforeMultiAgentInvocationEvent({ orchestrator, state: freshState, invocationState: {} })
      )

      expect(freshState.steps).toBe(0)
    })

    it('restores state independently for two orchestrators sharing one SessionManager', async () => {
      const { serializeStateSerializable } = await import('../../types/serializable.js')

      // Set up snapshots for two different orchestrators
      const orchestratorA = createMockOrchestrator('graph-a')
      const orchestratorB = createMockOrchestrator('swarm-b')

      for (const [orch, steps] of [
        [orchestratorA, 3],
        [orchestratorB, 5],
      ] as const) {
        const snap = createMultiAgentTestSnapshot(orch.id)
        const st = new MultiAgentState({ nodeIds: ['x'] })
        st.steps = steps
        snap.data.state = serializeStateSerializable(st)
        await storage.saveSnapshot({
          location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: orch.id },
          snapshotId: 'latest',
          isLatest: true,
          snapshot: snap,
        })
      }

      sessionManager = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestratorA)
      sessionManager.initMultiAgent(orchestratorB)

      // First orchestrator restores its own state
      const stateA = new MultiAgentState({ nodeIds: ['x'] })
      await invokeOrchestratorHook(
        orchestratorA,
        new BeforeMultiAgentInvocationEvent({ orchestrator: orchestratorA, state: stateA, invocationState: {} })
      )
      expect(stateA.steps).toBe(3)

      // Second orchestrator also restores — not blocked by the first
      const stateB = new MultiAgentState({ nodeIds: ['x'] })
      await invokeOrchestratorHook(
        orchestratorB,
        new BeforeMultiAgentInvocationEvent({ orchestrator: orchestratorB, state: stateB, invocationState: {} })
      )
      expect(stateB.steps).toBe(5)
    })

    it('consumes snapshot once — second invocation gets fresh state', async () => {
      const snapshot = createMultiAgentTestSnapshot()
      const state = new MultiAgentState({ nodeIds: ['a'] })
      state.steps = 7
      const { serializeStateSerializable } = await import('../../types/serializable.js')
      snapshot.data.state = serializeStateSerializable(state)

      await storage.saveSnapshot({
        location: { sessionId: 'test-session', scope: 'multiAgent', scopeId: 'test-graph' },
        snapshotId: 'latest',
        isLatest: true,
        snapshot,
      })

      sessionManager = new SessionManager({ sessionId: 'test-session', storage: { snapshot: storage } })
      sessionManager.initMultiAgent(orchestrator)

      // First invocation — state is restored
      const firstState = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new BeforeMultiAgentInvocationEvent({ orchestrator, state: firstState, invocationState: {} })
      )
      expect(firstState.steps).toBe(7)

      // Second invocation — snapshot already consumed
      const secondState = new MultiAgentState({ nodeIds: ['a'] })
      await invokeOrchestratorHook(
        orchestrator,
        new BeforeMultiAgentInvocationEvent({ orchestrator, state: secondState, invocationState: {} })
      )
      expect(secondState.steps).toBe(0)
    })
  })
})
