import { describe, expect, it } from 'vitest'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { SlidingWindowConversationManager } from '../../conversation-manager/sliding-window-conversation-manager.js'
import { NullConversationManager } from '../../conversation-manager/null-conversation-manager.js'
import { ContextManager } from '../../context-manager/context-manager.js'
import type { ConversationManager } from '../../conversation-manager/conversation-manager.js'

function internals(agent: Agent): any {
  return agent as any
}

function getConversationManager(agent: Agent): ConversationManager {
  return internals(agent)._conversationManager
}

describe('Agent contextManager', () => {
  describe('when undefined (default)', () => {
    it('uses SlidingWindowConversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model })
      expect(getConversationManager(agent)).toBeInstanceOf(SlidingWindowConversationManager)
    })

    it('does not set contextManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model })
      expect(agent.contextManager).toBeUndefined()
    })
  })

  describe('when "auto"', () => {
    it('uses NullConversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'auto' })
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })

    it('creates a ContextManager instance', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'auto' })
      expect(agent.contextManager).toBeInstanceOf(ContextManager)
    })

    it('registers ContextManager as a plugin', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'auto' })
      await agent.invoke('hi')
      const plugins = internals(agent)._pluginRegistry._plugins
      expect(plugins.get('strands:context-manager')).toBe(agent.contextManager)
    })

    it('ignores user-provided conversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const userCm = new SlidingWindowConversationManager({ windowSize: 20 })
      const agent = new Agent({ model, contextManager: 'auto', conversationManager: userCm })
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })
  })

  describe('when "agentic"', () => {
    it('uses NullConversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'agentic' })
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })

    it('creates a ContextManager instance', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: 'agentic' })
      expect(agent.contextManager).toBeInstanceOf(ContextManager)
    })
  })

  describe('stateful model', () => {
    it('throws when used with a stateful model', () => {
      class StatefulModel extends MockMessageModel {
        override get stateful(): boolean {
          return true
        }
      }
      const model = new StatefulModel().addTurn({ type: 'textBlock', text: 'hi' })
      expect(() => new Agent({ model, contextManager: 'auto' })).toThrow('stateful model')
    })
  })

  describe('when false', () => {
    it('uses NullConversationManager when no conversationManager provided', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: false })
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })

    it('uses user-provided conversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const userCm = new SlidingWindowConversationManager({ windowSize: 20 })
      const agent = new Agent({ model, contextManager: false, conversationManager: userCm })
      expect(getConversationManager(agent)).toBe(userCm)
    })

    it('does not set contextManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: false })
      expect(agent.contextManager).toBeUndefined()
    })
  })

  describe('when ContextManagerConfig object', () => {
    it('uses NullConversationManager', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: { strategies: [{ name: 'noop', apply: async () => false }] } })
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })

    it('registers ContextManager as a plugin', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const agent = new Agent({ model, contextManager: { strategies: [{ name: 'noop', apply: async () => false }] } })
      await agent.invoke('hi')
      const plugins = internals(agent)._pluginRegistry._plugins
      expect(plugins.get('strands:context-manager')).toBeInstanceOf(ContextManager)
    })
  })
})
