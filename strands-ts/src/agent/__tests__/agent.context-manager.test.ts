import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Agent } from '../agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'
import { SlidingWindowConversationManager } from '../../conversation-manager/sliding-window-conversation-manager.js'
import { NullConversationManager } from '../../conversation-manager/null-conversation-manager.js'
import { ContextManager } from '../../context-manager/context-manager.js'
import { Offload } from '../../context-manager/strategies/offload/index.js'
import { createRetrievalTool } from '../../context-manager/retrieval-tool.js'
import { tool } from '../../tools/tool-factory.js'
import { OffloadedBlock, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { createRandomTool } from '../../__fixtures__/tool-helpers.js'
import type { ConversationManager } from '../../conversation-manager/conversation-manager.js'
import type { ContextStrategy } from '../../context-manager/types.js'

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

    it('registers a strategy tool after initializing the strategy', async () => {
      const strategyTool = createRandomTool('strategy-tool')
      let initialized = false
      let getToolsCalls = 0
      const strategy: ContextStrategy = {
        name: 'tool-provider',
        init: () => {
          initialized = true
        },
        getTools: () => {
          expect(initialized).toBe(true)
          getToolsCalls++
          return [strategyTool]
        },
        apply: async () => false,
      }
      const agent = new Agent({
        model: new MockMessageModel(),
        contextManager: { strategies: [strategy] },
      })

      await agent.initialize()

      expect(agent.toolRegistry.get('strategy-tool')).toBe(strategyTool)
      expect(agent.toolRegistry.get('retrieve_context')).toBeDefined()
      expect(agent.contextManager?.getTools()).toContain(strategyTool)
      expect(getToolsCalls).toBe(1)
    })

    it('rejects strategy tools with the same name', async () => {
      const strategy = (name: string): ContextStrategy => ({
        name,
        getTools: () => [createRandomTool('shared-name')],
        apply: async () => false,
      })
      const agent = new Agent({
        model: new MockMessageModel(),
        contextManager: { strategies: [strategy('first'), strategy('second')], stash: false },
      })

      await expect(agent.initialize()).rejects.toThrow("Tool with name 'shared-name' already registered")
    })
  })

  describe('when ContextManager instance', () => {
    it('uses the instance as-is', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const contextManager = new ContextManager({ strategies: [{ name: 'noop', apply: async () => false }] })
      const agent = new Agent({ model, contextManager })
      expect(agent.contextManager).toBe(contextManager)
      expect(getConversationManager(agent)).toBeInstanceOf(NullConversationManager)
    })

    it('registers the instance as a plugin', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hi' })
      const contextManager = new ContextManager({ strategies: [{ name: 'noop', apply: async () => false }] })
      const agent = new Agent({ model, contextManager })
      await agent.invoke('hi')
      const plugins = internals(agent)._pluginRegistry._plugins
      expect(plugins.get('strands:context-manager')).toBe(contextManager)
    })
  })

  describe('offloaded tool results', () => {
    it('stores an sends the model its text, and resolves the toolUseId to the original', async () => {
      const rows = tool({
        name: 'rows',
        description: 'lists rows',
        inputSchema: z.object({}),
        callback: () => Array.from({ length: 5000 }, (_, index) => `row-${index + 1}`).join('\n'),
      })
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'rows', toolUseId: 'tu-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'done' })
      const sent = vi.spyOn(model, 'streamAggregated')
      const agent = new Agent({
        model,
        tools: [rows],
        printer: false,
        contextManager: new ContextManager({
          strategies: [Offload.truncate('toolResults', { previewTokens: 100 }).when({ blockThreshold: 200 })],
        }),
      })

      await agent.invoke('list the rows')

      const stored = (agent.messages[2]!.content[0] as ToolResultBlock).content[0] as OffloadedBlock
      expect(stored).toEqual(
        new OffloadedBlock({ text: stored.text, method: 'truncate', ref: 'tu-1', tokens: expect.any(Number) })
      )
      expect(stored.text).toMatch(/ \[ref: tu-1\]$/)
      const received = (sent.mock.calls[1]![0][2]!.content[0] as ToolResultBlock).content[0]
      expect(received).toBeInstanceOf(TextBlock)
      expect((received as TextBlock).text).toBe(stored.text)

      const retrieve = createRetrievalTool(agent.contextManager!.stash!) as unknown as {
        invoke(input: unknown): Promise<unknown>
      }
      expect(await retrieve.invoke({ reference: 'tu-1', pattern: 'row-4321' })).toContain('row-4321')
      expect(await retrieve.invoke({ reference: 'tu-1_0', pattern: 'row-4321' })).toContain('row-4321')
    })
  })
})
