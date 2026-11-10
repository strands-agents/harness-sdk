import { describe, expect, it, vi, beforeEach } from 'vitest'
import { A2AAgent } from '../a2a-agent.js'
import { A2AStreamUpdateEvent, A2AResultEvent } from '../events.js'
import type {
  AgentCard,
  Task,
  Message as A2AMessage,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk'
import { TextBlock, Message } from '../../types/messages.js'
import type { InvokeArgs } from '../../types/agent.js'

// Mock the A2A SDK client
const mockSendMessageStream = vi.fn()
const mockGetAgentCard = vi.fn()

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

const mockAgentCard: AgentCard = {
  name: 'Remote Agent',
  description: 'A remote agent for testing',
  version: '1.0.0',
  protocolVersion: '0.2.0',
  url: 'http://localhost:9000',
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
  skills: [],
  capabilities: {},
}

function createMockTaskResponse(): Task {
  return {
    kind: 'task',
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state: 'completed' },
    artifacts: [
      {
        artifactId: 'art-1',
        parts: [{ kind: 'text', text: 'Agent response' }],
      },
    ],
  }
}

async function* mockStream(...events: unknown[]): AsyncGenerator<unknown, void, undefined> {
  for (const event of events) {
    yield event
  }
}

async function collectStream(
  gen: AsyncGenerator<unknown, unknown, undefined>
): Promise<{ events: unknown[]; result: unknown }> {
  const events: unknown[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

describe('A2AAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgentCard.mockResolvedValue(mockAgentCard)
    mockSendMessageStream.mockReturnValue(mockStream(createMockTaskResponse()))
  })

  describe('identity properties', () => {
    it('defaults id to the URL when not provided', () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      expect(agent.id).toBe('http://localhost:9000')
    })

    it('uses provided id from config', () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000', id: 'custom-id' })
      expect(agent.id).toBe('custom-id')
    })

    it('uses provided name and description from config', () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000', name: 'My Agent', description: 'Does things' })
      expect(agent.name).toBe('My Agent')
      expect(agent.description).toBe('Does things')
    })

    it('has undefined name and description when not provided in config', () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      expect(agent.name).toBeUndefined()
      expect(agent.description).toBeUndefined()
    })

    it('populates name and description from agent card on first connection', async () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      expect(agent.name).toBeUndefined()
      expect(agent.description).toBeUndefined()

      await agent.invoke('Hello')

      expect(agent.name).toBe('Remote Agent')
      expect(agent.description).toBe('A remote agent for testing')
    })

    it('does not overwrite config-provided name and description with agent card values', async () => {
      const agent = new A2AAgent({
        url: 'http://localhost:9000',
        name: 'Custom Name',
        description: 'Custom description',
      })

      await agent.invoke('Hello')

      expect(agent.name).toBe('Custom Name')
      expect(agent.description).toBe('Custom description')
    })
  })

  describe('invoke', () => {
    it('returns AgentResult with response text', async () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })

      const result = await agent.invoke('Hello')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.role).toBe('assistant')
      expect(result.lastMessage.content).toHaveLength(1)
      expect(result.lastMessage.content[0]).toBeInstanceOf(TextBlock)
      expect((result.lastMessage.content[0] as TextBlock).text).toBe('Agent response')
    })

    it.each([
      { desc: 'string', args: 'Hello from string', expectedText: 'Hello from string' },
      { desc: 'ContentBlock[]', args: [new TextBlock('Hello from blocks')], expectedText: 'Hello from blocks' },
      { desc: 'ContentBlockData[]', args: [{ text: 'Hello from data' }], expectedText: 'Hello from data' },
      {
        desc: 'multiple ContentBlocks joined with newline',
        args: [new TextBlock('Line 1'), new TextBlock('Line 2')],
        expectedText: 'Line 1\nLine 2',
      },
      {
        desc: 'Message[] (last user message)',
        args: [
          new Message({ role: 'user', content: [new TextBlock('First')] }),
          new Message({ role: 'assistant', content: [new TextBlock('Response')] }),
          new Message({ role: 'user', content: [new TextBlock('Second')] }),
        ],
        expectedText: 'Second',
      },
      {
        desc: 'MessageData[] (plain objects)',
        args: [{ role: 'user', content: [{ text: 'From plain data' }] }],
        expectedText: 'From plain data',
      },
      {
        desc: 'Message[] with no user messages',
        args: [new Message({ role: 'assistant', content: [new TextBlock('No user')] })],
        expectedText: '',
      },
      { desc: 'empty array', args: [] as TextBlock[], expectedText: '' },
    ])('sends correct parts for $desc input', async ({ args, expectedText }) => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })

      await agent.invoke(args as InvokeArgs)

      expect(mockSendMessageStream).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            parts: [{ kind: 'text', text: expectedText }],
          }),
        })
      )
    })

    it('auto-connects on first invoke', async () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      await agent.invoke('Hello')
      expect(mockGetAgentCard).toHaveBeenCalledOnce()
    })

    it('uses custom clientFactory when provided', async () => {
      const customSendMessageStream = vi.fn().mockReturnValue(mockStream(createMockTaskResponse()))
      const customGetAgentCard = vi.fn().mockResolvedValue(mockAgentCard)
      const customCreateFromUrl = vi.fn().mockResolvedValue({
        sendMessageStream: customSendMessageStream,
        getAgentCard: customGetAgentCard,
      })
      const customFactory = { createFromUrl: customCreateFromUrl }

      const agent = new A2AAgent({
        url: 'http://localhost:9000',
        clientFactory: customFactory as never,
      })

      await agent.invoke('Hello')

      expect(customCreateFromUrl).toHaveBeenCalledWith('http://localhost:9000', undefined)
      expect(customGetAgentCard).toHaveBeenCalledOnce()
      expect(customSendMessageStream).toHaveBeenCalledOnce()
      // Default mock should not have been called
      expect(mockSendMessageStream).not.toHaveBeenCalled()
    })
  })

  describe('stream', () => {
    it('yields A2AStreamUpdateEvent for each A2A event and A2AResultEvent at the end', async () => {
      const task = createMockTaskResponse()
      mockSendMessageStream.mockReturnValue(mockStream(task))

      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const { events, result } = await collectStream(agent.stream('Hello'))

      expect(events).toHaveLength(2)
      expect(events[0]).toBeInstanceOf(A2AStreamUpdateEvent)
      expect((events[0] as A2AStreamUpdateEvent).event).toStrictEqual(task)
      expect(events[1]).toBeInstanceOf(A2AResultEvent)
      expect((result as { stopReason: string }).stopReason).toBe('endTurn')
    })

    it('yields multiple A2AStreamUpdateEvents for streamed artifact chunks', async () => {
      const artifactUpdate1: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'art-1', parts: [{ kind: 'text', text: 'Hello ' }] },
        append: false,
      }
      const artifactUpdate2: TaskArtifactUpdateEvent = {
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { artifactId: 'art-1', parts: [{ kind: 'text', text: 'World' }] },
        append: true,
        lastChunk: true,
      }
      const statusUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'agent',
            parts: [{ kind: 'text', text: 'Final answer' }],
          },
        },
        final: true,
      }

      mockSendMessageStream.mockReturnValue(mockStream(artifactUpdate1, artifactUpdate2, statusUpdate))
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const { events } = await collectStream(agent.stream('Hello'))

      // 3 A2AStreamUpdateEvents + 1 A2AResultEvent
      expect(events).toHaveLength(4)
      expect(events[0]).toBeInstanceOf(A2AStreamUpdateEvent)
      expect(events[1]).toBeInstanceOf(A2AStreamUpdateEvent)
      expect(events[2]).toBeInstanceOf(A2AStreamUpdateEvent)
      expect(events[3]).toBeInstanceOf(A2AResultEvent)

      // Final result built from last complete event (status-update with completed state)
      const resultEvent = events[3] as A2AResultEvent
      expect((resultEvent.result.lastMessage.content[0] as TextBlock).text).toBe('Final answer')
    })

    it('yields A2AStreamUpdateEvent for Message response', async () => {
      const message: A2AMessage = {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{ kind: 'text', text: 'Direct response' }],
      }
      mockSendMessageStream.mockReturnValue(mockStream(message))

      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const { events } = await collectStream(agent.stream('Hello'))

      expect(events).toHaveLength(2)
      expect(events[0]).toBeInstanceOf(A2AStreamUpdateEvent)
      expect((events[0] as A2AStreamUpdateEvent).event.kind).toBe('message')

      const resultEvent = events[1] as A2AResultEvent
      expect((resultEvent.result.lastMessage.content[0] as TextBlock).text).toBe('Direct response')
    })

    it('builds result from status-update with completed state', async () => {
      const statusUpdate: TaskStatusUpdateEvent = {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'agent',
            parts: [{ kind: 'text', text: 'Status text' }],
          },
        },
        final: true,
      }
      mockSendMessageStream.mockReturnValue(mockStream(statusUpdate))

      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const { events } = await collectStream(agent.stream('Hello'))

      const resultEvent = events[1] as A2AResultEvent
      expect((resultEvent.result.lastMessage.content[0] as TextBlock).text).toBe('Status text')
    })

    it('returns empty text when no events are received', async () => {
      mockSendMessageStream.mockReturnValue(mockStream())

      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const { events, result } = await collectStream(agent.stream('Hello'))

      expect(events).toHaveLength(1) // only A2AResultEvent
      expect(events[0]).toBeInstanceOf(A2AResultEvent)
      expect((result as { lastMessage: Message }).lastMessage.content[0]).toBeInstanceOf(TextBlock)
      expect(((result as { lastMessage: Message }).lastMessage.content[0] as TextBlock).text).toBe('')
    })
  })

  describe('response extraction', () => {
    it('extracts text from Task response', async () => {
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const result = await agent.invoke('Hello')
      expect((result.lastMessage.content[0] as TextBlock).text).toBe('Agent response')
    })

    it('extracts text from Message response', async () => {
      mockSendMessageStream.mockReturnValue(
        mockStream({
          kind: 'message',
          messageId: 'msg-1',
          role: 'agent',
          parts: [{ kind: 'text', text: 'Direct response' }],
        })
      )
      const agent = new A2AAgent({ url: 'http://localhost:9000' })
      const result = await agent.invoke('Hello')
      expect((result.lastMessage.content[0] as TextBlock).text).toBe('Direct response')
    })
  })
})

describe('response text extraction via invoke', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAgentCard.mockResolvedValue(mockAgentCard)
  })

  it('joins multiple text parts from Task artifacts', async () => {
    mockSendMessageStream.mockReturnValue(
      mockStream({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' },
        artifacts: [
          {
            artifactId: 'art-1',
            parts: [
              { kind: 'text', text: 'Part 1' },
              { kind: 'text', text: 'Part 2' },
            ],
          },
        ],
      } as Task)
    )
    const agent = new A2AAgent({ url: 'http://localhost:9000' })
    const result = await agent.invoke('Hello')
    expect((result.lastMessage.content[0] as TextBlock).text).toBe('Part 1\nPart 2')
  })

  it('joins text from multiple Task artifacts', async () => {
    mockSendMessageStream.mockReturnValue(
      mockStream({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' },
        artifacts: [
          { artifactId: 'art-1', parts: [{ kind: 'text', text: 'First' }] },
          { artifactId: 'art-2', parts: [{ kind: 'text', text: 'Second' }] },
        ],
      } as Task)
    )
    const agent = new A2AAgent({ url: 'http://localhost:9000' })
    const result = await agent.invoke('Hello')
    expect((result.lastMessage.content[0] as TextBlock).text).toBe('First\nSecond')
  })

  it('falls back to Task status message when no artifacts', async () => {
    mockSendMessageStream.mockReturnValue(
      mockStream({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: {
          state: 'completed',
          message: {
            kind: 'message',
            messageId: 'msg-1',
            role: 'agent',
            parts: [{ kind: 'text', text: 'Status text' }],
          },
        },
      } as Task)
    )
    const agent = new A2AAgent({ url: 'http://localhost:9000' })
    const result = await agent.invoke('Hello')
    expect((result.lastMessage.content[0] as TextBlock).text).toBe('Status text')
  })

  it('returns empty text for Task with no text content', async () => {
    mockSendMessageStream.mockReturnValue(
      mockStream({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'completed' },
      } as Task)
    )
    const agent = new A2AAgent({ url: 'http://localhost:9000' })
    const result = await agent.invoke('Hello')
    expect((result.lastMessage.content[0] as TextBlock).text).toBe('')
  })

  it('extracts text from Message parts, ignoring non-text parts', async () => {
    mockSendMessageStream.mockReturnValue(
      mockStream({
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [
          { kind: 'text', text: 'Hello' },
          { kind: 'file', file: { uri: 'file://test.txt' } },
          { kind: 'text', text: 'World' },
        ],
      } as A2AMessage)
    )
    const agent = new A2AAgent({ url: 'http://localhost:9000' })
    const result = await agent.invoke('Hello')
    expect((result.lastMessage.content[0] as TextBlock).text).toBe('Hello\nWorld')
  })
})
