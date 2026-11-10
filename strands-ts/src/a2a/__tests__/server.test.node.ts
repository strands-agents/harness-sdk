import { describe, expect, it, vi } from 'vitest'
import { A2AExpressServer, type A2AExpressServerConfig } from '../express-server.js'
import { A2AServer } from '../server.js'
import { Agent } from '../../agent/agent.js'
import { MockMessageModel } from '../../__fixtures__/mock-message-model.js'

// Mock express
vi.mock('express', () => {
  const mockRouter = {
    get: vi.fn(),
    post: vi.fn(),
    use: vi.fn(),
  }
  const mockApp = {
    use: vi.fn(),
    listen: vi.fn((_port: number, _host: string, cb: () => void) => {
      cb()
      return { on: vi.fn(), close: vi.fn(), address: () => ({ port: _port || 54321 }) }
    }),
  }
  const express = Object.assign(
    vi.fn(() => mockApp),
    {
      Router: vi.fn(() => mockRouter),
      json: vi.fn(() => 'json-middleware'),
    }
  )
  return { default: express }
})

// Mock A2A SDK express middleware
const mockAgentCardHandler = vi.fn(() => 'agent-card-handler')
const mockJsonRpcHandler = vi.fn(() => 'json-rpc-handler')

vi.mock('@a2a-js/sdk/server/express', () => ({
  agentCardHandler: (...args: Parameters<typeof mockAgentCardHandler>) => mockAgentCardHandler(...args),
  jsonRpcHandler: (...args: Parameters<typeof mockJsonRpcHandler>) => mockJsonRpcHandler(...args),
  UserBuilder: { noAuthentication: vi.fn() },
}))

function createTestConfig(overrides?: Partial<A2AExpressServerConfig>): A2AExpressServerConfig {
  const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })
  return {
    agent: new Agent({ model, printer: false }),
    name: 'Test Agent',
    ...overrides,
  }
}

describe('A2AExpressServer', () => {
  describe('constructor', () => {
    it('builds agent card with default values', () => {
      const server = new A2AExpressServer(createTestConfig())

      expect(server.agentCard).toStrictEqual({
        name: 'Test Agent',
        description: '',
        version: '0.0.1',
        protocolVersion: '0.2.0',
        url: 'http://127.0.0.1:9000',
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
        capabilities: { streaming: true },
      })
    })

    it('uses custom config values', () => {
      const server = new A2AExpressServer(
        createTestConfig({
          description: 'A helpful agent',
          host: '0.0.0.0',
          port: 8080,
          version: '1.0.0',
          skills: [{ id: 'skill-1', name: 'Skill 1', description: 'A skill', tags: [] }],
        })
      )

      expect(server.agentCard).toStrictEqual({
        name: 'Test Agent',
        description: 'A helpful agent',
        version: '1.0.0',
        protocolVersion: '0.2.0',
        url: 'http://0.0.0.0:8080',
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [{ id: 'skill-1', name: 'Skill 1', description: 'A skill', tags: [] }],
        capabilities: { streaming: true },
      })
    })

    it('uses httpUrl override when provided', () => {
      const server = new A2AExpressServer(createTestConfig({ httpUrl: 'https://my-agent.example.com' }))

      expect(server.agentCard.url).toBe('https://my-agent.example.com')
    })

    it('accepts custom taskStore', () => {
      const taskStore = { save: vi.fn(), load: vi.fn() }
      const server = new A2AExpressServer(createTestConfig({ taskStore }))
      expect(server.agentCard).toBeDefined()
    })

    it('is an instance of A2AServer', () => {
      const server = new A2AExpressServer(createTestConfig())
      expect(server).toBeInstanceOf(A2AServer)
    })
  })

  describe('createMiddleware', () => {
    it('returns an express router with SDK middleware', async () => {
      const server = new A2AExpressServer(createTestConfig())
      const router = server.createMiddleware()

      expect(router).toBeDefined()
      expect(router.use).toHaveBeenCalledTimes(2)
      expect(router.use).toHaveBeenCalledWith('/.well-known/agent-card.json', 'agent-card-handler')
      expect(router.use).toHaveBeenCalledWith('/', 'json-rpc-handler')
      expect(mockAgentCardHandler).toHaveBeenCalledWith({
        agentCardProvider: expect.objectContaining({ getAgentCard: expect.any(Function) }),
      })
      expect(mockJsonRpcHandler).toHaveBeenCalledWith({
        requestHandler: expect.anything(),
        userBuilder: expect.anything(),
      })
    })
  })
})
