import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { InMemoryStorage } from '../../storage/in-memory-storage.js'
import { SessionManager } from '../../session/session-manager.js'

describe('Agent storage', () => {
  describe('agent-level storage flows to ContextManager stash', () => {
    it('auto-created ContextManager uses agent storage when provided', async () => {
      const storage = new InMemoryStorage()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'auto', storage })
      await agent.invoke('hi')
      expect(agent.contextManager).toBeDefined()
      expect(agent.contextManager!.stash).toBeDefined()
    })

    it('auto-created ContextManager uses InMemoryStorage when no agent storage', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'auto' })
      await agent.invoke('hi')
      expect(agent.contextManager).toBeDefined()
      expect(agent.contextManager!.stash).toBeDefined()
    })
  })

  describe('agent-level storage flows to SessionManager', () => {
    it('session manager resolves storage from agent when not explicitly provided', async () => {
      const storage = new InMemoryStorage()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const sessionManager = new SessionManager({ sessionId: 'test-session' })
      const agent = new Agent({ model, storage, sessionManager })
      await agent.invoke('hi')

      const keys = await storage.list('session/')
      expect(keys.length).toBeGreaterThan(0)
    })

    it('explicit session manager storage overrides agent storage', async () => {
      const agentStorage = new InMemoryStorage()
      const sessionStorage = new InMemoryStorage()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const sessionManager = new SessionManager({ sessionId: 'test-session', storage: sessionStorage })
      const agent = new Agent({ model, storage: agentStorage, sessionManager })
      await agent.invoke('hi')

      const sessionKeys = await sessionStorage.list('session/')
      expect(sessionKeys.length).toBeGreaterThan(0)
      const agentKeys = await agentStorage.list('session/')
      expect(agentKeys.length).toBe(0)
    })

    it('throws when session manager has no storage and agent has no storage', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const sessionManager = new SessionManager({ sessionId: 'test-session' })
      const agent = new Agent({ model, sessionManager })
      await expect(agent.invoke('hi')).rejects.toThrow('SessionManager requires a storage backend')
    })
  })

  describe('agent.storage property', () => {
    it('returns the configured storage', () => {
      const storage = new InMemoryStorage()
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, storage })
      expect(agent.storage).toBe(storage)
    })

    it('returns undefined when no storage configured', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model })
      expect(agent.storage).toBeUndefined()
    })
  })
})
