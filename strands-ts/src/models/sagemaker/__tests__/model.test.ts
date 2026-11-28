import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SageMakerModel } from '../model.js'
import { Message, TextBlock } from '../../../types/messages.js'
import type { ModelStreamEvent } from '../../streaming.js'

// ── Helpers ──────────────────────────────────────────────────────────────

async function collectEvents(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

function textMessage(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

// ── Mock SageMaker SDK ──────────────────────────────────────────────────

function createMockClient(sendFn: (command: unknown) => Promise<unknown>) {
  return { send: vi.fn(sendFn) }
}

function mockStreamingResponse(chunks: Array<Record<string, unknown>>) {
  const body = (async function* () {
    for (const chunk of chunks) {
      yield {
        PayloadPart: {
          Bytes: new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`),
        },
      }
    }
    yield {
      PayloadPart: {
        Bytes: new TextEncoder().encode('data: [DONE]\n\n'),
      },
    }
  })()

  return { Body: body }
}

function mockNonStreamingResponse(body: Record<string, unknown>) {
  return {
    Body: new TextEncoder().encode(JSON.stringify(body)),
  }
}

// Mock the dynamic import of @aws-sdk/client-sagemaker-runtime
vi.mock('@aws-sdk/client-sagemaker-runtime', () => {
  class MockSageMakerRuntimeClient {
    send = vi.fn()
    constructor() {}
  }
  class MockInvokeEndpointCommand {
    input: unknown
    _type = 'InvokeEndpointCommand'
    constructor(input: unknown) {
      this.input = input
    }
  }
  class MockInvokeEndpointWithResponseStreamCommand {
    input: unknown
    _type = 'InvokeEndpointWithResponseStreamCommand'
    constructor(input: unknown) {
      this.input = input
    }
  }
  return {
    SageMakerRuntimeClient: MockSageMakerRuntimeClient,
    InvokeEndpointCommand: MockInvokeEndpointCommand,
    InvokeEndpointWithResponseStreamCommand: MockInvokeEndpointWithResponseStreamCommand,
  }
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('SageMakerModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('requires an endpoint name', () => {
      expect(() => new SageMakerModel({ endpointName: '' })).toThrow('requires an endpointName')
    })

    it('rejects client + clientConfig', () => {
      expect(
        () =>
          new SageMakerModel({
            endpointName: 'ep',
            client: {} as any,
            clientConfig: { region: 'us-east-1' },
          })
      ).toThrow('Cannot specify both')
    })

    it('creates with valid endpoint name', () => {
      const model = new SageMakerModel({ endpointName: 'my-endpoint' })
      expect(model).toBeDefined()
    })

    it('sets default config values', () => {
      const model = new SageMakerModel({ endpointName: 'ep' })
      const config = model.getConfig()
      expect(config.stream).not.toBe(false)
      expect(config.toolResultsAsUserMessages).toBe(false)
    })
  })

  describe('config', () => {
    it('returns the current config', () => {
      const model = new SageMakerModel({
        endpointName: 'ep',
        maxTokens: 2048,
        temperature: 0.5,
      })
      const config = model.getConfig()
      expect(config.maxTokens).toBe(2048)
      expect(config.temperature).toBe(0.5)
    })

    it('updates config', () => {
      const model = new SageMakerModel({ endpointName: 'ep' })
      model.updateConfig({ maxTokens: 4096 })
      expect(model.getConfig().maxTokens).toBe(4096)
    })

    it('returns modelId', () => {
      const model = new SageMakerModel({ endpointName: 'ep', modelId: 'my-model' })
      expect(model.modelId).toBe('my-model')
    })
  })

  describe('stream - streaming mode', () => {
    it('streams a simple text response', async () => {
      const streamChunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]

      const mockClient = createMockClient(async () => mockStreamingResponse(streamChunks))
      const model = new SageMakerModel({
        endpointName: 'ep',
        client: mockClient as any,
      })

      const events = await collectEvents(model.stream([textMessage('Hi')]))

      // Should have message start, content start, text deltas, content stop, message stop, metadata
      const messageStarts = events.filter((e) => e.type === 'modelMessageStartEvent')
      const contentStarts = events.filter((e) => e.type === 'modelContentBlockStartEvent')
      const textDeltas = events.filter(
        (e) => e.type === 'modelContentBlockDeltaEvent' && 'delta' in e && (e.delta as any).type === 'textDelta'
      )
      const messageStops = events.filter((e) => e.type === 'modelMessageStopEvent')

      expect(messageStarts).toHaveLength(1)
      expect(contentStarts.length).toBeGreaterThanOrEqual(1)
      expect(textDeltas.length).toBeGreaterThanOrEqual(1)
      expect(messageStops).toHaveLength(1)

      // Check text content
      const texts = textDeltas.map((e) => ((e as any).delta as any).text)
      expect(texts.join('')).toContain('Hello')
    })

    it('streams a tool call response', async () => {
      const streamChunks = [
        { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"city":"Tokyo"}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]

      const mockClient = createMockClient(async () => mockStreamingResponse(streamChunks))
      const model = new SageMakerModel({
        endpointName: 'ep',
        client: mockClient as any,
      })

      const events = await collectEvents(model.stream([textMessage('Weather in Tokyo')]))

      const toolStarts = events.filter(
        (e) => e.type === 'modelContentBlockStartEvent' && (e as any).start?.type === 'toolUseStart'
      )
      const toolDeltas = events.filter(
        (e) => e.type === 'modelContentBlockDeltaEvent' && (e as any).delta?.type === 'toolUseInputDelta'
      )
      const messageStops = events.filter((e) => e.type === 'modelMessageStopEvent')

      expect(toolStarts).toHaveLength(1)
      expect((toolStarts[0] as any).start.name).toBe('get_weather')
      expect(toolDeltas.length).toBeGreaterThanOrEqual(1)
      expect(messageStops).toHaveLength(1)
      expect((messageStops[0] as any).stopReason).toBe('toolUse')
    })

    it('requires at least one message', async () => {
      const model = new SageMakerModel({ endpointName: 'ep', client: {} as any })
      await expect(collectEvents(model.stream([]))).rejects.toThrow('At least one message is required')
    })
  })

  describe('stream - non-streaming mode', () => {
    it('handles a non-streaming text response', async () => {
      const responseBody = {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello from SageMaker' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }

      const mockClient = createMockClient(async () => mockNonStreamingResponse(responseBody))
      const model = new SageMakerModel({
        endpointName: 'ep',
        stream: false,
        client: mockClient as any,
      })

      const events = await collectEvents(model.stream([textMessage('Hi')]))

      const textDeltas = events.filter(
        (e) => e.type === 'modelContentBlockDeltaEvent' && (e as any).delta?.type === 'textDelta'
      )
      const messageStops = events.filter((e) => e.type === 'modelMessageStopEvent')
      const metadata = events.filter((e) => e.type === 'modelMetadataEvent')

      expect(textDeltas).toHaveLength(1)
      expect((textDeltas[0] as any).delta.text).toBe('Hello from SageMaker')
      expect(messageStops).toHaveLength(1)
      expect((messageStops[0] as any).stopReason).toBe('endTurn')
      expect(metadata).toHaveLength(1)
      expect((metadata[0] as any).usage.inputTokens).toBe(5)
    })

    it('handles non-streaming tool call response', async () => {
      const responseBody = {
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'search', arguments: '{"q":"test"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      }

      const mockClient = createMockClient(async () => mockNonStreamingResponse(responseBody))
      const model = new SageMakerModel({
        endpointName: 'ep',
        stream: false,
        client: mockClient as any,
      })

      const events = await collectEvents(model.stream([textMessage('Search for test')]))

      const toolStarts = events.filter(
        (e) => e.type === 'modelContentBlockStartEvent' && (e as any).start?.type === 'toolUseStart'
      )
      const messageStops = events.filter((e) => e.type === 'modelMessageStopEvent')

      expect(toolStarts).toHaveLength(1)
      expect((toolStarts[0] as any).start.name).toBe('search')
      expect(messageStops).toHaveLength(1)
      expect((messageStops[0] as any).stopReason).toBe('toolUse')
    })
  })
})
