import { describe, expect, it, vi } from 'vitest'
import { A2AServer } from '../server.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

describe('A2AServer', () => {
  describe('constructor', () => {
    it('builds agent card with provided values', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const server = new A2AServer({
        agent: new Agent({ model, printer: false }),
        name: 'Base Agent',
        description: 'A base agent',
        httpUrl: 'http://example.com',
        version: '2.0.0',
      })

      expect(server.agentCard).toStrictEqual({
        name: 'Base Agent',
        description: 'A base agent',
        version: '2.0.0',
        protocolVersion: '0.2.0',
        url: 'http://example.com',
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        capabilities: { streaming: true },
      })
    })

    it('uses default values when optional config is omitted', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const server = new A2AServer({
        agent: new Agent({ model, printer: false }),
        name: 'Minimal Agent',
      })

      expect(server.agentCard.description).toBe('')
      expect(server.agentCard.version).toBe('0.0.1')
      expect(server.agentCard.url).toBe('')
      expect(server.agentCard.skills).toStrictEqual([])
    })

    it('accepts custom taskStore', () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
      const taskStore = { save: vi.fn(), load: vi.fn() }
      const server = new A2AServer({
        agent: new Agent({ model, printer: false }),
        name: 'Agent',
        taskStore,
      })
      expect(server.agentCard).toBeDefined()
    })

    it('builds an agent card from a factory-built representative agent', () => {
      const built: string[] = []
      const server = new A2AServer({
        agentFactory: (contextId) => {
          built.push(contextId)
          return new Agent({ model: new MockMessageModel(), printer: false })
        },
        name: 'Factory Agent',
      })

      // Factory invoked once at construction (placeholder context) for card metadata.
      expect(built).toHaveLength(1)
      expect(server.agentCard.name).toBe('Factory Agent')
    })

    it('throws when neither agent nor agentFactory is provided', () => {
      expect(() => new A2AServer({ name: 'No Agent' })).toThrow("Provide exactly one of 'agent' or 'agentFactory'.")
    })

    it('throws when both agent and agentFactory are provided', () => {
      const agent = new Agent({ model: new MockMessageModel(), printer: false })
      expect(() => new A2AServer({ agent, agentFactory: () => agent, name: 'Both' })).toThrow(
        "Provide exactly one of 'agent' or 'agentFactory'."
      )
    })
  })
})
