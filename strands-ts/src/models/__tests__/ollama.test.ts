import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Ollama, type ChatResponse } from 'ollama'
import { OllamaModel } from '../ollama.js'
import { ContextWindowOverflowError } from '../../errors.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock, JsonBlock, ReasoningBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'
import type { ToolSpec } from '../../tools/types.js'
import { warnOnce } from '../../logging/warn-once.js'
import { logger } from '../../logging/logger.js'

type MockResponse = { abort: ReturnType<typeof vi.fn> } & AsyncIterable<ChatResponse>

/** A mock streaming response that yields the given chunks and records aborts. */
function makeResponse(chunks: Partial<ChatResponse>[]): MockResponse {
  return {
    abort: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk as ChatResponse
    },
  }
}

/** A mock Ollama client whose `chat` returns the given response. */
function createMockClient(response: MockResponse): Ollama {
  return { chat: vi.fn(async () => response) } as unknown as Ollama
}

const userMessage = (text: string): Message[] => [new Message({ role: 'user', content: [new TextBlock(text)] })]

vi.mock('ollama', () => ({
  Ollama: vi.fn(function () {
    return { chat: vi.fn() }
  }),
}))

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

describe('OllamaModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('uses the default model ID when none is provided', () => {
      const provider = new OllamaModel()
      expect(provider.getConfig().modelId).toBe('llama3.1')
    })

    it('uses the provided model ID', () => {
      const provider = new OllamaModel({ modelId: 'mistral' })
      expect(provider.getConfig().modelId).toBe('mistral')
    })

    it('warns when modelId is not explicitly set', () => {
      new OllamaModel()
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('does not warn when modelId is explicitly set', () => {
      new OllamaModel({ modelId: 'llama3.1' })
      expect(warnOnce).not.toHaveBeenCalled()
    })

    it('constructs a client with the provided host', () => {
      new OllamaModel({ host: 'http://example:11434' })
      expect(Ollama).toHaveBeenCalledWith(expect.objectContaining({ host: 'http://example:11434' }))
    })

    it('uses a provided client instance', () => {
      const client = createMockClient(makeResponse([]))
      const provider = new OllamaModel({ client })
      expect(Ollama).not.toHaveBeenCalled()
      expect(provider).toBeDefined()
    })
  })

  describe('config', () => {
    it('merges updates via updateConfig', () => {
      const provider = new OllamaModel({ modelId: 'llama3.1', temperature: 0.2 })
      provider.updateConfig({ temperature: 0.9 })
      expect(provider.getConfig()).toEqual(expect.objectContaining({ modelId: 'llama3.1', temperature: 0.9 }))
    })

    it('preserves an explicit contextWindowLimit', () => {
      const provider = new OllamaModel({ modelId: 'llama3.1', contextWindowLimit: 8_000 })
      expect(provider.getConfig().contextWindowLimit).toBe(8_000)
    })
  })

  describe('request formatting', () => {
    it('flattens messages and prepends the system prompt', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: 'hi' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      await collectIterator(provider.stream(userMessage('Hello'), { systemPrompt: 'Be brief' }))

      expect(client.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'llama3.1',
          stream: true,
          messages: [
            { role: 'system', content: 'Be brief' },
            { role: 'user', content: 'Hello' },
          ],
        })
      )
    })

    it('maps config knobs onto Ollama options', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({
        modelId: 'llama3.1',
        client,
        maxTokens: 128,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ['STOP'],
        options: { top_k: 40 },
        keepAlive: '10m',
      })

      await collectIterator(provider.stream(userMessage('Hi')))

      expect(client.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          keep_alive: '10m',
          options: { top_k: 40, num_predict: 128, temperature: 0.5, top_p: 0.9, stop: ['STOP'] },
        })
      )
    })

    it('maps tool specs onto Ollama function tools', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client })
      const toolSpecs: ToolSpec[] = [
        { name: 'calc', description: 'Adds numbers', inputSchema: { type: 'object', properties: {} } },
      ]

      await collectIterator(provider.stream(userMessage('Hi'), { toolSpecs }))

      expect(client.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              type: 'function',
              function: { name: 'calc', description: 'Adds numbers', parameters: { type: 'object', properties: {} } },
            },
          ],
        })
      )
    })

    it('flattens a tool use block into a tool_calls message', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client })
      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'calc', toolUseId: 't1', input: { a: 1 } })],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const request = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(request.messages).toContainEqual({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'calc', arguments: { a: 1 } } }],
      })
    })

    it('flattens a tool result block into tool-role messages', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 't1',
              status: 'success',
              content: [new JsonBlock({ json: { ok: true } }), new TextBlock('done')],
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const request = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(request.messages).toEqual([
        { role: 'tool', content: JSON.stringify({ ok: true }) },
        { role: 'tool', content: 'done' },
      ])
    })

    it('sends image bytes and skips unsupported blocks', async () => {
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client })
      const bytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [new ImageBlock({ format: 'png', source: { bytes } }), new ReasoningBlock({ text: 'thinking' })],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const request = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(request.messages).toEqual([{ role: 'user', content: '', images: [bytes] }])
    })

    it('warns and ignores cacheConfig', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const client = createMockClient(makeResponse([{ message: { role: 'assistant', content: '' }, done: true }]))
      const provider = new OllamaModel({ modelId: 'llama3.1', client, cacheConfig: {} })

      await collectIterator(provider.stream(userMessage('Hi')))

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('caching is not supported'))
      warnSpy.mockRestore()
    })
  })

  describe('stream event handling', () => {
    it('yields the correct event sequence for a text response', async () => {
      const client = createMockClient(
        makeResponse([
          {
            message: { role: 'assistant', content: 'Hello' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 10,
            eval_count: 5,
            total_duration: 2_000_000,
          },
        ])
      )
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      const events = await collectIterator(provider.stream(userMessage('Hi')))

      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } },
        { type: 'modelContentBlockStopEvent' },
        {
          type: 'modelMetadataEvent',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 2 },
        },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
    })

    it('emits tool call events and a toolUse stop reason', async () => {
      const client = createMockClient(
        makeResponse([
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'calc', arguments: { a: 1 } } }],
            },
            done: true,
            done_reason: 'stop',
          },
        ])
      )
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      const events = await collectIterator(provider.stream(userMessage('Hi')))

      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'modelContentBlockStartEvent',
          start: expect.objectContaining({ type: 'toolUseStart', name: 'calc' }),
        })
      )
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify({ a: 1 }) },
      })
      expect(events).toContainEqual({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
    })

    it('maps done_reason "length" to maxTokens', async () => {
      const client = createMockClient(
        makeResponse([{ message: { role: 'assistant', content: 'x' }, done: true, done_reason: 'length' }])
      )
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      const events = await collectIterator(provider.stream(userMessage('Hi')))

      expect(events).toContainEqual({ type: 'modelMessageStopEvent', stopReason: 'maxTokens' })
    })

    it('aborts the response when the cancel signal fires', async () => {
      const response = makeResponse([{ message: { role: 'assistant', content: 'x' }, done: true }])
      const provider = new OllamaModel({ modelId: 'llama3.1', client: createMockClient(response) })
      const controller = new AbortController()
      controller.abort()

      await collectIterator(provider.stream(userMessage('Hi'), { cancelSignal: controller.signal }))

      expect(response.abort).toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('translates context-window overflow errors', async () => {
      const client = {
        chat: vi.fn(async () => {
          throw new Error('the prompt is longer than the context length')
        }),
      } as unknown as Ollama
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      await expect(collectIterator(provider.stream(userMessage('Hi')))).rejects.toThrow(ContextWindowOverflowError)
    })

    it('rethrows other errors unchanged', async () => {
      const client = {
        chat: vi.fn(async () => {
          throw new Error('connection refused')
        }),
      } as unknown as Ollama
      const provider = new OllamaModel({ modelId: 'llama3.1', client })

      await expect(collectIterator(provider.stream(userMessage('Hi')))).rejects.toThrow('connection refused')
    })
  })
})
