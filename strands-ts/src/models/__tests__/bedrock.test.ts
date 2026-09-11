import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  CountTokensCommand,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime'
import { isNode } from '../../__fixtures__/environment.js'
import { BedrockModel } from '../bedrock.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import { Message, ReasoningBlock, ToolUseBlock, ToolResultBlock, JsonBlock } from '../../types/messages.js'
import type { SystemContentBlock } from '../../types/messages.js'
import { TextBlock, GuardContentBlock, CachePointBlock } from '../../types/messages.js'
import { AudioBlock, ImageBlock, VideoBlock, DocumentBlock } from '../../types/media.js'
import { CitationsBlock } from '../../types/citations.js'
import type { StreamOptions } from '../model.js'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { NOOP_TOOL_SPEC } from '../../tools/noop-tool.js'
import { warnOnce } from '../../logging/warn-once.js'

/**
 * Helper function to mock BedrockRuntimeClient implementation with customizable config.
 * @param options - Optional configuration for mock region, useFipsEndpoint, and send functions
 */
function mockBedrockClientImplementation(options?: {
  region?: () => Promise<string>
  useFipsEndpoint?: () => Promise<boolean>
  send?: (...args: unknown[]) => Promise<unknown>
}): void {
  const mockSend = vi.fn(
    options?.send ??
      (async () => {
        throw new Error('send() not mocked - specify send option if needed')
      })
  )

  vi.mocked(BedrockRuntimeClient).mockImplementation(function (...args: unknown[]) {
    // Extract region from constructor args if provided
    const clientConfig = (args[0] as { region?: string } | undefined) ?? {}
    const configuredRegion = clientConfig.region

    const mockRegion = vi.fn(
      options?.region ??
        (async () => {
          // If region was explicitly configured in constructor, return it; otherwise return default
          if (configuredRegion) return configuredRegion
          return 'us-east-1'
        })
    )
    const mockUseFipsEndpoint = vi.fn(options?.useFipsEndpoint ?? (async () => false))

    return {
      send: mockSend,
      middlewareStack: { add: vi.fn() },
      config: {
        region: mockRegion,
        useFipsEndpoint: mockUseFipsEndpoint,
      },
    } as never
  } as never)
}

/**
 * Helper function to setup mock send with custom stream generator.
 */
function setupMockSend(streamGenerator: () => AsyncGenerator<unknown>): void {
  vi.clearAllMocks()
  const mockSend = vi.fn(async (): Promise<{ stream: AsyncIterable<unknown> }> => ({
    stream: streamGenerator(),
  }))
  mockBedrockClientImplementation({ send: mockSend })
}

// Mock the AWS SDK
vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const originalModule = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>()

  // Mock command classes that the code under test will instantiate
  const ConverseStreamCommand = vi.fn()
  const ConverseCommand = vi.fn()

  const mockSend = vi.fn(async (command: unknown) => {
    // Check which constructor was used to create the command object
    if (command instanceof ConverseStreamCommand) {
      // Return a streaming response
      return {
        stream: (async function* (): AsyncGenerator<unknown> {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              metrics: { latencyMs: 100 },
            },
          }
        })(),
      }
    }

    if (command instanceof ConverseCommand) {
      // Return a non-streaming (full) response for the non-streaming API
      return {
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'Hello' }],
          },
        },
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 100 },
      }
    }

    throw new Error('Unhandled command type in mock')
  })

  // Create a mock CountTokensCommand class
  const CountTokensCommand = vi.fn()

  // Create a mock ValidationException class
  class MockValidationException extends Error {
    constructor(opts: { message: string; $metadata: Record<string, unknown> }) {
      super(opts.message)
      this.name = 'ValidationException'
    }
  }

  return {
    ...originalModule,
    BedrockRuntimeClient: vi.fn(function () {
      return {
        send: mockSend,
        middlewareStack: { add: vi.fn() },
        config: {
          region: vi.fn(async () => 'us-east-1'),
          useFipsEndpoint: vi.fn(async () => false),
        },
      }
    }),
    ConverseStreamCommand,
    ConverseCommand,
    CountTokensCommand,
    ValidationException: MockValidationException,
  }
})

vi.mock('../../logging/warn-once.js', () => ({
  warnOnce: vi.fn(),
}))

describe('BedrockModel', () => {
  const BEDROCK_NOOP_TOOL_CONFIG = {
    tools: [{ toolSpec: { ...NOOP_TOOL_SPEC, inputSchema: { json: NOOP_TOOL_SPEC.inputSchema } } }],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock to a working implementation to ensure test isolation
    setupMockSend(async function* () {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockStart: {} }
      yield { contentBlockDelta: { delta: { text: 'Hello' } } }
      yield { contentBlockStop: {} }
      yield { messageStop: { stopReason: 'end_turn' } }
      yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
    })
    // Clean up AWS_REGION env var in Node.js only
    if (isNode && process.env) {
      delete process.env.AWS_REGION
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('creates an instance with default configuration', () => {
      const provider = new BedrockModel()
      const config = provider.getConfig()
      expect(config.modelId).toBeDefined()
    })

    it('warns when modelId is not explicitly set', () => {
      new BedrockModel()
      expect(warnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('does not warn when modelId is explicitly set', () => {
      new BedrockModel({ modelId: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0' })
      expect(warnOnce).not.toHaveBeenCalledWith(
        expect.objectContaining({ warn: expect.any(Function) }),
        expect.stringContaining('using default modelId')
      )
    })

    it('uses provided model ID ', () => {
      const customModelId = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0'
      const provider = new BedrockModel({ modelId: customModelId })
      expect(provider.getConfig()).toStrictEqual({
        modelId: customModelId,
        contextWindowLimit: 200_000,
      })
    })

    it('uses provided region', () => {
      const customRegion = 'eu-west-1'
      new BedrockModel({ region: customRegion })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith({
        region: customRegion,
        customUserAgent: 'strands-agents-ts-sdk',
        requestHandler: { requestTimeout: 120_000 },
      })
    })

    it('extends custom user agent if provided', () => {
      const customAgent = 'my-app/1.0'
      new BedrockModel({ region: 'us-west-2', clientConfig: { customUserAgent: customAgent } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith({
        region: 'us-west-2',
        customUserAgent: 'my-app/1.0 strands-agents-ts-sdk',
        requestHandler: { requestTimeout: 120_000 },
      })
    })

    it('passes custom endpoint to client', () => {
      const endpoint = 'https://vpce-abc.bedrock-runtime.us-west-2.vpce.amazonaws.com'
      const region = 'us-west-2'
      new BedrockModel({ region, clientConfig: { endpoint } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith({
        region,
        endpoint,
        customUserAgent: 'strands-agents-ts-sdk',
        requestHandler: { requestTimeout: 120_000 },
      })
    })

    it('passes custom credentials to client', () => {
      const credentials = {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }
      const region = 'us-west-2'
      new BedrockModel({ region, clientConfig: { credentials } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith({
        region,
        credentials,
        customUserAgent: 'strands-agents-ts-sdk',
        requestHandler: { requestTimeout: 120_000 },
      })
    })

    it('applies a default 120s request timeout', () => {
      new BedrockModel({ region: 'us-west-2' })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ requestHandler: { requestTimeout: 120_000 } })
      )
    })

    it('lets the caller override requestTimeout', () => {
      new BedrockModel({ region: 'us-west-2', clientConfig: { requestHandler: { requestTimeout: 5_000 } } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ requestHandler: { requestTimeout: 5_000 } })
      )
    })

    it('merges the default timeout with other requestHandler options', () => {
      new BedrockModel({ region: 'us-west-2', clientConfig: { requestHandler: { connectionTimeout: 1_000 } } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(
        expect.objectContaining({ requestHandler: { requestTimeout: 120_000, connectionTimeout: 1_000 } })
      )
    })

    it('passes a user-provided handler instance through untouched', () => {
      const handler = { handle: vi.fn(), updateHttpClientConfig: vi.fn(), httpHandlerConfigs: vi.fn() }
      new BedrockModel({ region: 'us-west-2', clientConfig: { requestHandler: handler } })
      expect(BedrockRuntimeClient).toHaveBeenCalledWith(expect.objectContaining({ requestHandler: handler }))
    })

    it('adds api key middleware when apiKey is provided', () => {
      const provider = new BedrockModel({ region: 'us-east-1', apiKey: 'br-test-key' })
      const mockAdd = provider['_client'].middlewareStack.add as ReturnType<typeof vi.fn>
      expect(mockAdd).toHaveBeenCalledWith(expect.any(Function), {
        step: 'finalizeRequest',
        priority: 'low',
        name: 'bedrockApiKeyMiddleware',
      })
    })

    it('does not add api key middleware when apiKey is not provided', () => {
      const provider = new BedrockModel({ region: 'us-east-1' })
      const mockAdd = provider['_client'].middlewareStack.add as ReturnType<typeof vi.fn>
      expect(mockAdd).not.toHaveBeenCalled()
    })

    it('api key middleware sets authorization header', async () => {
      const provider = new BedrockModel({ region: 'us-east-1', apiKey: 'br-test-key' })
      const mockAdd = provider['_client'].middlewareStack.add as ReturnType<typeof vi.fn>
      const middlewareFn = mockAdd.mock.calls[0]![0] as (
        next: (args: unknown) => Promise<unknown>
      ) => (args: unknown) => Promise<unknown>

      const mockNext = vi.fn(async (args: unknown) => args)
      const handler = middlewareFn(mockNext)
      const args = { request: { headers: { authorization: 'AWS4-HMAC-SHA256 ...' } } }
      await handler(args)

      expect(args.request.headers['authorization']).toBe('Bearer br-test-key')
      expect(mockNext).toHaveBeenCalledWith(args)
    })

    it('does not include apiKey in model config', () => {
      const provider = new BedrockModel({ region: 'us-east-1', apiKey: 'br-test-key', temperature: 0.5 })
      const config = provider.getConfig()
      expect(config).toStrictEqual({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        temperature: 0.5,
        contextWindowLimit: 1_000_000,
      })
    })

    it('includes contextWindowLimit in config when provided', () => {
      const provider = new BedrockModel({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        contextWindowLimit: 200_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        contextWindowLimit: 200_000,
      })
    })

    it('auto-populates contextWindowLimit from model ID lookup', () => {
      const provider = new BedrockModel({ modelId: 'anthropic.claude-sonnet-4-20250514-v1:0' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        contextWindowLimit: 1_000_000,
      })
    })

    it('auto-populates contextWindowLimit for cross-region model IDs', () => {
      const provider = new BedrockModel({ modelId: 'us.anthropic.claude-sonnet-4-6' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'us.anthropic.claude-sonnet-4-6',
        contextWindowLimit: 1_000_000,
      })
    })

    it('auto-populates contextWindowLimit for default model ID', () => {
      const provider = new BedrockModel()
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        contextWindowLimit: 1_000_000,
      })
    })

    it('does not override explicit contextWindowLimit', () => {
      const provider = new BedrockModel({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        contextWindowLimit: 100_000,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        contextWindowLimit: 100_000,
      })
    })

    it('leaves contextWindowLimit undefined for unknown model IDs', () => {
      const provider = new BedrockModel({ modelId: 'unknown.model-v1:0' })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'unknown.model-v1:0',
      })
    })
  })

  describe('updateConfig', () => {
    it('merges new config with existing config', () => {
      const provider = new BedrockModel({ region: 'us-west-2', temperature: 0.5 })
      provider.updateConfig({ temperature: 0.8, maxTokens: 2048 })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        temperature: 0.8,
        maxTokens: 2048,
        contextWindowLimit: 1_000_000,
      })
    })

    it('preserves fields not included in the update', () => {
      const provider = new BedrockModel({
        region: 'us-west-2',
        modelId: 'custom-model',
        temperature: 0.5,
        maxTokens: 1024,
      })
      provider.updateConfig({ temperature: 0.8 })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'custom-model',
        temperature: 0.8,
        maxTokens: 1024,
      })
    })

    it('re-resolves contextWindowLimit when modelId changes and it was auto-resolved', () => {
      const provider = new BedrockModel({ region: 'us-west-2' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_000_000)

      provider.updateConfig({ modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0' })
      expect(provider.getConfig().contextWindowLimit).toBe(200_000)
    })

    it('clears contextWindowLimit when modelId changes to unknown model', () => {
      const provider = new BedrockModel({ region: 'us-west-2' })
      expect(provider.getConfig().contextWindowLimit).toBe(1_000_000)

      provider.updateConfig({ modelId: 'my-custom-finetuned-model' })
      expect(provider.getConfig().contextWindowLimit).toBeUndefined()
    })

    it('preserves explicit contextWindowLimit when modelId changes', () => {
      const provider = new BedrockModel({ region: 'us-west-2', contextWindowLimit: 50_000 })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)

      provider.updateConfig({ modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0' })
      expect(provider.getConfig().contextWindowLimit).toBe(50_000)
    })
  })

  describe('getConfig', () => {
    it('returns the current configuration', () => {
      const provider = new BedrockModel({
        region: 'us-west-2',
        modelId: 'test-model',
        maxTokens: 1024,
        temperature: 0.7,
      })
      expect(provider.getConfig()).toStrictEqual({
        modelId: 'test-model',
        maxTokens: 1024,
        temperature: 0.7,
      })
    })
  })

  describe('format_message', async () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)
    it('formats the request to bedrock properly', async () => {
      const provider = new BedrockModel({
        region: 'us-west-2',
        modelId: 'anthropic.claude-test-model',
        maxTokens: 1024,
        temperature: 0.7,
        topP: 0.9,
        stopSequences: ['STOP'],
        cacheConfig: { strategy: 'auto' },
        additionalResponseFieldPaths: ['Hello!'],
        additionalRequestFields: ['World!'],
        additionalArgs: {
          MyExtraArg: 'ExtraArg',
        },
      })

      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const options: StreamOptions = {
        systemPrompt: 'You are a helpful assistant',
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Perform calculations',
            inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
          },
        ],
        toolChoice: { auto: {} },
      }

      // Trigger the stream to make the request, but ignore the events for now
      collectIterator(provider.stream(messages, options))

      // Verify ConverseStreamCommand was called with properly formatted request
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        MyExtraArg: 'ExtraArg',
        additionalModelRequestFields: ['World!'],
        additionalModelResponseFieldPaths: ['Hello!'],
        modelId: 'anthropic.claude-test-model',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }, { cachePoint: { type: 'default' } }],
          },
        ],
        system: [{ text: 'You are a helpful assistant' }, { cachePoint: { type: 'default' } }],
        toolConfig: {
          toolChoice: { auto: {} },
          tools: [
            {
              toolSpec: {
                name: 'calculator',
                description: 'Perform calculations',
                inputSchema: { json: { type: 'object', properties: { expression: { type: 'string' } } } },
              },
            },
            { cachePoint: { type: 'default' } },
          ],
        },
        inferenceConfig: {
          maxTokens: 1024,
          temperature: 0.7,
          topP: 0.9,
          stopSequences: ['STOP'],
        },
      })
    })

    it('formats tool use messages', async () => {
      const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'assistant',
          content: [
            new ToolUseBlock({
              name: 'calculator',
              toolUseId: 'tool-123',
              input: { a: 5, b: 3 },
            }),
          ],
        }),
      ]

      // Run the stream but ignore the output
      collectIterator(provider.stream(messages))

      // Verify ConverseStreamCommand was called with properly formatted request
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: expect.arrayContaining([
                expect.objectContaining({
                  toolUse: expect.objectContaining({
                    name: 'calculator',
                    toolUseId: 'tool-123',
                    input: { a: 5, b: 3 },
                  }),
                }),
              ]),
            }),
          ]),
        })
      )
    })

    it('formats tool result messages', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-123',
              status: 'success',
              content: [new TextBlock('Result: 8'), new JsonBlock({ json: { hello: 'world' } })],
            }),
          ],
        }),
      ]

      // Start the stream
      collectIterator(provider.stream(messages))

      // Verify ConverseStreamCommand was called with properly formatted request
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            content: [
              {
                toolResult: {
                  content: [
                    {
                      text: 'Result: 8',
                    },
                    {
                      json: {
                        hello: 'world',
                      },
                    },
                  ],
                  status: 'success',
                  toolUseId: 'tool-123',
                },
              },
            ],
            role: 'user',
          },
        ],
        toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
        modelId: expect.any(String),
      })
    })

    it('injects noop tool config when messages have tool blocks but no toolSpecs', async () => {
      const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'calc', toolUseId: 'id-1', input: { a: 1 } })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'id-1', status: 'success', content: [new TextBlock('42')] })],
        }),
        new Message({ role: 'user', content: [new TextBlock('Summarize')] }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
        })
      )
    })

    it('does not inject noop tool config when messages have no tool blocks', async () => {
      const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.calls[0]![0] as unknown as Record<string, unknown>
      expect(call.toolConfig).toBeUndefined()
    })

    it('does not inject noop tool config when toolSpecs are provided', async () => {
      const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'calc', toolUseId: 'id-1', input: {} })],
        }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'id-1', status: 'success', content: [new TextBlock('ok')] })],
        }),
      ]

      const options: StreamOptions = {
        toolSpecs: [{ name: 'calc', description: 'Calculator', inputSchema: { type: 'object', properties: {} } }],
      }
      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.calls[0]![0] as unknown as Record<string, unknown>
      const toolConfig = call.toolConfig as { tools: Array<{ toolSpec?: { name: string } }> }
      expect(toolConfig.tools[0]!.toolSpec!.name).toBe('calc')
      expect(toolConfig.tools.length).toBe(1)
    })

    it('formats tool specs without outputSchema in Bedrock requests', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: { result: { type: 'number' } },
            },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.toolConfig?.tools).toStrictEqual([
        {
          toolSpec: {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { json: { type: 'object' } },
          },
        },
      ])
    })

    it('formats reasoning messages properly', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ReasoningBlock({
              text: 'Hello',
              signature: 'World',
            }),
            new ReasoningBlock({
              redactedContent: new Uint8Array(1),
            }),
          ],
        }),
      ]

      // Start the stream but don't await it
      collectIterator(provider.stream(messages))

      // Verify ConverseStreamCommand was called with properly formatted request
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            role: 'user',
            content: [
              {
                reasoningContent: {
                  reasoningText: {
                    signature: 'World',
                    text: 'Hello',
                  },
                },
              },
              {
                reasoningContent: {
                  redactedContent: new Uint8Array(1),
                },
              },
            ],
          },
        ],
        modelId: expect.any(String),
      })
    })

    it('formats a signature-only reasoning block', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'assistant',
          content: [new ReasoningBlock({ signature: 'sig-abc' }), new TextBlock('the answer')],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                reasoningContent: {
                  reasoningText: {
                    text: '',
                    signature: 'sig-abc',
                  },
                },
              },
              { text: 'the answer' },
            ],
          },
        ],
        modelId: expect.any(String),
      })
    })

    it('formats cache point blocks in messages', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Message with cache point'), new CachePointBlock({ cacheType: 'default' })],
        }),
      ]

      collectIterator(provider.stream(messages))

      // Verify ConverseStreamCommand was called with properly formatted request
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Message with cache point' }, { cachePoint: { type: 'default' } }],
          },
        ],
        modelId: expect.any(String),
      })
    })

    it('preserves ttl on user-supplied cache point blocks in messages', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Message with 1h cache point'),
            new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Message with 1h cache point' }, { cachePoint: { type: 'default', ttl: '1h' } }],
          },
        ],
        modelId: expect.any(String),
      })
    })

    // https://github.com/strands-agents/harness-sdk/issues/3759
    it.each([null, ''])('omits a falsy ttl on user-supplied cache point blocks in messages', async (ttl) => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Message with cache point'),
            new CachePointBlock({ cacheType: 'default', ttl: ttl as unknown as string }),
          ],
        }),
      ]

      await collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        messages: [
          {
            role: 'user',
            content: [{ text: 'Message with cache point' }, { cachePoint: { type: 'default' } }],
          },
        ],
        modelId: expect.any(String),
      })
    })

    it('preserves ttl on cache point blocks in system prompt', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          new TextBlock('You are a helpful assistant'),
          new CachePointBlock({ cacheType: 'default', ttl: '5m' }),
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([
        { text: 'You are a helpful assistant' },
        { cachePoint: { type: 'default', ttl: '5m' } },
      ])
    })

    it('forwards arbitrary ttl strings without client-side validation (Bedrock validates server-side)', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('Hello'), new CachePointBlock({ cacheType: 'default', ttl: '2h' })],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default', ttl: '2h' } })
    })
  })

  describe.each([
    { mode: 'streaming', stream: true },
    { mode: 'non-streaming', stream: false },
  ])('BedrockModel in $mode mode', ({ stream }) => {
    it('yields and validates text events correctly', async () => {
      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield { contentBlockStart: {} }
              yield { contentBlockDelta: { delta: { text: 'Hello' } } }
              yield { contentBlockStop: {} }
              yield { messageStop: { stopReason: 'end_turn' } }
              yield {
                metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 100 } },
              }
            })(),
          }
        } else {
          return {
            output: { message: { role: 'assistant', content: [{ text: 'Hello' }] } },
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            metrics: { latencyMs: 100 },
          }
        }
      })

      mockBedrockClientImplementation({ send: mockSend })

      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({ role: 'assistant', type: 'modelMessageStartEvent' })
      expect(events).toContainEqual({ type: 'modelContentBlockStartEvent' })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'textDelta', text: 'Hello' },
      })
      expect(events).toContainEqual({ type: 'modelContentBlockStopEvent' })
      expect(events).toContainEqual({ type: 'modelMessageStopEvent', stopReason: 'endTurn' })
      expect(events).toContainEqual({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        metrics: { latencyMs: 100 },
      })
    })

    it('yields and validates toolUse events correctly', async () => {
      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield {
                contentBlockStart: {
                  start: { toolUse: { toolUseId: 'tool-use-123', name: 'get_weather' } },
                },
              }
              yield {
                contentBlockDelta: {
                  delta: { toolUse: { input: '{"location":"San Francisco"}' } },
                },
              }
              yield { contentBlockStop: {} }
              yield { messageStop: { stopReason: 'tool_use' } }
              yield {
                metadata: {
                  usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
                  metrics: { latencyMs: 120 },
                },
              }
            })(),
          }
        } else {
          return {
            output: {
              message: {
                role: 'assistant',
                content: [
                  { toolUse: { toolUseId: 'tool-use-123', name: 'get_weather', input: { location: 'San Francisco' } } },
                ],
              },
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
            metrics: { latencyMs: 120 },
          }
        }
      })
      mockBedrockClientImplementation({ send: mockSend })

      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Weather?')] })]
      const events = await collectIterator(provider.stream(messages))
      const startEvent = events.find((e) => e.type === 'modelContentBlockStartEvent')
      const inputDeltaEvent = events.find(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'toolUseInputDelta'
      )

      expect(events).toContainEqual({ role: 'assistant', type: 'modelMessageStartEvent' })
      expect(startEvent).toStrictEqual({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'tool-use-123' },
      })
      expect(inputDeltaEvent).toStrictEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"location":"San Francisco"}' },
      })
      expect(events).toContainEqual({ type: 'modelContentBlockStopEvent' })
      expect(events).toContainEqual({ stopReason: 'toolUse', type: 'modelMessageStopEvent' })
      expect(events).toContainEqual({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
        metrics: { latencyMs: 120 },
      })
    })

    it('yields and validates reasoningText events correctly', async () => {
      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield { contentBlockStart: {} }
              yield {
                contentBlockDelta: { delta: { reasoningContent: { text: 'Thinking...' } } },
              }
              yield { contentBlockStop: {} }
              yield { messageStop: { stopReason: 'end_turn' } }
              yield {
                metadata: {
                  usage: { inputTokens: 15, outputTokens: 30, totalTokens: 45 },
                  metrics: { latencyMs: 150 },
                },
              }
            })(),
          }
        } else {
          return {
            output: {
              message: {
                role: 'assistant',
                content: [{ reasoningContent: { reasoningText: { text: 'Thinking...' } } }],
              },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 15, outputTokens: 30, totalTokens: 45 },
            metrics: { latencyMs: 150 },
          }
        }
      })
      mockBedrockClientImplementation({ send: mockSend })

      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('A question.')] })]
      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({ role: 'assistant', type: 'modelMessageStartEvent' })
      expect(events).toContainEqual({ type: 'modelContentBlockStartEvent' })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: 'Thinking...' },
      })
      expect(events).toContainEqual({ type: 'modelContentBlockStopEvent' })
      expect(events).toContainEqual({ stopReason: 'endTurn', type: 'modelMessageStopEvent' })
      expect(events).toContainEqual({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 15, outputTokens: 30, totalTokens: 45 },
        metrics: { latencyMs: 150 },
      })
    })

    it('yields and validates redactedContent events correctly', async () => {
      const redactedBytes = new Uint8Array([1, 2, 3])

      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield { contentBlockStart: {} }
              yield {
                contentBlockDelta: {
                  delta: { reasoningContent: { redactedContent: redactedBytes } },
                },
              }
              yield { contentBlockStop: {} }
              yield { messageStop: { stopReason: 'end_turn' } }
              yield {
                metadata: { usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 }, metrics: { latencyMs: 110 } },
              }
            })(),
          }
        } else {
          return {
            output: {
              message: {
                role: 'assistant',
                content: [{ reasoningContent: { redactedContent: redactedBytes } }],
              },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
            metrics: { latencyMs: 110 },
          }
        }
      })
      mockBedrockClientImplementation({ send: mockSend })

      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('A sensitive question.')] })]
      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({ role: 'assistant', type: 'modelMessageStartEvent' })
      expect(events).toContainEqual({ type: 'modelContentBlockStartEvent' })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', redactedContent: redactedBytes },
      })
      expect(events).toContainEqual({ type: 'modelContentBlockStopEvent' })
      expect(events).toContainEqual({ stopReason: 'endTurn', type: 'modelMessageStopEvent' })
      expect(events).toContainEqual({
        type: 'modelMetadataEvent',
        usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
        metrics: { latencyMs: 110 },
      })
    })

    it('yields and validates citation events correctly', async () => {
      // Bedrock streaming sends individual citation deltas with key 'citation'
      const bedrockCitationDelta = {
        location: { documentChar: { documentIndex: 0, start: 10, end: 50 } },
        sourceContent: [{ text: 'source text' }],
        source: 'doc-0',
        title: 'Test Doc',
      }

      // Bedrock non-streaming wire format uses object-key discrimination
      const bedrockCitationsData = {
        citations: [bedrockCitationDelta],
        content: [{ text: 'generated text' }],
      }

      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield { contentBlockStart: {} }
              yield {
                contentBlockDelta: {
                  delta: { citation: bedrockCitationDelta },
                },
              }
              yield { contentBlockStop: {} }
              yield { messageStop: { stopReason: 'end_turn' } }
              yield {
                metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 100 } },
              }
            })(),
          }
        } else {
          return {
            output: {
              message: {
                role: 'assistant',
                content: [{ citationsContent: bedrockCitationsData }],
              },
            },
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            metrics: { latencyMs: 100 },
          }
        }
      })
      mockBedrockClientImplementation({ send: mockSend })

      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Cite this.')] })]
      const events = await collectIterator(provider.stream(messages))

      // SDK events should use type-field discrimination
      expect(events).toContainEqual({ role: 'assistant', type: 'modelMessageStartEvent' })
      expect(events).toContainEqual({ type: 'modelContentBlockStartEvent' })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'citationsDelta',
          citations: [
            {
              location: { type: 'documentChar', documentIndex: 0, start: 10, end: 50 },
              sourceContent: [{ text: 'source text' }],
              source: 'doc-0',
              title: 'Test Doc',
            },
          ],
          content: stream ? [] : [{ text: 'generated text' }],
        },
      })
      expect(events).toContainEqual({ type: 'modelContentBlockStopEvent' })
      expect(events).toContainEqual({ stopReason: 'endTurn', type: 'modelMessageStopEvent' })
    })

    describe('error handling', async () => {
      it.each([
        {
          name: 'ContextWindowOverflowError for context overflow',
          error: new Error('Input is too long for requested model'),
          expected: ContextWindowOverflowError,
        },
        {
          name: 'ValidationException for invalid input',
          error: new ValidationException({ message: 'ValidationException', $metadata: {} }),
          expected: ValidationException,
        },
      ])('throws $name', async ({ error, expected }) => {
        vi.clearAllMocks()
        const mockSendError = vi.fn().mockRejectedValue(error)
        mockBedrockClientImplementation({ send: mockSendError })

        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        await expect(collectIterator(provider.stream(messages))).rejects.toThrow(expected)
      })

      it('throws for a reasoning block with no text, signature, or redacted content', async () => {
        const provider = new BedrockModel()
        const messages = [
          new Message({
            role: 'assistant',
            content: [new ReasoningBlock({})],
          }),
        ]

        await expect(collectIterator(provider.stream(messages))).rejects.toThrow(
          "reasoning content requires one of 'text', 'signature', or 'redactedContent' to be set"
        )
      })
    })
  })

  describe('stream', () => {
    it.each([
      { mode: 'streaming', stream: true },
      { mode: 'non-streaming', stream: false },
    ])('passes the cancellation signal to the $mode Bedrock request', async ({ stream }) => {
      const mockSend = vi.fn(async () => {
        if (stream) {
          return {
            stream: (async function* (): AsyncGenerator<unknown> {
              yield { messageStart: { role: 'assistant' } }
              yield { messageStop: { stopReason: 'end_turn' } }
            })(),
          }
        }
        return {
          output: { message: { role: 'assistant', content: [{ text: 'Hello' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 100 },
        }
      })
      mockBedrockClientImplementation({ send: mockSend })
      const controller = new AbortController()
      const provider = new BedrockModel({ stream })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(provider.stream(messages, { cancelSignal: controller.signal }))

      expect(mockSend).toHaveBeenCalledWith(expect.anything(), { abortSignal: controller.signal })
    })

    it('stops a fake in-flight Bedrock producer when the signal aborts', async () => {
      let producedTokens = 0
      let producerStopped = false
      let resolveFirstToken!: () => void
      const firstTokenProduced = new Promise<void>((resolve) => {
        resolveFirstToken = resolve
      })
      const mockSend = vi.fn(async (_command: unknown, sendOptions?: unknown) => {
        const signal = (sendOptions as { abortSignal?: AbortSignal } | undefined)?.abortSignal
        return {
          stream: (async function* (): AsyncGenerator<unknown> {
            yield { messageStart: { role: 'assistant' } }
            yield { contentBlockStart: { start: {}, contentBlockIndex: 0 } }
            while (producedTokens < 20) {
              if (signal?.aborted) {
                producerStopped = true
                break
              }
              producedTokens += 1
              if (producedTokens === 1) {
                resolveFirstToken()
              }
              yield { contentBlockDelta: { delta: { text: 'token ' }, contentBlockIndex: 0 } }
              await new Promise<void>((resolve) => setTimeout(resolve, 1))
            }
            yield { contentBlockStop: { contentBlockIndex: 0 } }
            yield { messageStop: { stopReason: 'end_turn' } }
          })(),
        }
      })
      mockBedrockClientImplementation({ send: mockSend })
      const controller = new AbortController()
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const streamResult = collectIterator(provider.stream(messages, { cancelSignal: controller.signal }))
      await firstTokenProduced
      const tokensAtCancel = producedTokens
      controller.abort()
      await streamResult

      expect(producerStopped).toBe(true)
      expect(producedTokens).toBe(tokensAtCancel)
    })

    it('handles tool use input delta', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield {
          contentBlockStart: { start: { toolUse: { name: 'calc', toolUseId: 'id' } } },
        }
        yield { contentBlockDelta: { delta: { toolUse: { input: '{"a": 1}' } } } }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'tool_use' } }
        yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'toolUseInputDelta',
          input: '{"a": 1}',
        },
      })
    })

    it('handles reasoning content delta with both text and signature, as well as redactedContent', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield {
          contentBlockDelta: {
            delta: { reasoningContent: { text: 'thinking...', signature: 'sig123' } },
          },
        }
        yield {
          contentBlockDelta: {
            delta: { reasoningContent: { redactedContent: new Uint8Array(1) } },
          },
        }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn' } }
        yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'reasoningContentDelta',
          text: 'thinking...',
          signature: 'sig123',
        },
      })
      expect(events).toContainEqual({
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'reasoningContentDelta',
          redactedContent: new Uint8Array(1),
        },
      })
    })

    it('handles reasoning content delta with only text, skips unsupported types', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield {
          contentBlockDelta: {
            delta: { reasoningContent: { text: 'thinking...' } },
          },
        }
        yield {
          contentBlockDelta: {
            delta: { unknown: 'type' },
          },
        }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn' } }
        yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        yield { unknown: 'type' }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      const reasoningDelta = events.find(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'reasoningContentDelta'
      )
      expect(reasoningDelta).toBeDefined()
      if (
        reasoningDelta?.type === 'modelContentBlockDeltaEvent' &&
        reasoningDelta.delta.type === 'reasoningContentDelta'
      ) {
        expect(reasoningDelta.delta.text).toBe('thinking...')
        expect(reasoningDelta.delta.signature).toBeUndefined()
      }
    })

    it('handles reasoning content delta with only signature', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield {
          contentBlockDelta: {
            delta: { reasoningContent: { signature: 'sig123' } },
          },
        }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn' } }
        yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      const reasoningDelta = events.find(
        (e) => e.type === 'modelContentBlockDeltaEvent' && e.delta.type === 'reasoningContentDelta'
      )
      expect(reasoningDelta).toBeDefined()
      if (
        reasoningDelta?.type === 'modelContentBlockDeltaEvent' &&
        reasoningDelta.delta.type === 'reasoningContentDelta'
      ) {
        expect(reasoningDelta.delta.text).toBeUndefined()
        expect(reasoningDelta.delta.signature).toBe('sig123')
      }
    })

    it('handles cache usage metrics', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield { contentBlockDelta: { delta: { text: 'Hello' } } }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn' } }
        yield {
          metadata: {
            usage: {
              inputTokens: 100,
              outputTokens: 50,
              totalTokens: 150,
              cacheReadInputTokens: 80,
              cacheWriteInputTokens: 20,
            },
          },
        }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toBeDefined()
      if (metadataEvent?.type === 'modelMetadataEvent') {
        expect(metadataEvent.usage?.cacheReadInputTokens).toBe(80)
        expect(metadataEvent.usage?.cacheWriteInputTokens).toBe(20)
      }
    })

    it('handles trace in metadata', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield { contentBlockDelta: { delta: { text: 'Hello' } } }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn' } }
        yield {
          metadata: {
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            trace: { guardrail: { action: 'INTERVENED' } },
          },
        }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      const metadataEvent = events.find((e) => e.type === 'modelMetadataEvent')
      expect(metadataEvent).toBeDefined()
      if (metadataEvent?.type === 'modelMetadataEvent') {
        expect(metadataEvent.trace).toBeDefined()
      }
    })

    it('handles additionalModelResponseFields', async () => {
      setupMockSend(async function* () {
        yield { messageStart: { role: 'assistant' } }
        yield { contentBlockStart: {} }
        yield { contentBlockDelta: { delta: { text: 'Hello' } } }
        yield { contentBlockStop: {} }
        yield { messageStop: { stopReason: 'end_turn', additionalModelResponseFields: { customField: 'value' } } }
        yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
      })

      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(provider.stream(messages))

      const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
      expect(stopEvent).toBeDefined()
      if (stopEvent?.type === 'modelMessageStopEvent') {
        expect(stopEvent.additionalModelResponseFields).toStrictEqual({ customField: 'value' })
      }
    })

    describe('handles all stop reason types', () => {
      const stopReasons = [
        ['end_turn', 'endTurn'],
        ['tool_use', 'toolUse'],
        ['max_tokens', 'maxTokens'],
        ['stop_sequence', 'stopSequence'],
        ['content_filtered', 'contentFiltered'],
        ['guardrail_intervened', 'guardrailIntervened'],
        ['model_context_window_exceeded', 'modelContextWindowExceeded'],
        ['new_stop_reason', 'newStopReason'],
      ]
      for (const [bedrockReason, expectedReason] of stopReasons) {
        it(`handles ${bedrockReason} stop reason types`, async () => {
          setupMockSend(async function* () {
            yield { messageStart: { role: 'assistant' } }
            yield { messageStop: { stopReason: bedrockReason } }
            yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
          })

          const provider = new BedrockModel()
          const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

          const events = []
          for await (const event of provider.stream(messages)) {
            events.push(event)
          }

          const stopEvent = events.find((e) => e.type === 'modelMessageStopEvent')
          expect(stopEvent).toBeDefined()
          if (stopEvent?.type === 'modelMessageStopEvent') {
            expect(stopEvent.stopReason).toBe(expectedReason)
          }
        })
      }
    })

    describe('throttling', () => {
      it('throws ModelThrottledError when throttlingException is received', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { throttlingException: { message: 'Rate exceeded' } }
        })

        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // consume stream
          }
        }).rejects.toThrow(ModelThrottledError)
      })

      it('includes throttling message in ModelThrottledError', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { throttlingException: { message: 'Too many requests' } }
        })

        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // consume stream
          }
        }).rejects.toThrow('Too many requests')
      })

      it('uses default message when throttlingException has no message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { throttlingException: {} }
        })

        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        await expect(async () => {
          for await (const _ of provider.stream(messages)) {
            // consume stream
          }
        }).rejects.toThrow('Request was throttled by the model provider')
      })
    })
  })

  describe('system prompt formatting', async () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('appends a cache point to a string system prompt with cacheConfig', async () => {
      // Regression guard for https://github.com/strands-agents/harness-sdk/issues/3144.
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: 'You are a helpful assistant',
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }, { cachePoint: { type: 'default' } }],
          },
        ],
        system: [{ text: 'You are a helpful assistant' }, { cachePoint: { type: 'default' } }],
      })
    })

    it('formats array system prompt with text blocks only', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          { type: 'textBlock', text: 'You are a helpful assistant' },
          { type: 'textBlock', text: 'Additional context here' },
        ] as SystemContentBlock[],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [{ text: 'You are a helpful assistant' }, { text: 'Additional context here' }],
      })
    })

    it('formats array system prompt with cache points', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          { type: 'textBlock', text: 'You are a helpful assistant' },
          { type: 'textBlock', text: 'Large context document' },
          { type: 'cachePointBlock', cacheType: 'default' },
        ] as SystemContentBlock[],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [
          { text: 'You are a helpful assistant' },
          { text: 'Large context document' },
          { cachePoint: { type: 'default' } },
        ],
      })
    })

    it('does not warn when array system prompt is provided without cacheConfig', async () => {
      const provider = new BedrockModel()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          { type: 'textBlock', text: 'You are a helpful assistant' },
          { type: 'cachePointBlock', cacheType: 'default' },
        ] as SystemContentBlock[],
      }

      collectIterator(provider.stream(messages, options))

      // Verify no warning was logged
      expect(warnSpy).not.toHaveBeenCalled()

      // Verify array is used as-is
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [{ text: 'You are a helpful assistant' }, { cachePoint: { type: 'default' } }],
      })

      warnSpy.mockRestore()
    })

    it('adds cache point after tools when cacheConfig enabled', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }, { cachePoint: { type: 'default' } }],
          },
        ],
        toolConfig: {
          tools: [
            {
              toolSpec: {
                name: 'calculator',
                description: 'Calculate',
                inputSchema: { json: { type: 'object' } },
              },
            },
            { cachePoint: { type: 'default' } },
          ],
        },
      })
    })

    it('adds cache points to tools and messages when cacheConfig enabled', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Hello')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Hi')] }),
      ]
      const options: StreamOptions = {
        systemPrompt: 'You are a helpful assistant',
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'You are a helpful assistant' }, { cachePoint: { type: 'default' } }])
      expect(call?.toolConfig?.tools).toStrictEqual([
        {
          toolSpec: {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { json: { type: 'object' } },
          },
        },
        { cachePoint: { type: 'default' } },
      ])
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default' } })
      const assistantMsg = call?.messages?.[1]
      const assistantLastBlock = assistantMsg?.content?.[assistantMsg.content.length - 1]
      expect(assistantLastBlock).not.toStrictEqual({ cachePoint: { type: 'default' } })
    })

    it('propagates cacheConfig ttls independently to tools and last user message', async () => {
      const provider = new BedrockModel({
        cacheConfig: { strategy: 'auto', toolsTTL: '1h', messagesTTL: '5m' },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.toolConfig?.tools).toStrictEqual([
        {
          toolSpec: {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { json: { type: 'object' } },
          },
        },
        { cachePoint: { type: 'default', ttl: '1h' } },
      ])
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default', ttl: '5m' } })
    })

    it('propagates only toolsTTL when messagesTTL is not set', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', toolsTTL: '1h' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      const toolsLast = call?.toolConfig?.tools?.[call.toolConfig.tools.length - 1]
      expect(toolsLast).toStrictEqual({ cachePoint: { type: 'default', ttl: '1h' } })
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default' } })
    })

    it('propagates only messagesTTL when toolsTTL is not set', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      const toolsLast = call?.toolConfig?.tools?.[call.toolConfig.tools.length - 1]
      expect(toolsLast).toStrictEqual({ cachePoint: { type: 'default' } })
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default', ttl: '1h' } })
    })

    it('omits ttl on auto-injected cache points when no ttl is set', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        toolSpecs: [
          {
            name: 'calculator',
            description: 'Calculate',
            inputSchema: { type: 'object' },
          },
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      const toolsLast = call?.toolConfig?.tools?.[call.toolConfig.tools.length - 1]
      expect(toolsLast).toStrictEqual({ cachePoint: { type: 'default' } })
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default' } })
    })

    it('applies the configured messagesTTL over a null ttl on the caller point', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
      const point = new CachePointBlock({ cacheType: 'default' })
      // Off the typed path, but reachable from untyped JSON: a null ttl is not a ttl.
      ;(point as unknown as { ttl: string | null }).ttl = null
      const messages = [new Message({ role: 'user', content: [new TextBlock('durable ask'), point] })]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default', ttl: '1h' } },
      ])
    })

    it('replaces a leading caller-placed cache point with automatic placement', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [new CachePointBlock({ cacheType: 'default' }), new TextBlock('durable ask')],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([{ text: 'durable ask' }, { cachePoint: { type: 'default' } }])
    })

    it('leaves a message that was only a cache point empty', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new CachePointBlock({ cacheType: 'default' })] })]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([])
    })

    it('honors a cache point the caller placed in the last user message', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('<context-status>rebuilt each call</context-status>'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default' } },
        { text: '<context-status>rebuilt each call</context-status>' },
      ])
    })

    it('keeps only the first of three cache points, and gives it the configured ttl', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('per-call'),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('more per-call'),
            new CachePointBlock({ cacheType: 'default' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default', ttl: '1h' } },
        { text: 'per-call' },
        { text: 'more per-call' },
      ])
    })

    it('relocates an honored cache point over the adjacent document run only', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const earlier = new DocumentBlock({ name: 'earlier', format: 'md', source: { bytes: new Uint8Array([1]) } })
      const adjacent = new DocumentBlock({ name: 'adjacent', format: 'md', source: { bytes: new Uint8Array([2]) } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('analyze these'),
            earlier,
            new TextBlock('notes'),
            adjacent,
            new CachePointBlock({ cacheType: 'default' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'analyze these' },
        { document: { name: 'earlier', format: 'md', source: { bytes: new Uint8Array([1]) } } },
        { text: 'notes' },
        { cachePoint: { type: 'default' } },
        { document: { name: 'adjacent', format: 'md', source: { bytes: new Uint8Array([2]) } } },
      ])
    })

    it('still strips cache points in earlier messages', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [new TextBlock('old ask'), new CachePointBlock({ cacheType: 'default' })],
        }),
        new Message({ role: 'assistant', content: [new TextBlock('reply')] }),
        new Message({
          role: 'user',
          content: [new TextBlock('new ask'), new CachePointBlock({ cacheType: 'default' })],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.map((msg) => msg.content)).toStrictEqual([
        [{ text: 'old ask' }],
        [{ text: 'reply' }],
        [{ text: 'new ask' }, { cachePoint: { type: 'default' } }],
      ])
    })

    it('applies the configured messagesTTL to an honored cache point without one', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default', ttl: '1h' } },
        { text: 'per-call' },
      ])
    })

    it('does not forward an empty configured messagesTTL', async () => {
      // "" is not a TTL - Bedrock rejects it against its enum - and Python drops it, so TS must too.
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '' as never } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default' } },
        { text: 'per-call' },
      ])
    })

    it('normalizes the ttl of a relocated cache point', async () => {
      // The relocation path must normalize too: a caller ttl there is just as capable of a rejection.
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '5m' } })
      const doc = new DocumentBlock({ name: 'd', format: 'md', source: { bytes: new Uint8Array([1]) } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('analyze'),
            doc,
            new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'analyze' },
        { cachePoint: { type: 'default', ttl: '5m' } },
        { document: { name: 'd', format: 'md', source: { bytes: new Uint8Array([1]) } } },
        { text: 'per-call' },
      ])
    })

    it('normalizes a hand-placed ttl to the configured one', async () => {
      // A caller ttl can invalidate the request: Bedrock rejects a longer ttl after a shorter one.
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
      const messages = [
        new Message({
          role: 'user',
          // A trailing block makes the honored POSITION observable: a strip-and-re-append would move
          // the point to the end, so this also fails against the behaviour this change replaces.
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default', ttl: '5m' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default', ttl: '1h' } },
        { text: 'per-call' },
      ])
    })

    it('drops a hand-placed ttl when no messagesTTL is configured', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('durable ask'),
            new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'durable ask' },
        { cachePoint: { type: 'default' } },
        { text: 'per-call' },
      ])
    })

    it('relocates an honored cache point ahead of a directly preceding non-PDF document', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('analyze this'),
            new DocumentBlock({ name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } }),
            new CachePointBlock({ cacheType: 'default' }),
            new TextBlock('per-call'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'analyze this' },
        { cachePoint: { type: 'default' } },
        { document: { name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } } },
        { text: 'per-call' },
      ])
    })

    it('does not relocate an honored cache point a document does not directly precede', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('analyze this'),
            new DocumentBlock({ name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } }),
            new TextBlock('notes'),
            new CachePointBlock({ cacheType: 'default' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'analyze this' },
        { document: { name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } } },
        { text: 'notes' },
        { cachePoint: { type: 'default' } },
      ])
    })

    it('leaves an honored cache point after a PDF document', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('analyze this'),
            new DocumentBlock({ name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } }),
            new CachePointBlock({ cacheType: 'default' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'analyze this' },
        { document: { name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } } },
        { cachePoint: { type: 'default' } },
      ])
    })

    it('drops an honored cache point when a non-PDF document leads the message', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new DocumentBlock({ name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } }),
            new CachePointBlock({ cacheType: 'default' }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { document: { name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } } },
      ])
    })

    describe('cache sections', () => {
      const toolSpecs = [{ name: 'calculator', description: 'Calculate', inputSchema: { type: 'object' as const } }]
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      /** The auto-injected cache points, as [tools, lastUserMessage]. */
      const cachePoints = (): [unknown, unknown] => {
        const call = mockConverseStreamCommand.mock.lastCall?.[0]
        const tools = call?.toolConfig?.tools ?? []
        const userMsg = call?.messages?.[0]
        const content = userMsg?.content ?? []
        const toolsLast = tools[tools.length - 1]
        const messagesLast = content[content.length - 1]
        return [
          toolsLast && 'cachePoint' in toolsLast ? toolsLast.cachePoint : undefined,
          messagesLast && 'cachePoint' in messagesLast ? messagesLast.cachePoint : undefined,
        ]
      }

      /** The cache points in `system`, in order. */
      const systemCachePoints = (): unknown[] =>
        (mockConverseStreamCommand.mock.lastCall?.[0]?.system ?? [])
          .filter((block) => 'cachePoint' in block)
          .map((block) => ('cachePoint' in block ? block.cachePoint : undefined))

      const systemPromptWith = (ttl?: string): SystemContentBlock[] => [
        new TextBlock('durable system prompt'),
        new CachePointBlock({ cacheType: 'default', ...(ttl === undefined ? {} : { ttl }) }),
      ]

      it('caches every section when no strategy is given', async () => {
        // strategy defaults to 'auto', so a config that omits it still enables caching.
        const provider = new BedrockModel({ cacheConfig: {} })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([{ type: 'default' }, { type: 'default' }])
      })

      it('caches only the tool definitions when messagesTTL is false', async () => {
        const provider = new BedrockModel({ cacheConfig: { messagesTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([{ type: 'default' }, undefined])
      })

      it('caches only the conversation when toolsTTL is false', async () => {
        const provider = new BedrockModel({ cacheConfig: { toolsTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([undefined, { type: 'default' }])
      })

      it('emits nothing when every section is disabled', async () => {
        const provider = new BedrockModel({ cacheConfig: { toolsTTL: false, messagesTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([undefined, undefined])
      })

      it('applies the shared ttl to both sections', async () => {
        // Bedrock requires checkpoint TTLs to be non-increasing across toolConfig then messages, which
        // equal values satisfy.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([
          { type: 'default', ttl: '1h' },
          { type: 'default', ttl: '1h' },
        ])
      })

      it('lets a per-section ttl override the shared ttl', async () => {
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', messagesTTL: '5m' } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([
          { type: 'default', ttl: '1h' },
          { type: 'default', ttl: '5m' },
        ])
      })

      it('treats an empty ttl as unset rather than shipping it', async () => {
        // Bedrock validates ttl against an enum and rejects ''.
        const provider = new BedrockModel({ cacheConfig: { ttl: '', messagesTTL: '' } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([{ type: 'default' }, { type: 'default' }])
      })

      it('falls through an empty per-section ttl to the shared ttl', async () => {
        // An empty section ttl is unconfigured rather than an override, so the shared one applies.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', messagesTTL: '' } })

        collectIterator(provider.stream(messages, { toolSpecs }))

        expect(cachePoints()).toStrictEqual([
          { type: 'default', ttl: '1h' },
          { type: 'default', ttl: '1h' },
        ])
      })

      it('applies the shared ttl to a caller-placed system cache point', async () => {
        // Bedrock rejects a TTL that exceeds an earlier checkpoint's, so a shared ttl that reached tools
        // and messages but not the system point between them would emit an invalid request.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        const [tools, messagePoint] = cachePoints()
        expect([tools, systemCachePoints(), messagePoint]).toStrictEqual([
          { type: 'default', ttl: '1h' },
          [{ type: 'default', ttl: '1h' }],
          { type: 'default', ttl: '1h' },
        ])
      })

      it('falls through an empty system cache point ttl to the shared ttl', async () => {
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith('') }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '1h' }])
      })

      it('leaves a system cache point ttl the caller wrote as written', async () => {
        // Two conflicting TTLs are the caller's to reconcile; only an absent one is filled in.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith('5m') }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '5m' }])
      })

      it('leaves a system cache point alone when no ttl is configured', async () => {
        const provider = new BedrockModel({ cacheConfig: {} })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default' }])
      })

      it('leaves a system cache point alone when the model does not support caching', async () => {
        // A config that never reaches the wire must not reach the system point either.
        const provider = new BedrockModel({ modelId: 'meta.llama3-70b-instruct-v1:0', cacheConfig: { ttl: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default' }])
      })

      it('does not mutate the system prompt blocks the caller owns', async () => {
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })
        const systemPrompt = systemPromptWith()

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '1h' }])
        expect((systemPrompt[1] as CachePointBlock).ttl).toBeUndefined()
      })

      it('applies the shared ttl to every system cache point', async () => {
        // Every checkpoint has to move together; a TTL on only the first would leave the rest behind it.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h' } })
        const systemPrompt: SystemContentBlock[] = [
          new TextBlock('a'),
          new CachePointBlock({ cacheType: 'default' }),
          new TextBlock('b'),
          new CachePointBlock({ cacheType: 'default' }),
        ]

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt }))

        expect(systemCachePoints()).toStrictEqual([
          { type: 'default', ttl: '1h' },
          { type: 'default', ttl: '1h' },
        ])
      })

      it('treats an empty shared ttl as unconfigured', async () => {
        // An empty TTL is not a TTL, so it must not reach the wire for the Bedrock enum to reject. Asserted
        // without tools so the tools checkpoint cannot be what holds the fill-in back.
        const provider = new BedrockModel({ cacheConfig: { ttl: '' } })

        collectIterator(provider.stream(messages, { systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default' }])
      })

      it('drops an empty system cache point ttl when no ttl is configured', async () => {
        // A falsy TTL is not a TTL: Bedrock validates ttl against an enum and rejects ''. No fill-in applies
        // here, so normalizing is the only thing standing between the caller's '' and a rejected request.
        const provider = new BedrockModel({})

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith('') }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default' }])
      })

      it('drops an empty system cache point ttl behind a shorter tools ttl', async () => {
        // The fill-in stands down behind a shorter tools TTL, but the caller's empty TTL still must not ship.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', toolsTTL: '5m', messagesTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith('') }))

        const [tools] = cachePoints()
        expect([tools, systemCachePoints()]).toStrictEqual([{ type: 'default', ttl: '5m' }, [{ type: 'default' }]])
      })

      it('does not mutate a system cache point whose empty ttl it drops', async () => {
        // The caller owns the block, so normalizing must not reach back into it.
        const provider = new BedrockModel({})
        const systemPrompt = systemPromptWith('')

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default' }])
        expect((systemPrompt[1] as CachePointBlock).ttl).toBe('')
      })

      it('leaves a system cache point alone when the tools checkpoint ahead of it is shorter', async () => {
        // Bedrock rejects a TTL longer than an earlier checkpoint's, so filling in the shared ttl over a
        // shorter toolsTTL would trade one invalid request for another.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', toolsTTL: '5m', messagesTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        const [tools] = cachePoints()
        expect([tools, systemCachePoints()]).toStrictEqual([{ type: 'default', ttl: '5m' }, [{ type: 'default' }]])
      })

      it('leaves a system cache point alone when the tools checkpoint ahead of it is longer', async () => {
        // The fill-in stands down on ANY difference from the tools TTL, not only a shortening one.
        // Comparing two durations means parsing them, and CacheTTL accepts arbitrary strings, so a longer
        // tools TTL is treated the same. The emitted request is equivalent either way: the provider
        // default this leaves the point at is 5m, which is what the shared ttl would have stamped here.
        const provider = new BedrockModel({ cacheConfig: { ttl: '5m', toolsTTL: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        const [tools] = cachePoints()
        expect([tools, systemCachePoints()]).toStrictEqual([{ type: 'default', ttl: '1h' }, [{ type: 'default' }]])
      })

      it('applies the shared ttl when the tools section carries it too', async () => {
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', toolsTTL: '1h' } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '1h' }])
      })

      it('applies the shared ttl when the tools section is disabled', async () => {
        // No tools checkpoint means nothing precedes the system point, so the shared ttl is safe.
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', toolsTTL: false } })

        collectIterator(provider.stream(messages, { toolSpecs, systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '1h' }])
      })

      it('applies the shared ttl when the request carries no tools at all', async () => {
        const provider = new BedrockModel({ cacheConfig: { ttl: '1h', toolsTTL: '5m' } })

        collectIterator(provider.stream(messages, { systemPrompt: systemPromptWith() }))

        expect(systemCachePoints()).toStrictEqual([{ type: 'default', ttl: '1h' }])
      })

      it('resolves the ttl for a caller-placed cache point too', async () => {
        // The honored path takes its own route to the cache point, so it needs the same resolution:
        // `true` enables the section without being a duration, and the shared ttl still applies.
        const placed = [
          new Message({
            role: 'user',
            content: [new TextBlock('durable prefix'), new CachePointBlock({ cacheType: 'default' })],
          }),
        ]

        const enabledWithoutDuration = new BedrockModel({ cacheConfig: { messagesTTL: true } })
        collectIterator(enabledWithoutDuration.stream(placed))
        expect(mockConverseStreamCommand.mock.lastCall?.[0]?.messages?.[0]?.content).toStrictEqual([
          { text: 'durable prefix' },
          { cachePoint: { type: 'default' } },
        ])

        const sharedTTL = new BedrockModel({ cacheConfig: { ttl: '1h' } })
        collectIterator(sharedTTL.stream(placed))
        expect(mockConverseStreamCommand.mock.lastCall?.[0]?.messages?.[0]?.content).toStrictEqual([
          { text: 'durable prefix' },
          { cachePoint: { type: 'default', ttl: '1h' } },
        ])
      })

      it('ignores cacheKey: it does not change the request shape', () => {
        // Bedrock does not consume cacheKey, so it must not reach the request.
        const withoutKey = new BedrockModel({ modelId: 'anthropic.claude-test-model', cacheConfig: {} })
        const withKey = new BedrockModel({
          modelId: 'anthropic.claude-test-model',
          cacheConfig: { cacheKey: 'tenant-42' },
        })

        collectIterator(withoutKey.stream(messages, { toolSpecs }))
        const withoutKeyRequest = mockConverseStreamCommand.mock.lastCall?.[0]

        collectIterator(withKey.stream(messages, { toolSpecs }))
        const withKeyRequest = mockConverseStreamCommand.mock.lastCall?.[0]

        expect(withKeyRequest).toStrictEqual(withoutKeyRequest)
      })
    })

    describe('per-call trailing blocks', () => {
      const lastContent = (): unknown[] => mockConverseStreamCommand.mock.lastCall?.[0]?.messages?.[0]?.content ?? []

      it('places the cache point ahead of the per-call tail', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('durable ask'), new TextBlock('per-call')] }),
        ]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 1 }))

        expect(lastContent()).toStrictEqual([
          { text: 'durable ask' },
          { cachePoint: { type: 'default' } },
          { text: 'per-call' },
        ])
      })

      it('places the cache point ahead of every block of a multi-block tail', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
        const messages = [
          new Message({
            role: 'user',
            content: [new TextBlock('durable ask'), new TextBlock('injected'), new TextBlock('status')],
          }),
        ]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 2 }))

        expect(lastContent()).toStrictEqual([
          { text: 'durable ask' },
          { cachePoint: { type: 'default' } },
          { text: 'injected' },
          { text: 'status' },
        ])
      })

      it('appends the cache point at the end when no per-call tail is marked', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
        const messages = [new Message({ role: 'user', content: [new TextBlock('a'), new TextBlock('b')] })]

        collectIterator(provider.stream(messages))

        expect(lastContent()).toStrictEqual([{ text: 'a' }, { text: 'b' }, { cachePoint: { type: 'default' } }])
      })

      it('skips the cache point when the whole message is per-call content', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
        const messages = [new Message({ role: 'user', content: [new TextBlock('per-call only')] })]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 1 }))

        expect(lastContent()).toStrictEqual([{ text: 'per-call only' }])
      })

      it('steps a per-call boundary back over a directly preceding non-PDF document', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('analyze this'),
              new DocumentBlock({ name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } }),
              new TextBlock('per-call'),
            ],
          }),
        ]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 1 }))

        // Bedrock rejects a cache point directly after a non-PDF document; the per-call path is routed
        // through the same honor logic, so the same step-back applies.
        expect(lastContent()).toStrictEqual([
          { text: 'analyze this' },
          { cachePoint: { type: 'default' } },
          { document: { name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } } },
          { text: 'per-call' },
        ])
      })

      it('applies the configured messages TTL to a per-call boundary', () => {
        const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', messagesTTL: '1h' } })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('durable ask'), new TextBlock('per-call')] }),
        ]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 1 }))

        expect(lastContent()).toStrictEqual([
          { text: 'durable ask' },
          { cachePoint: { type: 'default', ttl: '1h' } },
          { text: 'per-call' },
        ])
      })

      it('emits no cache point for a per-call tail when caching is not configured', () => {
        const provider = new BedrockModel({})
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('durable ask'), new TextBlock('per-call')] }),
        ]

        collectIterator(provider.stream(messages, { dynamicTrailingBlocks: 1 }))

        expect(lastContent()).toStrictEqual([{ text: 'durable ask' }, { text: 'per-call' }])
      })
    })

    it('inserts cache point before a non-PDF document block', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Analyze this file'),
            new DocumentBlock({ name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'Analyze this file' },
        { cachePoint: { type: 'default' } },
        { document: { name: 'readme', format: 'md', source: { bytes: new Uint8Array([1]) } } },
      ])
    })

    it('appends cache point at the end when only PDF documents are present', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Analyze this PDF'),
            new DocumentBlock({ name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'Analyze this PDF' },
        { document: { name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } } },
        { cachePoint: { type: 'default' } },
      ])
    })

    it('inserts cache point before the first non-PDF document in mixed content', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Analyze these files'),
            new DocumentBlock({ name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } }),
            new DocumentBlock({ name: 'data', format: 'csv', source: { bytes: new Uint8Array([2]) } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'Analyze these files' },
        { document: { name: 'report', format: 'pdf', source: { bytes: new Uint8Array([1]) } } },
        { cachePoint: { type: 'default' } },
        { document: { name: 'data', format: 'csv', source: { bytes: new Uint8Array([2]) } } },
      ])
    })

    it('inserts cache point before the first of several non-PDF documents', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Analyze these files'),
            new DocumentBlock({ name: 'first', format: 'csv', source: { bytes: new Uint8Array([1]) } }),
            new DocumentBlock({ name: 'second', format: 'csv', source: { bytes: new Uint8Array([2]) } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      // A cache point after either document would be directly preceded by one, which Bedrock rejects.
      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { text: 'Analyze these files' },
        { cachePoint: { type: 'default' } },
        { document: { name: 'first', format: 'csv', source: { bytes: new Uint8Array([1]) } } },
        { document: { name: 'second', format: 'csv', source: { bytes: new Uint8Array([2]) } } },
      ])
    })

    it('skips cache point when a non-PDF document is the first block', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new DocumentBlock({ name: 'data', format: 'csv', source: { bytes: new Uint8Array([1]) } }),
            new TextBlock('Analyze this file'),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.messages?.[0]?.content).toStrictEqual([
        { document: { name: 'data', format: 'csv', source: { bytes: new Uint8Array([1]) } } },
        { text: 'Analyze this file' },
      ])
    })

    it('does not mutate the original messages array', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const originalMessages = [
        new Message({ role: 'user', content: [new TextBlock('Hello')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Hi')] }),
      ]

      // Create a deep copy to compare against
      const messagesCopy = JSON.parse(JSON.stringify(originalMessages))

      collectIterator(provider.stream(originalMessages))

      // Verify original messages are unchanged
      expect(JSON.stringify(originalMessages)).toBe(JSON.stringify(messagesCopy))
    })

    it('logs warning and disables caching for non-caching models', async () => {
      const warnSpy = vi.spyOn(console, 'warn')
      const provider = new BedrockModel({
        modelId: 'amazon.titan-text-express-v1',
        cacheConfig: { strategy: 'auto' },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: 'You are a helpful assistant',
      }

      collectIterator(provider.stream(messages, options))

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalled()

      // Verify no cache points were added
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'amazon.titan-text-express-v1',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [{ text: 'You are a helpful assistant' }],
      })

      warnSpy.mockRestore()
    })

    it('enables caching with anthropic strategy for application inference profiles', async () => {
      const provider = new BedrockModel({
        modelId: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123',
        cacheConfig: { strategy: 'anthropic' },
      })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('Hello')] }),
        new Message({ role: 'assistant', content: [new TextBlock('Hi')] }),
      ]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      // Cache point should be on the user message (index 0)
      const userMsg = call?.messages?.[0]
      const lastBlock = userMsg?.content?.[userMsg.content.length - 1]
      expect(lastBlock).toStrictEqual({ cachePoint: { type: 'default' } })
    })

    it('handles empty array system prompt', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [],
      }

      collectIterator(provider.stream(messages, options))

      // Empty array should not set system field
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
      })
    })

    it('formats array system prompt with guard content', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          new TextBlock('You are a helpful assistant'),
          new GuardContentBlock({
            text: {
              qualifiers: ['grounding_source'],
              text: 'This content should be evaluated for grounding.',
            },
          }),
        ],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [
          { text: 'You are a helpful assistant' },
          {
            guardContent: {
              text: {
                text: 'This content should be evaluated for grounding.',
                qualifiers: ['grounding_source'],
              },
            },
          },
        ],
      })
    })

    it('formats mixed system prompt with text, guard content, and cache points', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          new TextBlock('You are a helpful assistant'),
          new GuardContentBlock({
            text: {
              qualifiers: ['grounding_source', 'query'],
              text: 'Guard content',
            },
          }),
          new TextBlock('Additional context'),
          new CachePointBlock({ cacheType: 'default' }),
        ],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [
          { text: 'You are a helpful assistant' },
          {
            guardContent: {
              text: {
                text: 'Guard content',
                qualifiers: ['grounding_source', 'query'],
              },
            },
          },
          { text: 'Additional context' },
          { cachePoint: { type: 'default' } },
        ],
      })
    })

    it('formats guard content with all qualifier types', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          new GuardContentBlock({
            text: {
              qualifiers: ['grounding_source', 'query', 'guard_content'],
              text: 'Multi-qualifier guard content',
            },
          }),
        ],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [
          {
            guardContent: {
              text: {
                text: 'Multi-qualifier guard content',
                qualifiers: ['grounding_source', 'query', 'guard_content'],
              },
            },
          },
        ],
      })
    })

    it('formats guard content with image in system prompt', async () => {
      const provider = new BedrockModel()
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const imageBytes = new Uint8Array([1, 2, 3, 4])
      const options: StreamOptions = {
        systemPrompt: [
          new GuardContentBlock({
            image: {
              format: 'jpeg',
              source: { bytes: imageBytes },
            },
          }),
        ],
      }

      collectIterator(provider.stream(messages, options))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Hello' }],
          },
        ],
        system: [
          {
            guardContent: {
              image: {
                format: 'jpeg',
                source: { bytes: imageBytes },
              },
            },
          },
        ],
      })
    })

    it('carries cacheConfig.ttl into the appended system cache point', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', ttl: '1h' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = { systemPrompt: 'static prompt' }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default', ttl: '1h' } }])
    })

    it('does not inject a system cache point when systemPromptTTL is false', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', systemPromptTTL: false } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = { systemPrompt: 'static prompt' }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }])
    })

    it('fills a caller-placed system point from ttl when systemPromptTTL is false', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', ttl: '1h', systemPromptTTL: false } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [new TextBlock('static prompt'), new CachePointBlock({ cacheType: 'default' })],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default', ttl: '1h' } }])
    })

    it('emits an explicit systemPromptTTL as written, above a shorter tools point', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', systemPromptTTL: '1h', toolsTTL: '5m' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: 'static prompt',
        toolSpecs: [{ name: 'calc', description: 'Calculator', inputSchema: { type: 'object', properties: {} } }],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default', ttl: '1h' } }])
    })

    it('carries an explicit systemPromptTTL into the appended cache point without a shared ttl', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', systemPromptTTL: '1h' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = { systemPrompt: 'static prompt' }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default', ttl: '1h' } }])
    })

    it('honors a caller-placed system cache point anywhere in the prefix', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: [
          new TextBlock('static prompt'),
          new CachePointBlock({ cacheType: 'default', ttl: '1h' }),
          new TextBlock('trailing instructions'),
        ],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([
        { text: 'static prompt' },
        { cachePoint: { type: 'default', ttl: '1h' } },
        { text: 'trailing instructions' },
      ])
    })

    it('stands the system cache point TTL down when the tools point carries a different TTL', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto', ttl: '1h', toolsTTL: '5m' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = {
        systemPrompt: 'static prompt',
        toolSpecs: [{ name: 'calc', description: 'Calculator', inputSchema: { type: 'object', properties: {} } }],
      }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default' } }])
    })

    it('skips the system cache point when the system prompt is absent', async () => {
      const provider = new BedrockModel({ cacheConfig: { strategy: 'auto' } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      collectIterator(provider.stream(messages))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toBeUndefined()
    })

    it('appends a system cache point under explicit anthropic strategy for ARN inference profiles', async () => {
      const provider = new BedrockModel({
        modelId: 'arn:aws:bedrock:us-east-1:123:application-inference-profile/abc',
        cacheConfig: { strategy: 'anthropic' },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
      const options: StreamOptions = { systemPrompt: 'static prompt' }

      collectIterator(provider.stream(messages, options))

      const call = mockConverseStreamCommand.mock.lastCall?.[0]
      expect(call?.system).toStrictEqual([{ text: 'static prompt' }, { cachePoint: { type: 'default' } }])
    })
  })

  describe('guard content in messages', async () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('formats guard content with text in message', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Verify this information:'),
            new GuardContentBlock({
              text: {
                qualifiers: ['grounding_source'],
                text: 'The capital of France is Paris.',
              },
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { text: 'Verify this information:' },
              {
                guardContent: {
                  text: {
                    text: 'The capital of France is Paris.',
                    qualifiers: ['grounding_source'],
                  },
                },
              },
            ],
          },
        ],
      })
    })

    it('formats guard content with image in message', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2, 3, 4])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Is this image safe?'),
            new GuardContentBlock({
              image: {
                format: 'jpeg',
                source: { bytes: imageBytes },
              },
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
        modelId: 'global.anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { text: 'Is this image safe?' },
              {
                guardContent: {
                  image: {
                    format: 'jpeg',
                    source: { bytes: imageBytes },
                  },
                },
              },
            ],
          },
        ],
      })
    })
  })

  describe('media blocks in tool results', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    it('formats image block in tool result', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ image: { format: 'png', source: { bytes: imageBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats video block in tool result with 3gp format mapping', async () => {
      const provider = new BedrockModel()
      const videoBytes = new Uint8Array([4, 5, 6])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new VideoBlock({ format: '3gp', source: { bytes: videoBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ video: { format: 'three_gp', source: { bytes: videoBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats document block in tool result', async () => {
      const provider = new BedrockModel()
      const docBytes = new Uint8Array([7, 8, 9])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ document: { name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats mixed text and media content in tool result', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [
                new TextBlock('Here is the image:'),
                new ImageBlock({ format: 'jpeg', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [
                      { text: 'Here is the image:' },
                      { image: { format: 'jpeg', source: { bytes: imageBytes } } },
                    ],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })
  })

  describe('media blocks in messages', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    it('formats top-level audio block', async () => {
      const provider = new BedrockModel()
      const audioBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [new AudioBlock({ format: 'mp3', source: { bytes: audioBytes } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ audio: { format: 'mp3', source: { bytes: audioBytes } } }],
            },
          ],
        })
      )
    })

    it('formats top-level audio block with S3 source', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new AudioBlock({
              format: 'wav',
              source: { location: { type: 's3', uri: 's3://bucket/audio.wav' } },
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ audio: { format: 'wav', source: { s3Location: { uri: 's3://bucket/audio.wav' } } } }],
            },
          ],
        })
      )
    })

    it('formats top-level image block', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ image: { format: 'png', source: { bytes: imageBytes } } }],
            },
          ],
        })
      )
    })

    it('formats top-level image block with S3 source', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ImageBlock({ format: 'png', source: { location: { type: 's3', uri: 's3://bucket/image.png' } } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ image: { format: 'png', source: { s3Location: { uri: 's3://bucket/image.png' } } } }],
            },
          ],
        })
      )
    })

    it('formats top-level video block with 3gp format mapping', async () => {
      const provider = new BedrockModel()
      const videoBytes = new Uint8Array([4, 5, 6])
      const messages = [
        new Message({
          role: 'user',
          content: [new VideoBlock({ format: '3gp', source: { bytes: videoBytes } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ video: { format: 'three_gp', source: { bytes: videoBytes } } }],
            },
          ],
        })
      )
    })

    it('formats top-level document block with text source converted to bytes', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [new DocumentBlock({ name: 'notes.txt', format: 'txt', source: { text: 'Hello world' } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  document: {
                    name: 'notes.txt',
                    format: 'txt',
                    source: { bytes: new TextEncoder().encode('Hello world') },
                  },
                },
              ],
            },
          ],
        })
      )
    })
  })

  describe('citations content block formatting', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    it('maps SDK CitationLocation types to Bedrock object-key format through formatting pipeline', async () => {
      const provider = new BedrockModel()
      const sdkCitations = [
        {
          location: { type: 'documentChar' as const, documentIndex: 0, start: 150, end: 300 },
          source: 'doc-0',
          sourceContent: [{ text: 'char source' }],
          title: 'Text Document',
        },
        {
          location: { type: 'documentPage' as const, documentIndex: 0, start: 2, end: 3 },
          source: 'doc-0',
          sourceContent: [{ text: 'page source' }],
          title: 'PDF Document',
        },
        {
          location: { type: 'documentChunk' as const, documentIndex: 1, start: 5, end: 8 },
          source: 'doc-1',
          sourceContent: [{ text: 'chunk source' }],
          title: 'Chunked Document',
        },
        {
          location: { type: 'searchResult' as const, searchResultIndex: 0, start: 25, end: 150 },
          source: 'search-0',
          sourceContent: [{ text: 'search source' }],
          title: 'Search Result',
        },
        {
          location: { type: 'web' as const, url: 'https://example.com/doc', domain: 'example.com' },
          source: 'web-0',
          sourceContent: [{ text: 'web source' }],
          title: 'Web Page',
        },
      ]

      const messages = [
        new Message({
          role: 'assistant',
          content: [
            new CitationsBlock({
              citations: sdkCitations,
              content: [{ text: 'generated text with all citation types' }],
            }),
          ],
        }),
        new Message({
          role: 'user',
          content: [new TextBlock('Follow up')],
        }),
      ]

      collectIterator(provider.stream(messages))

      // Bedrock wire format uses object-key discrimination
      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  citationsContent: {
                    citations: [
                      {
                        location: { documentChar: { documentIndex: 0, start: 150, end: 300 } },
                        source: 'doc-0',
                        sourceContent: [{ text: 'char source' }],
                        title: 'Text Document',
                      },
                      {
                        location: { documentPage: { documentIndex: 0, start: 2, end: 3 } },
                        source: 'doc-0',
                        sourceContent: [{ text: 'page source' }],
                        title: 'PDF Document',
                      },
                      {
                        location: { documentChunk: { documentIndex: 1, start: 5, end: 8 } },
                        source: 'doc-1',
                        sourceContent: [{ text: 'chunk source' }],
                        title: 'Chunked Document',
                      },
                      {
                        location: {
                          searchResultLocation: { searchResultIndex: 0, start: 25, end: 150 },
                        },
                        source: 'search-0',
                        sourceContent: [{ text: 'search source' }],
                        title: 'Search Result',
                      },
                      {
                        location: { web: { url: 'https://example.com/doc', domain: 'example.com' } },
                        source: 'web-0',
                        sourceContent: [{ text: 'web source' }],
                        title: 'Web Page',
                      },
                    ],
                    content: [{ text: 'generated text with all citation types' }],
                  },
                },
              ],
            },
            {
              role: 'user',
              content: [{ text: 'Follow up' }],
            },
          ],
        })
      )
    })
  })

  describe('media blocks in tool results', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    it('formats image block in tool result', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ image: { format: 'png', source: { bytes: imageBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats video block in tool result with 3gp format mapping', async () => {
      const provider = new BedrockModel()
      const videoBytes = new Uint8Array([4, 5, 6])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new VideoBlock({ format: '3gp', source: { bytes: videoBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ video: { format: 'three_gp', source: { bytes: videoBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats document block in tool result', async () => {
      const provider = new BedrockModel()
      const docBytes = new Uint8Array([7, 8, 9])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } })],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [{ document: { name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } } }],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })

    it('formats mixed text and media content in tool result', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2])
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tool-1',
              status: 'success',
              content: [
                new TextBlock('Here is the image:'),
                new ImageBlock({ format: 'jpeg', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  toolResult: {
                    toolUseId: 'tool-1',
                    content: [
                      { text: 'Here is the image:' },
                      { image: { format: 'jpeg', source: { bytes: imageBytes } } },
                    ],
                    status: 'success',
                  },
                },
              ],
            },
          ],
        })
      )
    })
  })

  describe('media blocks in messages', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    it('formats top-level image block', async () => {
      const provider = new BedrockModel()
      const imageBytes = new Uint8Array([1, 2, 3])
      const messages = [
        new Message({
          role: 'user',
          content: [new ImageBlock({ format: 'png', source: { bytes: imageBytes } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ image: { format: 'png', source: { bytes: imageBytes } } }],
            },
          ],
        })
      )
    })

    it('formats top-level image block with S3 source', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [
            new ImageBlock({ format: 'png', source: { location: { type: 's3', uri: 's3://bucket/image.png' } } }),
          ],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ image: { format: 'png', source: { s3Location: { uri: 's3://bucket/image.png' } } } }],
            },
          ],
        })
      )
    })

    it('formats top-level video block with 3gp format mapping', async () => {
      const provider = new BedrockModel()
      const videoBytes = new Uint8Array([4, 5, 6])
      const messages = [
        new Message({
          role: 'user',
          content: [new VideoBlock({ format: '3gp', source: { bytes: videoBytes } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [{ video: { format: 'three_gp', source: { bytes: videoBytes } } }],
            },
          ],
        })
      )
    })

    it('formats top-level document block with text source converted to bytes', async () => {
      const provider = new BedrockModel()
      const messages = [
        new Message({
          role: 'user',
          content: [new DocumentBlock({ name: 'notes.txt', format: 'txt', source: { text: 'Hello world' } })],
        }),
      ]

      collectIterator(provider.stream(messages))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  document: {
                    name: 'notes.txt',
                    format: 'txt',
                    source: { bytes: new TextEncoder().encode('Hello world') },
                  },
                },
              ],
            },
          ],
        })
      )
    })
  })

  describe('includeToolResultStatus configuration', async () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    describe('when includeToolResultStatus is true', () => {
      it('always includes status field in tool results', async () => {
        const provider = new BedrockModel({ includeToolResultStatus: true })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [new TextBlock('Result')],
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
          messages: [
            {
              content: [
                {
                  toolResult: {
                    content: [{ text: 'Result' }],
                    status: 'success',
                    toolUseId: 'tool-123',
                  },
                },
              ],
              role: 'user',
            },
          ],
          toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
          modelId: expect.any(String),
        })
      })
    })

    describe('when includeToolResultStatus is false', () => {
      it('never includes status field in tool results', async () => {
        const provider = new BedrockModel({ includeToolResultStatus: false })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [new TextBlock('Result')],
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
          messages: [
            {
              content: [
                {
                  toolResult: {
                    content: [{ text: 'Result' }],
                    toolUseId: 'tool-123',
                  },
                },
              ],
              role: 'user',
            },
          ],
          toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
          modelId: expect.any(String),
        })
      })
    })

    describe('when includeToolResultStatus is auto', () => {
      it('includes status field for Claude models', async () => {
        const provider = new BedrockModel({
          modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
          includeToolResultStatus: 'auto',
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [new TextBlock('Result')],
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
          messages: [
            {
              content: [
                {
                  toolResult: {
                    content: [{ text: 'Result' }],
                    status: 'success',
                    toolUseId: 'tool-123',
                  },
                },
              ],
              role: 'user',
            },
          ],
          toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
          modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        })
      })
    })

    describe('when includeToolResultStatus is undefined (default)', () => {
      it('follows auto logic for non-Claude models', async () => {
        const provider = new BedrockModel({
          modelId: 'amazon.nova-lite-v1:0',
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [new TextBlock('Result')],
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith({
          messages: [
            {
              content: [
                {
                  toolResult: {
                    content: [{ text: 'Result' }],
                    toolUseId: 'tool-123',
                  },
                },
              ],
              role: 'user',
            },
          ],
          toolConfig: BEDROCK_NOOP_TOOL_CONFIG,
          modelId: 'amazon.nova-lite-v1:0',
        })
      })
    })
  })

  describe('region configuration', () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('uses explicit region when provided', async () => {
      mockBedrockClientImplementation()

      const provider = new BedrockModel({ region: 'eu-west-1' })

      // After applyDefaultRegion wraps the config functions, verify they still return the correct value
      const regionResult = await provider['_client'].config.region()
      expect(regionResult).toBe('eu-west-1')
    })

    it('defaults to us-west-2 when region is missing', async () => {
      mockBedrockClientImplementation({
        region: async () => {
          throw new Error('Region is missing')
        },
        useFipsEndpoint: async () => {
          throw new Error('Region is missing')
        },
      })

      const provider = new BedrockModel()

      // After applyDefaultRegion wraps the config functions
      const regionResult = await provider['_client'].config.region()
      expect(regionResult).toBe('us-west-2')

      const fipsResult = await provider['_client'].config.useFipsEndpoint()
      expect(fipsResult).toBe(false)
    })

    it('rethrows other region errors', async () => {
      mockBedrockClientImplementation({
        region: async () => {
          throw new Error('Network error')
        },
      })

      const provider = new BedrockModel()

      // Should rethrow the error
      await expect(provider['_client'].config.region()).rejects.toThrow('Network error')
    })
  })

  describe('guardrail configuration', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    beforeEach(() => {
      vi.clearAllMocks()
    })

    describe('constructor', () => {
      it('accepts guardrailConfig in options', () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        expect(provider.getConfig().guardrailConfig).toStrictEqual({
          guardrailIdentifier: 'my-guardrail-id',
          guardrailVersion: '1',
        })
      })

      it('accepts guardrailConfig with all options', () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            trace: 'enabled_full',
            streamProcessingMode: 'sync',
            redaction: {
              input: true,
              inputMessage: '[Custom input redacted.]',
              output: true,
              outputMessage: '[Custom output redacted.]',
            },
          },
        })
        expect(provider.getConfig().guardrailConfig).toStrictEqual({
          guardrailIdentifier: 'my-guardrail-id',
          guardrailVersion: '1',
          trace: 'enabled_full',
          streamProcessingMode: 'sync',
          redaction: {
            input: true,
            inputMessage: '[Custom input redacted.]',
            output: true,
            outputMessage: '[Custom output redacted.]',
          },
        })
      })
    })

    describe('request formatting', () => {
      it('includes guardrailConfig in request with default trace', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            guardrailConfig: {
              guardrailIdentifier: 'my-guardrail-id',
              guardrailVersion: '1',
              trace: 'enabled',
            },
          })
        )
      })

      it('includes guardrailConfig in request with custom trace', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            trace: 'disabled',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            guardrailConfig: {
              guardrailIdentifier: 'my-guardrail-id',
              guardrailVersion: '1',
              trace: 'disabled',
            },
          })
        )
      })

      it('includes streamProcessingMode when specified', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            streamProcessingMode: 'sync',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            guardrailConfig: {
              guardrailIdentifier: 'my-guardrail-id',
              guardrailVersion: '1',
              trace: 'enabled',
              streamProcessingMode: 'sync',
            },
          })
        )
      })

      it('does not include guardrailConfig when not configured', async () => {
        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.not.objectContaining({
            guardrailConfig: expect.anything(),
          })
        )
      })
    })

    describe('blocked guardrail detection', () => {
      it('detects blocked guardrail in inputAssessment', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: {
                    '1234': {
                      topicPolicy: {
                        topics: [{ name: 'Harmful', action: 'BLOCKED', detected: true }],
                      },
                    },
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvent = events.find((e) => e.type === 'modelRedactionEvent')
        expect(redactEvent).toBeDefined()
        expect(redactEvent).toStrictEqual({
          type: 'modelRedactionEvent',
          inputRedaction: { replaceContent: '[User input redacted.]' },
        })
      })

      it('detects blocked guardrail in outputAssessments', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  outputAssessments: {
                    '1234': {
                      contentPolicy: {
                        filters: [{ type: 'VIOLENCE', action: 'BLOCKED', detected: true }],
                      },
                    },
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvent = events.find((e) => e.type === 'modelRedactionEvent')
        expect(redactEvent).toBeDefined()
      })

      it('does not emit redaction events when guardrail not blocked', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'end_turn' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: {
                    '1234': {
                      topicPolicy: {
                        topics: [{ name: 'Safe', action: 'NONE', detected: false }],
                      },
                    },
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvent = events.find((e) => e.type === 'modelRedactionEvent')
        expect(redactEvent).toBeUndefined()
      })

      it('does not emit redaction events without guardrailConfig', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: {
                    '1234': {
                      topicPolicy: {
                        topics: [{ name: 'Harmful', action: 'BLOCKED', detected: true }],
                      },
                    },
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel()
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvent = events.find((e) => e.type === 'modelRedactionEvent')
        expect(redactEvent).toBeUndefined()
      })

      it('emits redaction events when guardrail_intervened is reported without a trace', async () => {
        // Guards against https://github.com/strands-agents/harness-sdk/issues/3612: with
        // guardrailConfig.trace='disabled' Bedrock still reports guardrail_intervened but carries no
        // assessment, and blocked content must still be redacted.
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvents = events.filter((e) => e.type === 'modelRedactionEvent')
        expect(redactEvents).toStrictEqual([
          {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          },
        ])
      })

      it('emits redaction events when guardrail_intervened but no metadata event arrives', async () => {
        // Guards against https://github.com/strands-agents/harness-sdk/issues/3612: the guardrail
        // trace normally arrives with metadata, but redaction keys off the stop reason and must still
        // occur when the stream ends without any metadata event.
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvents = events.filter((e) => e.type === 'modelRedactionEvent')
        expect(redactEvents).toStrictEqual([
          {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          },
        ])
      })

      it('emits redaction events exactly once across multiple metadata events', async () => {
        // Guards against https://github.com/strands-agents/harness-sdk/issues/3612: Bedrock may emit
        // more than one metadata event, and redaction must not be duplicated.
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'Hello' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
          yield { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        const redactEvents = events.filter((e) => e.type === 'modelRedactionEvent')
        expect(redactEvents).toStrictEqual([
          {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          },
        ])
      })

      it('does not emit redaction events when the trace only reports ANONYMIZED (masking)', async () => {
        // Bedrock reports stopReason=guardrail_intervened for masked content too, but the
        // masked spans have already been substituted in place and the surrounding message
        // must be preserved. The trace disambiguates: only BLOCKED actions warrant redaction.
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: '{BLOCKING_HELLO}! 👋' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 13, outputTokens: 17, totalTokens: 30 },
              trace: {
                guardrail: {
                  outputAssessments: {
                    '8oi5sp73w4ca': [
                      {
                        sensitiveInformationPolicy: {
                          regexes: [
                            {
                              action: 'ANONYMIZED',
                              detected: true,
                              match: 'Hello',
                              name: 'BLOCKING_HELLO',
                              regex: 'Hello',
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        expect(events.some((e) => e.type === 'modelRedactionEvent')).toBe(false)
      })

      it('does not emit redaction events for masking in non-streaming path', async () => {
        const mockSend = vi.fn(async () => ({
          output: { message: { role: 'assistant', content: [{ text: '{BLOCKING_HELLO}! 👋' }] } },
          stopReason: 'guardrail_intervened',
          usage: { inputTokens: 13, outputTokens: 17, totalTokens: 30 },
          trace: {
            guardrail: {
              outputAssessments: {
                '8oi5sp73w4ca': [
                  {
                    sensitiveInformationPolicy: {
                      regexes: [
                        {
                          action: 'ANONYMIZED',
                          detected: true,
                          match: 'Hello',
                          name: 'BLOCKING_HELLO',
                          regex: 'Hello',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        }))
        mockBedrockClientImplementation({ send: mockSend })

        const provider = new BedrockModel({
          stream: false,
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
        const events = await collectIterator(provider.stream(messages))

        expect(events.some((e) => e.type === 'modelRedactionEvent')).toBe(false)
      })
    })

    describe('redaction event generation', () => {
      it('emits input redaction with default message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          inputRedaction: { replaceContent: '[User input redacted.]' },
        })
      })

      it('emits input redaction with custom message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              inputMessage: '[Custom input message]',
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          inputRedaction: { replaceContent: '[Custom input message]' },
        })
      })

      it('does not emit input redaction when redactInput is false', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              input: false,
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        const inputRedactEvent = events.find((e) => e.type === 'modelRedactionEvent' && 'inputRedaction' in e)
        expect(inputRedactEvent).toBeUndefined()
      })

      it('emits output redaction when redactOutput is true', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              output: true,
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          outputRedaction: { replaceContent: '[Assistant output redacted.]' },
        })
      })

      it('emits output redaction with custom message', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              output: true,
              outputMessage: '[Custom output message]',
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          outputRedaction: { replaceContent: '[Custom output message]' },
        })
      })

      it('emits both input and output redaction when both are enabled', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              input: true,
              output: true,
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          inputRedaction: { replaceContent: '[User input redacted.]' },
        })
        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          outputRedaction: { replaceContent: '[Assistant output redacted.]' },
        })
      })

      it('includes redactedContent from modelOutput when available', async () => {
        setupMockSend(async function* () {
          yield { messageStart: { role: 'assistant' } }
          yield { contentBlockStart: {} }
          yield { contentBlockDelta: { delta: { text: 'This content was blocked' } } }
          yield { contentBlockStop: {} }
          yield { messageStop: { stopReason: 'guardrail_intervened' } }
          yield {
            metadata: {
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              trace: {
                guardrail: {
                  modelOutput: ['This content ', 'was blocked'],
                  outputAssessments: {
                    '0': [{ topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } }],
                  },
                },
              },
            },
          }
        })

        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
            redaction: {
              output: true,
              outputMessage: '[Blocked]',
            },
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          outputRedaction: {
            replaceContent: '[Blocked]',
            redactedContent: 'This content was blocked',
          },
        })
      })
    })

    describe('non-streaming mode', () => {
      it('emits redaction events in non-streaming mode when guardrail blocks', async () => {
        const mockSend = vi.fn(async () => ({
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'Hello' }],
            },
          },
          stopReason: 'guardrail_intervened',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          trace: {
            guardrail: {
              inputAssessment: { '1': { topicPolicy: { topics: [{ action: 'BLOCKED', detected: true }] } } },
            },
          },
        }))
        mockBedrockClientImplementation({ send: mockSend })

        const provider = new BedrockModel({
          stream: false,
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        expect(events).toContainEqual({
          type: 'modelRedactionEvent',
          inputRedaction: { replaceContent: '[User input redacted.]' },
        })
      })

      it('emits redaction events when guardrail_intervened is reported without a trace', async () => {
        // Guards against https://github.com/strands-agents/harness-sdk/issues/3612: with
        // guardrailConfig.trace='disabled' Bedrock still reports guardrail_intervened but carries no
        // assessment, and blocked content must still be redacted.
        const mockSend = vi.fn(async () => ({
          output: {
            message: {
              role: 'assistant',
              content: [{ text: 'Hello' }],
            },
          },
          stopReason: 'guardrail_intervened',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        }))
        mockBedrockClientImplementation({ send: mockSend })

        const provider = new BedrockModel({
          stream: false,
          guardrailConfig: {
            guardrailIdentifier: 'id',
            guardrailVersion: '1',
          },
        })
        const events = await collectIterator(
          provider.stream([new Message({ role: 'user', content: [new TextBlock('Hello')] })])
        )

        const redactEvents = events.filter((e) => e.type === 'modelRedactionEvent')
        expect(redactEvents).toStrictEqual([
          {
            type: 'modelRedactionEvent',
            inputRedaction: { replaceContent: '[User input redacted.]' },
          },
        ])
      })
    })

    describe('guardLatestUserMessage', () => {
      const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

      beforeEach(() => {
        vi.clearAllMocks()
      })

      it('accepts guardLatestUserMessage in guardrailConfig', () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        expect(provider.getConfig().guardrailConfig).toStrictEqual({
          guardrailIdentifier: 'my-guardrail-id',
          guardrailVersion: '1',
          guardLatestUserMessage: true,
        })
      })

      it('wraps latest user message text content in guardContent when enabled', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello world')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'Hello world',
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('wraps latest user message image content in guardContent when enabled', async () => {
        const imageBytes = new Uint8Array([1, 2, 3, 4])
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'jpeg',
                source: { bytes: imageBytes },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      image: {
                        format: 'jpeg',
                        source: { bytes: imageBytes },
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('does not wrap toolResult messages even though role is user', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('What is 2+2?')] }),
          new Message({
            role: 'assistant',
            content: [
              new ToolUseBlock({
                name: 'calculator',
                toolUseId: 'tool-123',
                input: { expression: '2+2' },
              }),
            ],
          }),
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({
                toolUseId: 'tool-123',
                status: 'success',
                content: [new TextBlock('4')],
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        // The latest message is a toolResult, but guardContent should wrap the FIRST user message
        // which contains text, not the toolResult
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'What is 2+2?',
                      },
                    },
                  },
                ],
              },
              {
                role: 'assistant',
                content: [
                  {
                    toolUse: {
                      name: 'calculator',
                      toolUseId: 'tool-123',
                      input: { expression: '2+2' },
                    },
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    toolResult: expect.objectContaining({
                      toolUseId: 'tool-123',
                    }),
                  },
                ],
              },
            ],
          })
        )
      })

      it('does not wrap messages when guardLatestUserMessage is false', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: false,
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello world')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [{ text: 'Hello world' }],
              },
            ],
          })
        )
      })

      it('does not wrap messages when guardLatestUserMessage is undefined', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
          },
        })
        const messages = [new Message({ role: 'user', content: [new TextBlock('Hello world')] })]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [{ text: 'Hello world' }],
              },
            ],
          })
        )
      })

      it('does not wrap assistant messages', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('Hello')] }),
          new Message({ role: 'assistant', content: [new TextBlock('Hi there!')] }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'Hello',
                      },
                    },
                  },
                ],
              },
              {
                role: 'assistant',
                content: [{ text: 'Hi there!' }],
              },
            ],
          })
        )
      })

      it('wraps only the last user text/image message in multi-turn conversation', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({ role: 'user', content: [new TextBlock('First message')] }),
          new Message({ role: 'assistant', content: [new TextBlock('First response')] }),
          new Message({ role: 'user', content: [new TextBlock('Second message')] }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [{ text: 'First message' }],
              },
              {
                role: 'assistant',
                content: [{ text: 'First response' }],
              },
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'Second message',
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('handles no user messages with text/image content gracefully', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        // Only assistant message, no user text/image content
        const messages = [new Message({ role: 'assistant', content: [new TextBlock('Hello!')] })]

        collectIterator(provider.stream(messages))

        // Should not throw and should not wrap anything
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'assistant',
                content: [{ text: 'Hello!' }],
              },
            ],
          })
        )
      })

      it('preserves explicit GuardContentBlock in messages without double-wrapping', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new GuardContentBlock({
                text: {
                  qualifiers: ['grounding_source'],
                  text: 'Already guarded content',
                },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        // Explicit GuardContentBlock should be preserved as-is (no text/image content to wrap)
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'Already guarded content',
                        qualifiers: ['grounding_source'],
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('wraps all text and image blocks in the latest user message', async () => {
        const imageBytes = new Uint8Array([5, 6, 7, 8])
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('Check this text'),
              new ImageBlock({
                format: 'png',
                source: { bytes: imageBytes },
              }),
              new TextBlock('And this text too'),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'Check this text',
                      },
                    },
                  },
                  {
                    guardContent: {
                      image: {
                        format: 'png',
                        source: { bytes: imageBytes },
                      },
                    },
                  },
                  {
                    guardContent: {
                      text: {
                        text: 'And this text too',
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('skips wrapping images with unsupported formats (gif)', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const imageBytes = new Uint8Array([1, 2, 3, 4])
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'gif',
                source: { bytes: imageBytes },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          'image_format=<gif> | format not supported by bedrock guardrails | skipping guardContent wrap'
        )
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    image: {
                      format: 'gif',
                      source: { bytes: imageBytes },
                    },
                  },
                ],
              },
            ],
          })
        )
        consoleWarnSpy.mockRestore()
      })

      it('skips wrapping images with unsupported formats (webp)', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const imageBytes = new Uint8Array([1, 2, 3, 4])
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'webp',
                source: { bytes: imageBytes },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          'image_format=<webp> | format not supported by bedrock guardrails | skipping guardContent wrap'
        )
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    image: {
                      format: 'webp',
                      source: { bytes: imageBytes },
                    },
                  },
                ],
              },
            ],
          })
        )
        consoleWarnSpy.mockRestore()
      })

      it('skips wrapping images with S3 source', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'png',
                source: {
                  location: {
                    type: 's3',
                    uri: 's3://bucket/image.png',
                  },
                },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          'source_type=<non-bytes> | image source must be bytes for bedrock guardrails | skipping guardContent wrap'
        )
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    image: {
                      format: 'png',
                      source: {
                        s3Location: {
                          uri: 's3://bucket/image.png',
                        },
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
        consoleWarnSpy.mockRestore()
      })

      it('skips wrapping images with URL source', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'jpeg',
                source: { url: 'https://example.com/image.jpg' },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        // URL sources return undefined in _formatMediaSource, resulting in source: undefined
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          'source_type=<imageSourceUrl> | not supported by bedrock | skipping'
        )
        // The image block still appears but with undefined source (Bedrock will reject this)
        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    image: {
                      format: 'jpeg',
                      source: undefined,
                    },
                  },
                ],
              },
            ],
          })
        )
        consoleWarnSpy.mockRestore()
      })

      it('wraps supported image formats (png and jpeg) with bytes source', async () => {
        const imageBytes = new Uint8Array([1, 2, 3, 4])
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new ImageBlock({
                format: 'png',
                source: { bytes: imageBytes },
              }),
              new ImageBlock({
                format: 'jpeg',
                source: { bytes: imageBytes },
              }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      image: {
                        format: 'png',
                        source: { bytes: imageBytes },
                      },
                    },
                  },
                  {
                    guardContent: {
                      image: {
                        format: 'jpeg',
                        source: { bytes: imageBytes },
                      },
                    },
                  },
                ],
              },
            ],
          })
        )
      })

      it('does not wrap reasoning or cachePoint blocks', async () => {
        const provider = new BedrockModel({
          guardrailConfig: {
            guardrailIdentifier: 'my-guardrail-id',
            guardrailVersion: '1',
            guardLatestUserMessage: true,
          },
        })
        const messages = [
          new Message({
            role: 'user',
            content: [
              new TextBlock('User message'),
              new ReasoningBlock({ text: 'thinking...', signature: 'sig' }),
              new CachePointBlock({ cacheType: 'default' }),
            ],
          }),
        ]

        collectIterator(provider.stream(messages))

        expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
          expect.objectContaining({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    guardContent: {
                      text: {
                        text: 'User message',
                      },
                    },
                  },
                  {
                    reasoningContent: {
                      reasoningText: {
                        text: 'thinking...',
                        signature: 'sig',
                      },
                    },
                  },
                  { cachePoint: { type: 'default' } },
                ],
              },
            ],
          })
        )
      })
    })
  })

  describe('thinking with forced tool choice', () => {
    const mockConverseStreamCommand = vi.mocked(ConverseStreamCommand)

    const provider = new BedrockModel({
      modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
      additionalRequestFields: {
        thinking: { type: 'enabled', budget_tokens: 5000 },
        some_other_field: 'value',
      },
    })
    const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]
    const toolSpecs = [{ name: 'test_tool', description: 'test' }]

    it.each([
      { name: 'any', toolChoice: { any: {} } },
      { name: 'tool', toolChoice: { tool: { name: 'test_tool' } } },
    ])('strips thinking from additional request fields when tool choice is $name', ({ toolChoice }) => {
      collectIterator(provider.stream(messages, { toolSpecs, toolChoice }))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additionalModelRequestFields: { some_other_field: 'value' },
        })
      )
    })

    it('preserves thinking when tool choice is auto', () => {
      collectIterator(provider.stream(messages, { toolSpecs, toolChoice: { auto: {} } }))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additionalModelRequestFields: {
            thinking: { type: 'enabled', budget_tokens: 5000 },
            some_other_field: 'value',
          },
        })
      )
    })

    it('preserves thinking when no tool choice is provided', () => {
      collectIterator(provider.stream(messages, { toolSpecs }))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          additionalModelRequestFields: {
            thinking: { type: 'enabled', budget_tokens: 5000 },
            some_other_field: 'value',
          },
        })
      )
    })

    it('omits additionalModelRequestFields when thinking is the only field and tool choice forces tool use', () => {
      const thinkingOnlyProvider = new BedrockModel({
        modelId: 'anthropic.claude-sonnet-4-20250514-v1:0',
        additionalRequestFields: {
          thinking: { type: 'enabled', budget_tokens: 5000 },
        },
      })

      collectIterator(thinkingOnlyProvider.stream(messages, { toolSpecs, toolChoice: { any: {} } }))

      expect(mockConverseStreamCommand).toHaveBeenLastCalledWith(
        expect.not.objectContaining({
          additionalModelRequestFields: expect.anything(),
        })
      )
    })
  })

  describe('countTokens', () => {
    const messages: Message[] = [new Message({ role: 'user', content: [new TextBlock('hello')] })]
    const toolSpecs = [
      { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' as const, properties: {} } },
    ]

    beforeEach(() => {
      vi.clearAllMocks()
      BedrockModel.clearCountTokensCache()
    })

    it('should use heuristic by default when useNativeTokenCount is not set', async () => {
      const mockSend = vi.fn()
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel()

      const result = await model.countTokens(messages)

      expect(mockSend).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })

    it('should return native token count on success', async () => {
      const mockSend = vi.fn(async () => ({ inputTokens: 42 }))
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(result).toBe(42)
      expect(mockSend).toHaveBeenCalledOnce()
    })

    it('should include system prompt in request', async () => {
      const mockSend = vi.fn(async () => ({ inputTokens: 55 }))
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      const result = await model.countTokens(messages, { systemPrompt: 'Be helpful.' })

      expect(result).toBe(55)
      const commandInput = vi.mocked(CountTokensCommand).mock.calls[0]![0]!
      expect(commandInput).toStrictEqual({
        modelId: expect.any(String),
        input: {
          converse: {
            messages: [{ role: 'user', content: [{ text: 'hello' }] }],
            system: [{ text: 'Be helpful.' }],
          },
        },
      })
    })

    it('should include tool specs in request', async () => {
      const mockSend = vi.fn(async () => ({ inputTokens: 100 }))
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      const result = await model.countTokens(messages, { toolSpecs })

      expect(result).toBe(100)
      const commandInput = vi.mocked(CountTokensCommand).mock.calls[0]![0]!
      expect(commandInput).toStrictEqual({
        modelId: expect.any(String),
        input: {
          converse: {
            messages: [{ role: 'user', content: [{ text: 'hello' }] }],
            toolConfig: {
              tools: [
                {
                  toolSpec: {
                    name: 'test_tool',
                    description: 'A test tool',
                    inputSchema: { json: { type: 'object', properties: {} } },
                  },
                },
              ],
            },
          },
        },
      })
    })

    it('should strip inferenceConfig from request', async () => {
      const mockSend = vi.fn(async () => ({ inputTokens: 10 }))
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ maxTokens: 100, useNativeTokenCount: true })

      await model.countTokens(messages)

      const commandInput = vi.mocked(CountTokensCommand).mock.calls[0]![0]!
      expect(commandInput).toStrictEqual({
        modelId: expect.any(String),
        input: {
          converse: {
            messages: [{ role: 'user', content: [{ text: 'hello' }] }],
          },
        },
      })
    })

    it('should fall back to estimation on API error', async () => {
      const mockSend = vi.fn(async () => {
        throw new Error('API error')
      })
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should fall back to estimation on generic exception', async () => {
      const mockSend = vi.fn(async () => {
        throw new Error('Connection failed')
      })
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      const result = await model.countTokens(messages)

      expect(typeof result).toBe('number')
      expect(result).toBeGreaterThanOrEqual(0)
    })

    it('should cache model ID and skip API call when model does not support counting tokens', async () => {
      const unsupportedError = new Error("The provided model doesn't support counting tokens")
      unsupportedError.name = 'ValidationException'
      const mockSend = vi.fn(async () => {
        throw unsupportedError
      })
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      // First call: hits API, gets error, caches
      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledOnce()

      // Second call: skips API entirely
      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledOnce()
    })

    it('should cache model ID and skip API call on AccessDeniedException', async () => {
      const accessDeniedError = new Error(
        'User: arn:aws:sts::123456789012:assumed-role/role is not authorized to perform: bedrock:CountTokens'
      )
      accessDeniedError.name = 'AccessDeniedException'
      const mockSend = vi.fn(async () => {
        throw accessDeniedError
      })
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      // First call: hits API, gets AccessDeniedException, caches
      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledOnce()

      // Second call: skips API entirely due to caching
      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledOnce()
    })

    it('should not cache model ID for other errors', async () => {
      const mockSend = vi.fn(async () => {
        throw new Error('Transient network error')
      })
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: true })

      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledTimes(1)

      // Second call should still attempt the API
      await model.countTokens(messages)
      expect(mockSend).toHaveBeenCalledTimes(2)
    })

    it('should skip native API and use heuristic when useNativeTokenCount is false', async () => {
      const mockSend = vi.fn()
      mockBedrockClientImplementation({ send: mockSend })
      const model = new BedrockModel({ useNativeTokenCount: false })

      const result = await model.countTokens(messages)

      expect(mockSend).not.toHaveBeenCalled()
      expect(result).toBe(2) // heuristic: Math.ceil('hello'.length / 4)
    })
  })
})
