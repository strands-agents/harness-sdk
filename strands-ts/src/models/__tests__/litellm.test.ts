import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { collectIterator } from '../../__fixtures__/model-test-helpers.js'
import { Agent } from '../../agent/agent.js'
import { DocumentBlock, ImageBlock, VideoBlock } from '../../types/media.js'
import {
  CachePointBlock,
  JsonBlock,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '../../types/messages.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../errors.js'
import { LiteLLMModel } from '../litellm.js'

const openAIMocks = vi.hoisted(() => ({
  create: vi.fn(),
  post: vi.fn(),
}))

vi.mock('openai', () => ({
  default: vi.fn(function () {
    return {
      post: openAIMocks.post,
      chat: {
        completions: {
          create: openAIMocks.create,
        },
      },
    }
  }),
}))

describe('LiteLLMModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('configuration', () => {
    it('returns and updates LiteLLM model parameters', () => {
      const model = new LiteLLMModel({
        modelId: 'anthropic/claude-3-7-sonnet',
        temperature: 0.5,
      })

      model.updateConfig({ temperature: 0.8, maxTokens: 2_048 })

      expect(model.getConfig()).toStrictEqual({
        modelId: 'anthropic/claude-3-7-sonnet',
        temperature: 0.8,
        maxTokens: 2_048,
      })
    })
  })

  describe('Agent integration', () => {
    it('returns structured output through the TypeScript agent tool workflow', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'structured-output-1',
                      function: {
                        name: 'strands_structured_output',
                        arguments: '{"name":"Ada","age":37}',
                      },
                    },
                  ],
                },
                index: 0,
              },
            ],
          }
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }
        })()
      )
      const model = new LiteLLMModel({ modelId: 'openai/gpt-4o' })
      const agent = new Agent({
        model,
        structuredOutputSchema: z.object({ name: z.string(), age: z.number() }),
        printer: false,
        retryStrategy: null,
      })

      const result = await agent.invoke('Describe Ada')

      expect(result.structuredOutput).toEqual({ name: 'Ada', age: 37 })
      expect(openAIMocks.post).toHaveBeenCalledOnce()
      expect(openAIMocks.post.mock.calls[0]?.[1]).toMatchObject({
        body: {
          tools: [
            {
              type: 'function',
              function: { name: 'strands_structured_output' },
            },
          ],
        },
      })
    })
  })

  describe('stream', () => {
    it('formats LiteLLM-specific content, caching, tools, and thought signatures', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] }
        })()
      )
      const model = new LiteLLMModel({
        modelId: 'gemini/gemini-2.5-pro',
        temperature: 0.2,
        maxTokens: 1_024,
        topP: 0.8,
        frequencyPenalty: 0.1,
        presencePenalty: 0.3,
      })
      const messages = [
        new Message({
          role: 'user',
          content: [
            new TextBlock('Inspect these files'),
            new ImageBlock({ format: 'png', source: { url: 'https://example.com/image.png' } }),
            new VideoBlock({ format: 'mp4', source: { bytes: new Uint8Array([1, 2, 3]) } }),
            new DocumentBlock({ name: 'guide.pdf', format: 'pdf', source: { bytes: new Uint8Array([4, 5]) } }),
          ],
        }),
        new Message({
          role: 'assistant',
          content: [
            new ReasoningBlock({ text: 'I should inspect them.', signature: 'reasoning-signature' }),
            new ToolUseBlock({
              name: 'inspect',
              toolUseId: 'call-1',
              input: { path: '/tmp/input' },
              reasoningSignature: 'thought-signature',
            }),
          ],
        }),
      ]

      await collectIterator(
        model.stream(messages, {
          systemPrompt: [new TextBlock('Follow policy.'), new CachePointBlock({ cacheType: 'default', ttl: '1h' })],
          toolSpecs: [
            {
              name: 'inspect',
              description: 'Inspect a path',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
          ],
          toolChoice: { tool: { name: 'inspect' } },
        })
      )

      expect(openAIMocks.post).toHaveBeenCalledWith('/chat/completions', {
        body: {
          model: 'gemini/gemini-2.5-pro',
          messages: [
            {
              role: 'system',
              content: [
                {
                  type: 'text',
                  text: 'Follow policy.',
                  cache_control: { type: 'ephemeral', ttl: '1h' },
                },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Inspect these files' },
                { type: 'image_url', image_url: { detail: 'auto', url: 'https://example.com/image.png' } },
                { type: 'video_url', video_url: { detail: 'auto', url: 'data:video/mp4;base64,AQID' } },
                {
                  type: 'file',
                  file: { file_data: 'data:application/pdf;base64,BAU=', filename: 'guide.pdf' },
                },
              ],
            },
            {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'I should inspect them.', signature: 'reasoning-signature' }],
              tool_calls: [
                {
                  id: 'call-1__thought__thought-signature',
                  type: 'function',
                  function: { name: 'inspect', arguments: '{"path":"/tmp/input"}' },
                },
              ],
            },
          ],
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.2,
          max_tokens: 1_024,
          top_p: 0.8,
          frequency_penalty: 0.1,
          presence_penalty: 0.3,
          tools: [
            {
              type: 'function',
              function: {
                name: 'inspect',
                description: 'Inspect a path',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'inspect' } },
        },
        stream: true,
      })
    })

    it('preserves encoded tool IDs across assistant calls and tool results', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }
        })()
      )
      const model = new LiteLLMModel({ modelId: 'gemini/gemini-2.5-pro' })
      const encodedId = 'call-3__thought__signature'
      const messages = [
        new Message({
          role: 'assistant',
          content: [
            new ToolUseBlock({
              name: 'inspect',
              toolUseId: encodedId,
              input: { path: '/tmp' },
              reasoningSignature: 'signature',
            }),
          ],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: encodedId,
              status: 'success',
              content: [new TextBlock('found'), new JsonBlock({ json: { count: 1 } })],
            }),
          ],
        }),
      ]

      await collectIterator(model.stream(messages))

      expect(openAIMocks.post).toHaveBeenCalledWith('/chat/completions', {
        body: {
          model: 'gemini/gemini-2.5-pro',
          messages: [
            {
              role: 'assistant',
              tool_calls: [
                {
                  id: encodedId,
                  type: 'function',
                  function: { name: 'inspect', arguments: '{"path":"/tmp"}' },
                },
              ],
            },
            { role: 'tool', tool_call_id: encodedId, content: 'found\n{"count":1}' },
          ],
          stream: true,
          stream_options: { include_usage: true },
          tools: [],
        },
        stream: true,
      })
    })

    it('handles a non-streaming LiteLLM response when streaming is disabled', async () => {
      openAIMocks.post.mockResolvedValue({
        choices: [
          {
            message: { role: 'assistant', content: 'Hello without streaming' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
      })
      const model = new LiteLLMModel({ modelId: 'openai/gpt-4o', params: { stream: false } })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(model.stream(messages))

      expect(openAIMocks.post).toHaveBeenCalledWith('/chat/completions', {
        body: {
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          stream: false,
          tools: [],
        },
      })
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello without streaming' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
        { type: 'modelMetadataEvent', usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } },
      ])
    })

    it('streams an agent message through the configured LiteLLM model', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
          yield { choices: [{ delta: { content: 'Hello from LiteLLM' }, index: 0 }] }
          yield { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }
          yield {
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
          }
        })()
      )
      const model = new LiteLLMModel({
        modelId: 'openai/gpt-4o',
        baseURL: 'https://litellm.example.com/v1',
        apiKey: 'sk-proxy',
        params: { seed: 42 },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const events = await collectIterator(model.stream(messages))

      expect(openAIMocks.post).toHaveBeenCalledWith('/chat/completions', {
        body: {
          seed: 42,
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          stream: true,
          stream_options: { include_usage: true },
          tools: [],
        },
        stream: true,
      })
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello from LiteLLM' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
        { type: 'modelMetadataEvent', usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 } },
      ])
    })

    it('streams reasoning, text, Gemini tool signatures, and cache metrics', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: { role: 'assistant' }, index: 0 }] }
          yield { choices: [{ delta: { reasoning_content: 'Inspect first. ' }, index: 0 }] }
          yield { choices: [{ delta: { content: 'Using the tool.' }, index: 0 }] }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-2__thought__encoded-signature',
                      provider_specific_fields: { thought_signature: 'structured-signature' },
                      function: { name: 'inspect', arguments: '{"path":' },
                    },
                  ],
                },
                index: 0,
              },
            ],
          }
          yield {
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/input"}' } }] }, index: 0 }],
          }
          yield { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }
          yield {
            choices: [],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 7,
              total_tokens: 27,
              prompt_tokens_details: { cached_tokens: 12 },
              cache_creation_input_tokens: 4,
            },
          }
        })()
      )
      const model = new LiteLLMModel({ modelId: 'gemini/gemini-2.5-pro' })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Inspect')] })]

      const events = await collectIterator(model.stream(messages))

      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'reasoningContentDelta', text: 'Inspect first. ' },
        },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Using the tool.' } },
        { type: 'modelContentBlockStopEvent' },
        {
          type: 'modelContentBlockStartEvent',
          start: {
            type: 'toolUseStart',
            name: 'inspect',
            toolUseId: 'call-2__thought__encoded-signature',
            reasoningSignature: 'structured-signature',
          },
        },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"path":' } },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '"/tmp/input"}' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
        {
          type: 'modelMetadataEvent',
          usage: {
            inputTokens: 20,
            outputTokens: 7,
            totalTokens: 27,
            cacheReadInputTokens: 12,
            cacheWriteInputTokens: 4,
          },
        },
      ])
    })

    it('maps non-streaming reasoning and synthesizes missing tool call IDs', async () => {
      openAIMocks.post.mockResolvedValue({
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'I need a tool.',
              tool_calls: [{ type: 'function', function: { name: 'inspect', arguments: '{"path":"/tmp"}' } }],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      })
      const model = new LiteLLMModel({ modelId: 'openai/gpt-4o', stream: false })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Inspect')] })]

      const events = await collectIterator(model.stream(messages))
      const toolStart = events[4]

      expect(toolStart).toMatchObject({
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'inspect', toolUseId: expect.stringMatching(/^call_[0-9a-f-]+$/) },
      })
      if (toolStart?.type !== 'modelContentBlockStartEvent' || !toolStart.start) {
        throw new Error('Expected a tool use start event')
      }
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'I need a tool.' } },
        { type: 'modelContentBlockStopEvent' },
        {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'inspect', toolUseId: toolStart.start.toolUseId },
        },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"path":"/tmp"}' },
        },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      ])
    })

    it('honors top-level stream configuration over legacy params', async () => {
      openAIMocks.post.mockResolvedValue(
        (async function* () {
          yield { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] }
        })()
      )
      const model = new LiteLLMModel({
        modelId: 'openai/gpt-4o',
        stream: true,
        params: { stream: false, stream_options: { include_usage: false } },
      })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      await collectIterator(model.stream(messages))

      expect(openAIMocks.post).toHaveBeenCalledWith('/chat/completions', {
        body: {
          model: 'openai/gpt-4o',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          stream: true,
          stream_options: { include_usage: false },
          tools: [],
        },
        stream: true,
      })
    })

    it.each([
      {
        name: 'context overflow',
        vendorError: Object.assign(new Error('maximum context length exceeded'), { status: 400 }),
        expectedError: ContextWindowOverflowError,
      },
      {
        name: 'throttling',
        vendorError: Object.assign(new Error('rate limit exceeded'), { status: 429 }),
        expectedError: ModelThrottledError,
      },
    ])('maps $name errors and preserves their cause', async ({ vendorError, expectedError }) => {
      openAIMocks.post.mockRejectedValue(vendorError)
      const model = new LiteLLMModel({ modelId: 'openai/gpt-4o' })
      const messages = [new Message({ role: 'user', content: [new TextBlock('Hello')] })]

      const invocation = collectIterator(model.stream(messages))

      await expect(invocation).rejects.toBeInstanceOf(expectedError)
      await expect(invocation).rejects.toMatchObject({ cause: vendorError })
    })
  })
})
