import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider'
import { APICallError } from '@ai-sdk/provider'
import { VercelModel } from '../vercel.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../errors.js'
import { logger } from '../../logging/logger.js'
import { warnOnce } from '../../logging/warn-once.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock, ReasoningBlock, JsonBlock } from '../../types/messages.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import type { ToolSpec } from '../../tools/types.js'

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

/**
 * Creates a mock LanguageModelV3 that streams the given parts.
 */
function createMockModel(
  parts: LanguageModelV3StreamPart[],
  provider = 'test',
  modelId = 'test-model'
): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async (): Promise<LanguageModelV3StreamResult> => ({
      stream: new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part)
          }
          controller.close()
        },
      }),
    })),
  }
}

/** Standard usage object for finish events */
const testUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, noCache: undefined, text: 5, reasoning: undefined },
}

/** Standard finish reason */
const stopFinish = { unified: 'stop' as const, raw: 'stop' }

/** Minimal stream parts that produce a valid (empty) response */
const minimalParts: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'finish', usage: testUsage, finishReason: stopFinish },
]

/**
 * Creates a model backed by a mock that streams the given parts,
 * collects events, and returns the mock's doStream call args for inspection.
 */
function setupCaptureTest(
  parts: LanguageModelV3StreamPart[] = minimalParts,
  config?: Parameters<typeof VercelModel.prototype.updateConfig>[0],
  provider = 'test',
  modelId = 'test-model'
): {
  model: VercelModel
  mock: LanguageModelV3
  callArgs: () => LanguageModelV3CallOptions
  collect: (messages: Message[], options?: Parameters<VercelModel['stream']>[1]) => ReturnType<typeof collectIterator>
} {
  const mock = createMockModel(parts, provider, modelId)
  const model = new VercelModel({ provider: mock, ...config })
  return {
    model,
    mock,
    callArgs: () => (mock.doStream as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LanguageModelV3CallOptions,
    collect: (messages, options) => collectIterator(model.stream(messages, options)),
  }
}

describe('VercelModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor and config', () => {
    it('uses model.modelId as default and allows override', () => {
      const mock = createMockModel([])
      expect(new VercelModel({ provider: mock }).getConfig().modelId).toBe('test-model')
      expect(new VercelModel({ provider: mock, modelId: 'custom-id' }).getConfig().modelId).toBe('custom-id')
    })

    it('passes through all config fields', () => {
      const mock = createMockModel([])
      const model = new VercelModel({
        provider: mock,
        maxTokens: 100,
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.3,
        stopSequences: ['END'],
        seed: 42,
      })
      expect(model.getConfig()).toStrictEqual({
        modelId: 'test-model',
        maxTokens: 100,
        temperature: 0.5,
        topP: 0.9,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: 0.3,
        stopSequences: ['END'],
        seed: 42,
      })
    })

    it('updateConfig merges config and getConfig returns a copy', () => {
      const mock = createMockModel([])
      const model = new VercelModel({ provider: mock })
      model.updateConfig({ modelId: 'updated', maxTokens: 200 })
      const config1 = model.getConfig()
      const config2 = model.getConfig()
      expect(config1).toStrictEqual({ modelId: 'updated', maxTokens: 200 })
      expect(config1).not.toBe(config2)
    })
  })

  describe('stream', () => {
    describe('text streaming', () => {
      it('emits correct events for simple text response', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hello' },
          { type: 'text-delta', id: 't1', delta: ' world' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))

        expect(events[0]).toMatchObject({ type: 'modelMessageStartEvent', role: 'assistant' })
        expect(events[1]).toMatchObject({ type: 'modelContentBlockStartEvent' })
        expect(events[2]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'Hello' },
        })
        expect(events[3]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: ' world' },
        })
        expect(events[4]).toMatchObject({ type: 'modelContentBlockStopEvent' })
        expect(events[5]).toMatchObject({ type: 'modelMetadataEvent' })
        expect(events[6]).toMatchObject({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
      })
    })

    describe('reasoning streaming', () => {
      it('emits reasoning content delta events', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'Let me think...' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Answer' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))

        const reasoningDelta = events.find(
          (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'reasoningContentDelta'
        )
        expect(reasoningDelta).toMatchObject({
          delta: { type: 'reasoningContentDelta', text: 'Let me think...' },
        })
      })
    })

    describe('tool call streaming', () => {
      it('synthesizes start/delta/stop from complete tool-call part', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'calculator', input: '{"expr":"2+2"}' },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
        ])

        const events = await collectIterator(model.stream([]))

        expect(events[1]).toMatchObject({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'calculator', toolUseId: 'call_1' },
        })
        expect(events[2]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"expr":"2+2"}' },
        })
        expect(events[3]).toMatchObject({ type: 'modelContentBlockStopEvent' })
        expect(events[5]).toMatchObject({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
      })

      it('normalizes object tool-call input to JSON string', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'calculator',
            input: { expr: '2+2' } as unknown as string,
          },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
        ])

        const events = await collectIterator(model.stream([]))

        expect(events[2]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"expr":"2+2"}' },
        })
      })

      it('skips duplicate tool-call when incremental tool-input events were already emitted', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call_1', toolName: 'calculator' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"expr":"2+2"}' },
          { type: 'tool-input-end', id: 'call_1' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'calculator', input: '{"expr":"2+2"}' },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
        ])

        const events = await collectIterator(model.stream([]))

        const toolStarts = events.filter(
          (e) => e.type === 'modelContentBlockStartEvent' && e.start?.type === 'toolUseStart'
        )
        expect(toolStarts).toHaveLength(1)
      })

      it('emits tool use start/delta/stop events', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call_1', toolName: 'calculator' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"expr' },
          { type: 'tool-input-delta', id: 'call_1', delta: '":"2+2"}' },
          { type: 'tool-input-end', id: 'call_1' },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } },
        ])

        const events = await collectIterator(model.stream([]))

        expect(events[1]).toMatchObject({
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'calculator', toolUseId: 'call_1' },
        })
        expect(events[2]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"expr' },
        })
        expect(events[3]).toMatchObject({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '":"2+2"}' },
        })
        expect(events[4]).toMatchObject({ type: 'modelContentBlockStopEvent' })
        expect(events[6]).toMatchObject({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
      })

      // A community provider (e.g. ai-sdk-ollama) can stream tool-call blocks yet report
      // finish_reason "stop". The adapter must decide from the streamed content, promoting the
      // otherwise-endTurn stop reason to toolUse so the agent still executes the tools. See #3185.
      it('promotes endTurn to toolUse when a complete tool-call is streamed with finish_reason stop', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'calculator', input: '{"expr":"2+2"}' },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toMatchObject({ stopReason: 'toolUse' })
      })

      it('promotes endTurn to toolUse when incremental tool-input is streamed with finish_reason stop', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call_1', toolName: 'calculator' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"expr":"2+2"}' },
          { type: 'tool-input-end', id: 'call_1' },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toMatchObject({ stopReason: 'toolUse' })
      })

      // Guard the scoping: promotion is intentionally limited to endTurn, so a genuine truncation
      // that happens to carry a tool block keeps its maxTokens stop reason. See #3185.
      it('does not promote maxTokens to toolUse when a tool-call is streamed', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'calculator', input: '{"expr":"2+2"}' },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'length', raw: 'length' } },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toMatchObject({ stopReason: 'maxTokens' })
      })

      // Provider-executed tool calls were already run by the provider; promoting them would make the
      // agent re-execute or report a missing tool, so they must not drive the endTurn->toolUse promotion.
      it('does not promote endTurn for a provider-executed tool-call with finish_reason stop', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'calculator',
            input: '{"expr":"2+2"}',
            providerExecuted: true,
          },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toMatchObject({ stopReason: 'endTurn' })
      })

      // A malformed stream can open a client tool block and finish without ever closing it (no
      // tool-input-end, no complete tool-call). The aggregator never builds a ToolUseBlock for the
      // half-streamed input, so promoting would hand the agent stopReason toolUse with zero tool
      // blocks — an invariant violation that throws. Only a completed client tool block promotes;
      // a truncated one keeps the endTurn mapping.
      it('does not promote endTurn for a truncated tool block that never completes', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: 'call_1', toolName: 'calculator' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"expr":' },
          { type: 'finish', usage: testUsage, finishReason: stopFinish },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toMatchObject({ stopReason: 'endTurn' })
      })
    })

    describe('finish reasons', () => {
      it.each([
        ['stop', 'endTurn'],
        ['length', 'maxTokens'],
        ['content-filter', 'contentFiltered'],
        ['tool-calls', 'toolUse'],
        ['other', 'endTurn'],
      ] as const)('maps Language Model "%s" to Strands "%s"', async (unified, expected) => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'finish', usage: testUsage, finishReason: { unified, raw: unified } },
        ])

        const events = await collectIterator(model.stream([]))
        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent?.stopReason).toBe(expected)
      })

      it('throws ModelError for error finish reason', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'finish', usage: testUsage, finishReason: { unified: 'error', raw: 'internal_error' } },
        ])

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ModelError)
      })
    })

    describe('usage mapping', () => {
      it('maps usage with cache tokens', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            usage: {
              inputTokens: { total: 100, noCache: 80, cacheRead: 15, cacheWrite: 5 },
              outputTokens: { total: 50, text: 40, reasoning: 10 },
            },
            finishReason: stopFinish,
          },
        ])

        const events = await collectIterator(model.stream([]))
        const metaEvent = events.find((e) => e.type === 'modelMetadataEvent')

        expect(metaEvent?.usage).toEqual({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cacheReadInputTokens: 15,
          cacheWriteInputTokens: 5,
        })
      })

      it('handles undefined token counts', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          {
            type: 'finish',
            usage: {
              inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
            finishReason: stopFinish,
          },
        ])

        const events = await collectIterator(model.stream([]))
        const metaEvent = events.find((e) => e.type === 'modelMetadataEvent')

        expect(metaEvent?.usage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        })
      })
    })

    describe('error handling', () => {
      it('throws ModelError on stream error part', async () => {
        const { model } = setupCaptureTest([
          { type: 'stream-start', warnings: [] },
          { type: 'error', error: new Error('rate limit exceeded') },
        ])

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ModelError)
      })

      it('throws ModelError when doStream fails with generic error', async () => {
        const { mock, model } = setupCaptureTest()
        ;(mock.doStream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection failed'))

        await expect(collectIterator(model.stream([]))).rejects.toThrow(
          'Language model stream error: connection failed'
        )
      })

      it('throws ModelThrottledError for APICallError with status 429', async () => {
        const { mock, model } = setupCaptureTest()
        ;(mock.doStream as ReturnType<typeof vi.fn>).mockRejectedValue(
          new APICallError({
            message: 'Too many requests',
            url: 'https://api.example.com',
            requestBodyValues: {},
            statusCode: 429,
          })
        )

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ModelThrottledError)
      })

      it('throws ContextWindowOverflowError for APICallError with context overflow in responseBody', async () => {
        const { mock, model } = setupCaptureTest()
        ;(mock.doStream as ReturnType<typeof vi.fn>).mockRejectedValue(
          new APICallError({
            message: 'Bad request',
            url: 'https://api.example.com',
            requestBodyValues: {},
            statusCode: 400,
            responseBody: 'Input is too long for requested model',
          })
        )

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ContextWindowOverflowError)
      })

      it('throws ContextWindowOverflowError for non-APICallError with context overflow message', async () => {
        const { mock, model } = setupCaptureTest()
        ;(mock.doStream as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('context_length_exceeded: maximum context length is 128000')
        )

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ContextWindowOverflowError)
      })

      it('classifies errors thrown during reader.read()', async () => {
        const mock = createMockModel([])
        ;(mock.doStream as ReturnType<typeof vi.fn>).mockResolvedValue({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] })
              controller.error(
                new APICallError({
                  message: 'Too many requests',
                  url: 'https://api.example.com',
                  requestBodyValues: {},
                  statusCode: 429,
                })
              )
            },
          }),
        })
        const model = new VercelModel({ provider: mock })

        await expect(collectIterator(model.stream([]))).rejects.toThrow(ModelThrottledError)
      })
    })

    describe('call options forwarding', () => {
      it('forwards config to doStream', async () => {
        const { collect, callArgs } = setupCaptureTest(minimalParts, {
          maxTokens: 100,
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3,
          stopSequences: ['END'],
          seed: 42,
        })
        await collect([])

        expect(callArgs()).toMatchObject({
          maxOutputTokens: 100,
          temperature: 0.7,
          topP: 0.95,
          topK: 40,
          presencePenalty: 0.5,
          frequencyPenalty: 0.3,
          stopSequences: ['END'],
          seed: 42,
        })
      })

      it('omits undefined config values', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([])

        const args = callArgs()
        for (const key of [
          'maxOutputTokens',
          'temperature',
          'topP',
          'topK',
          'presencePenalty',
          'frequencyPenalty',
          'stopSequences',
          'seed',
        ]) {
          expect(args).not.toHaveProperty(key)
        }
      })
    })

    it('logs response-metadata at debug level', async () => {
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
      const { model } = setupCaptureTest([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hi' },
        { type: 'text-end', id: 't1' },
        { type: 'response-metadata', id: 'resp1', timestamp: new Date() } as any,
        { type: 'finish', usage: testUsage, finishReason: stopFinish },
      ])

      const events = await collectIterator(model.stream([]))
      expect(events.map((e) => e.type)).not.toContain('response-metadata')
      expect(debugSpy).toHaveBeenCalled()
      debugSpy.mockRestore()
    })
  })

  describe('message formatting', () => {
    describe('system prompt', () => {
      it('formats string system prompt', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([], { systemPrompt: 'You are helpful.' })

        expect(callArgs().prompt[0]).toEqual({ role: 'system', content: 'You are helpful.' })
      })

      it('formats system prompt content blocks', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([], { systemPrompt: [{ text: 'Part 1' }, { text: 'Part 2' }] as any })

        expect(callArgs().prompt[0]).toEqual({ role: 'system', content: 'Part 1Part 2' })
      })

      it('ignores cache points in system prompt', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { collect, callArgs } = setupCaptureTest()
        await collect([], {
          systemPrompt: [
            { type: 'textBlock', text: 'Hello' },
            { type: 'cachePointBlock', cacheType: 'default' },
          ] as any,
        })

        expect(callArgs().prompt[0]).toEqual({ role: 'system', content: 'Hello' })
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })

      it('ignores guard content in system prompt', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { collect, callArgs } = setupCaptureTest()
        await collect([], {
          systemPrompt: [
            { type: 'textBlock', text: 'Hello' },
            { type: 'guardContentBlock', guardContent: {} },
          ] as any,
        })

        expect(callArgs().prompt[0]).toEqual({ role: 'system', content: 'Hello' })
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })

    describe('user messages', () => {
      it('formats user text message', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([new Message({ role: 'user', content: [new TextBlock('Hello')] })])

        const userMsg = callArgs().prompt[0] as any
        expect(userMsg.role).toBe('user')
        expect(userMsg.content[0]).toEqual({ type: 'text', text: 'Hello' })
      })

      it('formats image blocks with bytes and URL sources', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'user',
            content: [
              new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
              new ImageBlock({ format: 'png', source: { url: 'https://example.com/image.png' } }),
            ],
          }),
        ])

        const userMsg = callArgs().prompt[0] as any
        expect(userMsg.content[0]).toMatchObject({ type: 'file', mediaType: 'image/png' })
        expect(userMsg.content[0].data).toBeInstanceOf(Uint8Array)
        expect(userMsg.content[1]).toMatchObject({ type: 'file', mediaType: 'image/png' })
        expect(userMsg.content[1].data).toBeInstanceOf(URL)
        expect(userMsg.content[1].data.href).toBe('https://example.com/image.png')
      })

      it('formats document content block source as text parts', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'user',
            content: [
              new DocumentBlock({
                format: 'txt',
                name: 'doc',
                source: { content: [{ text: 'paragraph 1' }, { text: 'paragraph 2' }] },
              }),
            ],
          }),
        ])

        const userMsg = callArgs().prompt[0] as any
        expect(userMsg.content).toHaveLength(2)
        expect(userMsg.content[0]).toEqual({ type: 'text', text: 'paragraph 1' })
        expect(userMsg.content[1]).toEqual({ type: 'text', text: 'paragraph 2' })
      })

      it('formats video bytes in user messages', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'user',
            content: [new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1, 2]) } })],
          }),
        ])

        const userMsg = callArgs().prompt[0] as any
        expect(userMsg.content[0]).toMatchObject({ type: 'file', mediaType: 'video/mp4' })
      })

      it.each([
        {
          name: 'image S3 source',
          block: new ImageBlock({
            format: 'png',
            source: { location: { type: 's3', uri: 's3://bucket/key', bucketOwner: '' } },
          }),
        },
        {
          name: 'video S3 source',
          block: new VideoBlock({
            format: 'mp4',
            source: { location: { type: 's3', uri: 's3://bucket/video', bucketOwner: '' } },
          }),
        },
      ])('skips unsupported $name', async ({ block }) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { collect, callArgs } = setupCaptureTest()
        await collect([new Message({ role: 'user', content: [block] })])

        expect(callArgs().prompt).toHaveLength(0)
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })

      // Regression: an everyTurn context injector folds rendered text onto a tool-result turn, making a
      // mixed turn. Tool results must lead the split regardless of source-block order so each one stays
      // adjacent to the assistant tool call it answers once an adapter re-merges the messages (#4138).
      it.each([
        { name: 'tool result then text', order: ['tu1', 'text'], roles: ['user', 'assistant', 'tool', 'user'] },
        { name: 'text then tool result', order: ['text', 'tu1'], roles: ['user', 'assistant', 'tool', 'user'] },
        {
          name: 'text between parallel tool results',
          order: ['tu1', 'text', 'tu2'],
          roles: ['user', 'assistant', 'tool', 'tool', 'user'],
        },
      ])('keeps tool results ahead of injected text for $name', async ({ order, roles }) => {
        const toolUseIds = order.filter((entry) => entry !== 'text')
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({ role: 'user', content: [new TextBlock('task')] }),
          new Message({
            role: 'assistant',
            content: toolUseIds.map((toolUseId) => new ToolUseBlock({ name: 'calc', toolUseId, input: {} })),
          }),
          new Message({
            role: 'user',
            content: order.map((entry) =>
              entry === 'text'
                ? new TextBlock('\n\nNOTE')
                : new ToolResultBlock({ toolUseId: entry, status: 'success', content: [new TextBlock('42')] })
            ),
          }),
        ])

        const prompt = callArgs().prompt
        expect(prompt.map((message) => message.role)).toEqual(roles)
        expect((prompt[2] as any).content[0]).toMatchObject({
          type: 'tool-result',
          toolCallId: 'tu1',
          toolName: 'calc',
        })
        expect((prompt.at(-1) as any).content[0]).toEqual({ type: 'text', text: '\n\nNOTE' })
      })
    })

    describe('assistant messages', () => {
      it('formats text and tool use blocks', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'assistant',
            content: [
              new TextBlock('Let me calculate'),
              new ToolUseBlock({ name: 'calc', toolUseId: 'tu1', input: { x: 1 } }),
            ],
          }),
        ])

        const prompt = callArgs().prompt
        expect(prompt).toHaveLength(1)
        const assistantMsg = prompt[0] as any
        expect(assistantMsg.role).toBe('assistant')
        expect(assistantMsg.content).toHaveLength(2)
        expect(assistantMsg.content[0]).toEqual({ type: 'text', text: 'Let me calculate' })
        expect(assistantMsg.content[1].type).toBe('tool-call')
        expect(assistantMsg.content[1].toolCallId).toBe('tu1')
      })

      it('formats reasoning blocks', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'assistant',
            content: [new ReasoningBlock({ text: 'thinking...' })],
          }),
        ])

        const assistantMsg = callArgs().prompt[0] as any
        expect(assistantMsg.content[0]).toEqual({ type: 'reasoning', text: 'thinking...' })
      })

      it('warns and skips tool results in assistant messages', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const { collect, callArgs } = setupCaptureTest()
        await collect([
          new Message({
            role: 'assistant',
            content: [
              new ToolUseBlock({ name: 'calc', toolUseId: 'tu1', input: {} }),
              new ToolResultBlock({ toolUseId: 'tu1', status: 'success', content: [new TextBlock('42')] }),
            ],
          }),
        ])

        const prompt = callArgs().prompt
        expect(prompt).toHaveLength(1)
        const assistantMsg = prompt[0] as any
        expect(assistantMsg.content).toHaveLength(1)
        expect(assistantMsg.content[0].type).toBe('tool-call')
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })

      it('handles assistant message with no tool results', async () => {
        const { collect, callArgs } = setupCaptureTest()
        await collect([new Message({ role: 'assistant', content: [new TextBlock('Just text')] })])

        const prompt = callArgs().prompt
        expect(prompt).toHaveLength(1)
        expect((prompt[0] as any).role).toBe('assistant')
      })
    })
    describe('tool result output formatting', () => {
      function toolResultMessages(
        content: ToolResultBlock['content'],
        status: 'success' | 'error' = 'success'
      ): Message[] {
        return [
          new Message({
            role: 'assistant',
            content: [new ToolUseBlock({ name: 'tool', toolUseId: 'tu1', input: {} })],
          }),
          new Message({
            role: 'user',
            content: [new ToolResultBlock({ toolUseId: 'tu1', status, content })],
          }),
        ]
      }

      async function getToolOutput(content: ToolResultBlock['content'], status?: 'success' | 'error'): Promise<any> {
        const { collect, callArgs } = setupCaptureTest()
        await collect(toolResultMessages(content, status))
        return (callArgs().prompt.find((m: any) => m.role === 'tool') as any).content[0].output
      }

      it('formats error status with text and fallback', async () => {
        expect(await getToolOutput([new TextBlock('boom')], 'error')).toStrictEqual({
          type: 'error-text',
          value: 'boom',
        })
        expect(await getToolOutput([], 'error')).toStrictEqual({
          type: 'error-text',
          value: 'Tool execution failed',
        })
      })

      it.each([
        { name: 'text', content: [new TextBlock('result')], expected: [{ type: 'text', text: 'result' }] },
        {
          name: 'json',
          content: [new JsonBlock({ json: { k: 'v' } })],
          expected: [{ type: 'text', text: '{"k":"v"}' }],
        },
        {
          name: 'image URL',
          content: [new ImageBlock({ format: 'png', source: { url: 'https://example.com/img.png' } })],
          expected: [{ type: 'text', text: 'https://example.com/img.png' }],
        },
        {
          name: 'document text',
          content: [new DocumentBlock({ format: 'txt', name: 'd', source: { text: 'doc' } })],
          expected: [{ type: 'text', text: 'doc' }],
        },
        {
          name: 'document content blocks',
          content: [
            new DocumentBlock({ format: 'txt', name: 'd', source: { content: [{ text: 'p1' }, { text: 'p2' }] } }),
          ],
          expected: [
            { type: 'text', text: 'p1' },
            { type: 'text', text: 'p2' },
          ],
        },
      ])('formats $name content as text', async ({ content, expected }) => {
        expect(await getToolOutput(content)).toStrictEqual({ type: 'content', value: expected })
      })

      it.each([
        {
          name: 'image bytes',
          content: new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } }),
          mediaType: 'image/png',
        },
        {
          name: 'document bytes',
          content: new DocumentBlock({ format: 'pdf', name: 'd', source: { bytes: new Uint8Array([1]) } }),
          mediaType: 'application/pdf',
        },
        {
          name: 'video bytes',
          content: new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1]) } }),
          mediaType: 'video/mp4',
        },
      ])('formats $name as file-data', async ({ content, mediaType }) => {
        const output = await getToolOutput([content])
        expect(output.value[0]).toMatchObject({ type: 'file-data', mediaType })
      })

      it.each([
        {
          name: 'image S3',
          block: new ImageBlock({
            format: 'png',
            source: { location: { type: 's3', uri: 's3://b/k', bucketOwner: '' } },
          }),
        },
        {
          name: 'document S3',
          block: new DocumentBlock({
            format: 'pdf',
            name: 'd',
            source: { location: { type: 's3', uri: 's3://b/k', bucketOwner: '' } },
          } as any),
        },
        {
          name: 'video S3',
          block: new VideoBlock({
            format: 'mp4',
            source: { location: { type: 's3', uri: 's3://b/k', bucketOwner: '' } },
          }),
        },
      ])('warns on unsupported $name source', async ({ block }) => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await getToolOutput([block])
        expect(warnSpy).toHaveBeenCalled()
        warnSpy.mockRestore()
      })
    })
  })

  describe('tool formatting', () => {
    it('formats tool specs', async () => {
      const tools: ToolSpec[] = [
        {
          name: 'calculator',
          description: 'Does math',
          inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
        },
      ]

      const { collect, callArgs } = setupCaptureTest()
      await collect([], { toolSpecs: tools })

      expect(callArgs().tools![0]).toMatchObject({
        type: 'function',
        name: 'calculator',
        description: 'Does math',
      })
    })

    it('handles tool spec with no inputSchema', async () => {
      const tools: ToolSpec[] = [{ name: 'noop', description: 'Does nothing' }]

      const { collect, callArgs } = setupCaptureTest()
      await collect([], { toolSpecs: tools })

      const tool = callArgs().tools![0]!
      expect(tool.type).toBe('function')
      if (tool.type === 'function') {
        expect(tool.inputSchema).toEqual({ type: 'object', properties: {} })
      }
    })

    it.each([
      { name: 'auto', input: { auto: {} }, expected: { type: 'auto' } },
      { name: 'any -> required', input: { any: {} }, expected: { type: 'required' } },
      { name: 'specific tool', input: { tool: { name: 'calc' } }, expected: { type: 'tool', toolName: 'calc' } },
    ])('maps toolChoice $name', async ({ input, expected }) => {
      const { collect, callArgs } = setupCaptureTest()
      await collect([], { toolChoice: input })

      expect(callArgs().toolChoice).toEqual(expected)
    })

    it('omits tools when not provided', async () => {
      const { collect, callArgs } = setupCaptureTest()
      await collect([])

      const args = callArgs()
      expect(args).not.toHaveProperty('tools')
      expect(args).not.toHaveProperty('toolChoice')
    })
  })

  describe('prompt caching', () => {
    const userMessages = [new Message({ role: 'user', content: [new TextBlock('durable prefix')] })]
    const toolSpecs: ToolSpec[] = [{ name: 'calculator', description: 'Calculate', inputSchema: { type: 'object' } }]

    /** cacheControl on the last function tool. */
    const toolCacheControl = (args: LanguageModelV3CallOptions): unknown => {
      const tools = args.tools ?? []
      for (let index = tools.length - 1; index >= 0; index--) {
        const tool = tools[index]
        if (tool?.type === 'function') return tool.providerOptions?.anthropic?.cacheControl
      }
      return undefined
    }

    /** cacheControl on the last content part of the last user message. */
    const messageCacheControl = (args: LanguageModelV3CallOptions): unknown => {
      const lastUser = [...args.prompt].reverse().find((message) => message.role === 'user')
      if (lastUser?.role !== 'user') return undefined
      const lastPart = lastUser.content[lastUser.content.length - 1]
      return lastPart?.providerOptions?.anthropic?.cacheControl
    }

    /** cacheControl on the system message. */
    const systemCacheControl = (args: LanguageModelV3CallOptions): unknown => {
      const system = args.prompt.find((message) => message.role === 'system')
      return system?.providerOptions?.anthropic?.cacheControl
    }

    it('strips cacheConfig from downstream call settings', async () => {
      const { collect, callArgs } = setupCaptureTest(minimalParts, { cacheConfig: { ttl: '1h' } }, 'anthropic.messages')
      await collect(userMessages)

      expect(callArgs()).not.toHaveProperty('cacheConfig')
    })

    it('adds no cache markers when cacheConfig is unset', async () => {
      const { collect, callArgs } = setupCaptureTest(minimalParts, undefined, 'anthropic.messages')
      await collect(userMessages, { toolSpecs })

      const args = callArgs()
      expect(toolCacheControl(args)).toBeUndefined()
      expect(messageCacheControl(args)).toBeUndefined()
    })

    describe('anthropic underlying provider', () => {
      it('caches the last tool, the system prompt, and the last user message by default', async () => {
        const { collect, callArgs } = setupCaptureTest(minimalParts, { cacheConfig: {} }, 'anthropic.messages')
        await collect(userMessages, { toolSpecs, systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(toolCacheControl(args)).toEqual({ type: 'ephemeral' })
        expect(systemCacheControl(args)).toEqual({ type: 'ephemeral' })
        expect(messageCacheControl(args)).toEqual({ type: 'ephemeral' })
      })

      it('carries a shared ttl onto every section', async () => {
        const { collect, callArgs } = setupCaptureTest(
          minimalParts,
          { cacheConfig: { ttl: '1h' } },
          'anthropic.messages'
        )
        await collect(userMessages, { toolSpecs, systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(toolCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '1h' })
        expect(systemCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '1h' })
        expect(messageCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '1h' })
      })

      it('lets a per-section ttl override the shared ttl', async () => {
        const config = { cacheConfig: { ttl: '1h', messagesTTL: '5m' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages, { toolSpecs })

        const args = callArgs()
        expect(toolCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '1h' })
        expect(messageCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '5m' })
      })

      it('disables a section set to false', async () => {
        const config = { cacheConfig: { ttl: '1h', toolsTTL: false as const, messagesTTL: false as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages, { toolSpecs })

        const args = callArgs()
        expect(toolCacheControl(args)).toBeUndefined()
        expect(messageCacheControl(args)).toBeUndefined()
      })

      it('adds cacheControl to the user message without disturbing call-level provider options', async () => {
        const config = {
          cacheConfig: { messagesTTL: '1h' as const },
          providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
        }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages)

        const args = callArgs()
        expect(args.providerOptions?.anthropic).toEqual({ thinking: { type: 'enabled' } })
        expect(messageCacheControl(args)).toEqual({ type: 'ephemeral', ttl: '1h' })
      })

      it('ignores cacheKey for the content-addressed anthropic provider', async () => {
        const config = { cacheConfig: { cacheKey: 'tenant-42' } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai).toBeUndefined()
        expect(messageCacheControl(callArgs())).toEqual({ type: 'ephemeral' })
      })

      it('disables caching and warns once on an unknown strategy', async () => {
        const config = { cacheConfig: { strategy: 'bogus' as unknown as 'auto' } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages, { toolSpecs })

        expect(toolCacheControl(callArgs())).toBeUndefined()
        expect(messageCacheControl(callArgs())).toBeUndefined()
        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('unknown cache strategy')
        )
      })

      it('keeps the breakpoint ahead of the trailing blocks a context injector rebuilds each call', async () => {
        const injected = [
          new Message({
            role: 'user',
            content: [new TextBlock('durable prefix'), new TextBlock('<now>2026-01-01</now>')],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(injected, { dynamicTrailingBlocks: 1 })

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content[0]?.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
        expect(lastUser.content[1]?.providerOptions?.anthropic?.cacheControl).toBeUndefined()
      })

      it('skips the conversation breakpoint when every content block is rebuilt each call', async () => {
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages, { dynamicTrailingBlocks: 1 })

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content.every((part) => part.providerOptions?.anthropic?.cacheControl === undefined)).toBe(true)
      })

      it('applies markers for an explicit anthropic strategy without warning', async () => {
        const config = { cacheConfig: { strategy: 'anthropic' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(userMessages, { toolSpecs, systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(toolCacheControl(args)).toEqual({ type: 'ephemeral' })
        expect(systemCacheControl(args)).toEqual({ type: 'ephemeral' })
        expect(messageCacheControl(args)).toEqual({ type: 'ephemeral' })
        expect(warnOnce).not.toHaveBeenCalled()
      })

      it('caches the last durable content part, not the first, by default', async () => {
        const twoDurableParts = [
          new Message({ role: 'user', content: [new TextBlock('durable one'), new TextBlock('durable two')] }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'anthropic.messages')
        await collect(twoDurableParts)

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content[0]?.providerOptions?.anthropic?.cacheControl).toBeUndefined()
        expect(lastUser.content[1]?.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral', ttl: '1h' })
      })
    })

    describe('openai underlying provider', () => {
      it.each(['openai.chat', 'openai.responses'])('maps cacheKey to promptCacheKey for %s', async (provider) => {
        const config = { cacheConfig: { cacheKey: 'tenant-42' } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, provider)
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheKey).toBe('tenant-42')
      })

      it('omits the openai namespace entirely when nothing maps onto it', async () => {
        const { collect, callArgs } = setupCaptureTest(minimalParts, { cacheConfig: {} }, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai).toBeUndefined()
      })

      it('lets an explicit promptCacheKey in providerOptions win over cacheConfig', async () => {
        const config = {
          cacheConfig: { cacheKey: 'from-config' },
          providerOptions: { openai: { promptCacheKey: 'explicit' } },
        }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheKey).toBe('explicit')
      })

      it.each(['24h', 'in_memory'])('maps retention-literal ttl %s to promptCacheRetention', async (ttl) => {
        const { collect, callArgs } = setupCaptureTest(minimalParts, { cacheConfig: { ttl } }, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheRetention).toBe(ttl)
      })

      it('ignores a non-retention ttl and warns once', async () => {
        const { collect, callArgs } = setupCaptureTest(minimalParts, { cacheConfig: { ttl: '5m' } }, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheRetention).toBeUndefined()
        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('ttl=<5m> | cacheConfig.ttl is not an openai retention value')
        )
      })

      it('lets an explicit promptCacheRetention in providerOptions win over cacheConfig', async () => {
        const config = {
          cacheConfig: { ttl: 'in_memory' as const },
          providerOptions: { openai: { promptCacheRetention: '24h' } },
        }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheRetention).toBe('24h')
      })

      it('does not warn about an unsupported ttl when an explicit promptCacheRetention already wins', async () => {
        const config = {
          cacheConfig: { ttl: '5m' },
          providerOptions: { openai: { promptCacheRetention: '24h' } },
        }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'openai.chat')
        await collect(userMessages)

        expect(callArgs().providerOptions?.openai?.promptCacheRetention).toBe('24h')
        expect(warnOnce).not.toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('not an openai retention value')
        )
      })

      it('warns once that placement fields have no effect', async () => {
        const config = { cacheConfig: { strategy: 'anthropic' as const, toolsTTL: '1h' as const, cacheKey: 'k' } }
        const { collect } = setupCaptureTest(minimalParts, config, 'openai.chat')
        await collect(userMessages)

        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('have no effect')
        )
      })
    })

    describe('bedrock underlying provider', () => {
      // A Bedrock model id the default 'auto' strategy recognizes as caching-capable, and one it does not.
      const CACHING_MODEL_ID = 'anthropic.claude-sonnet-4-20250514-v1:0'
      const UNSUPPORTED_MODEL_ID = 'meta.llama3-70b-instruct-v1:0'

      /** cachePoint on the system message. */
      const bedrockSystemCachePoint = (args: LanguageModelV3CallOptions): unknown => {
        const system = args.prompt.find((message) => message.role === 'system')
        return system?.providerOptions?.bedrock?.cachePoint
      }

      /** cachePoint on the last content part of the last user message. */
      const bedrockMessageCachePoint = (args: LanguageModelV3CallOptions): unknown => {
        const lastUser = [...args.prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') return undefined
        const lastPart = lastUser.content[lastUser.content.length - 1]
        return lastPart?.providerOptions?.bedrock?.cachePoint
      }

      /** cachePoint on any function tool. */
      const bedrockToolCachePoint = (args: LanguageModelV3CallOptions): unknown => {
        for (const tool of args.tools ?? []) {
          if (tool.type === 'function' && tool.providerOptions?.bedrock?.cachePoint !== undefined) {
            return tool.providerOptions.bedrock.cachePoint
          }
        }
        return undefined
      }

      it('caches the system prompt and the last user message by default', async () => {
        const { collect, callArgs } = setupCaptureTest(
          minimalParts,
          { cacheConfig: {} },
          'amazon-bedrock',
          CACHING_MODEL_ID
        )
        await collect(userMessages, { toolSpecs, systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(bedrockSystemCachePoint(args)).toEqual({ type: 'default' })
        expect(bedrockMessageCachePoint(args)).toEqual({ type: 'default' })
      })

      it('carries a shared ttl onto system and messages', async () => {
        const { collect, callArgs } = setupCaptureTest(
          minimalParts,
          { cacheConfig: { ttl: '1h' } },
          'amazon-bedrock',
          CACHING_MODEL_ID
        )
        await collect(userMessages, { systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(bedrockSystemCachePoint(args)).toEqual({ type: 'default', ttl: '1h' })
        expect(bedrockMessageCachePoint(args)).toEqual({ type: 'default', ttl: '1h' })
      })

      it('never marks tool definitions, since bedrock caches them as part of the prefix', async () => {
        const config = { cacheConfig: { toolsTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { toolSpecs })

        expect(bedrockToolCachePoint(callArgs())).toBeUndefined()
      })

      it('warns once that a configured toolsTTL has no effect, naming the value', async () => {
        const config = { cacheConfig: { toolsTTL: '1h' as const } }
        const { collect } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { toolSpecs })

        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('toolsTTL=<1h> | toolsTTL has no effect on the amazon-bedrock vercel adapter')
        )
      })

      // toolsTTL:false reads as "do not cache tools", but tools ride the system/messages prefix
      // regardless, so the request cannot honor it — warn rather than silently invert the intent.
      it('warns that toolsTTL:false cannot opt tools out of prefix caching', async () => {
        const config = { cacheConfig: { toolsTTL: false as const } }
        const { collect } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { toolSpecs })

        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('toolsTTL=<false> | toolsTTL has no effect on the amazon-bedrock vercel adapter')
        )
      })

      it('does not warn when toolsTTL is left at its enabled default', async () => {
        const config = { cacheConfig: { toolsTTL: true as const } }
        const { collect } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { toolSpecs })

        expect(warnOnce).not.toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('toolsTTL has no effect')
        )
      })

      it('does not warn when toolsTTL is unset', async () => {
        const { collect } = setupCaptureTest(minimalParts, { cacheConfig: {} }, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { toolSpecs })

        expect(warnOnce).not.toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('toolsTTL has no effect')
        )
      })

      it('disables a section set to false', async () => {
        const config = { cacheConfig: { ttl: '1h', systemPromptTTL: false as const, messagesTTL: false as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(bedrockSystemCachePoint(args)).toBeUndefined()
        expect(bedrockMessageCachePoint(args)).toBeUndefined()
      })

      it('leaves call-level provider options untouched', async () => {
        const config = {
          cacheConfig: { messagesTTL: '1h' as const },
          providerOptions: { bedrock: { reasoningConfig: { type: 'enabled' } } },
        }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages)

        const args = callArgs()
        expect(args.providerOptions?.bedrock).toEqual({ reasoningConfig: { type: 'enabled' } })
        expect(bedrockMessageCachePoint(args)).toEqual({ type: 'default', ttl: '1h' })
      })

      it('places the cache point before a trailing non-pdf document bedrock would reject', async () => {
        const withDocument = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('durable prefix'),
              new DocumentBlock({ format: 'csv', name: 'data', source: { bytes: new Uint8Array([1, 2, 3]) } }),
            ],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(withDocument)

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        const textPart = lastUser.content.find((part) => part.type === 'text')
        const documentPart = lastUser.content.find((part) => part.type === 'file')
        expect(textPart?.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default', ttl: '1h' })
        expect(documentPart?.providerOptions?.bedrock?.cachePoint).toBeUndefined()
      })

      it('skips the cache point when the last user message is only non-pdf documents', async () => {
        const documentsOnly = [
          new Message({
            role: 'user',
            content: [new DocumentBlock({ format: 'csv', name: 'data', source: { bytes: new Uint8Array([1, 2, 3]) } })],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(documentsOnly)

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content.every((part) => part.providerOptions?.bedrock?.cachePoint === undefined)).toBe(true)
      })

      it('rides the conversation cache point onto an earlier user turn when the final turn is tool results only', async () => {
        const toolResultsOnly = [
          new Message({ role: 'user', content: [new TextBlock('durable prefix')] }),
          new Message({
            role: 'assistant',
            content: [new ToolUseBlock({ name: 'calculator', toolUseId: 'tu1', input: {} })],
          }),
          new Message({
            role: 'user',
            content: [new ToolResultBlock({ toolUseId: 'tu1', status: 'success', content: [new TextBlock('42')] })],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(toolResultsOnly)

        const args = callArgs()
        // The tool-results turn emits no user message, so the breakpoint rides the earlier user turn.
        expect(args.prompt.filter((message) => message.role === 'user')).toHaveLength(1)
        expect(bedrockMessageCachePoint(args)).toEqual({ type: 'default', ttl: '1h' })
      })

      it('keeps the cache point ahead of the trailing blocks a context injector rebuilds each call', async () => {
        const injected = [
          new Message({
            role: 'user',
            content: [new TextBlock('durable prefix'), new TextBlock('<now>2026-01-01</now>')],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(injected, { dynamicTrailingBlocks: 1 })

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content[0]?.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default', ttl: '1h' })
        expect(lastUser.content[1]?.providerOptions?.bedrock?.cachePoint).toBeUndefined()
      })

      it('disables caching and warns once on an unknown strategy', async () => {
        const config = { cacheConfig: { strategy: 'bogus' as unknown as 'auto' } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(bedrockSystemCachePoint(args)).toBeUndefined()
        expect(bedrockMessageCachePoint(args)).toBeUndefined()
        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('unknown cache strategy')
        )
      })

      it('caches the last durable content part, not the first, by default', async () => {
        const twoDurableParts = [
          new Message({ role: 'user', content: [new TextBlock('durable one'), new TextBlock('durable two')] }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(twoDurableParts)

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content[0]?.providerOptions?.bedrock?.cachePoint).toBeUndefined()
        expect(lastUser.content[1]?.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default', ttl: '1h' })
      })

      it('places the cache point on a trailing pdf document, which bedrock accepts', async () => {
        const withPdf = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('durable prefix'),
              new DocumentBlock({ format: 'pdf', name: 'doc', source: { bytes: new Uint8Array([1, 2, 3]) } }),
            ],
          }),
        ]
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(withPdf)

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        const textPart = lastUser.content.find((part) => part.type === 'text')
        const documentPart = lastUser.content.find((part) => part.type === 'file')
        expect(textPart?.providerOptions?.bedrock?.cachePoint).toBeUndefined()
        expect(documentPart?.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default', ttl: '1h' })
      })

      it('skips the cache point when every content block is rebuilt each call', async () => {
        const config = { cacheConfig: { messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', CACHING_MODEL_ID)
        await collect(userMessages, { dynamicTrailingBlocks: 1 })

        const lastUser = [...callArgs().prompt].reverse().find((message) => message.role === 'user')
        if (lastUser?.role !== 'user') throw new Error('expected a user message')
        expect(lastUser.content.every((part) => part.providerOptions?.bedrock?.cachePoint === undefined)).toBe(true)
      })

      it('under the default auto strategy, skips and warns for a model without caching support', async () => {
        const config = { cacheConfig: {} }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', UNSUPPORTED_MODEL_ID)
        await collect(userMessages, { systemPrompt: 'be helpful' })

        const args = callArgs()
        expect(bedrockSystemCachePoint(args)).toBeUndefined()
        expect(bedrockMessageCachePoint(args)).toBeUndefined()
        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('does not support automatic caching')
        )
      })

      it('caches on an unsupported model when the anthropic strategy is explicit', async () => {
        const config = { cacheConfig: { strategy: 'anthropic' as const, messagesTTL: '1h' as const } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, 'amazon-bedrock', UNSUPPORTED_MODEL_ID)
        await collect(userMessages)

        expect(bedrockMessageCachePoint(callArgs())).toEqual({ type: 'default', ttl: '1h' })
      })
    })

    describe('unsupported underlying provider', () => {
      it.each(['google.generative-ai', 'mistral.chat'])('warns once and adds no markers for %s', async (provider) => {
        const config = { cacheConfig: { ttl: '1h', cacheKey: 'k' } }
        const { collect, callArgs } = setupCaptureTest(minimalParts, config, provider)
        await collect(userMessages, { toolSpecs })

        const args = callArgs()
        expect(toolCacheControl(args)).toBeUndefined()
        expect(messageCacheControl(args)).toBeUndefined()
        expect(args.providerOptions?.openai).toBeUndefined()
        expect(warnOnce).toHaveBeenCalledWith(
          expect.objectContaining({ warn: expect.any(Function) }),
          expect.stringContaining('not supported for this vercel provider')
        )
      })
    })
  })
})
