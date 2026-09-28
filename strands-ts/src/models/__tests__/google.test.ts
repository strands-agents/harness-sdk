import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoogleGenAI, FunctionCallingConfigMode, type GenerateContentResponse } from '@google/genai'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { GoogleModel } from '../google/model.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import {
  Message,
  CachePointBlock,
  GuardContentBlock,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types/messages.js'
import type { ContentBlock } from '../../types/messages.js'
import { formatMessages, mapChunkToEvents } from '../google/adapters.js'
import type { GoogleStreamState } from '../google/types.js'
import { ImageBlock, DocumentBlock, VideoBlock } from '../../types/media.js'
import { warnOnce } from '../../logging/warn-once.js'

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

/**
 * Helper to create a mock Gemini client with streaming support
 */
function createMockClient(streamGenerator: () => AsyncGenerator<Record<string, unknown>>): GoogleGenAI {
  return {
    models: {
      generateContentStream: vi.fn(async () => streamGenerator()),
    },
  } as unknown as GoogleGenAI
}

/**
 * Helper to create a mock Gemini client that captures the request parameters.
 * Returns the client and a captured object with `config` and `contents` fields
 * populated after a stream call.
 */
function createMockClientWithCapture(): { client: GoogleGenAI; captured: Record<string, unknown> } {
  const captured: Record<string, unknown> = {}
  const client = {
    models: {
      generateContentStream: vi.fn(async (params: Record<string, unknown>) => {
        Object.assign(captured, params)
        return (async function* () {
          yield { candidates: [{ finishReason: 'STOP' }] }
        })()
      }),
    },
  } as unknown as GoogleGenAI
  return { client, captured }
}

/**
 * Helper to set up a capture-based test with provider, captured params, and a default user message.
 */
function setupCaptureTest(): {
  provider: GoogleModel
  captured: Record<string, unknown>
  messages: Message[]
} {
  const { client, captured } = createMockClientWithCapture()
  const provider = new GoogleModel({ client })
  const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
  return { provider, captured, messages }
}

/**
 * Helper to set up a stream-based test with a mock client, provider, and default user message.
 */
function setupStreamTest(streamGenerator: () => AsyncGenerator<Record<string, unknown>>): {
  provider: GoogleModel
  messages: Message[]
} {
  const client = createMockClient(streamGenerator)
  const provider = new GoogleModel({ client })
  const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
  return { provider, messages }
}

/**
 * Helper to format a single content block via formatMessages.
 */
function formatBlock(block: ContentBlock, role: 'user' | 'assistant' = 'user'): ReturnType<typeof formatMessages> {
  return formatMessages([new Message({ role, content: [block] })])
}

describe('GoogleModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('GEMINI_API_KEY', 'test-api-key')
  })

  describe('constructor', () => {
    it('creates instance with API key', () => {
      const provider = new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-2.0-flash' })
      expect(provider.getConfig().modelId).toBe('gemini-2.0-flash')
    })

    it('throws error when no API key provided and no env variable', () => {
      vi.stubEnv('GEMINI_API_KEY', '')

      expect(() => new GoogleModel()).toThrow('Gemini API key is required')
    })

    it('does not require API key when client is provided', () => {
      vi.stubEnv('GEMINI_API_KEY', '')

      const mockClient = createMockClient(async function* () {
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      expect(() => new GoogleModel({ client: mockClient })).not.toThrow()
    })

    it('warns when modelId is not explicitly set', () => {
      new GoogleModel({ apiKey: 'test-key' })
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('does not warn when modelId is explicitly set', () => {
      new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-2.5-flash' })
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })
  })

  describe('updateConfig', () => {
    it('merges new config with existing config', () => {
      const provider = new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-2.5-flash' })
      provider.updateConfig({ params: { temperature: 0.5 } })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gemini-2.5-flash',
        params: { temperature: 0.5 },
        contextWindowLimit: 1_048_576,
      })
    })

    it('re-resolves contextWindowLimit when modelId changes and it was auto-resolved', () => {
      const provider = new GoogleModel({ apiKey: 'test-key' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_048_576)

      provider.updateConfig({ modelId: 'gemini-2.0-flash' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_048_576)
    })

    it('clears contextWindowLimit when modelId changes to unknown model', () => {
      const provider = new GoogleModel({ apiKey: 'test-key' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_048_576)

      provider.updateConfig({ modelId: 'my-custom-finetuned-model' })
      expect(provider.getConfig().contextWindowLimit).toBeUndefined()
    })

    it('preserves explicit contextWindowLimit when modelId changes', () => {
      const provider = new GoogleModel({ apiKey: 'test-key', contextWindowLimit: 50_000 })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)

      provider.updateConfig({ modelId: 'gemini-2.0-flash' })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)
    })
  })

  describe('getConfig', () => {
    it('returns the current configuration', () => {
      const provider = new GoogleModel({
        apiKey: 'test-key',
        modelId: 'gemini-2.5-flash',
        params: { maxOutputTokens: 1024, temperature: 0.7 },
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gemini-2.5-flash',
        params: { maxOutputTokens: 1024, temperature: 0.7 },
        contextWindowLimit: 1_048_576,
      })
    })

    it('includes contextWindowLimit in config when provided', () => {
      const provider = new GoogleModel({
        apiKey: 'test-key',
        modelId: 'gemini-2.5-flash',
        contextWindowLimit: 1_048_576,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gemini-2.5-flash',
        contextWindowLimit: 1_048_576,
      })
    })

    it('auto-populates contextWindowLimit from model ID lookup', () => {
      const provider = new GoogleModel({ apiKey: 'test-key', modelId: 'gemini-2.5-pro' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gemini-2.5-pro',
        contextWindowLimit: 1_048_576,
      })
    })

    it('auto-populates contextWindowLimit for default model ID', () => {
      const provider = new GoogleModel({ apiKey: 'test-key' })
      expect(provider.getConfig()).toStrictEqual({
        contextWindowLimit: 1_048_576,
      })
    })

    it('does not override explicit contextWindowLimit', () => {
      const provider = new GoogleModel({
        apiKey: 'test-key',
        modelId: 'gemini-2.5-flash',
        contextWindowLimit: 500_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gemini-2.5-flash',
        contextWindowLimit: 500_000,
      })
    })

    it('leaves contextWindowLimit undefined for unknown model IDs', () => {
      const provider = new GoogleModel({ apiKey: 'test-key', modelId: 'unknown-model' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'unknown-model',
      })
    })
  })

  describe('stream', () => {
    it('throws error when messages array is empty', async () => {
      const provider = new GoogleModel({ apiKey: 'test-key' })

      await expect(collectIterator(provider.stream([]))).rejects.toThrow('At least one message is required')
    })

    it('emits message start and stop events', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Hello' }] },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[events.length - 1]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
    })

    it('emits text content block events', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Hello' }] },
            },
          ],
        }
        yield {
          candidates: [
            {
              content: { parts: [{ text: ' world' }] },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      expect(events).toHaveLength(6)
      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent' })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Hello' },
      })
      expect(events[3]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: ' world' },
      })
      expect(events[4]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[5]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
    })

    it('emits usage metadata when available', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Hi' }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            totalTokenCount: 15,
          },
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      })
    })

    // Regression for the token miscount catalogued in #3546: totalTokenCount sums four disjoint buckets
    // (prompt + candidates + toolUsePrompt + thoughts), so subtracting only prompt miscounts the
    // input-side toolUsePrompt tokens as output.
    it('counts tool-use tokens as input and thinking tokens as output', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            toolUsePromptTokenCount: 5,
            thoughtsTokenCount: 30,
            totalTokenCount: 155,
          },
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 105,
          outputTokens: 50,
          totalTokens: 155,
        },
      })
    })

    it('surfaces cache-read tokens when present', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 25,
            totalTokenCount: 120,
          },
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 25,
        },
      })
    })

    it('omits cache-read tokens when cachedContentTokenCount is 0', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 0,
            totalTokenCount: 120,
          },
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      })
    })

    it('clears cache-read tokens when a later usage chunk reports none', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            cachedContentTokenCount: 25,
            totalTokenCount: 120,
          },
        }
        yield {
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            totalTokenCount: 120,
          },
        }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
      })
    })

    it('clamps output to zero when totalTokenCount is below promptTokenCount', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 10,
            totalTokenCount: 5,
          },
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          totalTokens: 5,
        },
      })
    })

    it('handles MAX_TOKENS finish reason', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Truncated' }] },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'MAX_TOKENS' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(stopEvent).toBeDefined()
      expect(stopEvent!.stopReason).toBe('maxTokens')
    })
  })

  describe('error handling', () => {
    it('throws ContextWindowOverflowError for context overflow errors', async () => {
      const mockClient = {
        models: {
          generateContentStream: vi.fn(async () => {
            throw new Error(
              JSON.stringify({
                error: {
                  status: 'INVALID_ARGUMENT',
                  message: 'Request exceeds the maximum number of tokens allowed',
                },
              })
            )
          }),
        },
      } as unknown as GoogleGenAI

      const provider = new GoogleModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ContextWindowOverflowError)
    })

    it('throws ModelThrottledError for RESOURCE_EXHAUSTED status', async () => {
      const mockClient = {
        models: {
          generateContentStream: vi.fn(async () => {
            throw new Error(
              JSON.stringify({
                error: {
                  status: 'RESOURCE_EXHAUSTED',
                  message: 'Quota exceeded for the model',
                },
              })
            )
          }),
        },
      } as unknown as GoogleGenAI

      const provider = new GoogleModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ModelThrottledError)
    })

    it('throws ModelThrottledError for UNAVAILABLE status', async () => {
      const mockClient = {
        models: {
          generateContentStream: vi.fn(async () => {
            throw new Error(
              JSON.stringify({
                error: {
                  status: 'UNAVAILABLE',
                  message: 'Service temporarily unavailable',
                },
              })
            )
          }),
        },
      } as unknown as GoogleGenAI

      const provider = new GoogleModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow(ModelThrottledError)
    })

    it('rethrows unrecognized errors', async () => {
      const mockClient = {
        models: {
          generateContentStream: vi.fn(async () => {
            throw new Error('Network error')
          }),
        },
      } as unknown as GoogleGenAI

      const provider = new GoogleModel({ client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(collectIterator(provider.stream(messages))).rejects.toThrow('Network error')
    })
  })

  describe('system prompt', () => {
    it('passes string system prompt to config', async () => {
      const { provider, captured, messages } = setupCaptureTest()

      await collectIterator(provider.stream(messages, { systemPrompt: 'You are a helpful assistant' }))

      const config = captured.config as { systemInstruction?: string }
      expect(config.systemInstruction).toBe('You are a helpful assistant')
    })

    it('ignores empty string system prompt', async () => {
      const { provider, captured, messages } = setupCaptureTest()

      await collectIterator(provider.stream(messages, { systemPrompt: '   ' }))

      const config = captured.config as { systemInstruction?: string }
      expect(config.systemInstruction).toBeUndefined()
    })
  })

  describe('message formatting', () => {
    it('formats user messages correctly', async () => {
      const { provider, captured } = setupCaptureTest()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(provider.stream(messages))

      const contents = captured.contents as Array<{ role: string; parts: Array<{ text: string }> }>
      expect(contents).toHaveLength(1)
      expect(contents[0]?.role).toBe('user')
      expect(contents[0]?.parts[0]?.text).toBe('Hello')
    })

    it('formats assistant messages correctly', async () => {
      const { provider, captured } = setupCaptureTest()
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Hi')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Hello!')] }),
        new Message({ role: 'user', content: [new TextBlock('How are you?')] }),
      ]

      await collectIterator(provider.stream(messages))

      const contents = captured.contents as Array<{ role: string; parts: Array<{ text: string }> }>
      expect(contents).toHaveLength(3)
      expect(contents[0]?.role).toBe('user')
      expect(contents[1]?.role).toBe('model')
      expect(contents[2]?.role).toBe('user')
    })
  })

  describe('content type formatting', () => {
    describe('image content', () => {
      it('formats image with bytes source as inlineData', () => {
        const imageBlock = new ImageBlock({
          format: 'png',
          source: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
        })

        const contents = formatBlock(imageBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ inlineData: { data: 'iVBORw==', mimeType: 'image/png' } }])
      })

      it('formats image with URL source as fileData', () => {
        const imageBlock = new ImageBlock({
          format: 'jpeg',
          source: { url: 'https://example.com/image.jpg' },
        })

        const contents = formatBlock(imageBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([
          { fileData: { fileUri: 'https://example.com/image.jpg', mimeType: 'image/jpeg' } },
        ])
      })

      it('skips image with S3 source and logs warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const imageBlock = new ImageBlock({
          format: 'png',
          source: { location: { type: 's3', uri: 's3://test/image.png' } },
        })

        const contents = formatBlock(imageBlock)

        // Message with no valid parts is not included
        expect(contents).toHaveLength(0)
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })

    describe('document content', () => {
      it('formats document with bytes source as inlineData', () => {
        const docBlock = new DocumentBlock({
          name: 'test.pdf',
          format: 'pdf',
          source: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
        })

        const contents = formatBlock(docBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ inlineData: { data: 'JVBERg==', mimeType: 'application/pdf' } }])
      })

      it('formats document with text source as inlineData bytes', () => {
        const docBlock = new DocumentBlock({
          name: 'test.txt',
          format: 'txt',
          source: { text: 'Document content here' },
        })

        const contents = formatBlock(docBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([
          { inlineData: { data: 'RG9jdW1lbnQgY29udGVudCBoZXJl', mimeType: 'text/plain' } },
        ])
      })

      it('formats document with content block source as separate text parts', () => {
        const docBlock = new DocumentBlock({
          name: 'test.txt',
          format: 'txt',
          source: { content: [{ text: 'Line 1' }, { text: 'Line 2' }] },
        })

        const contents = formatBlock(docBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ text: 'Line 1' }, { text: 'Line 2' }])
      })
    })

    describe('video content', () => {
      it('formats video with bytes source as inlineData', () => {
        const videoBlock = new VideoBlock({
          format: 'mp4',
          source: { bytes: new Uint8Array([0x00, 0x00, 0x00, 0x1c]) },
        })

        const contents = formatBlock(videoBlock)

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ inlineData: { data: 'AAAAHA==', mimeType: 'video/mp4' } }])
      })
    })

    describe('reasoning content', () => {
      it('formats reasoning block with thought flag', () => {
        const reasoningBlock = new ReasoningBlock({ text: 'Let me think about this...' })

        const contents = formatBlock(reasoningBlock, 'assistant')

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ text: 'Let me think about this...', thought: true }])
      })

      it('includes thought signature when present', () => {
        const reasoningBlock = new ReasoningBlock({ text: 'Thinking...', signature: 'sig123' })

        const contents = formatBlock(reasoningBlock, 'assistant')

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([{ text: 'Thinking...', thought: true, thoughtSignature: 'sig123' }])
      })

      it('skips reasoning block with empty text', () => {
        const reasoningBlock = new ReasoningBlock({ text: '' })

        const contents = formatBlock(reasoningBlock, 'assistant')

        expect(contents).toHaveLength(0)
      })
    })

    describe('unsupported content types', () => {
      it.each([
        { name: 'cache point', block: new CachePointBlock({ cacheType: 'default' }) },
        {
          name: 'guard content',
          block: new GuardContentBlock({ text: { qualifiers: ['guard_content'], text: 'test' } }),
        },
      ])('skips $name blocks with warning', ({ block }) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const contents = formatBlock(block)

        expect(contents).toHaveLength(0)
        warnSpy.mockRestore()
      })

      it('formats tool use blocks as function calls', () => {
        const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'testTool', input: { key: 'value' } })

        const contents = formatBlock(toolUseBlock, 'assistant')

        expect(contents).toHaveLength(1)
        expect(contents[0]!.parts).toEqual([
          { functionCall: { id: 'test-id', name: 'testTool', args: { key: 'value' } } },
        ])
      })
    })
  })

  describe('reasoning content streaming', () => {
    it('emits reasoning content delta events for thought parts', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Thinking...', thought: true }] },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      expect(events).toHaveLength(5)
      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent' })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'Thinking...' },
      })
      expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[4]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
    })

    it('handles transition from reasoning to text content', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Let me think...', thought: true }] },
            },
          ],
        }
        yield {
          candidates: [
            {
              content: { parts: [{ text: 'Here is my answer' }] },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      // Should have: messageStart, blockStart (reasoning), delta (reasoning), blockStop,
      //              blockStart (text), delta (text), blockStop, messageStop
      expect(events).toHaveLength(8)

      // Reasoning block
      expect(events[1]).toEqual({ type: 'modelContentBlockStartEvent' })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'Let me think...' },
      })
      expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' })

      // Text block
      expect(events[4]).toEqual({ type: 'modelContentBlockStartEvent' })
      expect(events[5]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Here is my answer' },
      })
      expect(events[6]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[7]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
    })

    it('includes signature in reasoning delta when present', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: 'Thinking...',
                    thought: true,
                    thoughtSignature: 'sig456',
                  },
                ],
              },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      const deltaEvent = events.find(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'reasoningContentDelta'
      )
      expect(deltaEvent).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'Thinking...', signature: 'sig456' },
      })
    })
  })

  describe('tool configuration', () => {
    it('passes tool specs as functionDeclarations', async () => {
      const { provider, captured, messages } = setupCaptureTest()

      await collectIterator(
        provider.stream(messages, {
          toolSpecs: [
            {
              name: 'get_weather',
              description: 'Get the weather',
              inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        })
      )

      const config = captured.config as { tools?: unknown[] }
      expect(config.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get the weather',
              parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        },
      ])
    })

    it.each([
      {
        name: 'auto to AUTO',
        toolChoice: { auto: {} },
        expectedMode: FunctionCallingConfigMode.AUTO,
      },
      {
        name: 'any to ANY',
        toolChoice: { any: {} },
        expectedMode: FunctionCallingConfigMode.ANY,
      },
      {
        name: 'tool to ANY with allowedFunctionNames',
        toolChoice: { tool: { name: 'get_weather' } },
        expectedMode: FunctionCallingConfigMode.ANY,
        expectedAllowedFunctionNames: ['get_weather'],
      },
    ])('maps toolChoice $name', async ({ toolChoice, expectedMode, expectedAllowedFunctionNames }) => {
      const { provider, captured, messages } = setupCaptureTest()

      await collectIterator(
        provider.stream(messages, {
          toolSpecs: [{ name: 'get_weather', description: 'test' }],
          toolChoice,
        })
      )

      const config = captured.config as {
        toolConfig?: { functionCallingConfig?: { mode?: string; allowedFunctionNames?: string[] } }
      }
      expect(config.toolConfig?.functionCallingConfig?.mode).toBe(expectedMode)
      if (expectedAllowedFunctionNames) {
        expect(config.toolConfig?.functionCallingConfig?.allowedFunctionNames).toEqual(expectedAllowedFunctionNames)
      }
    })

    it('does not add tools config when no toolSpecs provided', async () => {
      const { provider, captured, messages } = setupCaptureTest()

      await collectIterator(provider.stream(messages))

      const config = captured.config as { tools?: unknown }
      expect(config.tools).toBeUndefined()
    })
  })

  describe('built-in tools', () => {
    it('appends builtInTools to config.tools alongside functionDeclarations', async () => {
      const { client, captured } = createMockClientWithCapture()
      const provider = new GoogleModel({ client, builtInTools: [{ googleSearch: {} }] })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await collectIterator(
        provider.stream(messages, {
          toolSpecs: [
            {
              name: 'get_weather',
              description: 'Get the weather',
              inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
            },
          ],
        })
      )

      const config = captured.config as { tools?: unknown[] }
      expect(config.tools).toHaveLength(2)
      expect(config.tools![0]).toEqual({
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the weather',
            parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      })
      expect(config.tools![1]).toEqual({ googleSearch: {} })
    })

    it('passes builtInTools when no toolSpecs provided', async () => {
      const { client, captured } = createMockClientWithCapture()
      const provider = new GoogleModel({ client, builtInTools: [{ codeExecution: {} }] })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await collectIterator(provider.stream(messages))

      const config = captured.config as { tools?: unknown[] }
      expect(config.tools).toHaveLength(1)
      expect(config.tools![0]).toEqual({ codeExecution: {} })
    })

    it('does not add tools when neither builtInTools nor toolSpecs provided', async () => {
      const { client, captured } = createMockClientWithCapture()
      const provider = new GoogleModel({ client })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await collectIterator(provider.stream(messages))

      const config = captured.config as { tools?: unknown }
      expect(config.tools).toBeUndefined()
    })
  })

  describe('tool use formatting', () => {
    it('formats toolUseBlock with reasoningSignature as thoughtSignature', () => {
      const toolUseBlock = new ToolUseBlock({
        toolUseId: 'test-id',
        name: 'testTool',
        input: { key: 'value' },
        reasoningSignature: 'sig789',
      })

      const contents = formatBlock(toolUseBlock, 'assistant')

      expect(contents).toHaveLength(1)
      expect(contents[0]!.parts).toEqual([
        {
          functionCall: { id: 'test-id', name: 'testTool', args: { key: 'value' } },
          thoughtSignature: 'sig789',
        },
      ])
    })

    it('formats toolResultBlock as functionResponse', () => {
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'testTool', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [new TextBlock('result text')],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      expect(contents).toHaveLength(2)
      expect(contents[1]!.parts![0]).toEqual({
        functionResponse: {
          id: 'test-id',
          name: 'testTool',
          response: { output: [{ text: 'result text' }] },
        },
      })
    })

    it('resolves tool name from toolUseId in toolResultBlock', () => {
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'abc-123', name: 'my_tool', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'abc-123',
        status: 'success',
        content: [new TextBlock('ok')],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]!
      const fr = (resultPart as { functionResponse: { name: string } }).functionResponse
      expect(fr.name).toBe('my_tool')
    })

    it('falls back to toolUseId when tool name mapping is not found', () => {
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'unknown-id',
        status: 'success',
        content: [new TextBlock('ok')],
      })
      const messages = [new Message({ role: 'user', content: [toolResultBlock] })]

      const contents = formatMessages(messages)

      const resultPart = contents[0]!.parts![0]!
      const fr = (resultPart as { functionResponse: { name: string } }).functionResponse
      expect(fr.name).toBe('unknown-id')
    })

    it('formats image block in tool result as inlineData', () => {
      const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'screenshot', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as { functionResponse: { response: unknown; parts?: unknown[] } }
      // Image goes to separate parts, not into response.output
      expect(resultPart.functionResponse.response).toEqual({ output: [] })
      expect(resultPart.functionResponse.parts).toEqual([
        { inlineData: { data: 'iVBORw==', mimeType: 'image/png', displayName: 'image.png' } },
      ])
    })

    it('disambiguates displayName for multiple same-format images in one tool result', () => {
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'two_images', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [
          new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } }),
          new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x48]) } }),
        ],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as {
        functionResponse: { parts?: Array<{ inlineData: { displayName: string } }> }
      }
      const displayNames = resultPart.functionResponse.parts!.map((p) => p.inlineData.displayName)
      // Gemini rejects duplicate part names within one function_response.parts.
      expect(new Set(displayNames).size).toBe(displayNames.length)
      expect(displayNames).toEqual(['image.png', 'image-1.png'])
    })

    it('disambiguates displayName for documents sharing a name in one tool result', () => {
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'two_docs', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [
          new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: new Uint8Array([0x25, 0x50]) } }),
          new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: new Uint8Array([0x25, 0x51]) } }),
        ],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as {
        functionResponse: { parts?: Array<{ inlineData: { displayName: string } }> }
      }
      const displayNames = resultPart.functionResponse.parts!.map((p) => p.inlineData.displayName)
      expect(new Set(displayNames).size).toBe(displayNames.length)
      expect(displayNames).toEqual(['report.pdf', 'report-1.pdf'])
    })

    it('formats document block with bytes source in tool result as inlineData', () => {
      const docBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'read_doc', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } })],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as { functionResponse: { response: unknown; parts?: unknown[] } }
      expect(resultPart.functionResponse.response).toEqual({ output: [] })
      expect(resultPart.functionResponse.parts).toEqual([
        { inlineData: { data: 'JVBERg==', mimeType: 'application/pdf', displayName: 'report.pdf' } },
      ])
    })

    it('formats document block with text source in tool result as inlineData', () => {
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'read_doc', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [new DocumentBlock({ name: 'notes.txt', format: 'txt', source: { text: 'Hello' } })],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as { functionResponse: { response: unknown; parts?: unknown[] } }
      expect(resultPart.functionResponse.response).toEqual({ output: [] })
      expect(resultPart.functionResponse.parts).toEqual([
        { inlineData: { data: 'SGVsbG8=', mimeType: 'text/plain', displayName: 'notes.txt' } },
      ])
    })

    it('skips video block in tool result with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'capture', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [new TextBlock('captured'), new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1]) } })],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as { functionResponse: { response: unknown; parts?: unknown[] } }
      expect(resultPart.functionResponse.response).toEqual({ output: [{ text: 'captured' }] })
      // No parts for video - it's skipped
      expect(resultPart.functionResponse.parts).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('formats mixed text and image content in tool result', () => {
      const imageBytes = new Uint8Array([1, 2])
      const toolUseBlock = new ToolUseBlock({ toolUseId: 'test-id', name: 'analyze', input: {} })
      const toolResultBlock = new ToolResultBlock({
        toolUseId: 'test-id',
        status: 'success',
        content: [
          new TextBlock('Analysis complete'),
          new ImageBlock({ format: 'jpeg', source: { bytes: imageBytes } }),
        ],
      })
      const messages = [
        new Message({ role: 'assistant', content: [toolUseBlock] }),
        new Message({ role: 'user', content: [toolResultBlock] }),
      ]

      const contents = formatMessages(messages)

      const resultPart = contents[1]!.parts![0]! as { functionResponse: { response: unknown; parts?: unknown[] } }
      expect(resultPart.functionResponse.response).toEqual({ output: [{ text: 'Analysis complete' }] })
      expect(resultPart.functionResponse.parts).toEqual([
        { inlineData: { data: 'AQI=', mimeType: 'image/jpeg', displayName: 'image.jpeg' } },
      ])
    })
  })

  describe('tool use streaming', () => {
    function createStreamState(): GoogleStreamState {
      return {
        messageStarted: true,
        textContentBlockStarted: false,
        reasoningContentBlockStarted: false,
        hasToolCalls: false,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }
    }

    it('emits tool use events for function call in response', () => {
      const streamState = createStreamState()
      const chunk = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { id: 'tool-1', name: 'get_weather', args: { city: 'NYC' } } }],
            },
          },
        ],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      expect(events).toEqual([
        {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'tool-1' },
        },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"city":"NYC"}' },
        },
        { type: 'modelContentBlockStopEvent' },
      ])
      expect(streamState.hasToolCalls).toBe(true)
    })

    it('generates tool use ID when Gemini does not provide one', () => {
      const streamState = createStreamState()
      const chunk = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'testTool', args: {} } }],
            },
          },
        ],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      const startEvent = events[0]!
      expect(startEvent.type).toBe('modelContentBlockStartEvent')
      const start = (startEvent as { start: { toolUseId: string } }).start
      expect(start.toolUseId).toMatch(/^tooluse_/)
    })

    it('includes reasoningSignature from thoughtSignature on function call', () => {
      const streamState = createStreamState()
      const chunk = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'tool-1', name: 'testTool', args: {} },
                  thoughtSignature: 'sig-abc',
                },
              ],
            },
          },
        ],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      const startEvent = events[0]!
      const start = (startEvent as { start: { reasoningSignature: string } }).start
      expect(start.reasoningSignature).toBe('sig-abc')
    })

    it('sets stop reason to toolUse when function calls are present', () => {
      const streamState = createStreamState()
      streamState.hasToolCalls = true

      const chunk = {
        candidates: [{ finishReason: 'STOP' }],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      expect(events).toEqual([{ type: 'modelMessageStopEvent', stopReason: 'toolUse' }])
    })

    it.each([
      { blockType: 'reasoning', stateField: 'reasoningContentBlockStarted' as const },
      { blockType: 'text', stateField: 'textContentBlockStarted' as const },
    ])('closes $blockType block before tool use block', ({ stateField }) => {
      const streamState = createStreamState()
      streamState[stateField] = true

      const chunk = {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { id: 'tool-1', name: 'testTool', args: {} } }],
            },
          },
        ],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      expect(events[0]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[1]).toEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'testTool', toolUseId: 'tool-1' },
      })
      expect(streamState[stateField]).toBe(false)
    })

    it('handles multiple function calls in a single response', () => {
      const streamState = createStreamState()
      const chunk = {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { id: 'tool-1', name: 'get_weather', args: { city: 'NYC' } } },
                { functionCall: { id: 'tool-2', name: 'get_time', args: { tz: 'EST' } } },
              ],
            },
          },
        ],
      }

      const events = mapChunkToEvents(chunk as unknown as GenerateContentResponse, streamState)

      // Each function call: start + delta + stop = 3 events, x2 = 6
      expect(events).toHaveLength(6)
      expect(events[0]).toEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'tool-1' },
      })
      expect(events[3]).toEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'get_time', toolUseId: 'tool-2' },
      })
    })

    it('handles full tool use flow via stream method', async () => {
      const { provider, messages } = setupStreamTest(async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { id: 'call-1', name: 'get_weather', args: { city: 'NYC' } } }],
              },
            },
          ],
        }
        yield { candidates: [{ finishReason: 'STOP' }] }
      })

      const events = await collectIterator(provider.stream(messages))

      // messageStart, blockStart (toolUse), delta (toolUseInput), blockStop, messageStop
      expect(events).toHaveLength(5)
      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[1]).toEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'call-1' },
      })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"city":"NYC"}' },
      })
      expect(events[3]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(events[4]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
    })
  })

  describe('countTokens', () => {
    const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock('hello')] })]
    const toolSpecs = [
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' as const, properties: {} } },
    ]

    function createCountTokensClient(mockCountTokens: ReturnType<typeof vi.fn>): GoogleGenAI {
      return {
        models: {
          generateContentStream: vi.fn(),
          countTokens: mockCountTokens,
        },
      } as unknown as GoogleGenAI
    }

    it('should use heuristic by default when useNativeTokenCount is not set', async () => {
      const mockCountTokens = vi.fn()
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash' })

      const result = await model.countTokens(messages)

      expect(mockCountTokens).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })

    it('should return native token count on success', async () => {
      const mockCountTokens = vi.fn(async () => ({ totalTokens: 42 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(result).toBe(42)
      expect(mockCountTokens).toHaveBeenCalledOnce()
    })

    it('should add heuristic estimate for system prompt', async () => {
      const mockCountTokens = vi.fn(async () => ({ totalTokens: 55 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages, { systemPrompt: 'Be helpful.' })

      expect(result).toBeGreaterThan(55) // native (55) + heuristic for system prompt
    })

    it('should add heuristic estimate for tool specs', async () => {
      const mockCountTokens = vi.fn(async () => ({ totalTokens: 100 }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages, { toolSpecs })

      expect(result).toBeGreaterThan(100) // native (100) + heuristic for tools
    })

    it('should fall back on null totalTokens', async () => {
      const mockCountTokens = vi.fn(async () => ({ totalTokens: null }))
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to estimation on API error', async () => {
      const mockCountTokens = vi.fn(async () => {
        throw new Error('Unsupported')
      })
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to estimation on generic exception', async () => {
      const mockCountTokens = vi.fn(async () => {
        throw new Error('Connection failed')
      })
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should skip native API and use heuristic when useNativeTokenCount is false', async () => {
      const mockCountTokens = vi.fn()
      const client = createCountTokensClient(mockCountTokens)
      const model = new GoogleModel({ client, modelId: 'gemini-2.5-flash', useNativeTokenCount: false })

      const result = await model.countTokens(messages)

      expect(mockCountTokens).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })
  })
})
