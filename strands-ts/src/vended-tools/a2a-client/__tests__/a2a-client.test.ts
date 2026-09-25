import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeA2AClient } from '../a2a-client.js'
import type { AgentCard } from '@a2a-js/sdk'
import type { ClientFactory as ClientFactoryType } from '@a2a-js/sdk/client'

const mockGetAgentCard = vi.fn()
const mockSendMessageStream = vi.fn()

vi.mock('@a2a-js/sdk/client', () => ({
  ClientFactory: class MockClientFactory {
    async createFromUrl(): Promise<{
      sendMessageStream: typeof mockSendMessageStream
      getAgentCard: typeof mockGetAgentCard
    }> {
      return {
        sendMessageStream: mockSendMessageStream,
        getAgentCard: mockGetAgentCard,
      }
    }
  },
}))

const FAKE_CARD: AgentCard = {
  name: 'Test Agent',
  description: 'A test agent',
  version: '1.0.0',
  protocolVersion: '0.2.0',
  url: 'https://agent.example.com',
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  capabilities: {},
}

const ENDPOINT = 'https://agent.example.com'
const ENDPOINTS: Record<string, undefined> = { [ENDPOINT]: undefined }

async function* mockStream(...events: unknown[]): AsyncGenerator<unknown, void, undefined> {
  for (const event of events) {
    yield event
  }
}

function setupSendMessageResponse(text: string): void {
  mockSendMessageStream.mockReturnValue(
    mockStream({
      kind: 'task',
      id: 'task-1',
      contextId: 'ctx-1',
      status: { state: 'completed' },
      artifacts: [
        {
          artifactId: 'art-1',
          parts: [{ kind: 'text', text }],
        },
      ],
    })
  )
}

describe('a2a-client tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgentCard.mockResolvedValue(FAKE_CARD)
    setupSendMessageResponse('Hello from agent')
  })

  describe('factory', () => {
    it('throws when allowedEndpoints is empty', () => {
      expect(() => makeA2AClient({ allowedEndpoints: {} })).toThrow(
        'allowedEndpoints must contain at least one endpoint'
      )
    })

    it('throws when maxBytes is zero', () => {
      expect(() => makeA2AClient({ allowedEndpoints: ENDPOINTS, maxBytes: 0 })).toThrow(
        'maxBytes must be a positive integer'
      )
    })

    it('throws when maxBytes is negative', () => {
      expect(() => makeA2AClient({ allowedEndpoints: ENDPOINTS, maxBytes: -1 })).toThrow(
        'maxBytes must be a positive integer'
      )
    })

    it('uses custom name', () => {
      const t = makeA2AClient({ name: 'my_agent', allowedEndpoints: ENDPOINTS })
      expect(t.name).toBe('my_agent')
    })

    it('default description includes endpoints', () => {
      const t = makeA2AClient({
        allowedEndpoints: { 'https://a.example.com': undefined, 'https://b.example.com': undefined },
      })
      expect(t.description).toContain('https://a.example.com')
      expect(t.description).toContain('https://b.example.com')
    })

    it('custom description overrides the default', () => {
      const t = makeA2AClient({
        description: 'My custom description',
        allowedEndpoints: ENDPOINTS,
      })
      expect(t.description).toBe('My custom description')
    })
  })

  describe('allowlist', () => {
    it('rejects an endpoint not in the allowlist', async () => {
      const t = makeA2AClient({
        allowedEndpoints: { 'https://a.example.com': undefined, 'https://b.example.com': undefined },
      })
      await expect(t.invoke({ operation: 'discover', endpoint: 'https://evil.example.com' })).rejects.toThrow(
        'not in the allowed endpoints list'
      )
    })

    it('includes permitted endpoints in the rejection message', async () => {
      const t = makeA2AClient({
        allowedEndpoints: { 'https://a.example.com': undefined },
      })
      await expect(t.invoke({ operation: 'discover', endpoint: 'https://evil.example.com' })).rejects.toThrow(
        'https://a.example.com'
      )
    })
  })

  describe('discover', () => {
    it('returns the agent card as a plain object', async () => {
      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      const result = await t.invoke({ operation: 'discover', endpoint: ENDPOINT })
      expect(result).toEqual(FAKE_CARD)
    })

    it('wraps discovery errors with cause', async () => {
      const original = new Error('connection refused')
      mockGetAgentCard.mockRejectedValue(original)

      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'discover', endpoint: ENDPOINT })).rejects.toSatisfy((err: Error) => {
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toContain('Failed to discover agent card')
        expect(err.cause).toBe(original)
        return true
      })
    })

    it('rejects an oversized agent card', async () => {
      mockGetAgentCard.mockResolvedValue({ ...FAKE_CARD, data: 'x'.repeat(1000) })

      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS, maxBytes: 100 })
      await expect(t.invoke({ operation: 'discover', endpoint: ENDPOINT })).rejects.toThrow('exceeds maxBytes limit')
    })
  })

  describe('send_message', () => {
    it('returns the response message', async () => {
      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      const result = (await t.invoke({
        operation: 'send_message',
        endpoint: ENDPOINT,
        message: 'Hello',
      })) as Record<string, unknown>
      expect(result).toHaveProperty('message')
      const msg = result['message'] as Record<string, unknown>
      expect(msg).toHaveProperty('role', 'assistant')
    })

    it("requires 'message' parameter", async () => {
      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT })).rejects.toThrow("'message' is required")
    })

    it("rejects empty string as 'message'", async () => {
      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: '' })).rejects.toThrow(
        "'message' is required"
      )
    })

    it("rejects null as 'message'", async () => {
      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: null })).rejects.toThrow(
        "'message' is required"
      )
    })

    it('wraps send errors with cause', async () => {
      const original = new Error('timeout')
      mockSendMessageStream.mockImplementation(() => {
        throw original
      })

      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: 'Hello' })).rejects.toSatisfy(
        (err: Error) => {
          expect(err).toBeInstanceOf(Error)
          expect(err.message).toContain('Failed to send message')
          expect(err.cause).toBe(original)
          return true
        }
      )
    })

    it('rejects an oversized response', async () => {
      setupSendMessageResponse('x'.repeat(1000))

      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS, maxBytes: 100 })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: 'Hello' })).rejects.toThrow(
        'exceeds maxBytes limit'
      )
    })

    it.each(['failed', 'rejected', 'canceled', 'input-required', 'auth-required'])(
      'throws when remote task state is %s',
      async (state) => {
        mockSendMessageStream.mockReturnValue(
          mockStream({
            kind: 'task',
            id: 'task-1',
            contextId: 'ctx-1',
            status: {
              state,
              message: {
                kind: 'message',
                messageId: 'msg-1',
                role: 'agent',
                parts: [{ kind: 'text', text: 'something went wrong' }],
              },
            },
          })
        )

        const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
        await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: 'Hello' })).rejects.toThrow(
          `did not complete: task state is '${state}'. something went wrong`
        )
      }
    )

    it('throws for a failed task with no status message', async () => {
      mockSendMessageStream.mockReturnValue(
        mockStream({
          kind: 'task',
          id: 'task-1',
          contextId: 'ctx-1',
          status: { state: 'failed' },
        })
      )

      const t = makeA2AClient({ allowedEndpoints: ENDPOINTS })
      await expect(t.invoke({ operation: 'send_message', endpoint: ENDPOINT, message: 'Hello' })).rejects.toThrow(
        "did not complete: task state is 'failed'"
      )
    })
  })

  describe('per-endpoint config', () => {
    it('uses the provided ClientFactory for the endpoint', async () => {
      const customGetAgentCard = vi.fn().mockResolvedValue(FAKE_CARD)
      const customFactory = {
        createFromUrl: vi.fn().mockResolvedValue({
          getAgentCard: customGetAgentCard,
          sendMessageStream: mockSendMessageStream,
        }),
      }

      const t = makeA2AClient({ allowedEndpoints: { [ENDPOINT]: customFactory as unknown as ClientFactoryType } })
      await t.invoke({ operation: 'discover', endpoint: ENDPOINT })

      expect(customFactory.createFromUrl).toHaveBeenCalledWith(ENDPOINT, undefined)
      expect(customGetAgentCard).toHaveBeenCalled()
    })
  })
})
