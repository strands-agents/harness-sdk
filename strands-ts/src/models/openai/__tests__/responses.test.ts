import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OpenAI, { APIUserAbortError } from 'openai'
import { isNode } from '../../../__fixtures__/environment.js'
import { OpenAIModel } from '../index.js'
import { ContextWindowOverflowError, MaxTokensError, ModelThrottledError } from '../../../errors.js'
import { collectGenerator, collectIterator } from '../../../__fixtures__/model-test-helpers.js'
import {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolReferenceBlock,
  OffloadedBlock,
  ServerToolBlock,
  UnknownBlock,
} from '../../../types/messages.js'
import { ImageBlock, DocumentBlock } from '../../../types/media.js'
import { CitationsBlock } from '../../../types/citations.js'
import { StateStore } from '../../../state-store.js'
import { logger } from '../../../logging/logger.js'
import type { JSONValue } from '../../../types/json.js'

/**
 * Build a mock OpenAI client whose `responses.create` returns the given async generator.
 * The last request passed to `create` is captured on `capture.request`.
 */
function createMockClient(streamGenerator: () => AsyncGenerator<any>, capture: { request?: any } = {}): OpenAI {
  return {
    responses: {
      create: vi.fn(async (request: any) => {
        capture.request = request
        return streamGenerator()
      }),
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

describe("OpenAIModel (api: 'responses')", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    if (isNode) {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-env')
    }
  })

  afterEach(() => {
    vi.clearAllMocks()
    if (isNode) {
      vi.unstubAllEnvs()
    }
  })

  describe.runIf(isNode)('constructor', () => {
    it('uses API key from constructor parameter', () => {
      new OpenAIModel({ api: 'responses', modelId: 'gpt-4o', apiKey: 'sk-explicit' })
      expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-explicit' }))
    })

    it('uses API key from environment variable', () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-from-env')
      new OpenAIModel({ api: 'responses', modelId: 'gpt-4o' })
      expect(OpenAI).toHaveBeenCalled()
    })

    it('throws error when no API key is available', () => {
      vi.stubEnv('OPENAI_API_KEY', '')
      expect(() => new OpenAIModel({ api: 'responses', modelId: 'gpt-4o' })).toThrow(/OpenAI API key is required/)
    })

    it('uses provided client instance and skips OpenAI constructor', () => {
      vi.clearAllMocks()
      const client = {} as OpenAI
      const model = new OpenAIModel({ api: 'responses', client })
      expect(OpenAI).not.toHaveBeenCalled()
      expect(model).toBeDefined()
    })

    it('does not require API key when client is provided', () => {
      vi.stubEnv('OPENAI_API_KEY', '')
      const client = {} as OpenAI
      expect(() => new OpenAIModel({ api: 'responses', client })).not.toThrow()
    })
  })

  describe('stateful', () => {
    it('defaults to false', () => {
      const model = new OpenAIModel({ api: 'responses', client: {} as OpenAI })
      expect(model.stateful).toBe(false)
    })

    it('returns true when explicitly enabled', () => {
      const model = new OpenAIModel({ api: 'responses', client: {} as OpenAI, stateful: true })
      expect(model.stateful).toBe(true)
    })

    it('is declared on info', () => {
      const stateful = new OpenAIModel({ api: 'responses', client: {} as OpenAI, stateful: true })
      const stateless = new OpenAIModel({ api: 'responses', client: {} as OpenAI })

      expect(stateful.modelInfo.capabilities?.stateful).toBe(true)
      expect(stateless.modelInfo.capabilities?.stateful).toBe(false)
    })

    it('is construction-only and cannot be changed via updateConfig', () => {
      const model = new OpenAIModel({ api: 'responses', client: {} as OpenAI, stateful: false })
      const warnSpy = vi.spyOn(logger, 'warn')
      expect(model.stateful).toBe(false)
      model.updateConfig({ stateful: true })
      expect(model.stateful).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'stateful' is construction-only"))
      warnSpy.mockRestore()
    })
  })

  describe('updateConfig / getConfig', () => {
    it('merges config without clobbering unspecified fields', () => {
      const model = new OpenAIModel({
        api: 'responses',
        client: {} as OpenAI,
        modelId: 'gpt-4o',
        temperature: 0.5,
        maxTokens: 1024,
      })
      model.updateConfig({ temperature: 0.9 })
      expect(model.getConfig()).toMatchObject({
        modelId: 'gpt-4o',
        temperature: 0.9,
        maxTokens: 1024,
      })
    })
  })

  describe('managed params warning', () => {
    it('warns on construction when params contains provider-managed keys', () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      new OpenAIModel({ api: 'responses', client: {} as OpenAI, params: { model: 'bad', store: false } })
      expect(warnSpy).toHaveBeenCalledTimes(2)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'model'"))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'store'"))
      warnSpy.mockRestore()
    })

    it('warns on updateConfig when params contains provider-managed keys', () => {
      const model = new OpenAIModel({ api: 'responses', client: {} as OpenAI })
      const warnSpy = vi.spyOn(logger, 'warn')
      model.updateConfig({ params: { stream: true } })
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'stream'"))
      warnSpy.mockRestore()
    })

    it('does not warn when params contains only non-managed keys', () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      new OpenAIModel({ api: 'responses', client: {} as OpenAI, params: { reasoning: { summary: 'auto' } } })
      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('cancellation', () => {
    // Guards against provider work continuing after agent cancellation (#3915).
    it('stops an in-flight responses producer when the signal aborts', async () => {
      let producedTokens = 0
      let producerStopped = false
      let resolveFirstToken!: () => void
      const firstTokenProduced = new Promise<void>((resolve) => {
        resolveFirstToken = resolve
      })
      const create = vi.fn(async (_request: unknown, requestOptions?: unknown): Promise<AsyncGenerator<unknown>> => {
        const signal = (requestOptions as { signal?: AbortSignal } | undefined)?.signal
        return (async function* (): AsyncGenerator<unknown> {
          yield { type: 'response.created', response: { id: 'response-1' } }
          while (producedTokens < 20) {
            if (signal?.aborted) {
              producerStopped = true
              return
            }
            producedTokens += 1
            if (producedTokens === 1) {
              resolveFirstToken()
            }
            yield { type: 'response.output_text.delta', delta: 'token ' }
            await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1))
          }
          yield { type: 'response.completed', response: {} }
        })()
      })
      const client = { responses: { create } } as unknown as OpenAI
      const controller = new AbortController()
      const model = new OpenAIModel({ api: 'responses', client })
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

  describe('request formatting', () => {
    const mkUserMessage = () => new Message({ role: 'user', content: [new TextBlock('Hi')] })

    async function runOnce(
      modelOptions: Omit<Extract<ConstructorParameters<typeof OpenAIModel>[0], { api?: 'responses' }>, 'api'> = {},
      messages = [mkUserMessage()],
      streamOptions: Parameters<OpenAIModel['stream']>[1] = undefined
    ): Promise<any> {
      const capture: { request?: any } = {}
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'resp_123' } }
        yield { type: 'response.completed', response: { usage: undefined } }
      }, capture)
      const model = new OpenAIModel({ api: 'responses', client, ...modelOptions })
      await collectIterator(model.stream(messages, streamOptions))
      return capture.request
    }

    it('includes model, input, stream, and store=false by default', async () => {
      const req = await runOnce()
      expect(req.model).toBe('gpt-5.4')
      expect(req.stream).toBe(true)
      expect(req.store).toBe(false)
      expect(Array.isArray(req.input)).toBe(true)
    })

    it('sets store=true when stateful is enabled', async () => {
      const req = await runOnce({ stateful: true })
      expect(req.store).toBe(true)
    })

    it('chains previous_response_id when stateful and modelState has responseId', async () => {
      const modelState = new StateStore({ responseId: 'resp_prev' })
      const req = await runOnce({ stateful: true }, [mkUserMessage()], { modelState })
      expect(req.previous_response_id).toBe('resp_prev')
    })

    it('omits previous_response_id when stateful is disabled, even with responseId in modelState', async () => {
      const modelState = new StateStore({ responseId: 'resp_prev' })
      const req = await runOnce({}, [mkUserMessage()], { modelState })
      expect(req.previous_response_id).toBeUndefined()
    })

    it('maps systemPrompt string to instructions', async () => {
      const req = await runOnce({}, [mkUserMessage()], { systemPrompt: 'Be helpful.' })
      expect(req.instructions).toBe('Be helpful.')
    })

    it.each([
      ['gpt-6.2-sol', { cacheConfig: {} }, true],
      ['openai.gpt-6.2-astra', {}, true],
      ['gpt-6.1-sol', { cacheConfig: {} }, false],
      ['gpt-6.2-sol', { stateful: true }, false],
    ])(
      // Guards against GPT-6.2 never caching instructions (#6367).
      'sends the system prompt as a developer message only where instructions never cache: %s %o',
      async (modelId, modelOptions, expectDeveloperMessage) => {
        const systemPrompt = [new TextBlock('Be '), new TextBlock('helpful.')]
        const req = await runOnce({ modelId, ...modelOptions }, [mkUserMessage()], { systemPrompt })
        const withoutSystemPrompt = await runOnce({ modelId, ...modelOptions })

        const developer = { role: 'developer', content: [{ type: 'input_text', text: 'Be helpful.' }] }
        expect(req).toStrictEqual({
          ...withoutSystemPrompt,
          ...(expectDeveloperMessage
            ? { input: [developer, ...withoutSystemPrompt.input] }
            : { instructions: 'Be helpful.' }),
        })
      }
    )

    it('merges toolSpecs with built-in tools from params', async () => {
      const req = await runOnce({ params: { tools: [{ type: 'web_search' }] } }, [mkUserMessage()], {
        toolSpecs: [
          {
            name: 'calc',
            description: 'calculator',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      })
      expect(req.tools).toEqual([
        { type: 'web_search' },
        {
          type: 'function',
          name: 'calc',
          description: 'calculator',
          parameters: { type: 'object', properties: {} },
          strict: null,
        },
      ])
    })

    it('maps tool_choice variants', async () => {
      const toolSpecs = [{ name: 'calc', description: 'd', inputSchema: {} }]
      const autoReq = await runOnce({}, [mkUserMessage()], { toolSpecs, toolChoice: { auto: {} } })
      expect(autoReq.tool_choice).toBe('auto')

      const anyReq = await runOnce({}, [mkUserMessage()], { toolSpecs, toolChoice: { any: {} } })
      expect(anyReq.tool_choice).toBe('required')

      const toolReq = await runOnce({}, [mkUserMessage()], {
        toolSpecs,
        toolChoice: { tool: { name: 'calc' } },
      })
      expect(toolReq.tool_choice).toEqual({ type: 'function', name: 'calc' })
    })

    it('formats temperature, maxTokens→max_output_tokens, and topP', async () => {
      const req = await runOnce({ temperature: 0.3, maxTokens: 512, topP: 0.8 })
      expect(req.temperature).toBe(0.3)
      expect(req.max_output_tokens).toBe(512)
      expect(req.top_p).toBe(0.8)
    })

    it('maps cacheConfig.cacheKey to prompt_cache_key', async () => {
      const req = await runOnce({ cacheConfig: { cacheKey: 'tenant-42' } })
      expect(req.prompt_cache_key).toBe('tenant-42')
    })

    it('omits prompt_cache_key when cacheConfig is unset', async () => {
      const req = await runOnce()
      expect(req.prompt_cache_key).toBeUndefined()
    })

    it('lets an explicit prompt_cache_key in params win over cacheConfig', async () => {
      const req = await runOnce({ params: { prompt_cache_key: 'explicit' }, cacheConfig: { cacheKey: 'from-config' } })
      expect(req.prompt_cache_key).toBe('explicit')
    })

    it('derives prompt_cache_key from the agent metadata session when cacheKey is unset', async () => {
      const req = await runOnce({ cacheConfig: {} }, [mkUserMessage()], { agentMetadata: { sessionId: 's1' } })
      expect(req.prompt_cache_key).toBe('strands-s1')
    })

    it('lets a configured cacheKey win over the agent metadata session', async () => {
      const req = await runOnce({ cacheConfig: { cacheKey: 'tenant-42' } }, [mkUserMessage()], {
        agentMetadata: { sessionId: 's1' },
      })
      expect(req.prompt_cache_key).toBe('tenant-42')
    })

    it('treats a false cacheKey as an opt-out even with an agent metadata session', async () => {
      const req = await runOnce({ cacheConfig: { cacheKey: false } }, [mkUserMessage()], {
        agentMetadata: { sessionId: 's1' },
      })
      expect(req.prompt_cache_key).toBeUndefined()
    })

    it('omits prompt_cache_key when the agent metadata carries no session', async () => {
      const req = await runOnce({ cacheConfig: {} }, [mkUserMessage()], { agentMetadata: {} })
      expect(req.prompt_cache_key).toBeUndefined()
    })

    it.each(['24h', 'in_memory'])(
      'maps retention-literal cacheConfig.ttl %s to prompt_cache_retention',
      async (ttl) => {
        const req = await runOnce({ cacheConfig: { ttl } })
        expect(req.prompt_cache_retention).toBe(ttl)
      }
    )

    it('ignores a non-retention cacheConfig.ttl and warns', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      const req = await runOnce({ cacheConfig: { ttl: '5m' } })
      expect(req.prompt_cache_retention).toBeUndefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not an openai retention value'))
      warnSpy.mockRestore()
    })

    it('lets an explicit prompt_cache_retention in params win over cacheConfig', async () => {
      const req = await runOnce({ params: { prompt_cache_retention: '24h' }, cacheConfig: { ttl: 'in_memory' } })
      expect(req.prompt_cache_retention).toBe('24h')
    })

    it('passes through extra params fields to the request', async () => {
      const req = await runOnce({ params: { reasoning: { summary: 'auto' } } })
      expect(req.reasoning).toEqual({ summary: 'auto' })
    })

    it('provider-managed fields in params are overridden and cannot take effect', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      const req = await runOnce({
        modelId: 'gpt-4o',
        stateful: true,
        params: { model: 'attacker-model', input: 'hijacked', stream: false, store: false },
      })
      expect(req.model).toBe('gpt-4o')
      expect(req.stream).toBe(true)
      expect(req.store).toBe(true)
      expect(Array.isArray(req.input)).toBe(true)
      warnSpy.mockRestore()
    })

    it('emits tool_use and tool_result as separate top-level items', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('run it')] }),
        new Message({
          role: 'assistant',
          content: [new ToolUseBlock({ name: 'calc', toolUseId: 'call_1', input: { expr: '2+2' } })],
        }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'call_1',
              status: 'success',
              content: [new TextBlock('4')],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      const functionCall = req.input.find((i: any) => i.type === 'function_call')
      const functionOutput = req.input.find((i: any) => i.type === 'function_call_output')
      expect(functionCall).toMatchObject({
        type: 'function_call',
        call_id: 'call_1',
        name: 'calc',
        arguments: JSON.stringify({ expr: '2+2' }),
      })
      expect(functionOutput).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_1',
        output: '4',
      })
    })

    it('prefixes errored tool results with [ERROR]', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('x')] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 't1',
              status: 'error',
              content: [new TextBlock('boom')],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      const out = req.input.find((i: any) => i.type === 'function_call_output')
      expect(out.output).toBe('[ERROR] boom')
    })

    it('emits an array output with input_image when a tool result carries image bytes', async () => {
      const imageBytes = new Uint8Array([1, 2, 3, 4])
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('fetch')] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'img_tool',
              status: 'success',
              content: [
                new TextBlock('here is the image'),
                new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
              ],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      const out = req.input.find((i: any) => i.type === 'function_call_output')
      expect(Array.isArray(out.output)).toBe(true)
      expect(out.output).toEqual([
        { type: 'input_text', text: 'here is the image' },
        { type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) },
      ])
    })

    it('emits an array output with input_file when a tool result carries a document', async () => {
      const docBytes = new Uint8Array([5, 6, 7, 8])
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('read')] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'doc_tool',
              status: 'success',
              content: [new DocumentBlock({ name: 'report.pdf', format: 'pdf', source: { bytes: docBytes } })],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      const out = req.input.find((i: any) => i.type === 'function_call_output')
      expect(Array.isArray(out.output)).toBe(true)
      expect(out.output).toEqual([
        {
          type: 'input_file',
          file_data: expect.stringMatching(/^data:application\/pdf;base64,/),
          filename: 'report.pdf',
        },
      ])
    })

    it('keeps tool result output as a plain string when only text is present', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('ping')] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'text_tool',
              status: 'success',
              content: [new TextBlock('pong')],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      const out = req.input.find((i: any) => i.type === 'function_call_output')
      expect(typeof out.output).toBe('string')
      expect(out.output).toBe('pong')
    })

    it('serializes assistant history as a string EasyInputMessage', async () => {
      // A bare `{ role: 'assistant', content: [output_text] }` is not a valid
      // Responses input item and is rejected by strict backends (Bedrock Mantle).
      // See https://github.com/strands-agents/harness-sdk/issues/3388
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('What is 2+2?')] }),
        new Message({ role: 'assistant', content: [new TextBlock('4')] }),
        new Message({ role: 'user', content: [new TextBlock('What about 3+3?')] }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[1]).toEqual({ role: 'assistant', content: '4' })
      expect(req.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'What is 2+2?' }] })
      expect(req.input[2]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'What about 3+3?' }] })
    })

    it('sends an offloaded block as the text the model receives, in user, assistant, and tool-result content', async () => {
      const placeholder = new OffloadedBlock({ text: '[Dropped] [ref: tu-1]', method: 'drop', ref: 'tu-1' })
      const messages = [
        new Message({ role: 'user', content: [placeholder] }),
        new Message({ role: 'assistant', content: [placeholder] }),
        new Message({
          role: 'user',
          content: [new ToolResultBlock({ toolUseId: 'tu-1', status: 'success', content: [placeholder] })],
        }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: '[Dropped] [ref: tu-1]' }] })
      expect(req.input[1]).toEqual({ role: 'assistant', content: '[Dropped] [ref: tu-1]' })
      expect(req.input.find((item: any) => item.type === 'function_call_output')).toMatchObject({
        call_id: 'tu-1',
        output: '[Dropped] [ref: tu-1]',
      })
    })

    it('joins multiple assistant text blocks with newlines', async () => {
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('list two words')] }),
        new Message({ role: 'assistant', content: [new TextBlock('First.'), new TextBlock('Second.')] }),
        new Message({ role: 'user', content: [new TextBlock('thanks')] }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[1]).toEqual({ role: 'assistant', content: 'First.\nSecond.' })
    })

    it('drops non-text assistant history content with a warning', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('draw something')] }),
        new Message({
          role: 'assistant',
          content: [
            new TextBlock('Here it is.'),
            new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
          ],
        }),
        new Message({ role: 'user', content: [new TextBlock('nice')] }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[1]).toEqual({ role: 'assistant', content: 'Here it is.' })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no valid responses api input shape'))
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('content_type=<input_image>'))
      warnSpy.mockRestore()
    })

    it('omits an assistant history turn whose content is entirely non-text', async () => {
      const warnSpy = vi.spyOn(logger, 'warn')
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('draw something')] }),
        new Message({
          role: 'assistant',
          content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } })],
        }),
        new Message({ role: 'user', content: [new TextBlock('nice')] }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input.filter((i: any) => i.role === 'assistant')).toEqual([])
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('content_type=<input_image>'))
      warnSpy.mockRestore()
    })

    it('serializes user-role citations content as input_text', async () => {
      const messages = [
        new Message({
          role: 'user',
          content: [
            new CitationsBlock({
              citations: [
                {
                  location: { type: 'documentChar', documentIndex: 0, start: 0, end: 10 },
                  source: 'doc-0',
                  sourceContent: [{ text: 'source' }],
                  title: 'Test',
                },
              ],
              content: [{ text: 'quoted passage' }],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'quoted passage' }] })
    })

    it('skips unknown blocks in messages and tool results, without a warning', async () => {
      using warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const unknownBlock = new UnknownBlock({ futureBlock: { value: 1 } })
      const messages = [
        new Message({ role: 'user', content: [new TextBlock('hello'), unknownBlock] }),
        new Message({ role: 'assistant', content: [new ToolUseBlock({ name: 'tool', toolUseId: 'tu1', input: {} })] }),
        new Message({
          role: 'user',
          content: [
            new ToolResultBlock({
              toolUseId: 'tu1',
              status: 'success',
              content: [new TextBlock('done'), unknownBlock],
            }),
          ],
        }),
      ]
      const req = await runOnce({}, messages)
      expect(req.input[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'hello' }] })
      expect(req.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'tu1' })
      expect(JSON.stringify(req.input)).not.toContain('futureBlock')
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('stream event mapping', () => {
    it('resolves stateful once per stream, not once per event', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'resp_abc' } }
        for (let i = 0; i < 50; i++) yield { type: 'response.output_text.delta', delta: 'x' }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client, stateful: true })
      const getConfig = vi.spyOn(model, 'getConfig')

      await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('hi')] })]))

      expect(getConfig.mock.calls.length).toBeLessThan(10)
    })

    it('captures responseId on response.created when stateful', async () => {
      const modelState = new StateStore()
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'resp_abc' } }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client, stateful: true })
      await collectIterator(
        model.stream([new Message({ role: 'user', content: [new TextBlock('hi')] })], { modelState })
      )
      expect(modelState.get('responseId')).toBe('resp_abc')
    })

    it('does NOT capture responseId when stateful is disabled', async () => {
      const modelState = new StateStore()
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'resp_abc' } }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      await collectIterator(
        model.stream([new Message({ role: 'user', content: [new TextBlock('hi')] })], { modelState })
      )
      expect(modelState.get('responseId')).toBeUndefined()
    })

    it('emits text deltas inside a content block', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'Hello' }
        yield { type: 'response.output_text.delta', delta: ' world' }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const types = events.map((e: any) => e.type)
      expect(types).toEqual([
        'modelMessageStartEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
      const deltas = events.filter((e: any) => e.type === 'modelContentBlockDeltaEvent').map((e: any) => e.delta)
      expect(deltas).toEqual([
        { type: 'textDelta', text: 'Hello' },
        { type: 'textDelta', text: ' world' },
      ])
    })

    it('switches content blocks between reasoning and text', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.reasoning_text.delta', delta: 'thinking...' }
        yield { type: 'response.output_text.delta', delta: 'answer' }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const types = events.map((e: any) => e.type)
      expect(types).toEqual([
        'modelMessageStartEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent', // reasoning
        'modelContentBlockStopEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent', // text
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
    })

    it('emits tool call triplet after stream close and sets stopReason=toolUse', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield {
          type: 'response.output_item.added',
          item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'calc' },
        }
        yield {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_1',
          delta: '{"a":',
        }
        yield {
          type: 'response.function_call_arguments.delta',
          item_id: 'item_1',
          delta: '1}',
        }
        yield {
          type: 'response.function_call_arguments.done',
          item_id: 'item_1',
          arguments: '{"a":1}',
        }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const startEvent = events.find(
        (e: any) => e.type === 'modelContentBlockStartEvent' && e.start?.type === 'toolUseStart'
      ) as any
      expect(startEvent?.start).toEqual({
        type: 'toolUseStart',
        name: 'calc',
        toolUseId: 'call_1',
      })
      const deltaEvent = events.find(
        (e: any) => e.type === 'modelContentBlockDeltaEvent' && e.delta?.type === 'toolUseInputDelta'
      ) as any
      expect(deltaEvent?.delta).toEqual({ type: 'toolUseInputDelta', input: '{"a":1}' })
      const stopEvent = events.find((e: any) => e.type === 'modelMessageStopEvent') as any
      expect(stopEvent?.stopReason).toBe('toolUse')
    })

    it('maps response.incomplete with max_output_tokens to stopReason=maxTokens', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'partial' }
        yield {
          type: 'response.incomplete',
          response: {
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const stop = events.find((e: any) => e.type === 'modelMessageStopEvent') as any
      expect(stop?.stopReason).toBe('maxTokens')
      const metadata = events.find((e: any) => e.type === 'modelMetadataEvent') as any
      expect(metadata?.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    })

    it('maps response.incomplete with content_filter to stopReason=contentFiltered', async () => {
      // #5740
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'partial' }
        yield { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'partial' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'contentFiltered' },
      ])
    })

    describe('when a function call is in flight at response.incomplete', () => {
      // #5740
      const truncatedCall = (reason: string) =>
        createMockClient(async function* () {
          yield { type: 'response.created', response: { id: 'r' } }
          yield {
            type: 'response.output_item.added',
            item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'write_file' },
          }
          yield {
            type: 'response.function_call_arguments.delta',
            item_id: 'item_1',
            delta: '{"path": "notes.md", "content": "Lorem',
          }
          yield { type: 'response.incomplete', response: { incomplete_details: { reason } } }
        })
      const toolCallEvents = [
        { type: 'modelMessageStartEvent', role: 'assistant' },
        {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'write_file', toolUseId: 'call_1' },
        },
        {
          type: 'modelContentBlockDeltaEvent',
          delta: { type: 'toolUseInputDelta', input: '{"path": "notes.md", "content": "Lorem' },
        },
        { type: 'modelContentBlockStopEvent' },
      ]
      const messages = [new Message({ role: 'user', content: [new TextBlock('x')] })]

      it('reports maxTokens instead of toolUse for max_output_tokens', async () => {
        const model = new OpenAIModel({ api: 'responses', client: truncatedCall('max_output_tokens') })
        const events = await collectIterator(model.stream(messages))
        expect(events).toEqual([...toolCallEvents, { type: 'modelMessageStopEvent', stopReason: 'maxTokens' }])
      })

      it('throws MaxTokensError from streamAggregated for max_output_tokens', async () => {
        const model = new OpenAIModel({ api: 'responses', client: truncatedCall('max_output_tokens') })
        await expect(collectGenerator(model.streamAggregated(messages))).rejects.toThrow(MaxTokensError)
      })

      it('keeps toolUse for content_filter', async () => {
        // contentFiltered here would leave an orphaned toolUse in history; TS has no repair for that yet.
        const model = new OpenAIModel({ api: 'responses', client: truncatedCall('content_filter') })
        const events = await collectIterator(model.stream(messages))
        expect(events).toEqual([...toolCallEvents, { type: 'modelMessageStopEvent', stopReason: 'toolUse' }])
      })
    })

    it('plumbs prompt-cache reads (input_tokens_details.cached_tokens) into cacheReadInputTokens', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'hi' }
        yield {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1553,
              output_tokens: 42,
              total_tokens: 1595,
              input_tokens_details: { cached_tokens: 873 },
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const metadata = events.find((e: any) => e.type === 'modelMetadataEvent') as any
      expect(metadata?.usage).toEqual({
        inputTokens: 1553,
        outputTokens: 42,
        totalTokens: 1595,
        cacheReadInputTokens: 873,
      })
    })

    it('omits cacheReadInputTokens when there is no cache hit (cached_tokens 0 or absent)', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1553,
              output_tokens: 42,
              total_tokens: 1595,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const metadata = events.find((e: any) => e.type === 'modelMetadataEvent') as any
      expect(metadata?.usage).toEqual({ inputTokens: 1553, outputTokens: 42, totalTokens: 1595 })
      expect(metadata?.usage).not.toHaveProperty('cacheReadInputTokens')
    })

    it('plumbs prompt-cache writes (input_tokens_details.cache_write_tokens) into cacheWriteInputTokens', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'hi' }
        yield {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1553,
              output_tokens: 42,
              total_tokens: 1595,
              input_tokens_details: { cached_tokens: 873, cache_write_tokens: 40 },
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const metadata = events.find((e: any) => e.type === 'modelMetadataEvent') as any
      expect(metadata?.usage).toEqual({
        inputTokens: 1553,
        outputTokens: 42,
        totalTokens: 1595,
        cacheReadInputTokens: 873,
        cacheWriteInputTokens: 40,
      })
    })

    it('omits cacheWriteInputTokens when cache_write_tokens is 0 or absent', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield {
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 1553,
              output_tokens: 42,
              total_tokens: 1595,
              input_tokens_details: { cached_tokens: 873, cache_write_tokens: 0 },
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const metadata = events.find((e: any) => e.type === 'modelMetadataEvent') as any
      expect(metadata?.usage).toEqual({
        inputTokens: 1553,
        outputTokens: 42,
        totalTokens: 1595,
        cacheReadInputTokens: 873,
      })
      expect(metadata?.usage).not.toHaveProperty('cacheWriteInputTokens')
    })

    it('emits URL citation delta from response.output_text.annotation.added', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'The answer is here.' }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: {
            type: 'url_citation',
            url: 'https://example.com',
            title: 'Example',
            cited_text: 'here',
          },
        }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const citation = events.find(
        (e: any) => e.type === 'modelContentBlockDeltaEvent' && e.delta?.type === 'citationsDelta'
      ) as any
      expect(citation?.delta.citations[0]).toMatchObject({
        location: { type: 'web', url: 'https://example.com' },
        source: 'https://example.com',
        title: 'Example',
      })
    })

    it('closes the text block before a citation, producing separate blocks when stream ends after citation', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'Before citation' }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: {
            type: 'url_citation',
            url: 'https://example.com',
            title: 'Source',
            cited_text: 'cited',
          },
        }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const types = events.map((e: any) => e.type)
      expect(types).toEqual([
        'modelMessageStartEvent',
        // Text block — closed before citation
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        // Citation block
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
      const deltas = events.filter((e: any) => e.type === 'modelContentBlockDeltaEvent').map((e: any) => e.delta.type)
      expect(deltas).toEqual(['textDelta', 'citationsDelta'])
    })

    it('closes the text block before a citation and opens a new text block after', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'Before ' }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: {
            type: 'url_citation',
            url: 'https://example.com',
            title: 'Source',
            cited_text: 'cited',
          },
        }
        yield { type: 'response.output_text.delta', delta: ' after' }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const types = events.map((e: any) => e.type)
      expect(types).toEqual([
        'modelMessageStartEvent',
        // First text block
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        // Citation block
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        // New text block after citation
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
      const deltas = events.filter((e: any) => e.type === 'modelContentBlockDeltaEvent').map((e: any) => e.delta.type)
      expect(deltas).toEqual(['textDelta', 'citationsDelta', 'textDelta'])
    })

    it('keeps consecutive citations in the same block without extra stop/start', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://a.com', title: 'A', cited_text: 'a' },
        }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://b.com', title: 'B', cited_text: 'b' },
        }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const types = events.map((e: any) => e.type)
      expect(types).toEqual([
        'modelMessageStartEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
    })

    it('handles text → citation → text → citation → text with separate blocks each time', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield { type: 'response.output_text.delta', delta: 'intro ' }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://1.com', title: '1', cited_text: 'c1' },
        }
        yield { type: 'response.output_text.delta', delta: 'middle ' }
        yield {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://2.com', title: '2', cited_text: 'c2' },
        }
        yield { type: 'response.output_text.delta', delta: 'end' }
        yield { type: 'response.completed', response: {} }
      })
      const model = new OpenAIModel({ api: 'responses', client })
      const events = await collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      const deltaTypes = events
        .filter((e: any) => e.type === 'modelContentBlockDeltaEvent')
        .map((e: any) => e.delta.type)
      expect(deltaTypes).toEqual(['textDelta', 'citationsDelta', 'textDelta', 'citationsDelta', 'textDelta'])
      // 5 content blocks = 5 start + 5 stop events
      const starts = events.filter((e: any) => e.type === 'modelContentBlockStartEvent')
      const stops = events.filter((e: any) => e.type === 'modelContentBlockStopEvent')
      expect(starts).toHaveLength(5)
      expect(stops).toHaveLength(5)
    })
  })

  describe('error mapping', () => {
    it('throws response.failed instead of finalizing an empty successful response', async () => {
      const client = createMockClient(async function* () {
        yield { type: 'response.created', response: { id: 'r' } }
        yield {
          type: 'response.failed',
          response: {
            error: {
              code: 'server_error',
              message: 'The model failed while processing the request.',
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })

      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toMatchObject({
        message: 'The model failed while processing the request.',
        code: 'server_error',
      })
    })

    it('wraps a response.failed context limit as ContextWindowOverflowError', async () => {
      const client = createMockClient(async function* () {
        yield {
          type: 'response.failed',
          response: {
            error: {
              code: 'invalid_prompt',
              message: 'prompt tokens (320666) exceed customer model maximum (278528) for model-id',
            },
          },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })

      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toBeInstanceOf(ContextWindowOverflowError)
    })

    it('throws the fallback message when response.failed has no error details', async () => {
      const client = createMockClient(async function* () {
        yield {
          type: 'response.failed',
          response: { error: null },
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })

      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toThrow('OpenAI Responses API response failed')
    })

    it('maps a Responses error event through the existing error classifier', async () => {
      const client = createMockClient(async function* () {
        yield {
          type: 'error',
          code: 'rate_limit_exceeded',
          message: 'Rate limit exceeded while streaming.',
        }
      })
      const model = new OpenAIModel({ api: 'responses', client })

      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toBeInstanceOf(ModelThrottledError)
    })

    it('wraps 429 as ModelThrottledError', async () => {
      const client: any = {
        responses: {
          create: vi.fn(async () => {
            const err: any = new Error('Too many requests')
            err.status = 429
            throw err
          }),
        },
      }
      const model = new OpenAIModel({ api: 'responses', client })
      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toBeInstanceOf(ModelThrottledError)
    })

    it('wraps context_length_exceeded as ContextWindowOverflowError', async () => {
      const client: any = {
        responses: {
          create: vi.fn(async () => {
            const err: any = new Error('This model has a maximum context length of 8k.')
            err.code = 'context_length_exceeded'
            throw err
          }),
        },
      }
      const model = new OpenAIModel({ api: 'responses', client })
      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toBeInstanceOf(ContextWindowOverflowError)
    })

    it('rethrows unknown errors untouched', async () => {
      const client: any = {
        responses: {
          create: vi.fn(async () => {
            throw new Error('some other failure')
          }),
        },
      }
      const model = new OpenAIModel({ api: 'responses', client })
      await expect(
        collectIterator(model.stream([new Message({ role: 'user', content: [new TextBlock('x')] })]))
      ).rejects.toThrow('some other failure')
    })
  })
})

describe("OpenAIModel (api: 'responses') tool search", () => {
  const OPENAI_API = 'https://api.openai.com/v1'
  const params = { type: 'object' as const, properties: { city: { type: 'string' } } }
  const searchTools = { name: 'search_tools', description: 'Load tools.', inputSchema: { type: 'object' as const } }
  const weather = { name: 'get_weather', description: 'Get the weather.', inputSchema: params }
  const forecast = { name: 'get_forecast', description: 'Get a forecast.', inputSchema: params }
  const toolSpecs = [searchTools, weather, forecast]
  const userMessage = (text: string): Message => new Message({ role: 'user', content: [new TextBlock(text)] })
  const fn = (spec: typeof weather, deferred = false): { [key: string]: JSONValue } => ({
    type: 'function',
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema as JSONValue,
    strict: null,
    ...(deferred && { defer_loading: true }),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    if (isNode) vi.stubEnv('OPENAI_API_KEY', 'sk-test-env')
  })

  afterEach(() => {
    if (isNode) vi.unstubAllEnvs()
  })

  /** The request a call with these options sends, and the model's aggregated result for these stream events. */
  async function run(
    options: Parameters<OpenAIModel['stream']>[1],
    { modelId = 'gpt-5.4', messages = [userMessage('Hi')], events = [] as unknown[], params: extra = {} } = {}
  ): Promise<{ request: any; content: unknown[] }> {
    const capture: { request?: any } = {}
    const client = createMockClient(async function* () {
      yield { type: 'response.created', response: { id: 'resp_1' } }
      yield* events
      yield { type: 'response.completed', response: {} }
    }, capture)
    Object.assign(client, { baseURL: OPENAI_API })
    const model = new OpenAIModel({ api: 'responses', client, modelId, params: extra })
    const { result } = await collectGenerator(model.streamAggregated(messages, options))
    return { request: capture.request, content: result.message.content }
  }

  const deferring = (serverToolSearch?: boolean): Parameters<OpenAIModel['stream']>[1] => ({
    toolSpecs,
    deferredTools: new Set(['get_weather', 'get_forecast']),
    ...(serverToolSearch !== undefined && { serverToolSearch }),
  })

  it.each([
    ['the Responses API on GPT-5.4', 'responses', 'gpt-5.4', OPENAI_API, 'native'],
    ['the Responses API on GPT-5.4 nano, which rejects tool search', 'responses', 'gpt-5.4-nano', OPENAI_API, 'stubs'],
    ['Chat Completions on GPT-5.4', 'chat', 'gpt-5.4', OPENAI_API, 'stubs'],
    ['the Responses API on another host', 'responses', 'gpt-5.4', 'https://gateway.example.com/v1', 'stubs'],
  ] as const)('defers tools natively only through %s', (_name, api, modelId, baseURL, expected) => {
    const model = new OpenAIModel({ api, modelId, client: { baseURL } as OpenAI })

    expect(model.modelInfo.capabilities?.deferredToolLoading).toBe(expected)
  })

  it('sends the API tool search in place of search_tools, each deferred function with defer_loading', async () => {
    const { request } = await run(deferring(true))

    expect(request.tools).toEqual([fn(weather, true), fn(forecast, true), { type: 'tool_search' }])
  })

  it('keeps a tool search the caller put in params, and adds no other', async () => {
    const { request } = await run(deferring(true), { params: { tools: [{ type: 'tool_search' }] } })

    expect(request.tools).toEqual([{ type: 'tool_search' }, fn(weather, true), fn(forecast, true)])
  })

  it('sends search_tools as a client tool search that lists the deferred tools, without serverToolSearch', async () => {
    const { request } = await run(deferring())

    expect(request.tools).toEqual([
      {
        type: 'tool_search',
        execution: 'client',
        description:
          'Load tools.\n\nTools you can load:\n- get_weather: Get the weather.\n- get_forecast: Get a forecast.',
        parameters: { type: 'object' },
      },
      fn(weather, true),
      fn(forecast, true),
    ])
  })

  it('sends load_tools as the client tool search when the model loads by name, and runs its call', async () => {
    const loadTools = { name: 'load_tools', description: 'Load tools.', inputSchema: { type: 'object' as const } }
    const searchCall = {
      type: 'tool_search_call',
      id: 'tsc_1',
      call_id: 'call_9',
      execution: 'client',
      arguments: { names: ['get_weather'] },
      status: 'completed',
    }
    const { request, content } = await run(
      { toolSpecs: [loadTools, weather, forecast], deferredTools: new Set(['get_weather', 'get_forecast']) },
      { events: [{ type: 'response.output_item.done', item: searchCall }] }
    )

    expect(request.tools[0]).toEqual({
      type: 'tool_search',
      execution: 'client',
      description:
        'Load tools.\n\nTools you can load:\n- get_weather: Get the weather.\n- get_forecast: Get a forecast.',
      parameters: { type: 'object' },
    })
    expect(content).toEqual([
      new ToolUseBlock({ name: 'load_tools', toolUseId: 'call_9', input: { names: ['get_weather'] } }),
    ])
  })

  it('sends every function as it is on a model that does not defer tools natively', async () => {
    const { request } = await run(deferring(true), { modelId: 'gpt-5.4-nano' })

    expect(request.tools).toEqual([fn(searchTools as typeof weather), fn(weather), fn(forecast)])
  })

  it("keeps the API's tool search items where they came and the namespace of a call to a tool it loaded", async () => {
    const searchCall = {
      type: 'tool_search_call',
      id: 'tsc_1',
      call_id: null,
      execution: 'server',
      arguments: { paths: ['get_weather'] },
      status: 'completed',
    }
    const searchOutput = {
      type: 'tool_search_output',
      id: 'tso_1',
      call_id: null,
      execution: 'server',
      status: 'completed',
      tools: [
        { ...fn(weather, true) },
        { type: 'namespace', name: 'crm', description: 'CRM tools.', tools: [{ ...fn(forecast, true) }] },
      ],
    }
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'get_weather',
      namespace: 'get_weather',
      arguments: '',
    }
    const { content } = await run(deferring(true), {
      events: [
        { type: 'response.output_text.delta', delta: 'Looking.' },
        { type: 'response.output_item.done', item: searchCall },
        { type: 'response.output_item.done', item: searchOutput },
        { type: 'response.output_item.added', item: call },
        { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"city":"Paris"}' },
      ],
    })

    expect(content).toEqual([
      new TextBlock('Looking.'),
      new ServerToolBlock({ provider: 'openai', data: searchCall }),
      new ServerToolBlock({ provider: 'openai', data: searchOutput, loadedTools: ['get_weather', 'get_forecast'] }),
      new ToolUseBlock({
        name: 'get_weather',
        toolUseId: 'call_1',
        input: { city: 'Paris' },
        namespace: 'get_weather',
      }),
    ])
  })

  it('turns a client tool search call into a search_tools call', async () => {
    const searchCall = {
      type: 'tool_search_call',
      id: 'tsc_1',
      call_id: 'call_9',
      execution: 'client',
      arguments: { query: 'weather' },
      status: 'completed',
    }
    const { content } = await run(deferring(), { events: [{ type: 'response.output_item.done', item: searchCall }] })

    expect(content).toEqual([
      new ToolUseBlock({ name: 'search_tools', toolUseId: 'call_9', input: { query: 'weather' } }),
    ])
  })

  it("sends its own server tool items back before the calls, leaves out another provider's, and keeps each call's namespace", async () => {
    const searchCall = {
      type: 'tool_search_call',
      call_id: null,
      execution: 'server',
      arguments: { paths: ['get_weather'] },
      status: 'completed',
    }
    const messages = [
      userMessage('Hi'),
      new Message({
        role: 'assistant',
        content: [
          new ServerToolBlock({ provider: 'openai', data: searchCall }),
          new ServerToolBlock({ provider: 'anthropic', data: { type: 'server_tool_use' } }),
          new ToolUseBlock({
            name: 'get_weather',
            toolUseId: 'call_1',
            input: { city: 'Paris' },
            namespace: 'get_weather',
          }),
          new TextBlock('Checking.'),
        ],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'call_1', status: 'success', content: [new TextBlock('Sunny.')] })],
      }),
    ]

    const { request } = await run(deferring(true), { messages })

    expect(request.input.slice(1)).toEqual([
      { role: 'assistant', content: 'Checking.' },
      searchCall,
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        namespace: 'get_weather',
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'Sunny.' },
    ])
  })

  it('sends a search_tools call that loaded tools as a client tool search, its output loading the tools the request still has', async () => {
    const messages = [
      userMessage('Hi'),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'search_tools', toolUseId: 'call_9', input: { query: 'weather' } })],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 'call_9',
            status: 'success',
            content: [
              new ToolReferenceBlock({ name: 'get_weather' }),
              new ToolReferenceBlock({ name: 'removed_tool' }),
            ],
          }),
        ],
      }),
    ]

    const { request } = await run(deferring(), { messages })

    expect(request.input.slice(1)).toEqual([
      {
        type: 'tool_search_call',
        call_id: 'call_9',
        execution: 'client',
        status: 'completed',
        arguments: { query: 'weather' },
      },
      {
        type: 'tool_search_output',
        call_id: 'call_9',
        execution: 'client',
        status: 'completed',
        tools: [fn(weather, true)],
      },
    ])
  })

  it('sends a search_tools call that loaded nothing, and a reference beside text, as text a function call output holds', async () => {
    const messages = [
      userMessage('Hi'),
      new Message({
        role: 'assistant',
        content: [
          new ToolUseBlock({ name: 'search_tools', toolUseId: 'call_9', input: { query: 'pizza' } }),
          new ToolUseBlock({ name: 'get_weather', toolUseId: 'call_1', input: {} }),
        ],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({ toolUseId: 'call_9', status: 'error', content: [new TextBlock('Nothing loaded.')] }),
          new ToolResultBlock({
            toolUseId: 'call_1',
            status: 'error',
            content: [new TextBlock('Not run.'), new ToolReferenceBlock({ name: 'get_weather' })],
          }),
        ],
      }),
    ]

    const { request } = await run(deferring(true), { messages })

    expect(request.input.slice(1)).toEqual([
      { type: 'function_call', call_id: 'call_9', name: 'search_tools', arguments: '{"query":"pizza"}' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_9', output: '[ERROR] Nothing loaded.' },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: `[ERROR] Not run.\nget_weather parameters: ${JSON.stringify(params)}`,
      },
    ])
  })
})
