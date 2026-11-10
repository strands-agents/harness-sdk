import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Agent } from '../agent.js'
import type { Snapshot } from '../../types/snapshot.js'
import { SNAPSHOT_SCHEMA_VERSION } from '../../types/snapshot.js'
import {
  ALL_SNAPSHOT_FIELDS,
  SNAPSHOT_PRESETS,
  createTimestamp,
  resolveSnapshotFields,
  takeSnapshot,
  loadSnapshot,
} from '../snapshot.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock } from '../../types/messages.js'
import { TestModelProvider } from '../../__fixtures__/model-test-helpers.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../__fixtures__/tool-helpers.js'
import { anyTrackingId } from '../../__fixtures__/message-helpers.js'

// Fixed timestamp for testing
const MOCK_TIMESTAMP = '2026-01-15T12:00:00.000Z'

/**
 * Helper to create a test agent with a mock model
 */
function createTestAgent(): Agent {
  return new Agent({
    model: new TestModelProvider(),
    tools: [],
  })
}

describe('Snapshot API', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(MOCK_TIMESTAMP))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('constants', () => {
    it('exports snapshot constants with correct values', () => {
      expect(SNAPSHOT_SCHEMA_VERSION).toBe('1.0')
      expect(ALL_SNAPSHOT_FIELDS).toEqual(['messages', 'state', 'systemPrompt', 'modelState', 'interrupts'])
      expect(SNAPSHOT_PRESETS).toEqual({
        session: ['messages', 'state', 'systemPrompt', 'modelState', 'interrupts'],
      })
    })
  })

  describe('createTimestamp', () => {
    it('returns ISO 8601 formatted timestamp', () => {
      expect(createTimestamp()).toBe(MOCK_TIMESTAMP)
    })
  })

  describe('resolveSnapshotFields', () => {
    it('throws error when no fields would be included', () => {
      expect(() => resolveSnapshotFields({})).toThrow('No fields to include in snapshot')
    })

    it('returns session preset fields when preset is "session"', () => {
      const fields = resolveSnapshotFields({ preset: 'session' })
      expect(fields).toEqual(new Set(['messages', 'state', 'systemPrompt', 'modelState', 'interrupts']))
    })

    it('returns explicit fields when include is specified', () => {
      const fields = resolveSnapshotFields({ include: ['messages', 'state'] })
      expect(fields).toEqual(new Set(['messages', 'state']))
    })

    it('applies exclude after preset', () => {
      const fields = resolveSnapshotFields({ preset: 'session', exclude: ['state'] })
      expect(fields).toEqual(new Set(['messages', 'systemPrompt', 'modelState', 'interrupts']))
    })

    it('throws error for invalid preset', () => {
      expect(() => resolveSnapshotFields({ preset: 'invalid' as any })).toThrow('Invalid preset: invalid')
    })

    it('throws error for invalid field names', () => {
      expect(() => resolveSnapshotFields({ include: ['invalidField' as any] })).toThrow(
        'Invalid snapshot field: invalidField'
      )
    })
  })

  describe('takeSnapshot', () => {
    let agent: Agent

    beforeEach(() => {
      agent = createTestAgent()
    })

    it('creates snapshot with session preset', () => {
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Hello')] }))
      agent.appState.set('key', 'value')
      agent.systemPrompt = 'Test prompt'

      const snapshot = takeSnapshot(agent, { preset: 'session' })

      expect(snapshot).toEqual({
        scope: 'agent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: MOCK_TIMESTAMP,
        data: {
          messages: [{ role: 'user', content: [{ text: 'Hello' }], trackingId: anyTrackingId }],
          state: { key: 'value' },
          systemPrompt: 'Test prompt',
          modelState: {},
          interrupts: { interrupts: {}, activated: false },
        },
        appData: {},
      })
    })

    it('includes appData in snapshot', () => {
      const snapshot = takeSnapshot(agent, {
        preset: 'session',
        appData: { customKey: 'customValue' },
      })
      expect(snapshot.appData).toEqual({ customKey: 'customValue' })
    })

    it('excludes specified fields', () => {
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Hello')] }))
      agent.appState.set('key', 'value')

      const snapshot = takeSnapshot(agent, { preset: 'session', exclude: ['messages'] })

      expect(snapshot.data.messages).toBeUndefined()
      expect(snapshot.data.state).toBeDefined()
    })
  })

  describe('loadSnapshot', () => {
    let agent: Agent

    beforeEach(() => {
      agent = createTestAgent()
    })

    it('throws error for incompatible schema version', () => {
      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '2.0',
        createdAt: createTimestamp(),
        data: {},
        appData: {},
      }

      expect(() => loadSnapshot(agent, snapshot)).toThrow(
        'Unsupported snapshot schema version: 2.0. Current version: 1.0'
      )
    })

    it('throws error for wrong scope', () => {
      const snapshot: Snapshot = {
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: createTimestamp(),
        data: {},
        appData: {},
      }

      expect(() => loadSnapshot(agent, snapshot)).toThrow("Expected snapshot scope 'agent', got 'multiAgent'")
    })

    it('restores messages from snapshot', () => {
      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: {
          messages: [{ role: 'user', content: [{ text: 'Restored message' }] }],
        },
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]).toEqual(
        new Message({
          role: 'user',
          content: [new TextBlock('Restored message')],
          trackingId: anyTrackingId,
        })
      )
    })

    it('restores state from snapshot', () => {
      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: {
          state: { restoredKey: 'restoredValue' },
        },
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      expect(agent.appState.get('restoredKey')).toBe('restoredValue')
    })

    it('restores systemPrompt from snapshot', () => {
      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: {
          systemPrompt: 'Restored system prompt',
        },
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      expect(agent.systemPrompt).toBe('Restored system prompt')
    })

    it('clears systemPrompt when snapshot has null systemPrompt (agent had no system prompt at snapshot time)', () => {
      agent.systemPrompt = 'Original prompt'

      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: { systemPrompt: null },
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      // null in snapshot means the agent had no system prompt — should be cleared
      expect(agent.systemPrompt).toBeUndefined()
    })

    it('leaves systemPrompt unchanged when systemPrompt key is absent from snapshot', () => {
      agent.systemPrompt = 'Original prompt'

      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: { messages: [] }, // systemPrompt key not present at all
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      // absent key means field was not snapshotted — agent prompt should be untouched
      expect(agent.systemPrompt).toBe('Original prompt')
    })

    it('leaves messages unchanged when messages key is absent from snapshot', () => {
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Existing')] }))

      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: { state: { key: 'val' } }, // messages key not present
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      expect(agent.messages).toHaveLength(1)
    })

    it('leaves state unchanged when state key is absent from snapshot', () => {
      agent.appState.set('existing', 'value')

      const snapshot: Snapshot = {
        scope: 'agent',
        schemaVersion: '1.0',
        createdAt: createTimestamp(),
        data: { messages: [] }, // state key not present
        appData: {},
      }

      loadSnapshot(agent, snapshot)

      expect(agent.appState.get('existing')).toBe('value')
    })
  })

  describe('round-trip', () => {
    let agent: Agent

    beforeEach(() => {
      agent = createTestAgent()
    })

    it('preserves messages through save/load cycle', () => {
      const originalMessages = [
        new Message({ role: 'user', content: [new TextBlock('Hello')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Hi!')] }),
      ]
      agent.messages.push(...originalMessages)

      const snapshot = takeSnapshot(agent, { preset: 'session' })

      // Modify agent
      agent.messages.length = 0
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Different')] }))

      // Restore
      loadSnapshot(agent, snapshot)

      expect(agent.messages).toEqual(originalMessages)
    })

    it('preserves state through save/load cycle', () => {
      agent.appState.set('userId', 'user-123')
      agent.appState.set('counter', 42)

      const snapshot = takeSnapshot(agent, { preset: 'session' })

      // Modify state
      agent.appState.clear()
      agent.appState.set('different', 'value')

      // Restore
      loadSnapshot(agent, snapshot)

      expect(agent.appState.getAll()).toEqual({ userId: 'user-123', counter: 42 })
    })

    it('handles complex message content', () => {
      const toolUseBlock = new ToolUseBlock({
        name: 'calculator',
        toolUseId: 'tool-123',
        input: { operation: 'add', numbers: [1, 2, 3] },
      })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'tool-123',
        status: 'success',
        content: [new TextBlock('6')],
      })
      const originalMessages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]
      agent.messages.push(...originalMessages)

      const snapshot = takeSnapshot(agent, { include: ['messages'] })
      agent.messages.length = 0
      loadSnapshot(agent, snapshot)

      expect(agent.messages).toEqual(originalMessages)
    })
  })

  describe('JSON serialization', () => {
    it('snapshot survives JSON.stringify/JSON.parse round-trip', () => {
      const agent = createTestAgent()
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Hello')] }))
      agent.appState.set('userId', 'user-123')
      agent.systemPrompt = 'You are a helpful assistant'

      const snapshot = takeSnapshot(agent, { preset: 'session' })

      // Serialize to JSON string and parse back
      const jsonString = JSON.stringify(snapshot)
      const parsed = JSON.parse(jsonString)

      // Verify structure is preserved
      expect(parsed).toEqual(snapshot)
    })

    it('snapshot can be stored and retrieved as JSON string', () => {
      const agent = createTestAgent()
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Test message')] }))
      agent.appState.set('key', 'value')

      const snapshot = takeSnapshot(agent, { preset: 'session' })

      // Simulate storing to a database or file as JSON
      const stored = JSON.stringify(snapshot)

      // Simulate retrieving and restoring
      const retrieved = JSON.parse(stored)
      const newAgent = createTestAgent()
      loadSnapshot(newAgent, retrieved)

      expect(newAgent.messages).toHaveLength(1)
      expect(newAgent.appState.getAll()).toEqual({ key: 'value' })
    })
  })

  describe('interrupt state round-trip', () => {
    it('preserves interrupt state through snapshot and restores for resume', async () => {
      // Set up agent that will interrupt
      const model = new MockMessageModel()
        .addTurn({
          type: 'toolUseBlock',
          name: 'confirmTool',
          toolUseId: 'tool-1',
          input: { action: 'delete' },
        })
        .addTurn({ type: 'textBlock', text: 'Done' })

      const tool = createMockTool('confirmTool', (context) => {
        const response = context.interrupt<string>({ name: 'confirm', reason: 'Confirm delete?' })
        return `confirmed: ${response}`
      })

      const agent = new Agent({ model, tools: [tool], printer: false })

      // Trigger interrupt
      const interruptResult = await agent.invoke('Delete it')
      expect(interruptResult.stopReason).toBe('interrupt')
      expect(interruptResult.interrupts).toHaveLength(1)

      // Snapshot the interrupted agent
      const snapshot = takeSnapshot(agent, { preset: 'session' })
      expect(snapshot.data.interrupts).toBeDefined()

      // Create a fresh agent and restore from snapshot
      const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const tool2 = createMockTool('confirmTool', (context) => {
        const response = context.interrupt<string>({ name: 'confirm', reason: 'Confirm delete?' })
        return `confirmed: ${response}`
      })
      const restoredAgent = new Agent({ model: model2, tools: [tool2], printer: false })
      loadSnapshot(restoredAgent, snapshot)

      // Resume from the restored agent
      const finalResult = await restoredAgent.invoke([
        {
          interruptResponse: {
            interruptId: interruptResult.interrupts![0]!.id,
            response: 'yes',
          },
        },
      ])

      expect(finalResult.stopReason).toBe('endTurn')
    })
  })
})

describe('Agent.takeSnapshot / Agent.loadSnapshot (public API)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(MOCK_TIMESTAMP))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takeSnapshot captures state and loadSnapshot restores it (round-trip)', () => {
    const agent = new Agent({ model: new TestModelProvider(), tools: [], printer: false })
    agent.messages.push(
      new Message({ role: 'user', content: [new TextBlock('Hello')] }),
      new Message({ role: 'assistant', content: [new TextBlock('Hi!')] })
    )
    agent.appState.set('counter', 42)
    agent.systemPrompt = 'Be helpful'

    const snapshot = agent.takeSnapshot({ preset: 'session' })

    expect(snapshot).toEqual({
      scope: 'agent',
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      createdAt: MOCK_TIMESTAMP,
      data: {
        messages: [
          { role: 'user', content: [{ text: 'Hello' }], trackingId: anyTrackingId },
          { role: 'assistant', content: [{ text: 'Hi!' }], trackingId: anyTrackingId },
        ],
        state: { counter: 42 },
        systemPrompt: 'Be helpful',
        modelState: {},
        interrupts: { interrupts: {}, activated: false },
      },
      appData: {},
    })

    // Mutate agent state
    agent.messages.length = 0
    agent.appState.clear()
    agent.systemPrompt = 'Different'

    // Restore
    agent.loadSnapshot(snapshot)

    expect(agent.messages).toHaveLength(2)
    expect(agent.appState.get('counter')).toBe(42)
    expect(agent.systemPrompt).toBe('Be helpful')
  })

  it('propagates errors from loadSnapshot for invalid snapshots', () => {
    const agent = new Agent({ model: new TestModelProvider(), tools: [], printer: false })

    expect(() =>
      agent.loadSnapshot({ scope: 'agent', schemaVersion: '99.0', createdAt: '', data: {}, appData: {} })
    ).toThrow('Unsupported snapshot schema version: 99.0')

    expect(() =>
      agent.loadSnapshot({
        scope: 'multiAgent',
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        createdAt: '',
        data: {},
        appData: {},
      })
    ).toThrow("Expected snapshot scope 'agent', got 'multiAgent'")

    expect(() => agent.takeSnapshot({})).toThrow('No fields to include in snapshot')
  })

  it('supports JSON serialization round-trip', () => {
    const agent = new Agent({ model: new TestModelProvider(), tools: [], printer: false })
    agent.messages.push(new Message({ role: 'user', content: [new TextBlock('Persist me')] }))
    agent.appState.set('session', 'abc')

    const snapshot = agent.takeSnapshot({ preset: 'session' })
    const json = JSON.stringify(snapshot)
    const parsed = JSON.parse(json) as Snapshot

    const newAgent = new Agent({ model: new TestModelProvider(), tools: [], printer: false })
    newAgent.loadSnapshot(parsed)

    expect(newAgent.messages).toHaveLength(1)
    expect(newAgent.appState.get('session')).toBe('abc')
  })

  it('preserves and restores interrupt state for resume', async () => {
    const model = new MockMessageModel()
      .addTurn({
        type: 'toolUseBlock',
        name: 'askUser',
        toolUseId: 'tool-1',
        input: { question: 'proceed?' },
      })
      .addTurn({ type: 'textBlock', text: 'Completed' })

    const tool = createMockTool('askUser', (context) => {
      const answer = context.interrupt<string>({ name: 'ask', reason: 'Need confirmation' })
      return `User said: ${answer}`
    })

    const agent = new Agent({ model, tools: [tool], printer: false })

    // Trigger interrupt
    const result = await agent.invoke('Do something')
    expect(result.stopReason).toBe('interrupt')

    // Snapshot via public method
    const snapshot = agent.takeSnapshot({ preset: 'session' })

    // Restore into a fresh agent
    const model2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Completed' })
    const tool2 = createMockTool('askUser', (context) => {
      const answer = context.interrupt<string>({ name: 'ask', reason: 'Need confirmation' })
      return `User said: ${answer}`
    })
    const restored = new Agent({ model: model2, tools: [tool2], printer: false })
    restored.loadSnapshot(snapshot)

    // Resume
    const finalResult = await restored.invoke([
      { interruptResponse: { interruptId: result.interrupts![0]!.id, response: 'go ahead' } },
    ])

    expect(finalResult.stopReason).toBe('endTurn')
  })
})
