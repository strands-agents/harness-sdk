import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SageMakerModel } from '../model.js'
import type { SageMakerModelOptions } from '../types.js'
import { Agent } from '../../../agent/agent.js'
import { tool } from '../../../tools/tool-factory.js'
import { ContextWindowOverflowError, ModelThrottledError } from '../../../errors.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { ModelStreamEvent } from '../../streaming.js'

const sdk = vi.hoisted(() => ({ clientConfigs: [] as unknown[] }))

vi.mock('@aws-sdk/client-sagemaker-runtime', () => {
  class SageMakerRuntimeClient {
    send = vi.fn()
    constructor(config: unknown) {
      sdk.clientConfigs.push(config)
    }
  }
  class InvokeEndpointCommand {
    readonly kind = 'invoke'
    constructor(readonly input: Record<string, unknown>) {}
  }
  class InvokeEndpointWithResponseStreamCommand {
    readonly kind = 'stream'
    constructor(readonly input: Record<string, unknown>) {}
  }
  return { SageMakerRuntimeClient, InvokeEndpointCommand, InvokeEndpointWithResponseStreamCommand }
})

// ── Helpers ──────────────────────────────────────────────────────────────

interface SentCommand {
  kind: 'invoke' | 'stream'
  input: { Body: Uint8Array; [key: string]: unknown }
}

const encoder = new TextEncoder()

function sseBody(chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const chunk of chunks) yield { PayloadPart: { Bytes: encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`) } }
    yield { PayloadPart: { Bytes: encoder.encode('data: [DONE]\n\n') } }
  })()
}

/** A client whose responses are returned in order, one per request. */
function fakeClient(responses: Array<(command: SentCommand) => unknown>) {
  const sent: Array<{ command: SentCommand; options: unknown }> = []
  const send = vi.fn(async (command: SentCommand, options: unknown) => {
    sent.push({ command, options })
    const respond = responses[sent.length - 1]
    if (!respond) throw new Error('unexpected request')
    return respond(command)
  })
  return { client: { send } as unknown as SageMakerModelOptions['client'], sent }
}

function streamOf(chunks: unknown[]) {
  return () => ({ Body: sseBody(chunks) })
}

function jsonOf(body: unknown) {
  return () => ({ Body: encoder.encode(JSON.stringify(body)) })
}

function payloadOf(command: SentCommand): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(command.input.Body))
}

function delta(d: Record<string, unknown>, finishReason: string | null = null) {
  return { choices: [{ index: 0, delta: d, finish_reason: finishReason }] }
}

async function collect(model: SageMakerModel, messages = [userText('hi')]): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of model.stream(messages)) events.push(event)
  return events
}

function userText(text: string): Message {
  return new Message({ role: 'user', content: [new TextBlock(text)] })
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('SageMakerModel', () => {
  beforeEach(() => {
    sdk.clientConfigs.length = 0
  })

  describe('constructor', () => {
    it('requires an endpoint name', () => {
      expect(() => new SageMakerModel({ endpointName: ' ' })).toThrow('requires an endpointName')
    })

    it('rejects a client combined with region or clientConfig', () => {
      const { client } = fakeClient([])
      expect(() => new SageMakerModel({ endpointName: 'ep', client: client!, region: 'us-east-1' })).toThrow(
        'Cannot specify both'
      )
      expect(() => new SageMakerModel({ endpointName: 'ep', client: client!, clientConfig: {} })).toThrow(
        'Cannot specify both'
      )
    })

    it('defaults to streaming and tool-role results', () => {
      const config = new SageMakerModel({ endpointName: 'ep' }).getConfig()
      expect(config.stream).toBe(true)
      expect(config.toolResultsAsUserMessages).toBe(false)
    })

    it('merges updateConfig into the configuration', () => {
      const model = new SageMakerModel({ endpointName: 'ep', modelId: 'm', maxTokens: 10 })
      model.updateConfig({ maxTokens: 20 })
      expect(model.getConfig()).toMatchObject({ modelId: 'm', maxTokens: 20 })
      expect(model.modelId).toBe('m')
    })
  })

  describe('client configuration', () => {
    it('keeps clientConfig.region when region is not set', async () => {
      const model = new SageMakerModel({ endpointName: 'ep', clientConfig: { region: 'eu-west-1' } })
      await (model as any)._getRuntime()
      expect(sdk.clientConfigs[0]).toMatchObject({ region: 'eu-west-1' })
    })

    it('lets region win over clientConfig.region', async () => {
      const model = new SageMakerModel({
        endpointName: 'ep',
        region: 'ap-northeast-1',
        clientConfig: { region: 'eu-west-1' },
      })
      await (model as any)._getRuntime()
      expect(sdk.clientConfigs[0]).toMatchObject({ region: 'ap-northeast-1' })
    })

    it('appends the SDK user agent to a string customUserAgent', async () => {
      const model = new SageMakerModel({ endpointName: 'ep', clientConfig: { customUserAgent: 'my-app/1.0' } })
      await (model as any)._getRuntime()
      expect(sdk.clientConfigs[0]).toMatchObject({
        customUserAgent: [['my-app/1.0'], ['strands-agents-ts-sdk']],
      })
    })
  })

  describe('streaming', () => {
    it('emits one text block for a text response', async () => {
      const { client } = fakeClient([
        streamOf([
          delta({ role: 'assistant', content: '' }),
          delta({ content: 'Hello' }),
          delta({ content: ' world' }),
          delta({}, 'stop'),
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ]),
      ])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))

      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hello' } },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: ' world' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMetadataEvent', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
    })

    it('streams reasoning before text as separate blocks', async () => {
      const { client } = fakeClient([
        streamOf([
          delta({ reasoning_content: 'Let me ' }),
          delta({ reasoning: 'think.' }),
          delta({ content: 'Answer' }, 'stop'),
        ]),
      ])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))

      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'Let me ' } },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'think.' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Answer' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
    })

    it('assembles a tool call whose id, name and arguments arrive in separate deltas', async () => {
      const { client } = fakeClient([
        streamOf([
          delta({ tool_calls: [{ index: 0, id: 'call_1' }] }),
          delta({ tool_calls: [{ index: 0, function: { name: 'get_weather' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] }),
          delta({}, 'tool_calls'),
        ]),
      ])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))

      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'get_weather', toolUseId: 'call_1' },
        },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"city":' } },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '"Tokyo"}' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      ])
    })

    it.each([['stop'], [null]])('reports toolUse when a tool call ends with finish_reason %s', async (reason) => {
      const chunks: unknown[] = [
        delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }] }),
      ]
      if (reason) chunks.push(delta({}, reason))
      const { client } = fakeClient([streamOf(chunks)])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))
      expect(events.at(-1)).toEqual({ type: 'modelMessageStopEvent', stopReason: 'toolUse' })
    })

    it('emits text before tool calls from the same response', async () => {
      const { client } = fakeClient([
        streamOf([
          delta({ content: 'Checking.' }),
          delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }] }, 'tool_calls'),
        ]),
      ])
      const types = (await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).map((e) =>
        e.type === 'modelContentBlockStartEvent' && e.start ? 'toolStart' : e.type
      )
      expect(types).toEqual([
        'modelMessageStartEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'toolStart',
        'modelContentBlockDeltaEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
    })

    it('maps finish_reason length to maxTokens', async () => {
      const { client } = fakeClient([streamOf([delta({ content: 'cut' }, 'length')])])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))
      expect(events.at(-1)).toEqual({ type: 'modelMessageStopEvent', stopReason: 'maxTokens' })
    })

    it('emits an empty text block when the response has no content', async () => {
      const { client } = fakeClient([streamOf([delta({}, 'stop')])])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', client: client! }))
      expect(events.map((e) => e.type)).toEqual([
        'modelMessageStartEvent',
        'modelContentBlockStartEvent',
        'modelContentBlockStopEvent',
        'modelMessageStopEvent',
      ])
    })

    it('rejects a tool call without a name', async () => {
      const { client } = fakeClient([streamOf([delta({ tool_calls: [{ index: 0, id: 'c' }] }, 'tool_calls')])])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).rejects.toThrow(
        'without a tool name'
      )
    })

    it('raises a ModelStreamError sent inside the stream', async () => {
      const failure = Object.assign(new Error('container crashed'), { name: 'ModelStreamError' })
      const { client } = fakeClient([
        () => ({
          Body: (async function* () {
            yield { PayloadPart: { Bytes: encoder.encode(`data: ${JSON.stringify(delta({ content: 'a' }))}\n\n`) } }
            yield { ModelStreamError: failure }
          })(),
        }),
      ])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).rejects.toThrow(
        'container crashed'
      )
    })
  })

  describe('non-streaming', () => {
    it('emits text, reasoning and usage from one response', async () => {
      const { client, sent } = fakeClient([
        jsonOf({
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hi', reasoning: 'thought' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      ])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', stream: false, client: client! }))

      expect(sent[0]!.command.kind).toBe('invoke')
      expect(payloadOf(sent[0]!.command)).toMatchObject({ stream: false })
      expect(payloadOf(sent[0]!.command)).not.toHaveProperty('stream_options')
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: 'thought' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelContentBlockStartEvent' },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Hi' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMetadataEvent', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
        { type: 'modelMessageStopEvent', stopReason: 'endTurn' },
      ])
    })

    it('emits tool calls whose arguments arrive as an object', async () => {
      const { client } = fakeClient([
        jsonOf({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: { q: 'x' } } }],
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ])
      const events = await collect(new SageMakerModel({ endpointName: 'ep', stream: false, client: client! }))
      expect(events).toEqual([
        { type: 'modelMessageStartEvent', role: 'assistant' },
        { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'search', toolUseId: 'c1' } },
        { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"q":"x"}' } },
        { type: 'modelContentBlockStopEvent' },
        { type: 'modelMessageStopEvent', stopReason: 'toolUse' },
      ])
    })

    it('rejects a response without a message', async () => {
      const { client } = fakeClient([jsonOf({ choices: [] })])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', stream: false, client: client! }))).rejects.toThrow(
        'without choices[0].message'
      )
    })
  })

  describe('request', () => {
    it('builds the SageMaker envelope and an OpenAI-compatible payload', async () => {
      const { client, sent } = fakeClient([streamOf([delta({ content: 'ok' }, 'stop')])])
      const model = new SageMakerModel({
        endpointName: 'ep',
        inferenceComponentName: 'ic',
        targetVariant: 'v1',
        additionalRequestArgs: { CustomAttributes: 'a=b' },
        maxTokens: 100,
        temperature: 0.2,
        topK: 5,
        stop: ['END'],
        additionalPayloadArgs: { repetition_penalty: 1.1, stream: false },
        client: client!,
      })
      const controller = new AbortController()
      const iterator = model.stream([userText('hi')], {
        systemPrompt: 'Be brief.',
        cancelSignal: controller.signal,
        toolSpecs: [{ name: 'calc', description: 'Calculator', inputSchema: { type: 'object' } }],
      })
      for await (const _ of iterator) {
        // drain
      }

      const { command, options } = sent[0]!
      expect(command.kind).toBe('stream')
      expect(command.input.Body).toBeInstanceOf(Uint8Array)
      expect(command.input).toMatchObject({
        EndpointName: 'ep',
        InferenceComponentName: 'ic',
        TargetVariant: 'v1',
        CustomAttributes: 'a=b',
        ContentType: 'application/json',
        Accept: 'application/json',
      })
      expect(options).toEqual({ abortSignal: controller.signal })
      expect(payloadOf(command)).toEqual({
        repetition_penalty: 1.1,
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 100,
        temperature: 0.2,
        top_k: 5,
        stop: ['END'],
        tools: [
          {
            type: 'function',
            function: { name: 'calc', description: 'Calculator', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
      })
    })

    it('omits fields set to null in additionalPayloadArgs', async () => {
      const { client, sent } = fakeClient([streamOf([delta({ content: 'ok' }, 'stop')])])
      await collect(
        new SageMakerModel({ endpointName: 'ep', additionalPayloadArgs: { stream_options: null }, client: client! })
      )
      expect(payloadOf(sent[0]!.command)).not.toHaveProperty('stream_options')
    })

    const history = [
      userText('weather?'),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'get_weather', toolUseId: 'c1', input: { city: 'Tokyo' } })],
      }),
      new Message({
        role: 'user',
        content: [new ToolResultBlock({ toolUseId: 'c1', status: 'success', content: [new TextBlock('sunny')] })],
      }),
    ]

    it('sends tool calls and tool results in the OpenAI shape', async () => {
      const { client, sent } = fakeClient([streamOf([delta({ content: 'ok' }, 'stop')])])
      await collect(new SageMakerModel({ endpointName: 'ep', client: client! }), history)
      expect(payloadOf(sent[0]!.command).messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
        {
          role: 'assistant',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'sunny' },
      ])
    })

    it('sends tool results as user messages when toolResultsAsUserMessages is set', async () => {
      const { client, sent } = fakeClient([streamOf([delta({ content: 'ok' }, 'stop')])])
      await collect(
        new SageMakerModel({ endpointName: 'ep', toolResultsAsUserMessages: true, client: client! }),
        history
      )
      expect(payloadOf(sent[0]!.command).messages.at(-1)).toEqual({
        role: 'user',
        content: "Tool call ID 'c1' returned: sunny",
      })
    })
  })

  describe('errors', () => {
    it('maps a container 429 to ModelThrottledError', async () => {
      const error = Object.assign(new Error('Received client error (429)'), {
        name: 'ModelError',
        OriginalStatusCode: 429,
      })
      const { client } = fakeClient([
        () => {
          throw error
        },
      ])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).rejects.toBeInstanceOf(
        ModelThrottledError
      )
    })

    it('maps a container context-length error to ContextWindowOverflowError', async () => {
      const error = Object.assign(new Error('Received client error (400)'), {
        name: 'ModelError',
        OriginalStatusCode: 400,
        OriginalMessage: '{"message":"This model\'s maximum context length is 8192 tokens"}',
      })
      const { client } = fakeClient([
        () => {
          throw error
        },
      ])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).rejects.toBeInstanceOf(
        ContextWindowOverflowError
      )
    })

    it('passes other errors through', async () => {
      const error = Object.assign(new Error('bad input'), { name: 'ValidationError' })
      const { client } = fakeClient([
        () => {
          throw error
        },
      ])
      await expect(collect(new SageMakerModel({ endpointName: 'ep', client: client! }))).rejects.toBe(error)
    })
  })

  describe('with an Agent', () => {
    it('runs a tool the model calls and returns the final answer', async () => {
      const { client, sent } = fakeClient([
        streamOf([
          delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'add', arguments: '{"a":2,"b":3}' } }] }),
          delta({}, 'stop'),
        ]),
        streamOf([delta({ content: 'The sum is 5.' }, 'stop')]),
      ])
      const add = tool({
        name: 'add',
        description: 'Adds two numbers',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        callback: (input: unknown) => {
          const { a, b } = input as { a: number; b: number }
          return String(a + b)
        },
      })
      const agent = new Agent({
        model: new SageMakerModel({ endpointName: 'ep', client: client! }),
        tools: [add],
        printer: false,
      })

      const result = await agent.invoke('What is 2 + 3?')

      expect(result.stopReason).toBe('endTurn')
      expect(result.lastMessage.content).toEqual([new TextBlock('The sum is 5.')])
      expect(payloadOf(sent[1]!.command).messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '5' })
    })
  })
})
