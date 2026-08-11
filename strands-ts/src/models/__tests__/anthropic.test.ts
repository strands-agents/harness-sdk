import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { isNode } from '../../__fixtures__/environment.js'
import { AnthropicModel } from '../anthropic.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import { collectGenerator, collectIterator } from '../../__fixtures__/model-test-helpers.js'
import {
  Message,
  TextBlock,
  CachePointBlock,
  GuardContentBlock,
  ToolResultBlock,
  JsonBlock,
  ReasoningBlock,
} from '../../types/messages.js'
import { ImageBlock, DocumentBlock, VideoBlock } from '../../types/media.js'
import { warnOnce } from '../../logging/warn-once.js'
import { logger } from '../../logging/logger.js'
import { CitationsBlock } from '../../types/citations.js'

/**
 * Helper to create a mock Anthropic client with streaming support
 */
function createMockClient(streamGenerator: () => AsyncGenerator<unknown>): Anthropic {
  return {
    messages: {
      stream: vi.fn(() => streamGenerator()),
      countTokens: vi.fn(),
    },
  } as unknown as Anthropic
}

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockConstructor = vi.fn(function () {
    return {
      messages: {
        stream: vi.fn(),
        countTokens: vi.fn(),
      },
    }
  })
  return {
    default: mockConstructor,
  }
})

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

describe('AnthropicModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-env')
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      vi.unstubAllEnvs()
    }
  })

  describe('constructor', () => {
    it('creates an instance with default configuration', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-ant-test' })
      const config = provider.getConfig()
      expect(config.modelId).toBe('claude-sonnet-4-6')
      expect(config.maxTokens).toBe(64_000)
    })

    it('uses provided model ID', () => {
      const customModelId = 'claude-3-opus-20240229'
      const provider = new AnthropicModel({ modelId: customModelId, apiKey: 'sk-ant-test' })
      expect(provider.getConfig().modelId).toBe(customModelId)
    })

    it('uses API key from constructor parameter', () => {
      const apiKey = 'sk-explicit'
      new AnthropicModel({ apiKey })
      expect(Anthropic).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey,
        })
      )
    })

    if (isNode) {
      it('uses API key from environment variable', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'sk-from-env')
        new AnthropicModel()
        expect(Anthropic).toHaveBeenCalled()
      })

      it('throws error when no API key is available', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '')
        expect(() => new AnthropicModel()).toThrow('Anthropic API key is required')
      })
    }

    it('uses provided client instance', () => {
      const mockClient = {} as Anthropic
      const provider = new AnthropicModel({ client: mockClient })
      expect(Anthropic).not.toHaveBeenCalled()
      expect(provider).toBeDefined()
    })

    it('warns when maxTokens is not explicitly set', () => {
      new AnthropicModel({ apiKey: 'sk-ant-test' })
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default maxTokens')
      )
    })

    it('does not warn when maxTokens is explicitly set', () => {
      new AnthropicModel({ apiKey: 'sk-ant-test', maxTokens: 4096 })
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default maxTokens')
      )
    })

    it('warns when modelId is not explicitly set', () => {
      new AnthropicModel({ apiKey: 'sk-ant-test' })
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('does not warn when modelId is explicitly set', () => {
      new AnthropicModel({ apiKey: 'sk-ant-test', modelId: 'claude-3-opus-20240229' })
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('auto-populates contextWindowLimit from model ID lookup', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test', modelId: 'claude-sonnet-4-20250514' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'claude-sonnet-4-20250514',
        maxTokens: 64_000,
        contextWindowLimit: 1_000_000,
      })
    })

    it('auto-populates contextWindowLimit for default model ID', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'claude-sonnet-4-6',
        maxTokens: 64_000,
        contextWindowLimit: 1_000_000,
      })
    })

    it('does not override explicit contextWindowLimit', () => {
      const provider = new AnthropicModel({
        apiKey: 'sk-test',
        modelId: 'claude-sonnet-4-20250514',
        contextWindowLimit: 100_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'claude-sonnet-4-20250514',
        maxTokens: 64_000,
        contextWindowLimit: 100_000,
      })
    })

    it('leaves contextWindowLimit undefined for unknown model IDs', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test', modelId: 'unknown-model' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'unknown-model',
        maxTokens: 64_000,
      })
    })
  })

  describe('updateConfig', () => {
    it('merges new config with existing config', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test', temperature: 0.5 })
      provider.updateConfig({ temperature: 0.8, maxTokens: 8192 })
      expect(provider.getConfig()).toMatchObject({
        temperature: 0.8,
        maxTokens: 8192,
      })
    })

    it('re-resolves contextWindowLimit when modelId changes and it was auto-resolved', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_000_000) // claude-sonnet-4-6 default

      provider.updateConfig({ modelId: 'claude-sonnet-4-20250514' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_000_000) // claude-sonnet-4-20250514 value
    })

    it('preserves explicit contextWindowLimit when modelId changes', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-test', contextWindowLimit: 50_000 })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)

      provider.updateConfig({ modelId: 'claude-sonnet-4-20250514' })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000) // preserved
    })
  })

  describe('stream event handling', () => {
    it('yields correct event sequence for simple text response', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toHaveLength(6)
      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent' })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Hello' },
      })
      expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[4]).toEqual({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      })
      expect(events[5]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
    })

    it('handles tool use events', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'calc' },
        }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a"' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':1}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'calc', toolUseId: 'tool_1' },
      })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"a"' },
      })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: ':1}' },
      })
      expect(events).toContainEqual({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
    })

    it.each([
      ['pause_turn', 'pauseTurn'],
      ['refusal', 'refusal'],
    ])('maps anthropic stop reason "%s" to "%s"', async (anthropicReason, expected) => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield { type: 'message_delta', delta: { stop_reason: anthropicReason }, usage: { output_tokens: 1 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({ type: 'modelMessageStopEvent', stopReason: expected })
    })

    it('handles thinking/reasoning events', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }
        // Thinking block
        yield { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hmm...' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_123' } }
        yield { type: 'content_block_stop', index: 0 }
        // Text block
        yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }
        yield { type: 'content_block_stop', index: 1 }

        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      // Check for thinking deltas
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'Hmm...' },
      })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', signature: 'sig_123' },
      })
    })

    it('handles redacted thinking events', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'data' },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', redactedContent: 'data' },
      })
    })

    it('handles text payload directly in content_block_start (optimization)', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Full text' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
        yield { type: 'message_stop' }
      })

      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Full text' },
      })
    })

    it('handles error during stream', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'ping' } // Satisfy linter require-yield
        throw new Error('API Error')
      })
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow('API Error')
    })

    it('maps overload error to ContextWindowOverflowError', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'ping' } // Satisfy linter require-yield
        throw new Error('prompt is too long')
      })
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ContextWindowOverflowError)
    })

    it.each([
      'input is too long',
      'input length exceeds context window',
      'input and output tokens exceed your context limit',
    ])('maps overflow phrase %p to ContextWindowOverflowError', async (phrase) => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'ping' }
        throw new Error(phrase)
      })
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ContextWindowOverflowError)
    })

    it('matches overflow phrases case-insensitively', async () => {
      const mockClient = createMockClient(async function* () {
        yield { type: 'ping' }
        throw new Error('PROMPT IS TOO LONG: 200000 tokens')
      })
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ContextWindowOverflowError)
    })

    it('maps HTTP 429 error to ModelThrottledError', async () => {
      const rateLimitError = Object.assign(new Error('Rate limit exceeded'), { status: 429 })
      // eslint-disable-next-line require-yield
      const mockClient = createMockClient(async function* () {
        throw rateLimitError
      })
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ModelThrottledError)
      await expect(collectIterator(provider.stream(messages))).rejects.toThrow('Rate limit exceeded')
    })
  })

  describe('request formatting', () => {
    // Helper to capture request arguments
    const setupCapture = () => {
      const captured: { request: any; options: any } = { request: null, options: null }
      const mockClient = {
        messages: {
          stream: vi.fn((req, opts) => {
            captured.request = req
            captured.options = opts
            return (async function* () {})()
          }),
        },
      } as any
      return { captured, mockClient }
    }

    it('formats basic request correctly', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({
        modelId: 'claude-3-opus',
        maxTokens: 1000,
        temperature: 0.7,
        client: mockClient,
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(provider.stream(messages))

      expect(captured.request).toEqual({
        model: 'claude-3-opus',
        max_tokens: 1000,
        temperature: 0.7,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
        stream: true,
      })
    })

    it('never sends the durable message id to the provider', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ modelId: 'claude-3-opus', maxTokens: 1000, client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Hello')],
          trackingId: 'durable-1',
          metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        }),
      ]

      await collectIterator(provider.stream(messages))

      // The request the provider receives carries only role and content — never trackingId or metadata.
      expect(captured.request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
      expect('trackingId' in captured.request.messages[0]).toBe(false)
    })

    it('formats tools correctly', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
      const toolSpecs = [
        {
          name: 'calc',
          description: 'calculate',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ]

      await collectIterator(provider.stream(messages, { toolSpecs, toolChoice: { auto: {} } }))

      expect(captured.request.tools).toHaveLength(1)
      expect(captured.request.tools[0]).toEqual({
        name: 'calc',
        description: 'calculate',
        input_schema: { type: 'object', properties: {} },
      })
      expect(captured.request.tool_choice).toEqual({ type: 'auto' })
    })

    it('formats a signature-only reasoning block', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient })
      const messages = [
        new Message({
          role: 'assistant',
          content: [new ReasoningBlock({ signature: 'sig-abc' }), new TextBlock('answer')],
        }),
      ]

      await collectIterator(provider.stream(messages))

      expect(captured.request.messages[0].content).toEqual([
        { type: 'thinking', thinking: '', signature: 'sig-abc' },
        { type: 'text', text: 'answer' },
      ])
    })

    describe('Prompt Caching (Lookahead logic)', () => {
      it('attaches cache control to message content block followed by cache point', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('Cached content'),
              // Use 'default' here; provider converts it to 'ephemeral' for Anthropic
              new CachePointBlock({ cacheType: 'default' }),
              new TextBlock('Non-cached content'),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content
        expect(content).toHaveLength(2) // 3 blocks reduced to 2 (cache point merged)
        expect(content[0]).toEqual({
          type: 'text',
          text: 'Cached content',
          cache_control: { type: 'ephemeral' },
        })
        expect(content[1]).toEqual({
          type: 'text',
          text: 'Non-cached content',
        })
      })

      it('formats system prompt string without cache', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await collectIterator(provider.stream(messages, { systemPrompt: 'System instruction' }))

        expect(captured.request.system).toBe('System instruction')
      })

      it('formats system prompt array with cache points', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
        const systemPrompt = [
          new TextBlock('Heavy context'),
          new CachePointBlock({ cacheType: 'default' }),
          new TextBlock('Light context'),
        ]

        await collectIterator(provider.stream(messages, { systemPrompt }))

        expect(Array.isArray(captured.request.system)).toBe(true)
        const system = captured.request.system
        expect(system).toHaveLength(2)
        expect(system[0]).toEqual({
          type: 'text',
          text: 'Heavy context',
          cache_control: { type: 'ephemeral' },
        })
        expect(system[1]).toEqual({
          type: 'text',
          text: 'Light context',
        })
      })
    })

    describe('Media blocks', () => {
      it('formats images correctly', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const imageBytes = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'png',
                source: { bytes: imageBytes },
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('image')
        expect(content.source.media_type).toBe('image/png')
        // Base64 of "Hello" is "SGVsbG8="
        expect(content.source.data).toBe('SGVsbG8=')
      })

      it('formats PDFs correctly', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const pdfBytes = new Uint8Array([1, 2, 3])
        const messages = [
          new Message({
            role: 'user',
            content: [
              new DocumentBlock({
                name: 'doc.pdf',
                format: 'pdf',
                source: { bytes: pdfBytes },
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('document')
        expect(content.source.media_type).toBe('application/pdf')
        expect(content.title).toBe('doc.pdf')
      })

      it('logs warning for unsupported GuardContentBlock in user message', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) // Spy on console.warn (via logger)
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new GuardContentBlock({
                text: { text: 'guard', qualifiers: ['query'] },
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        // Should result in empty content if blocked
        expect(captured.request.messages[0].content).toHaveLength(0)
        warnSpy.mockRestore()
      })
    })

    describe('Tool Results', () => {
      it('formats simple text tool result', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 't1',
                status: 'success',
                content: [new TextBlock('42')],
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('tool_result')
        expect(content.tool_use_id).toBe('t1')
        expect(content.content).toBe('42') // Simplified to string
        expect(content.is_error).toBe(false)
      })

      it('formats mixed tool result (json/image)', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 't1',
                status: 'error',
                content: [new JsonBlock({ json: { error: 'failed' } }), new TextBlock('Details here')],
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('tool_result')
        expect(content.is_error).toBe(true)
        expect(Array.isArray(content.content)).toBe(true)
        // JSON is stringified in Anthropic tool result content
        expect(content.content[0]).toEqual({ type: 'text', text: '{"error":"failed"}' })
        expect(content.content[1]).toEqual({ type: 'text', text: 'Details here' })
      })

      it('formats image block inside tool result via recursive formatting', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const imageBytes = new Uint8Array([72, 101, 108, 108, 111])
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 't1',
                status: 'success',
                content: [
                  new TextBlock('Here is the screenshot'),
                  new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
                ],
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('tool_result')
        expect(Array.isArray(content.content)).toBe(true)
        expect(content.content[0]).toEqual({ type: 'text', text: 'Here is the screenshot' })
        expect(content.content[1]).toEqual({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'SGVsbG8=' },
        })
      })

      it('formats document block inside tool result as text for text formats', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 't1',
                status: 'success',
                content: [new DocumentBlock({ name: 'data.json', format: 'json', source: { text: '{"key":"val"}' } })],
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('tool_result')
        // Single text item collapses to string
        expect(content.content).toBe('{"key":"val"}')
      })

      it('skips video block inside tool result with warning', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 't1',
                status: 'success',
                content: [
                  new TextBlock('result'),
                  new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1]) } }),
                ],
              }),
            ],
          }),
        ]

        await collectIterator(provider.stream(messages))

        const content = captured.request.messages[0].content[0]
        expect(content.type).toBe('tool_result')
        // Video is filtered out, single text collapses to string
        expect(content.content).toBe('result')
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })

    describe('Beta headers', () => {
      it('does not pass per-request options when betas is unset', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await collectIterator(provider.stream(messages))

        expect(captured.options).toBeUndefined()
      })

      it('forwards configured betas as a per-request anthropic-beta header', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({
          client: mockClient,
          betas: ['interleaved-thinking-2025-05-14', 'mcp-client-2025-11-20'],
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await collectIterator(provider.stream(messages))

        expect(captured.options).toEqual({
          headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14,mcp-client-2025-11-20' },
        })
      })

      it('reflects updateConfig({ betas }) on the next request', async () => {
        const { captured, mockClient } = setupCapture()
        const provider = new AnthropicModel({ client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await collectIterator(provider.stream(messages))
        expect(captured.options).toBeUndefined()

        provider.updateConfig({ betas: ['interleaved-thinking-2025-05-14'] })
        await collectIterator(provider.stream(messages))

        expect(captured.options).toEqual({
          headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
        })
      })
    })
  })

  describe('countTokens', () => {
    const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock('hello')] })]
    const toolSpecs = [
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' as const, properties: {} } },
    ]

    function createCountTokensClient(mockCountTokens: ReturnType<typeof vi.fn>): Anthropic {
      return {
        messages: {
          stream: vi.fn(),
          countTokens: mockCountTokens,
        },
      } as unknown as Anthropic
    }

    it('should use heuristic by default when useNativeTokenCount is not set', async () => {
      const mockCountTokens = vi.fn()
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6' })

      const result = await model.countTokens(messages)

      expect(mockCountTokens).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })

    it('should return native token count on success', async () => {
      const mockCountTokens = vi.fn(async () => ({ input_tokens: 42 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(result).toBe(42)
      expect(mockCountTokens).toHaveBeenCalledOnce()
    })

    it('should include system prompt in request', async () => {
      const mockCountTokens = vi.fn(async () => ({ input_tokens: 55 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      const result = await model.countTokens(messages, { systemPrompt: 'Be helpful.' })

      expect(result).toBe(55)
      expect(mockCountTokens).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        system: 'Be helpful.',
      })
    })

    it('should include tool specs in request', async () => {
      const mockCountTokens = vi.fn(async () => ({ input_tokens: 100 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      const result = await model.countTokens(messages, { toolSpecs })

      expect(result).toBe(100)
      expect(mockCountTokens).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [{ name: 'test_tool', description: 'A test tool', input_schema: { type: 'object', properties: {} } }],
      })
    })

    it('should strip max_tokens from request', async () => {
      const mockCountTokens = vi.fn(async () => ({ input_tokens: 10 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      await model.countTokens(messages)

      expect(mockCountTokens).toHaveBeenCalledWith({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      })
    })

    it('should fall back to estimation on API error', async () => {
      const mockCountTokens = vi.fn(async () => {
        throw new Error('Unsupported')
      })
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to estimation on generic exception', async () => {
      const mockCountTokens = vi.fn(async () => {
        throw new Error('Connection failed')
      })
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should skip native API and use heuristic when useNativeTokenCount is false', async () => {
      const mockCountTokens = vi.fn()
      const client = createCountTokensClient(mockCountTokens)
      const model = new AnthropicModel({ client, modelId: 'claude-sonnet-4-6', useNativeTokenCount: false })

      const result = await model.countTokens(messages)

      expect(mockCountTokens).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })
  })

  // -------------------------------------------------------------------------------------------------
  // Anthropic server-side tools (web search)
  //
  // Versioned tool type strings below are from the Anthropic tool catalog:
  // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
  // -------------------------------------------------------------------------------------------------
  describe('server-side tools (anthropicTools)', () => {
    const WEB_SEARCH_TOOL = { type: 'web_search_20260318' as const, name: 'web_search' as const, max_uses: 3 }
    const WEB_FETCH_TOOL = { type: 'web_fetch_20260318' as const, name: 'web_fetch' as const }

    const FUNCTION_TOOL_SPEC = {
      name: 'calc',
      description: 'calculate',
      inputSchema: { type: 'object' as const, properties: {} },
    }

    const setupCapture = () => {
      const captured: { request: any } = { request: null }
      const mockClient = {
        messages: {
          stream: vi.fn((req) => {
            captured.request = req
            return (async function* () {})()
          }),
        },
      } as any
      return { captured, mockClient }
    }

    /** A realistic stream for one server-side web search followed by a cited answer. */
    async function* webSearchStream(): AsyncGenerator<unknown> {
      yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 10 } } }

      // Anthropic runs the search itself; this block and its input deltas describe a tool the agent
      // never executes.
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query": "agents"}' },
      }
      yield { type: 'content_block_stop', index: 0 }

      yield {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://docs.example.com/agents',
              title: 'Agents guide',
              encrypted_content: 'enc',
              page_age: '1 day ago',
            },
          ],
        },
      }
      yield { type: 'content_block_stop', index: 1 }

      yield { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Agents are ' } }
      yield {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://docs.example.com/agents',
            title: 'Agents guide',
            cited_text: 'Agents are autonomous programs.',
            encrypted_index: 'idx',
          },
        },
      }
      yield { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'autonomous.' } }
      yield { type: 'content_block_stop', index: 2 }

      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
      yield { type: 'message_stop' }
    }

    it('appends server-side tools alongside function tools', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient, anthropicTools: [WEB_SEARCH_TOOL] })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          toolSpecs: [FUNCTION_TOOL_SPEC],
        })
      )

      expect(captured.request.tools).toEqual([
        { name: 'calc', description: 'calculate', input_schema: { type: 'object', properties: {} } },
        WEB_SEARCH_TOOL,
      ])
    })

    it('keeps every function tool when server-side tools are enabled', async () => {
      const { captured, mockClient } = setupCapture()
      const toolSpecs = Array.from({ length: 5 }, (_, index) => ({ ...FUNCTION_TOOL_SPEC, name: `tool_${index}` }))
      const provider = new AnthropicModel({
        client: mockClient,
        anthropicTools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
      })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], { toolSpecs })
      )

      expect(captured.request.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'tool_0',
        'tool_1',
        'tool_2',
        'tool_3',
        'tool_4',
        'web_search',
        'web_fetch',
      ])
    })

    it('sends server-side tools when the agent has no function tools', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient, anthropicTools: [WEB_SEARCH_TOOL] })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.tools).toEqual([WEB_SEARCH_TOOL])
    })

    it('omits tools entirely when unset', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect('tools' in captured.request).toBe(false)
      expect(warnOnce).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('anthropicTools'))
    })

    it('warns and merges instead of clobbering when tools are passed via params', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({
        client: mockClient,
        params: { temperature: 0.5, tools: [WEB_SEARCH_TOOL] },
      })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          toolSpecs: [FUNCTION_TOOL_SPEC],
        })
      )

      expect(captured.request.tools.map((tool: { name: string }) => tool.name)).toEqual(['calc', 'web_search'])
      expect(captured.request.temperature).toBe(0.5)
      expect(warnOnce).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('anthropicTools'))
    })

    it('does not accumulate params.tools into the stored config across requests', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient, params: { tools: [WEB_SEARCH_TOOL] } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await collectIterator(provider.stream(messages, { toolSpecs: [FUNCTION_TOOL_SPEC] }))
      const first = captured.request.tools
      await collectIterator(provider.stream(messages, { toolSpecs: [FUNCTION_TOOL_SPEC] }))

      expect(captured.request.tools).toEqual(first)
      expect(provider.getConfig().params).toEqual({ tools: [WEB_SEARCH_TOOL] })
    })

    it('round-trips web search citations into a citations content block without losing the text', async () => {
      const provider = new AnthropicModel({ client: createMockClient(webSearchStream) })

      const { result } = await collectGenerator(
        provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      expect(result.stopReason).toBe('endTurn')
      expect(result.message.content).toHaveLength(1)

      const block = result.message.content[0] as CitationsBlock
      expect(block.type).toBe('citationsBlock')
      expect(block.content).toEqual([{ text: 'Agents are autonomous.' }])
      expect(block.citations).toEqual([
        {
          location: { type: 'web', url: 'https://docs.example.com/agents', domain: 'docs.example.com' },
          source: 'https://docs.example.com/agents',
          sourceContent: [{ text: 'Agents are autonomous programs.' }],
          title: 'Agents guide',
        },
      ])
    })

    it('does not replay server-side tool input as function tool input', async () => {
      const provider = new AnthropicModel({ client: createMockClient(webSearchStream) })

      const events = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      const deltaTypes = events.flatMap((event) =>
        event.type === 'modelContentBlockDeltaEvent' ? [event.delta.type] : []
      )

      expect(deltaTypes).not.toContain('toolUseInputDelta')
      expect(events.some((event) => event.type === 'modelContentBlockStartEvent' && event.start !== undefined)).toBe(
        false
      )
    })

    it('round-trips a cited answer back into the request as text', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient })

      const messages = [
        new Message({ role: 'user', content: [new TextBlock('hi')] }),
        new Message({
          role: 'assistant',
          content: [
            new CitationsBlock({
              citations: [
                {
                  location: { type: 'web', url: 'https://docs.example.com/agents' },
                  source: 'https://docs.example.com/agents',
                  sourceContent: [{ text: 'Agents are autonomous programs.' }],
                  title: 'Agents guide',
                },
              ],
              content: [{ text: 'Agents are autonomous.' }],
            }),
          ],
        }),
        new Message({ role: 'user', content: [new TextBlock('and?')] }),
      ]

      await collectIterator(provider.stream(messages))

      expect(captured.request.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Agents are autonomous.' }],
      })
    })

    it('releases a server-side block index on stop so a recycled index still streams a real tool', async () => {
      // Anthropic reuses block indexes; a genuine tool_use at a recycled index must not be suppressed.
      async function* recycledIndexStream(): AsyncGenerator<unknown> {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
        }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu1', name: 'calc', input: {} },
        }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a": 1}' },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      }

      const provider = new AnthropicModel({ client: createMockClient(recycledIndexStream) })
      const events = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      const toolStarts = events.filter(
        (event) => event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart'
      )
      const toolInputDeltas = events.flatMap((event) =>
        event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'toolUseInputDelta'
          ? [event.delta.input]
          : []
      )

      expect(toolStarts).toHaveLength(1)
      expect(toolInputDeltas).toEqual(['{"a": 1}'])
    })

    // --- fixes from adversarial review of PR #3568 ---------------------------------------------

    it('drops a citations block with no generated text instead of sending an empty text block', async () => {
      // Reachable in practice: bedrock.ts streams citation deltas with an empty `content`, so replaying
      // a Bedrock-produced history through AnthropicModel would otherwise be a guaranteed 400
      // ("text content blocks must contain non-whitespace text").
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient })

      const messages = [
        new Message({ role: 'user', content: [new TextBlock('hi')] }),
        new Message({
          role: 'assistant',
          content: [
            new CitationsBlock({
              citations: [
                {
                  location: { type: 'web', url: 'https://docs.example.com/a' },
                  source: 'https://docs.example.com/a',
                  sourceContent: [{ text: 'cited source text' }],
                  title: 'A',
                },
              ],
              content: [],
            }),
            new TextBlock('real answer'),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      expect(captured.request.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'real answer' }],
      })
    })

    it.each([
      ['a string', 'web_search'],
      ['a number', 123],
    ])('rejects params.tools that is %s rather than spreading it', async (_label, badTools) => {
      const { mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient, params: { tools: badTools } })

      await expect(
        collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))
      ).rejects.toThrow(/params\.tools must be an array/)
    })

    it('wraps a bare params.tools object rather than discarding it', async () => {
      const { captured, mockClient } = setupCapture()
      const provider = new AnthropicModel({ client: mockClient, params: { tools: WEB_SEARCH_TOOL } })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          toolSpecs: [FUNCTION_TOOL_SPEC],
        })
      )

      expect(captured.request.tools.map((tool: { name: string }) => tool.name)).toEqual(['calc', 'web_search'])
    })

    it('rejects anthropicTools entries that are function tool definitions', () => {
      expect(
        () =>
          new AnthropicModel({
            apiKey: 'sk-ant-test',
            anthropicTools: [{ name: 'my_tool', description: 'd', input_schema: { type: 'object' } }] as never,
          })
      ).toThrow(/should not contain function tool definitions/)
    })

    it('rejects anthropicTools entries missing the versioned type string', () => {
      expect(
        () => new AnthropicModel({ apiKey: 'sk-ant-test', anthropicTools: [{ name: 'web_search' }] as never })
      ).toThrow(/versioned `type` string/)
    })

    it('rejects a bare string for anthropicTools', () => {
      expect(() => new AnthropicModel({ apiKey: 'sk-ant-test', anthropicTools: 'web_search' as never })).toThrow(
        /anthropicTools must be an array/
      )
    })

    it('validates anthropicTools on updateConfig too', () => {
      const provider = new AnthropicModel({ apiKey: 'sk-ant-test' })

      expect(() =>
        provider.updateConfig({
          anthropicTools: [{ name: 'my_tool', description: 'd', input_schema: { type: 'object' } }] as never,
        })
      ).toThrow(/should not contain function tool definitions/)

      provider.updateConfig({ anthropicTools: [WEB_SEARCH_TOOL] })
      expect(provider.getConfig().anthropicTools).toEqual([WEB_SEARCH_TOOL])
    })

    it('derives the citation domain without the port, matching the Python provider', async () => {
      async function* portStream(): AsyncGenerator<unknown> {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } }
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              url: 'https://example.com:8443/a',
              title: 'T',
              cited_text: 'c',
              encrypted_index: 'i',
            },
          },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
        yield { type: 'message_stop' }
      }

      const provider = new AnthropicModel({ client: createMockClient(portStream) })
      const { result } = await collectGenerator(
        provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      const block = result.message.content[0] as CitationsBlock
      expect(block.citations[0]?.location).toEqual({
        type: 'web',
        url: 'https://example.com:8443/a',
        domain: 'example.com',
      })
    })

    it('suppresses mcp_tool_use input deltas, not just web search blocks', async () => {
      async function* mcpStream(): AsyncGenerator<unknown> {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'remote_tool', input: {} },
        }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      }

      const provider = new AnthropicModel({ client: createMockClient(mcpStream) })
      const events = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      const deltaTypes = events.flatMap((event) =>
        event.type === 'modelContentBlockDeltaEvent' ? [event.delta.type] : []
      )
      expect(deltaTypes).not.toContain('toolUseInputDelta')
    })

    it('forwards an unrecognized block type with a warning rather than dropping content', async () => {
      const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      async function* unknownStream(): AsyncGenerator<unknown> {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'brand_new_block_20991231' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
        yield { type: 'message_stop' }
      }

      const provider = new AnthropicModel({ client: createMockClient(unknownStream) })
      const { result } = await collectGenerator(
        provider.streamAggregated([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      expect((result.message.content[0] as TextBlock).text).toBe('hello')
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('brand_new_block_20991231'))
      logSpy.mockRestore()
    })

    it('leaves no empty content block behind for suppressed server-side blocks', async () => {
      const provider = new AnthropicModel({ client: createMockClient(webSearchStream) })
      const events = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      expect(events.filter((event) => event.type === 'modelContentBlockStartEvent')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'modelContentBlockStopEvent')).toHaveLength(1)
    })

    it('does not duplicate the cited text across textDelta and citationsDelta events', async () => {
      const provider = new AnthropicModel({ client: createMockClient(webSearchStream) })
      const events = await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })])
      )

      const citationsContent = events.flatMap((event) =>
        event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'citationsDelta' ? event.delta.content : []
      )

      // The text streams only as textDeltas; model.ts recovers it for the citations block.
      expect(citationsContent).toEqual([])
    })

    it('warns when a server-side tool result is an error', async () => {
      const logSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      async function* errorStream(): AsyncGenerator<unknown> {
        yield { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 1 } } }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
          },
        }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
      }

      const provider = new AnthropicModel({ client: createMockClient(errorStream) })
      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('max_uses_exceeded'))
      logSpy.mockRestore()
    })
  })
})
