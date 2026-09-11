import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OpenAI, { APIUserAbortError } from 'openai'
import { isNode } from '../../../__fixtures__/environment.js'
import { OpenAIModel } from '../index.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../../errors.js'
import { collectIterator } from '../../../__fixtures__/model-test-helpers.js'
import { Message, TextBlock, ToolUseBlock, ToolResultBlock, GuardContentBlock } from '../../../types/messages.js'
import type { SystemContentBlock } from '../../../types/messages.js'
import { ImageBlock, DocumentBlock, VideoBlock } from '../../../types/media.js'
import { warnOnce } from '../../../logging/warn-once.js'
import { logger } from '../../../logging/logger.js'

/**
 * Helper to create a mock OpenAI client with streaming support
 */
function createMockClient(streamGenerator: () => AsyncGenerator<any>): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => streamGenerator()),
      },
    },
  } as any
}

// Mock the OpenAI SDK
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  const mockConstructor = vi.fn(function (this: any) {
    return {}
  })
  return {
    ...actual,
    default: mockConstructor,
  }
})

vi.mock('../../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

describe('OpenAIModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    // Set default env var for most tests using Vitest's stubEnv (Node.js only)
    if (isNode) {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-env')
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    // Restore all environment variables to their original state (Node.js only)
    if (isNode) {
      vi.unstubAllEnvs()
    }
  })

  // Shared helper to create a mock OpenAI client that captures the request
  const createMockClientWithCapture = (captureContainer: { request: any }): any => {
    return {
      chat: {
        completions: {
          create: vi.fn(async (request: any) => {
            captureContainer.request = request
            return (async function* () {
              yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
              yield { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] }
            })()
          }),
        },
      },
    } as any
  }

  describe('constructor', () => {
    it('creates an instance with required modelId', () => {
      const provider = new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-test' })
      const config = provider.getConfig()
      expect(config.modelId).toBe('gpt-5.4')
    })

    it('uses custom model ID', () => {
      const customModelId = 'gpt-3.5-turbo'
      const provider = new OpenAIModel({ api: 'chat', modelId: customModelId, apiKey: 'sk-test' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: customModelId,
      })
    })

    it('warns when modelId is not explicitly set', () => {
      new OpenAIModel({ api: 'chat', apiKey: 'sk-test' })
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('does not warn when modelId is explicitly set', () => {
      new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-test' })
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('uses API key from constructor parameter', () => {
      const apiKey = 'sk-explicit'
      new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey })
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: apiKey,
        })
      )
    })

    // Node.js-specific test: environment variable usage
    if (isNode) {
      it('uses API key from environment variable', () => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-from-env')
        new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4' })
        // OpenAI client should be called without explicit apiKey (uses env var internally)
        expect(OpenAI).toHaveBeenCalled()
      })
    }

    it('explicit API key takes precedence over environment variable', () => {
      if (isNode) {
        vi.stubEnv('OPENAI_API_KEY', 'sk-from-env')
      }
      const explicitKey = 'sk-explicit'
      new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: explicitKey })
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: explicitKey,
        })
      )
    })

    it('throws error when no API key is available', () => {
      if (isNode) {
        vi.stubEnv('OPENAI_API_KEY', '')
      }
      expect(() => new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4' })).toThrow(
        "OpenAI API key is required. Provide it via the 'apiKey' option (string or function) or set the OPENAI_API_KEY environment variable."
      )
    })

    it('uses custom client configuration', () => {
      const timeout = 30000
      new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-test', clientConfig: { timeout } })
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: timeout,
        })
      )
    })

    it('uses provided client instance', () => {
      vi.clearAllMocks()
      const mockClient = {} as OpenAI
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      // Should not create a new OpenAI client
      expect(OpenAI).not.toHaveBeenCalled()
      expect(provider).toBeDefined()
    })

    it('provided client takes precedence over apiKey and clientConfig', () => {
      vi.clearAllMocks()
      const mockClient = {} as OpenAI
      new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        apiKey: 'sk-test',
        client: mockClient,
        clientConfig: { timeout: 30000 },
      })
      // Should not create a new OpenAI client when client is provided
      expect(OpenAI).not.toHaveBeenCalled()
    })

    it('does not require API key when client is provided', () => {
      vi.clearAllMocks()
      if (isNode) {
        vi.stubEnv('OPENAI_API_KEY', '')
      }
      const mockClient = {} as OpenAI
      expect(() => new OpenAIModel({ api: 'chat', client: mockClient })).not.toThrow()
    })

    it('accepts function-based API key', () => {
      const apiKeyFn = vi.fn(async () => 'sk-dynamic')
      new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        apiKey: apiKeyFn,
      })
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: apiKeyFn,
        })
      )
    })

    it('accepts async function-based API key', () => {
      const apiKeyFn = async (): Promise<string> => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 10))
        return 'sk-async-key'
      }

      new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        apiKey: apiKeyFn,
      })

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: apiKeyFn,
        })
      )
    })
  })

  describe('updateConfig', () => {
    it('merges new config with existing config', () => {
      const provider = new OpenAIModel({ api: 'chat', modelId: 'gpt-5.4', apiKey: 'sk-test', temperature: 0.5 })
      provider.updateConfig({ modelId: 'gpt-5.4', temperature: 0.8, maxTokens: 2048 })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-5.4',
        temperature: 0.8,
        maxTokens: 2048,
        contextWindowLimit: 1_050_000,
      })
    })

    it('preserves fields not included in the update', () => {
      const provider = new OpenAIModel({
        api: 'chat',
        apiKey: 'sk-test',
        modelId: 'gpt-3.5-turbo',
        temperature: 0.5,
        maxTokens: 1024,
      })
      provider.updateConfig({ modelId: 'gpt-3.5-turbo', temperature: 0.8 })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-3.5-turbo',
        temperature: 0.8,
        maxTokens: 1024,
      })
    })

    it('re-resolves contextWindowLimit when modelId changes and it was auto-resolved', () => {
      const provider = new OpenAIModel({ api: 'chat', apiKey: 'sk-test' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_050_000) // gpt-5.4 default

      provider.updateConfig({ modelId: 'gpt-4o' })
      expect(provider.getConfig().contextWindowLimit).toBe(128_000) // gpt-4o value
    })

    it('preserves explicit contextWindowLimit when modelId changes', () => {
      const provider = new OpenAIModel({ api: 'chat', apiKey: 'sk-test', contextWindowLimit: 50_000 })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)

      provider.updateConfig({ modelId: 'gpt-4o' })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000) // preserved
    })
  })

  describe('getConfig', () => {
    it('returns the current configuration', () => {
      const provider = new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        apiKey: 'sk-test',
        maxTokens: 1024,
        temperature: 0.7,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-5.4',
        maxTokens: 1024,
        temperature: 0.7,
        contextWindowLimit: 1_050_000,
      })
    })

    it('includes contextWindowLimit in config when provided', () => {
      const provider = new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-4o',
        apiKey: 'sk-test',
        contextWindowLimit: 128_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-4o',
        contextWindowLimit: 128_000,
      })
    })

    it('auto-populates contextWindowLimit from model ID lookup', () => {
      const provider = new OpenAIModel({ api: 'chat', modelId: 'gpt-4o', apiKey: 'sk-test' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-4o',
        contextWindowLimit: 128_000,
      })
    })

    it('auto-populates contextWindowLimit for default model ID', () => {
      const provider = new OpenAIModel({ api: 'chat', apiKey: 'sk-test' })
      expect(provider.getConfig()).toStrictEqual({
        contextWindowLimit: 1_050_000,
      })
    })

    it('does not override explicit contextWindowLimit', () => {
      const provider = new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-4o',
        apiKey: 'sk-test',
        contextWindowLimit: 50_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'gpt-4o',
        contextWindowLimit: 50_000,
      })
    })

    it('leaves contextWindowLimit undefined for unknown model IDs', () => {
      const provider = new OpenAIModel({ api: 'chat', modelId: 'unknown-model', apiKey: 'sk-test' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'unknown-model',
      })
    })
  })

  describe('managed params warning', () => {
    it('warns on construction when params contains provider-managed keys', () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      new OpenAIModel({
        api: 'chat',
        client: {} as OpenAI,
        params: { model: 'bad', stream: false },
      })
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'model'"))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'stream'"))
      warnSpy.mockRestore()
    })

    it('warns on updateConfig when params contains provider-managed keys', () => {
      const model = new OpenAIModel({ api: 'chat', client: {} as OpenAI })
      const warnSpy = vi.spyOn(logger, 'warn')
      model.updateConfig({ params: { stream_options: { include_usage: false } } })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'stream_options'"))
      warnSpy.mockRestore()
    })

    it('does not warn when params contains only non-managed keys', () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      new OpenAIModel({ api: 'chat', client: {} as OpenAI, params: { seed: 42 } })
      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('provider-managed fields in params are overridden and cannot take effect', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const warnSpy = vi.spyOn(logger, 'warn')
      const provider = new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        client: mockClient,
        params: {
          model: 'attacker-model',
          messages: [{ role: 'user', content: 'hijacked' }],
          stream: false,
          stream_options: { include_usage: false },
        },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]
      await collectIterator(provider.stream(messages))
      expect(captured.request.model).toBe('gpt-5.4')
      expect(captured.request.stream).toBe(true)
      expect(captured.request.stream_options).toEqual({ include_usage: true })
      expect(Array.isArray(captured.request.messages)).toBe(true)
      expect(captured.request.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hi' }] })
      warnSpy.mockRestore()
    })
  })

  describe('stream', () => {
    describe('cancellation', () => {
      // Guards against provider work continuing after agent cancellation (#3915).
      it('stops an in-flight chat completions producer when the signal aborts', async () => {
        let producedTokens = 0
        let producerStopped = false
        let resolveFirstToken!: () => void
        const firstTokenProduced = new Promise<void>((resolve) => {
          resolveFirstToken = resolve
        })
        const create = vi.fn(async (_request: unknown, requestOptions?: unknown): Promise<AsyncGenerator<unknown>> => {
          const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal
          return (async function* (): AsyncGenerator<unknown> {
            yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
            while (producedTokens < 20) {
              if (signal?.aborted) {
                producerStopped = true
                return
              }
              producedTokens += 1
              if (producedTokens === 1) {
                resolveFirstToken()
              }
              yield { choices: [{ delta: { content: 'token ' }, index: 0 }] }
              await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1))
            }
            yield { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] }
          })()
        })
        const client = { chat: { completions: { create } } } as unknown as OpenAI
        const controller = new AbortController()
        const model = new OpenAIModel({ api: 'chat', client })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        const streamResult = collectIterator(model.stream(messages, { cancelSignal: controller.signal }))
        await firstTokenProduced
        const tokensAtCancel = producedTokens
        controller.abort()
        await expect(streamResult).rejects.toBeInstanceOf(APIUserAbortError)

        expect(create).toHaveBeenCalledWith(expect.anything(), { signal: controller.signal })
        expect({ producedTokens, producerStopped }).toEqual({
          producedTokens: tokensAtCancel,
          producerStopped: true,
        })
      })
    })

    describe('validation', () => {
      it('throws error when messages array is empty', async () => {
        const mockClient = createMockClient(async function* () {})
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })

        await expect(async () => {
          await collectIterator(provider.stream([]))
        }).rejects.toThrow('At least one message is required')
      })

      it('validates system prompt is not empty', async () => {
        const mockClient = createMockClient(async function* () {
          yield {
            choices: [{ delta: { role: 'assistant', content: 'Hello' }, index: 0 }],
          }
          yield {
            choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
          }
        })
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        // System prompt that's only whitespace should not be sent
        const events = await collectIterator(provider.stream(messages, { systemPrompt: '   ' }))

        // Should still get valid events
        expect(events.length).toBeGreaterThan(0)
        expect(events[0]?.type).toBe('modelMessageStartEvent')
      })

      it('throws error for streaming with n > 1', async () => {
        const mockClient = createMockClient(async function* () {})
        const provider = new OpenAIModel({
          api: 'chat',
          modelId: 'gpt-5.4',
          client: mockClient,
          params: { n: 2 },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // Should not reach here
          }
        }).rejects.toThrow('Streaming with n > 1 is not supported')
      })

      it('throws error for tool spec without name or description', async () => {
        const mockClient = createMockClient(async function* () {})
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        await expect(async () => {
          for await (const _ of provider.stream(messages, {
            toolSpecs: [{ name: '', description: 'test', inputSchema: {} }],
          })) {
            // Should not reach here
          }
        }).rejects.toThrow('Tool specification must have both name and description')
      })

      it('throws error for empty tool result content', async () => {
        const mockClient = createMockClient(async function* () {})
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [],
              }),
            ],
          }),
        ]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // Should not reach here
          }
        }).rejects.toThrow('Tool result for toolUseId "tool-123" has empty content')
      })

      it('handles tool result with error status', async () => {
        const mockClient = createMockClient(async function* () {
          yield {
            choices: [{ delta: { role: 'assistant', content: 'Ok' }, index: 0 }],
          }
          yield {
            choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
          }
        })
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('Run tool')] }),
          new Message({
            role: 'assistant',
            content: [
              new ToolUseBlock({
                name: 'calculator',
                toolUseId: 'tool-123',
                input: { expr: 'invalid' },
              }),
            ],
          }),
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'error',
                content: [new TextBlock('Division by zero')],
              }),
            ],
          }),
        ]

        // Should not throw - error status is handled by prepending [ERROR]
        const events = await collectIterator(provider.stream(messages))

        // Verify we got a response
        expect(events.length).toBeGreaterThan(0)
        expect(events[0]?.type).toBe('modelMessageStartEvent')
      })

      it('throws error for circular reference in tool input', async () => {
        const mockClient = createMockClient(async function* () {})
        const provider = new OpenAIModel({ api: 'chat', client: mockClient })

        const circular: any = { a: 1 }
        circular.self = circular

        const messages = [
          new Message({ role: 'user', content: [new TextBlock('Hi')] }),
          new Message({
            role: 'assistant',
            content: [
              new ToolUseBlock({
                name: 'test',
                toolUseId: 'tool-1',
                input: circular,
              }),
            ],
          }),
        ]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // Should not reach here
          }
        }).rejects.toThrow('Failed to serialize tool input')
      })
    })

    describe('basic streaming', () => {
      it('yields correct event sequence for simple text response', async () => {
        const mockClient = createMockClient(async function* () {
          yield {
            choices: [{ delta: { role: 'assistant' }, index: 0 }],
          }
          yield {
            choices: [{ delta: { content: 'Hello' }, index: 0 }],
          }
          yield {
            choices: [{ delta: { content: ' world' }, index: 0 }],
          }
          yield {
            choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
          }
        })

        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const events = await collectIterator(provider.stream(messages))

        // Now includes complete content block lifecycle: start, deltas, stop
        expect(events).toHaveLength(6)
        expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
        expect(events[1]).toEqual({
          type: 'modelContentBlockStartEvent',
        })
        expect(events[2]).toEqual({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: 'Hello' },
        })
        expect(events[3]).toEqual({
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'textDelta', text: ' world' },
        })
        expect(events[4]).toEqual({
          type: 'modelContentBlockStopEvent',
        })
        expect(events[5]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
      })
    })

    it('emits modelMetadataEvent with usage information', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
        yield {
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toBeDefined()
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      })
    })

    it('surfaces cacheReadInputTokens from prompt_tokens_details', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
        yield {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 64,
        },
      })
    })

    it('omits cacheReadInputTokens when cached_tokens is zero or absent', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
        yield {
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

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

    it('handles usage with undefined properties', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
        yield {
          choices: [],
          usage: {}, // Empty usage object
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toBeDefined()
      expect(metadataEvent).toEqual({
        type: 'modelMetadataEvent',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
      })
    })

    it('filters out empty string content deltas', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ delta: { content: '' }, index: 0 }], // Empty content
        }
        yield {
          choices: [{ delta: { content: 'Hello' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      // Should not emit event for empty content
      const contentEvents = events.filter((e) => e.type === 'modelContentBlockDeltaEvent')
      expect(contentEvents).toHaveLength(1)
      expect((contentEvents[0] as any).delta.text).toBe('Hello')
    })

    it('prevents duplicate message start events', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ delta: { role: 'assistant', content: 'Hello' }, index: 0 }], // Duplicate role
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      // Suppress console.warn for this test
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const events = await collectIterator(provider.stream(messages))

      // Should only have one message start event
      const startEvents = events.filter((e) => e.type === 'modelMessageStartEvent')
      expect(startEvents).toHaveLength(1)
    })
  })

  describe('tool calling', () => {
    it('handles tool use request with contentBlockStart and contentBlockStop events', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'calculator', arguments: '' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"expr' } }],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '":"2+2"}' } }],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [{ finish_reason: 'tool_calls', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Calculate 2+2')] })]

      const events = await collectIterator(provider.stream(messages))

      // Verify key events in sequence
      expect(events[0]).toEqual({ type: 'modelMessageStartEvent', role: 'assistant' })
      expect(events[1]).toEqual({
        type: 'modelContentBlockStartEvent',
        start: {
          type: 'toolUseStart',
          name: 'calculator',
          toolUseId: 'call_123',
        },
      })
      expect(events[2]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'toolUseInputDelta',
          input: '{"expr',
        },
      })
      expect(events[3]).toEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'toolUseInputDelta',
          input: '":"2+2"}',
        },
      })
      expect(events[4]).toEqual({
        type: 'modelContentBlockStopEvent',
      })
      expect(events[5]).toEqual({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
    })

    it('handles multiple tool calls', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'tool1', arguments: '{}' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: 'call_2',
                    type: 'function',
                    function: { name: 'tool2', arguments: '{}' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [{ finish_reason: 'tool_calls', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      // Should emit stop events for both tool calls
      const stopEvents = events.filter((e) => e.type === 'modelContentBlockStopEvent')
      expect(stopEvents).toHaveLength(2)
      expect(stopEvents[0]).toEqual({ type: 'modelContentBlockStopEvent' })
      expect(stopEvents[1]).toEqual({ type: 'modelContentBlockStopEvent' })
    })

    it('skips tool calls with invalid index', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: undefined as any, // Invalid index
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'tool', arguments: '{}' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        yield {
          choices: [{ finish_reason: 'stop', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      // Suppress console.warn for this test
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      const events = await collectIterator(provider.stream(messages))

      // Should not emit any tool-related events
      const toolEvents = events.filter(
        (e) => e.type === 'modelContentBlockStartEvent' || e.type === 'modelContentBlockDeltaEvent'
      )
      expect(toolEvents).toHaveLength(0)

      // The important thing is that invalid tool calls don't crash the stream
      // and are properly skipped
      expect(events.length).toBeGreaterThan(0) // Still got message events
    })

    it('tool argument deltas can be reassembled into valid JSON', async () => {
      const mockClient = createMockClient(async function* () {
        yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'calculator', arguments: '' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        // Split JSON across multiple chunks in realistic ways
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"' } }] }, index: 0 }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'x":' } }] }, index: 0 }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '10,' } }] }, index: 0 }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"y":' } }] }, index: 0 }] }
        yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '20}' } }] }, index: 0 }] }
        yield { choices: [{ finish_reason: 'tool_calls', delta: {}, index: 0 }] }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      // Extract and concatenate all tool input deltas
      const inputDeltas = events
        .filter((e) => e.type === 'modelContentBlockDeltaEvent' && (e as any).delta.type === 'toolUseInputDelta')
        .map((e) => (e as any).delta.input)

      const reassembled = inputDeltas.join('')

      // Should be valid JSON
      expect(() => JSON.parse(reassembled)).not.toThrow()
      expect(JSON.parse(reassembled)).toEqual({ x: 10, y: 20 })
    })

    it('handles messages with both text and tool calls', async () => {
      const mockClient = createMockClient(async function* () {
        yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
        // Text content first
        yield { choices: [{ delta: { content: 'Let me calculate ' }, index: 0 }] }
        yield { choices: [{ delta: { content: 'that for you.' }, index: 0 }] }
        // Then tool call
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'calculator', arguments: '{"expr":"2+2"}' },
                  },
                ],
              },
              index: 0,
            },
          ],
        }
        yield { choices: [{ finish_reason: 'tool_calls', delta: {}, index: 0 }] }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Calculate 2+2')] })]

      const events = await collectIterator(provider.stream(messages))

      // Should have text deltas followed by tool events
      expect(events[0]?.type).toBe('modelMessageStartEvent')
      // Text content block start
      expect(events[1]?.type).toBe('modelContentBlockStartEvent')
      // Text deltas
      expect(events[2]?.type).toBe('modelContentBlockDeltaEvent')
      expect((events[2] as any).delta.type).toBe('textDelta')
      expect((events[2] as any).delta.text).toBe('Let me calculate ')
      // Tool events should follow
      const toolStartEvent = events.find(
        (e) => e.type === 'modelContentBlockStartEvent' && (e as any).start?.type === 'toolUseStart'
      )
      expect(toolStartEvent).toBeDefined()
      // Both text and tool blocks should have stop events
      const stopEvents = events.filter((e) => e.type === 'modelContentBlockStopEvent')
      expect(stopEvents.length).toBeGreaterThan(0)
    })
  })

  describe('stop reasons', () => {
    it('maps OpenAI stop reasons to SDK stop reasons', async () => {
      const stopReasons = [
        { openai: 'stop', sdk: 'endTurn' },
        { openai: 'tool_calls', sdk: 'toolUse' },
        { openai: 'length', sdk: 'maxTokens' },
        { openai: 'content_filter', sdk: 'contentFiltered' },
      ]

      for (const { openai, sdk } of stopReasons) {
        const mockClient = createMockClient(async function* () {
          yield {
            choices: [{ delta: { role: 'assistant' }, index: 0 }],
          }
          yield {
            choices: [{ finish_reason: openai, delta: {}, index: 0 }],
          }
        })

        const provider = new OpenAIModel({ api: 'chat', client: mockClient })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

        const events = await collectIterator(provider.stream(messages))

        const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
        expect(stopEvent).toBeDefined()
        expect((stopEvent as any).stopReason).toBe(sdk)
      }
    })

    it('handles unknown stop reasons with warning', async () => {
      const mockClient = createMockClient(async function* () {
        yield {
          choices: [{ delta: { role: 'assistant' }, index: 0 }],
        }
        yield {
          choices: [{ finish_reason: 'new_unknown_reason', delta: {}, index: 0 }],
        }
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const events = await collectIterator(provider.stream(messages))

      // Should convert unknown stop reason to camelCase
      const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(stopEvent).toBeDefined()
      expect((stopEvent as any).stopReason).toBe('newUnknownReason')

      // Note: Warning logging is verified manually/visually since console.warn spying
      // has test isolation issues when running the full test suite
    })
  })

  describe('API request formatting', () => {
    it('formats API request correctly with all options', async () => {
      let capturedRequest: any = null
      let callCount = 0

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async (request: any) => {
              capturedRequest = request
              callCount++
              // Return an async generator
              return (async function* (): AsyncGenerator<any, any, unknown> {
                yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
                yield { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] }
              })()
            }),
          },
        },
      } as any

      const provider = new OpenAIModel({
        api: 'chat',
        modelId: 'gpt-5.4',
        client: mockClient,
        temperature: 0.7,
        maxTokens: 1000,
      })

      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      const toolSpecs = [
        {
          name: 'calculator',
          description: 'Calculate expressions',
          inputSchema: { type: 'object' as const, properties: { expr: { type: 'string' as const } } },
        },
      ]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: 'You are a helpful assistant',
          toolSpecs,
          toolChoice: { auto: {} },
        })
      )

      // Verify create was called with correct structure
      expect(callCount).toBe(1)
      expect(capturedRequest).toBeDefined()
      expect(capturedRequest).toEqual({
        model: 'gpt-5.4',
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0.7,
        max_completion_tokens: 1000,
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Calculate expressions',
              parameters: { type: 'object', properties: { expr: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'auto',
      })
    })

    it('maps cacheConfig.cacheKey to prompt_cache_key', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        cacheConfig: { cacheKey: 'tenant-42' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_key).toBe('tenant-42')
    })

    it('omits prompt_cache_key when cacheConfig is unset', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({ api: 'chat', client: createMockClientWithCapture(captured) })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_key).toBeUndefined()
    })

    it('lets an explicit prompt_cache_key in params win over cacheConfig', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        params: { prompt_cache_key: 'explicit' },
        cacheConfig: { cacheKey: 'from-config' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_key).toBe('explicit')
    })

    it('derives prompt_cache_key from the agent metadata session when cacheKey is unset', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({ api: 'chat', client: createMockClientWithCapture(captured), cacheConfig: {} })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          agentMetadata: { sessionId: 's1' },
        })
      )

      expect(captured.request.prompt_cache_key).toBe('strands-s1')
    })

    it('lets a configured cacheKey win over the agent metadata session', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        cacheConfig: { cacheKey: 'tenant-42' },
      })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          agentMetadata: { sessionId: 's1' },
        })
      )

      expect(captured.request.prompt_cache_key).toBe('tenant-42')
    })

    it('treats a false cacheKey as an opt-out even with an agent metadata session', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        cacheConfig: { cacheKey: false },
      })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], {
          agentMetadata: { sessionId: 's1' },
        })
      )

      expect(captured.request.prompt_cache_key).toBeUndefined()
    })

    it('omits prompt_cache_key when the agent metadata carries no session', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({ api: 'chat', client: createMockClientWithCapture(captured), cacheConfig: {} })

      await collectIterator(
        provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })], { agentMetadata: {} })
      )

      expect(captured.request.prompt_cache_key).toBeUndefined()
    })

    it.each(['24h', 'in_memory'])(
      'maps retention-literal cacheConfig.ttl %s to prompt_cache_retention',
      async (ttl) => {
        const captured: { request: any } = { request: null }
        const provider = new OpenAIModel({
          api: 'chat',
          client: createMockClientWithCapture(captured),
          cacheConfig: { ttl },
        })

        await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

        expect(captured.request.prompt_cache_retention).toBe(ttl)
      }
    )

    it('ignores a non-retention cacheConfig.ttl and warns once', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        cacheConfig: { ttl: '5m' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_retention).toBeUndefined()
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('ttl=<5m> | cacheConfig.ttl is not an openai retention value')
      )
    })

    it('lets an explicit prompt_cache_retention in params win over cacheConfig', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        params: { prompt_cache_retention: '24h' },
        cacheConfig: { ttl: 'in_memory' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_retention).toBe('24h')
    })

    it('does not warn about an unsupported ttl when an explicit prompt_cache_retention already wins', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        params: { prompt_cache_retention: '24h' },
        cacheConfig: { ttl: '5m' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(captured.request.prompt_cache_retention).toBe('24h')
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('not an openai retention value')
      )
    })

    it('warns once that placement fields have no effect', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({
        api: 'chat',
        client: createMockClientWithCapture(captured),
        cacheConfig: { strategy: 'anthropic', systemPromptTTL: false, toolsTTL: '1h', cacheKey: 'k' },
      })

      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))
      await collectIterator(provider.stream([new Message({ role: 'user', content: [new TextBlock('Hi')] })]))

      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('have no effect')
      )
    })
  })

  describe('systemPrompt handling', () => {
    it('formats array system prompt with text blocks only', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [
            { type: 'textBlock', text: 'You are a helpful assistant' },
            { type: 'textBlock', text: 'Additional context here' },
          ] as SystemContentBlock[],
        })
      )

      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistantAdditional context here' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ])
    })

    it('formats array system prompt with cache points', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      collectIterator(
        provider.stream(messages, {
          systemPrompt: [
            { type: 'textBlock', text: 'You are a helpful assistant' },
            { type: 'textBlock', text: 'Large context document' },
            { type: 'cachePointBlock', cacheType: 'default' },
          ] as SystemContentBlock[],
        })
      )

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'cache points are not supported in openai system prompts, ignoring cache points'
      )

      // Verify system message contains only text (cache points ignored)
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistantLarge context document' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ])

      warnSpy.mockRestore()
    })

    it('handles empty array system prompt', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [],
        })
      )

      // Empty array should not add system message
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
    })

    it('formats array system prompt with single text block', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [{ type: 'textBlock', text: 'You are a helpful assistant' }] as SystemContentBlock[],
        })
      )

      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ])
    })

    it('warns and filters guard content from system prompt', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [
            { type: 'textBlock', text: 'You are a helpful assistant' },
            {
              type: 'guardContentBlock',
              text: {
                qualifiers: ['grounding_source'],
                text: 'Guard content',
              },
            },
          ] as SystemContentBlock[],
        })
      )

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'guard content is not supported in openai system prompts, removing guard content block'
      )

      // Verify guard content is filtered out
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ])

      warnSpy.mockRestore()
    })

    it('preserves text blocks when filtering guard content', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [
            { type: 'textBlock', text: 'First text' },
            {
              type: 'guardContentBlock',
              text: {
                qualifiers: ['query'],
                text: 'Guard content',
              },
            },
            { type: 'textBlock', text: 'Second text' },
          ] as SystemContentBlock[],
        })
      )

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'guard content is not supported in openai system prompts, removing guard content block'
      )

      // Verify both text blocks preserved, guard content removed
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'system', content: 'First textSecond text' },
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ])

      warnSpy.mockRestore()
    })

    it('handles system prompt with only guard content', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(
        provider.stream(messages, {
          systemPrompt: [
            {
              type: 'guardContentBlock',
              text: {
                qualifiers: ['guard_content'],
                text: 'Only guard content',
              },
            },
          ] as SystemContentBlock[],
        })
      )

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'guard content is not supported in openai system prompts, removing guard content block'
      )

      // Verify no system message added (only guard content)
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])

      warnSpy.mockRestore()
    })
  })

  describe('guard content in messages', () => {
    it('warns and filters guard content from user messages', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Verify this:'),
            new GuardContentBlock({
              text: {
                qualifiers: ['grounding_source'],
                text: 'Guard content',
              },
            }),
            new TextBlock('Is it correct?'),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'block_type=<guardContentBlock> | unsupported content type in openai user message | skipping'
      )

      // Verify guard content filtered out
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Verify this:' },
            { type: 'text', text: 'Is it correct?' },
          ],
        },
      ])

      warnSpy.mockRestore()
    })

    it('warns and filters guard content with image from user messages', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const imageBytes = new Uint8Array([1, 2, 3, 4])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Check this image:'),
            new GuardContentBlock({
              image: {
                format: 'jpeg',
                source: { bytes: imageBytes },
              },
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'block_type=<guardContentBlock> | unsupported content type in openai user message | skipping'
      )

      // Verify guard content filtered out
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'Check this image:' }] },
      ])

      warnSpy.mockRestore()
    })

    it('handles message with only guard content', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new GuardContentBlock({
              text: {
                qualifiers: ['guard_content'],
                text: 'Only guard content',
              },
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalledWith(
        'block_type=<guardContentBlock> | unsupported content type in openai user message | skipping'
      )

      // Verify no user message added (only guard content)
      expect(captured.request).toBeDefined()
      expect(captured.request!.messages).toEqual([])

      warnSpy.mockRestore()
    })
  })

  describe('media blocks', () => {
    it('formats image block in user message as image_url with base64', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const imageBytes = new Uint8Array([72, 101, 108, 108, 111])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('What is in this image?'),
            new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const userMsg = captured.request.messages[0]
      expect(userMsg.role).toBe('user')
      expect(userMsg.content).toHaveLength(2)
      expect(userMsg.content[0]).toEqual({ type: 'text', text: 'What is in this image?' })
      expect(userMsg.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,SGVsbG8=' },
      })
    })

    it('formats image block in user message with URL source', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [new ImageBlock({ format: 'jpeg', source: { url: 'https://example.com/img.jpg' } })],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const userMsg = captured.request.messages[0]
      expect(userMsg.content[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/img.jpg' },
      })
    })

    it('formats document block with bytes source as file in user message', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const docBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } })],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const userMsg = captured.request.messages[0]
      expect(userMsg.content[0]).toEqual({
        type: 'file',
        file: { file_data: 'data:application/pdf;base64,AQID', filename: 'report.pdf' },
      })
    })

    it('splits image from tool result into separate user message', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const imageBytes = new Uint8Array([72, 101, 108, 108, 111])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [
                new TextBlock('Screenshot captured'),
                new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      // Tool message with text only
      const toolMsg = captured.request.messages[0]
      expect(toolMsg.role).toBe('tool')
      expect(toolMsg.tool_call_id).toBe('tool-1')
      expect(toolMsg.content).toBe('Screenshot captured')

      // Separate user message with image
      const userMsg = captured.request.messages[1]
      expect(userMsg.role).toBe('user')
      expect(userMsg.content[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,SGVsbG8=' },
      })
    })

    it('injects placeholder text when tool result contains only images', async () => {
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })],
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const toolMsg = captured.request.messages[0]
      expect(toolMsg.content).toContain('Tool successfully returned an image')
    })

    it('skips document block in tool result with warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [
                new TextBlock('result'),
                new DocumentBlock({ name: 'doc.pdf', format: 'pdf', source: { bytes: new Uint8Array([1]) } }),
              ],
            }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      const toolMsg = captured.request.messages[0]
      expect(toolMsg.content).toBe('result')
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('skips video block in tool result with warning', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const captured: { request: any } = { request: null }
      const mockClient = createMockClientWithCapture(captured)
      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
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

      const toolMsg = captured.request.messages[0]
      expect(toolMsg.content).toBe('result')
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('tool result and text ordering', () => {
    // Regression: an everyTurn context injector folds rendered text onto a tool-result turn, producing a
    // mixed [toolResult, text] user message. Tool results must be emitted before that text so each `tool`
    // message immediately follows the assistant `tool_calls` it answers — OpenAI rejects a request where a
    // non-tool message wedges between them.
    it.each([
      { name: 'tool result then text', order: ['tu1', 'text'], roles: ['user', 'assistant', 'tool', 'user'] },
      { name: 'text then tool result', order: ['text', 'tu1'], roles: ['user', 'assistant', 'tool', 'user'] },
      {
        name: 'text between parallel tool results',
        order: ['tu1', 'text', 'tu2'],
        roles: ['user', 'assistant', 'tool', 'tool', 'user'],
      },
    ])('keeps tool results adjacent to the assistant tool_calls for $name', async ({ order, roles }) => {
      const toolUseIds = order.filter((entry) => entry !== 'text')
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({ api: 'chat', client: createMockClientWithCapture(captured) })

      await collectIterator(
        provider.stream([
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
      )

      const requestMessages = captured.request.messages
      expect(requestMessages.map((message: any) => message.role)).toEqual(roles)
      // The message immediately after the assistant tool_calls must be the first tool response.
      expect(requestMessages[2]).toEqual({ role: 'tool', tool_call_id: 'tu1', content: '42' })
      // The injected text trails the tool responses as its own user message.
      expect(requestMessages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: '\n\nNOTE' }] })
    })

    it('keeps media hoisted out of a tool result ahead of the injected text', async () => {
      const captured: { request: any } = { request: null }
      const provider = new OpenAIModel({ api: 'chat', client: createMockClientWithCapture(captured) })

      await collectIterator(
        provider.stream([
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tu1',
                status: 'success',
                content: [
                  new TextBlock('42'),
                  new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } }),
                ],
              }),
              new TextBlock('\n\nNOTE'),
            ],
          }),
        ])
      )

      expect(captured.request.messages).toEqual([
        { role: 'tool', tool_call_id: 'tu1', content: '42' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }] },
        { role: 'user', content: [{ type: 'text', text: '\n\nNOTE' }] },
      ])
    })
  })

  describe('error handling', () => {
    it('throws ContextWindowOverflowError for structured error with code', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              const error: any = new Error('Context length exceeded')
              error.code = 'context_length_exceeded'
              throw error
            }),
          },
        },
      } as any

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ContextWindowOverflowError)
    })

    it('throws ContextWindowOverflowError for error with message pattern', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('maximum context length exceeded')
            }),
          },
        },
      } as any

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ContextWindowOverflowError)
    })

    it('throws ContextWindowOverflowError for APIError instance', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              // Simulate APIError from openai package
              const error: any = new Error('Context length exceeded')
              error.name = 'APIError'
              error.status = 400
              error.code = 'context_length_exceeded'
              // Make it behave like an APIError instance
              Object.setPrototypeOf(error, Error.prototype)
              throw error
            }),
          },
        },
      } as any

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ContextWindowOverflowError)
    })

    it('passes through other errors unchanged', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('Invalid API key')
            }),
          },
        },
      } as any

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow('Invalid API key')
    })

    it('handles stream interruption errors', async () => {
      const mockClient = createMockClient(async function* () {
        yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
        yield { choices: [{ delta: { content: 'Hello' }, index: 0 }] }
        // Stream interruption
        throw new Error('Network connection lost')
      })

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Stream will be interrupted
        }
      }).rejects.toThrow('Network connection lost')
    })

    it('throws ModelThrottledError for HTTP 429 status', async () => {
      const originalError: Error & { status?: number } = new Error('Too many requests')
      originalError.status = 429

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw originalError
            }),
          },
        },
      } as unknown as OpenAI

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ModelThrottledError)
    })

    it('throws ModelThrottledError for rate_limit_exceeded error code', async () => {
      const originalError: Error & { code?: string } = new Error('Rate limit reached')
      originalError.code = 'rate_limit_exceeded'

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw originalError
            }),
          },
        },
      } as unknown as OpenAI

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ModelThrottledError)
    })

    it('throws ModelThrottledError for error message containing rate limit pattern', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('You have exceeded your rate limit')
            }),
          },
        },
      } as unknown as OpenAI

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ModelThrottledError)
    })

    it('throws ModelThrottledError for too many requests message', async () => {
      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new Error('Too many requests, please slow down')
            }),
          },
        },
      } as unknown as OpenAI

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      await expect(async () => {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
      }).rejects.toThrow(ModelThrottledError)
    })

    it('preserves original error as cause in ModelThrottledError', async () => {
      const originalError: Error & { status?: number } = new Error('Request too large for gpt-5.4 on tokens per min')
      originalError.status = 429

      const mockClient = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw originalError
            }),
          },
        },
      } as unknown as OpenAI

      const provider = new OpenAIModel({ api: 'chat', client: mockClient })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hi')] })]

      try {
        for await (const _ of provider.stream(messages)) {
          // Should not reach here
        }
        expect.fail('Should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(ModelThrottledError)
        const throttleError = error as ModelThrottledError
        expect(throttleError.cause).toBe(originalError)
        expect(throttleError.message).toBe('Request too large for gpt-5.4 on tokens per min')
      }
    })
  })
})
