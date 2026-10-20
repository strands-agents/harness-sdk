import { describe, expect, it, vi } from 'vitest'

import { isNode } from '../../../__fixtures__/environment.js'

import { ImageBlock, decodeBase64 } from '../../../types/media.js'
import { JsonBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { AudioDelta } from '../../types/media.js'
import {
  BidiAudioDeltaEvent,
  BidiAudioStartEvent,
  BidiAudioStopEvent,
  BidiBargeInEvent,
  BidiConnectionStartEvent,
  BidiResponseStartEvent,
  BidiResponseStopEvent,
  BidiTextDeltaEvent,
  BidiTextStartEvent,
  BidiTextStopEvent,
  BidiToolUseBlocksEvent,
  BidiTranscriptDeltaEvent,
  BidiTranscriptStartEvent,
  BidiTranscriptStopEvent,
  BidiUsageEvent,
} from '../../types/events.js'
import { ConnectionTimeoutError } from '../model.js'
import {
  OPENAI_MAX_TIMEOUT_MS,
  OPENAI_PROACTIVE_RESTART_MARGIN_MS,
  OpenAIRealtimeModel,
  RESTART_INSTRUCTION,
} from '../openai.js'

import type { OpenAIRealtimeModelOptions, OpenAIRealtimeWebSocket, SessionState } from '../openai.js'
import type { BidiMessage } from '../../types/content.js'
import type { BidiOutputEvent } from '../../types/events.js'
import type { ToolSpec } from '../../../tools/types.js'

const MODEL_ID = 'gpt-realtime-2.1'
const API_KEY = 'test-api-key'

const toolSpec: ToolSpec = {
  description: 'Calculate mathematical expressions',
  name: 'calculator',
  inputSchema: { type: 'object', properties: { expression: { type: 'string' } } },
}

/** Fake WebSocket recording sent frames and letting tests push server messages. */
class FakeWebSocket implements OpenAIRealtimeWebSocket {
  readyState = 1
  bufferedAmount = 0
  sent: string[] = []
  closed = 0

  private readonly _listeners = new Map<string, ((event: unknown) => void)[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed += 1
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this._listeners.get(type) ?? []
    listeners.push(listener)
    this._listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this._listeners.set(
      type,
      (this._listeners.get(type) ?? []).filter((entry) => entry !== listener)
    )
  }

  /** Dispatch a raw socket event (`open`, `error`, `close`). */
  emit(type: string, event: unknown): void {
    for (const listener of this._listeners.get(type) ?? []) {
      listener(event)
    }
  }

  /** How many listeners are registered for a socket event. */
  listenerCount(type: string): number {
    return (this._listeners.get(type) ?? []).length
  }

  /** Deliver a server event to the model's reader. */
  push(...events: Record<string, unknown>[]): void {
    for (const event of events) {
      for (const listener of this._listeners.get('message') ?? []) {
        listener({ data: JSON.stringify(event) })
      }
    }
  }

  /** Client events decoded from the recorded frames. */
  sentEvents(): Record<string, any>[] {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, any>)
  }
}

function createModel(options: Partial<OpenAIRealtimeModelOptions> = {}): {
  model: OpenAIRealtimeModel
  socket: FakeWebSocket
  urls: string[]
  headers: Record<string, string>[]
} {
  const socket = new FakeWebSocket()
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  const model = new OpenAIRealtimeModel({
    modelId: MODEL_ID,
    transcriptionModelId: 'gpt-4o-transcribe',
    apiKey: API_KEY,
    websocket: (url, requestHeaders) => {
      urls.push(url)
      headers.push(requestHeaders)
      return socket
    },
    ...options,
  })
  return { model, socket, urls, headers }
}

async function take(receiver: AsyncGenerator<BidiOutputEvent>, count: number): Promise<BidiOutputEvent[]> {
  const events: BidiOutputEvent[] = []
  for (let index = 0; index < count; index += 1) {
    const result = await receiver.next()
    if (result.done === true) break
    events.push(result.value)
  }
  return events
}

/** Reach the provider's internals the Python tests touch directly. */
interface ModelInternals {
  _sessionState: SessionState
  _socket: OpenAIRealtimeWebSocket | undefined
  _reader?: { recv(timeoutMs: number): Promise<string | undefined> }
  _convertOpenAIEvent(event: Record<string, unknown>, state: SessionState): BidiOutputEvent[] | undefined
  _flushResponseRequest(state: SessionState): Promise<void>
}

function internals(model: OpenAIRealtimeModel): ModelInternals {
  return model as unknown as ModelInternals
}

function convert(
  model: OpenAIRealtimeModel,
  event: Record<string, unknown>,
  state: SessionState
): BidiOutputEvent[] | undefined {
  return internals(model)._convertOpenAIEvent(event, state)
}

function audioDelta(base64: string, contentId: string): BidiAudioDeltaEvent {
  return new BidiAudioDeltaEvent({
    type: 'bidiAudioDelta',
    audio: decodeBase64(base64),
    format: 'pcm',
    sampleRate: 24000,
    channels: 1,
    contentId,
  })
}

function toolResultMessage(toolUseId: string, text: string): BidiMessage {
  return { content: [new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock(text)] })] }
}

function functionCallOutput(callId: string, text: string): Record<string, unknown> {
  return {
    type: 'conversation.item.create',
    item: {
      id: expect.any(String),
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify([{ text }]),
    },
  }
}

describe('OpenAIRealtimeModel', () => {
  describe('constructor', () => {
    it('stores config and derives the proactive restart from the timeout', () => {
      const { model } = createModel()

      expect(model.getConfig()).toEqual({
        modelId: MODEL_ID,
        params: {},
        connection: { restartAfterMs: OPENAI_MAX_TIMEOUT_MS - OPENAI_PROACTIVE_RESTART_MARGIN_MS },
      })
      expect(model.timeoutMs).toBe(OPENAI_MAX_TIMEOUT_MS)
      expect(model.apiKey).toBe(API_KEY)
    })

    it('keeps an explicit connection override', () => {
      const { model } = createModel({ timeoutMs: 600, connection: { restartAfterMs: 60, autoRestart: false } })

      expect(model.getConfig().connection).toEqual({ restartAfterMs: 60, autoRestart: false })
    })

    it('resolves the audio config', () => {
      const { model } = createModel()

      expect(model.getAudioConfig()).toEqual({
        input: { sampleRate: 24000, channels: 1, format: 'pcm' },
        output: { sampleRate: 24000, channels: 1, format: 'pcm' },
      })
    })

    // Browsers have no process.env, so environment fallback is a Node-only behavior.
    it.runIf(isNode)('falls back to the OPENAI_API_KEY environment variable', () => {
      vi.stubEnv('OPENAI_API_KEY', 'env-key')

      const model = new OpenAIRealtimeModel({
        modelId: MODEL_ID,
        transcriptionModelId: null,
        websocket: () => new FakeWebSocket(),
      })

      expect(model.apiKey).toBe('env-key')
      vi.unstubAllEnvs()
    })

    it.each([
      ['missing api key', { apiKey: '' }, /OpenAI API key is required/],
      ['empty model id', { modelId: '' }, /model_id must be a non-empty string/],
      ['timeout above the max', { timeoutMs: OPENAI_MAX_TIMEOUT_MS + 1 }, /timeout exceeds max limit/],
      [
        'unsupported input format',
        { params: { audio: { input: { format: { type: 'audio/pcmu' } } } } },
        /Unsupported audio format: audio\/pcmu/,
      ],
      [
        'unsupported output sample rate',
        { params: { audio: { output: { format: { rate: 16000 } } } } },
        /Unsupported sample rate: 16000/,
      ],
    ])('rejects %s', (_name, options, expected) => {
      vi.stubEnv('OPENAI_API_KEY', '')

      expect(() => createModel(options as Partial<OpenAIRealtimeModelOptions>)).toThrow(expected)
      vi.unstubAllEnvs()
    })
  })

  describe('updateConfig', () => {
    it('replaces params and re-resolves audio', () => {
      const { model } = createModel()

      model.updateConfig({ params: { audio: { output: { voice: 'marin' } } } })

      expect(model.getConfig().params).toEqual({ audio: { output: { voice: 'marin' } } })
      expect(model.getAudioConfig().output.sampleRate).toBe(24000)
    })

    it('rejects an empty model id', () => {
      const { model } = createModel()

      expect(() => model.updateConfig({ modelId: '' })).toThrow('model_id must be a non-empty string')
    })

    it('rejects unsupported audio overrides', () => {
      const { model } = createModel()

      expect(() => model.updateConfig({ params: { audio: { input: { format: { rate: 8000 } } } } })).toThrow(
        /Unsupported sample rate: 8000/
      )
    })
  })

  describe('start', () => {
    it('sends session.update with instructions, tools, transcription, and voice', async () => {
      const { model, socket, urls, headers } = createModel({ voice: 'marin' })

      await model.start({ systemPrompt: 'You are a helpful assistant', tools: [toolSpec] })

      expect(urls).toEqual([`wss://api.openai.com/v1/realtime?model=${MODEL_ID}`])
      expect(headers[0]).toEqual({ Authorization: `Bearer ${API_KEY}` })

      const [event] = socket.sentEvents()
      expect(event?.['type']).toBe('session.update')
      expect(event?.['session']).toEqual({
        type: 'realtime',
        instructions: 'You are a helpful assistant',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            transcription: { model: 'gpt-4o-transcribe' },
          },
          output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
        },
        tools: [
          {
            type: 'function',
            name: 'calculator',
            description: 'Calculate mathematical expressions',
            parameters: { type: 'object', properties: { expression: { type: 'string' } } },
          },
        ],
      })
    })

    it('disables transcription when no transcription model is configured', async () => {
      const { model, socket } = createModel({ transcriptionModelId: null })

      await model.start()

      const [event] = socket.sentEvents()
      expect(event?.['session']['audio']['input']['transcription']).toBeNull()
    })

    it('merges params last', async () => {
      const { model, socket } = createModel({
        params: { instructions: 'from params', audio: { output: { voice: 'cedar' } } },
      })

      await model.start({ systemPrompt: 'from prompt' })

      const [event] = socket.sentEvents()
      expect(event?.['session']['instructions']).toBe('from params')
      expect(event?.['session']['audio']['output']['voice']).toBe('cedar')
    })

    it('sends organization and project headers', async () => {
      const { model, headers } = createModel({ organization: 'org-123', project: 'proj-456' })

      await model.start()

      expect(headers[0]).toEqual({
        Authorization: `Bearer ${API_KEY}`,
        'OpenAI-Organization': 'org-123',
        'OpenAI-Project': 'proj-456',
      })
    })

    it('rejects a second start before stop', async () => {
      const { model } = createModel()

      await model.start()

      await expect(model.start()).rejects.toThrow('model already started | call stop before starting again')
    })

    it.each([
      ['disabled turn detection', null],
      ['disabled automatic responses', { type: 'server_vad', create_response: false }],
      ['disabled interruption', { type: 'server_vad', interrupt_response: false }],
    ])('rejects %s', async (_name, turnDetection) => {
      const { model } = createModel({ params: { audio: { input: { turn_detection: turnDetection } } } })

      await expect(model.start()).rejects.toThrow(
        'OpenAIRealtimeModel requires turn detection with create_response=True and interrupt_response=True.'
      )
    })

    it('replays conversation history, truncating call ids and skipping orphan results', async () => {
      const { model, socket } = createModel()
      const toolUseId = 'call-123456789012345678901234567890-overflow'

      await model.start({
        messages: [
          new Message({ role: 'user', content: [new TextBlock("What's the weather?")] }),
          new Message({ role: 'assistant', content: [new TextBlock('Checking.')] }),
          new Message({
            role: 'assistant',
            content: [new ToolUseBlock({ toolUseId, name: 'get_weather', input: { location: 'Seattle' } })],
          }),
          new Message({
            role: 'user',
            content: [
              new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock('Sunny')] }),
              new ToolResultBlock({ toolUseId: 'orphan', status: 'success', content: [new TextBlock('Nope')] }),
            ],
          }),
        ],
      })

      const items = socket
        .sentEvents()
        .filter((event) => event['type'] === 'conversation.item.create')
        .map((event) => event['item'])
      expect(items).toEqual([
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: "What's the weather?" }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        {
          type: 'function_call',
          call_id: toolUseId.slice(0, 32),
          name: 'get_weather',
          arguments: JSON.stringify({ location: 'Seattle' }),
        },
        {
          type: 'function_call_output',
          call_id: toolUseId.slice(0, 32),
          output: JSON.stringify([{ text: 'Sunny' }]),
        },
      ])
    })
  })

  describe('send', () => {
    it('rejects before start', async () => {
      const { model } = createModel()

      await expect(model.send({ content: [new TextBlock('hi')] })).rejects.toThrow(
        'model not started | call start before sending'
      )
    })

    it('creates one message item and requests a response', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0

      await model.send({
        content: [new TextBlock('hello'), new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2]) } })],
      })

      const events = socket.sentEvents()
      expect(events.map((event) => event['type'])).toEqual(['conversation.item.create', 'response.create'])
      expect(events[0]?.['item']['content']).toEqual([
        { type: 'input_text', text: 'hello' },
        { type: 'input_image', image_url: 'data:image/png;base64,AQI=' },
      ])
      expect(events[0]?.['item']['role']).toBe('user')
      expect(typeof events[0]?.['item']['id']).toBe('string')
    })

    it('appends audio deltas to the input buffer', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0

      await model.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([1, 2, 3]) } }))

      expect(socket.sentEvents()).toEqual([{ type: 'input_audio_buffer.append', audio: 'AQID' }])
    })

    it.each([
      ['text', [new TextBlock('result')], JSON.stringify([{ text: 'result' }])],
      ['json', [new JsonBlock({ json: { value: 42 } })], JSON.stringify([{ json: { value: 42 } }])],
      [
        'multiple blocks',
        [new TextBlock('one'), new JsonBlock({ json: { two: true } })],
        JSON.stringify([{ text: 'one' }, { json: { two: true } }]),
      ],
    ])('sends %s tool results', async (_name, content, expectedOutput) => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0

      await model.send({
        content: [new ToolResultBlock({ toolUseId: 'call-1', status: 'success', content })],
      })

      const [event] = socket.sentEvents()
      expect(event?.['type']).toBe('conversation.item.create')
      expect(event?.['item']['type']).toBe('function_call_output')
      expect(event?.['item']['call_id']).toBe('call-1')
      expect(event?.['item']['output']).toBe(expectedOutput)
    })

    it('rejects unsupported tool result content', async () => {
      const { model } = createModel()
      await model.start()

      await expect(
        model.send({
          content: [
            new ToolResultBlock({
              toolUseId: 'call-1',
              status: 'success',
              content: [new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })],
            }),
          ],
        })
      ).rejects.toThrow(/content_types=<\['image'\]> \| Content type not supported by OpenAI Realtime API/)
    })
  })

  describe('receive', () => {
    it('rejects before start', async () => {
      const { model } = createModel()

      await expect(model.receive().next()).rejects.toThrow('model not started | call start before receiving')
    })

    it('emits connection start then converts audio deltas', async () => {
      const { model, socket } = createModel()
      model.updateConfig({ modelId: 'updated-model' })
      await model.start()
      socket.push({ type: 'response.output_audio.delta', delta: 'AQID', response_id: 'r1' })

      const receiver = model.receive()
      const events = await take(receiver, 3)
      await receiver.return(undefined)

      expect(events[0]).toBeInstanceOf(BidiConnectionStartEvent)
      expect((events[0] as BidiConnectionStartEvent).model).toBe('updated-model')
      expect(events[1]).toBeInstanceOf(BidiAudioStartEvent)
      expect(events[2]).toEqual(
        new BidiAudioDeltaEvent({
          type: 'bidiAudioDelta',
          audio: new Uint8Array([1, 2, 3]),
          format: 'pcm',
          sampleRate: 24000,
          channels: 1,
          contentId: (events[1] as BidiAudioStartEvent).contentId,
        })
      )
    })

    it('opens a user transcript when speech starts', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push(
        { type: 'input_audio_buffer.speech_started', item_id: 'speech-a' },
        { type: 'conversation.item.input_audio_transcription.delta', item_id: 'speech-a', delta: 'hello' },
        { type: 'conversation.item.input_audio_transcription.completed', item_id: 'speech-a', transcript: 'hello' }
      )

      const receiver = model.receive()
      const events = await take(receiver, 4)
      await receiver.return(undefined)

      expect(events.slice(1)).toEqual([
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'speech-a' }),
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'hello',
          role: 'user',
          contentId: 'speech-a',
        }),
        new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: 'speech-a' }),
      ])
    })

    it('throws when input transcription fails', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push({
        type: 'conversation.item.input_audio_transcription.failed',
        item_id: 'speech-a',
        error: { message: 'The audio could not be transcribed.' },
      })

      const receiver = model.receive()
      await take(receiver, 1)

      await expect(receiver.next()).rejects.toThrow('The audio could not be transcribed.')
    })

    it('emits tool uses for completed function calls', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-1',
          name: 'calculator',
          arguments: '{"expression": "1+1"}',
        },
      })

      const receiver = model.receive()
      const events = await take(receiver, 2)
      await receiver.return(undefined)

      expect(events[1]).toEqual(
        new BidiToolUseBlocksEvent({
          type: 'bidiToolUseBlocks',
          toolUses: [new ToolUseBlock({ toolUseId: 'call-1', name: 'calculator', input: { expression: '1+1' } })],
        })
      )
    })

    it('streams assistant text and closes it on response.done', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push(
        { type: 'response.created', response: { id: 'r1' } },
        {
          type: 'response.output_text.delta',
          response_id: 'r1',
          item_id: 'item-1',
          content_index: 0,
          delta: 'Hello',
        },
        {
          type: 'response.done',
          response: {
            id: 'r1',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_token_details: { text_tokens: 7, audio_tokens: 3, cached_tokens: 2 },
              output_token_details: { audio_tokens: 5 },
            },
          },
        }
      )

      const receiver = model.receive()
      const events = await take(receiver, 7)
      await receiver.return(undefined)

      expect(events.slice(2)).toEqual([
        new BidiTextStartEvent({ type: 'bidiTextStart', contentId: 'r1:text' }),
        new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'Hello', contentId: 'r1:text' }),
        new BidiTextStopEvent({ type: 'bidiTextStop', contentId: 'r1:text' }),
        new BidiUsageEvent({
          type: 'bidiUsage',
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          inputTokenDetails: { text: 7, audio: 3, cacheRead: 2 },
          outputTokenDetails: { audio: 5 },
        }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r1' }),
      ])
    })

    it('emits barge-in when the server cancels a turn', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push(
        { type: 'response.created', response: { id: 'r1' } },
        {
          type: 'response.done',
          response: { id: 'r1', status: 'cancelled', status_details: { reason: 'turn_detected' }, output: [] },
        }
      )

      const receiver = model.receive()
      const events = await take(receiver, 3)
      await receiver.return(undefined)

      expect(events[2]).toEqual(new BidiBargeInEvent())
    })

    it('omits usage details the provider does not report', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push(
        { type: 'response.created', response: { id: 'r1' } },
        {
          type: 'response.done',
          response: { id: 'r1', status: 'completed', output: [], usage: { input_tokens: 1 } },
        }
      )

      const receiver = model.receive()
      const events = await take(receiver, 3)
      await receiver.return(undefined)

      expect(events[2]).toEqual(
        new BidiUsageEvent({ type: 'bidiUsage', inputTokens: 1, outputTokens: 0, totalTokens: 0 })
      )
    })

    it('throws ConnectionTimeoutError past the configured timeout', async () => {
      const { model } = createModel({ timeoutMs: 1 })
      await model.start()

      const receiver = model.receive()
      await take(receiver, 1)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)

      await expect(receiver.next()).rejects.toBeInstanceOf(ConnectionTimeoutError)
      vi.restoreAllMocks()
    })
  })

  describe('stop', () => {
    it('closes the socket and clears the connection', async () => {
      const { model, socket } = createModel()
      await model.start()

      await model.stop()

      expect(socket.closed).toBe(1)
      await expect(model.send({ content: [new TextBlock('hi')] })).rejects.toThrow('model not started')
    })
  })

  describe('restart', () => {
    it('reestablishes the connection, replays history, and re-anchors the session', async () => {
      const { model, socket } = createModel()
      await model.start({ systemPrompt: 'first' })
      socket.sent.length = 0

      await model.restart({
        systemPrompt: 'second',
        messages: [new Message({ role: 'user', content: [new TextBlock('Hello')] })],
      })

      const events = socket.sentEvents()
      expect(events[0]?.['type']).toBe('session.update')
      expect(events[0]?.['session']['instructions']).toBe('second')
      expect(events[1]?.['item']['content']).toEqual([{ type: 'input_text', text: 'Hello' }])
      expect(events.at(-1)).toEqual({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: RESTART_INSTRUCTION }],
        },
      })
      expect(socket.closed).toBe(1)
    })

    it('forwards tools to the new connection', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0

      await model.restart({ tools: [toolSpec] })

      expect(socket.sentEvents()[0]?.['session']['tools'][0]['name']).toBe('calculator')
    })

    it('survives a failed re-anchor send', async () => {
      const { model, socket } = createModel()
      await model.start()
      const send = vi.spyOn(socket, 'send')
      send.mockImplementation((data: string) => {
        if (data.includes(RESTART_INSTRUCTION)) throw new Error('socket gone')
        socket.sent.push(data)
      })

      await expect(model.restart()).resolves.toBeUndefined()
      expect(model.getConfig().modelId).toBe(MODEL_ID)
      send.mockRestore()
    })
  })

  describe('audio stream ids', () => {
    it.each([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ])('stops each audio stream once (nativeStart=%s, nativeStop=%s)', (nativeStart, nativeStop) => {
      for (const status of ['completed', 'cancelled', 'failed']) {
        const { model } = createModel()
        const state = internals(model)._sessionState
        const nativeEvents: Record<string, unknown>[] = [{ type: 'response.created', response: { id: 'r1' } }]
        if (nativeStart) {
          nativeEvents.push({ type: 'response.content_part.added', response_id: 'r1', part: { type: 'audio' } })
        }
        nativeEvents.push(
          { type: 'response.output_audio.delta', response_id: 'r1', delta: 'YQ==' },
          { type: 'response.output_audio.delta', response_id: 'r1', delta: 'Yg==' }
        )
        if (nativeStop) {
          nativeEvents.push({ type: 'response.output_audio.done', response_id: 'r1' })
        }
        nativeEvents.push({ type: 'response.done', response: { id: 'r1', status } })

        const events = nativeEvents.flatMap((native) => convert(model, native, state) ?? [])
        const contentId = (events[1] as BidiAudioStartEvent).contentId
        expect(typeof contentId).toBe('string')
        expect(events).toEqual([
          new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'r1' }),
          new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId }),
          audioDelta('YQ==', contentId),
          audioDelta('Yg==', contentId),
          new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId }),
          new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r1' }),
        ])
        expect(convert(model, { type: 'response.output_audio.done', response_id: 'r1' }, state)).toBeUndefined()
        expect(state.audioContentIds.size).toBe(0)
      }
    })

    it('distinguishes overlapping and reopened audio streams', () => {
      const { model } = createModel()
      const state = internals(model)._sessionState
      const delta = (responseId: string): BidiOutputEvent[] =>
        convert(model, { type: 'response.output_audio.delta', response_id: responseId, delta: 'YQ==' }, state) ?? []

      const firstEvents = delta('r1')
      const secondEvents = delta('r2')
      const firstId = (firstEvents[0] as BidiAudioStartEvent).contentId
      const secondId = (secondEvents[0] as BidiAudioStartEvent).contentId
      expect(firstId).not.toBe(secondId)
      expect(firstEvents).toEqual([
        new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId: firstId }),
        audioDelta('YQ==', firstId),
      ])
      expect(secondEvents).toEqual([
        new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId: secondId }),
        audioDelta('YQ==', secondId),
      ])
      expect(delta('r1')).toEqual([audioDelta('YQ==', firstId)])
      expect(convert(model, { type: 'response.output_audio.done', response_id: 'r1' }, state)).toEqual([
        new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId: firstId }),
      ])

      const nextEvents = delta('r1')
      const nextId = (nextEvents[0] as BidiAudioStartEvent).contentId
      expect([firstId, secondId]).not.toContain(nextId)
      expect(nextEvents).toEqual([
        new BidiAudioStartEvent({ type: 'bidiAudioStart', contentId: nextId }),
        audioDelta('YQ==', nextId),
      ])
      expect(convert(model, { type: 'response.done', response: { id: 'r2' } }, state)).toEqual([
        new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId: secondId }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r2' }),
      ])
      expect(convert(model, { type: 'response.done', response: { id: 'r1' } }, state)).toEqual([
        new BidiAudioStopEvent({ type: 'bidiAudioStop', contentId: nextId }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'r1' }),
      ])
      expect(state.audioContentIds.size).toBe(0)
    })
  })

  describe('response scheduling', () => {
    it('submits results immediately and continues once the remaining calls finish', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0
      const state = internals(model)._sessionState
      state.activeResponses.add('response-a')

      const items = ['a', 'b'].map((callId) => ({
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name: `tool_${callId}`,
        arguments: '{}',
      }))
      socket.push(
        ...items.map((item) => ({ type: 'response.output_item.done', item })),
        { type: 'response.done', response: { id: 'response-a', status: 'completed', output: items } },
        { type: 'response.created', response: { id: 'response-b' } },
        { type: 'response.done', response: { id: 'response-b', status: 'completed', output: [] } }
      )

      const receiver = model.receive()
      await take(receiver, 1)
      expect(await take(receiver, 2)).toEqual([
        new BidiToolUseBlocksEvent({
          type: 'bidiToolUseBlocks',
          toolUses: [new ToolUseBlock({ toolUseId: 'a', name: 'tool_a', input: {} })],
        }),
        new BidiToolUseBlocksEvent({
          type: 'bidiToolUseBlocks',
          toolUses: [new ToolUseBlock({ toolUseId: 'b', name: 'tool_b', input: {} })],
        }),
      ])

      await model.send(toolResultMessage('b', 'B'))
      expect(await take(receiver, 1)).toEqual([
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'response-a' }),
      ])
      await internals(model)._flushResponseRequest(state)
      // 'a' is still outstanding, so the continuation is withheld.
      expect(socket.sentEvents()).toEqual([functionCallOutput('b', 'B')])

      await model.send(toolResultMessage('a', 'A'))
      await internals(model)._flushResponseRequest(state)
      expect(socket.sentEvents()).toEqual([
        functionCallOutput('b', 'B'),
        functionCallOutput('a', 'A'),
        { type: 'response.create' },
      ])

      expect(await take(receiver, 2)).toEqual([
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'response-b' }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'response-b' }),
      ])
      await receiver.return(undefined)
      await model.stop()
    })

    it('correlates native acknowledgments with inputs and late transcripts', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push(
        { type: 'input_audio_buffer.speech_started', item_id: 'speech' },
        { type: 'input_audio_buffer.committed', item_id: 'speech' },
        { type: 'conversation.item.added', item: { id: 'speech', role: 'user', content: [{ type: 'input_audio' }] } },
        { type: 'response.created', response: { id: 'a' } },
        { type: 'response.done', response: { id: 'a' } },
        { type: 'conversation.item.added', item: { id: 'text', role: 'user' } },
        { type: 'response.created', response: { id: 'b' } },
        {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'speech',
          transcript: 'Earlier speech',
        },
        { type: 'response.done', response: { id: 'b' } }
      )

      const receiver = model.receive()
      const events = await take(receiver, 8)
      await receiver.return(undefined)

      expect(events.slice(1)).toEqual([
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'speech' }),
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'a' }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'a' }),
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'b' }),
        new BidiTranscriptDeltaEvent({
          type: 'bidiTranscriptDelta',
          delta: 'Earlier speech',
          role: 'user',
          contentId: 'speech',
        }),
        new BidiTranscriptStopEvent({ type: 'bidiTranscriptStop', role: 'user', contentId: 'speech' }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'b' }),
      ])
      await model.stop()
    })

    it('treats a history acknowledgment as an existing input, not a new one', async () => {
      const { model, socket } = createModel()
      await model.start({ messages: [new Message({ role: 'user', content: [new TextBlock('Earlier question')] })] })
      const historyItem = socket.sentEvents().find((event) => event['type'] === 'conversation.item.create')?.['item']
      const state = internals(model)._sessionState

      expect(convert(model, { type: 'conversation.item.added', item: historyItem }, state)).toBeUndefined()
      expect(convert(model, { type: 'response.created', response: { id: 'new' } }, state)).toEqual([
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'new' }),
      ])
      await model.stop()
    })

    it.each([
      ['text', true],
      ['text', false],
      ['tool', true],
      ['tool', false],
    ])('defers the response until speech completes (%s, earlyAck=%s)', async (kind, acknowledgedBeforeResponse) => {
      const { model, socket } = createModel()
      await model.start()
      socket.sent.length = 0
      const state = internals(model)._sessionState
      state.activeResponses.add('previous')
      socket.push({ type: 'input_audio_buffer.speech_started', item_id: 'speech' })

      const receiver = model.receive()
      await take(receiver, 1)
      expect(await take(receiver, 1)).toEqual([
        new BidiTranscriptStartEvent({ type: 'bidiTranscriptStart', role: 'user', contentId: 'speech' }),
      ])

      const message =
        kind === 'text' ? { content: [new TextBlock('Also consider this.')] } : toolResultMessage('call', 'Result')
      await model.send(message)
      expect(socket.sent).toHaveLength(1)

      const inputEvent = socket.sentEvents()[0] as Record<string, unknown>
      const acknowledgment = { type: 'conversation.item.added', item: inputEvent['item'] }
      const response = { type: 'response.created', response: { id: 'answer' } }
      socket.push(
        { type: 'response.done', response: { id: 'previous' } },
        { type: 'input_audio_buffer.speech_stopped', item_id: 'speech' },
        { type: 'input_audio_buffer.committed', item_id: 'speech' },
        ...(acknowledgedBeforeResponse ? [acknowledgment, response] : [response, acknowledgment]),
        { type: 'response.done', response: { id: 'answer' } }
      )

      expect(await take(receiver, 3)).toEqual([
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'previous' }),
        new BidiResponseStartEvent({ type: 'bidiResponseStart', responseId: 'answer' }),
        new BidiResponseStopEvent({ type: 'bidiResponseStop', responseId: 'answer' }),
      ])

      await internals(model)._flushResponseRequest(state)
      const expected = acknowledgedBeforeResponse ? [inputEvent] : [inputEvent, { type: 'response.create' }]
      expect(socket.sentEvents()).toEqual(expected)

      await receiver.return(undefined)
      await model.stop()
    })

    it('waits for pending tool results carried across a restart', async () => {
      const { model, socket } = createModel()
      await model.start()
      internals(model)._sessionState.pendingTools.add('a')
      internals(model)._sessionState.pendingTools.add('b')
      await model.restart()
      socket.sent.length = 0

      await model.send(toolResultMessage('a', 'a'))
      expect(socket.sentEvents()).toEqual([functionCallOutput('a', 'a')])

      await model.send(toolResultMessage('b', 'b'))
      expect(socket.sentEvents()).toEqual([
        functionCallOutput('a', 'a'),
        functionCallOutput('b', 'b'),
        { type: 'response.create' },
      ])
      await model.stop()
    })

    it('keeps a superseded reader bound to its own socket', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.push({ type: 'response.output_audio.delta', response_id: 'r1', delta: 'YQ==' })

      const receiver = model.receive()
      const events = await take(receiver, 3)
      expect(events[2]).toBeInstanceOf(BidiAudioDeltaEvent)
      expect((events[2] as BidiAudioDeltaEvent).audio).toEqual(new Uint8Array([97]))

      // Swap in a replacement socket, as a restart would.
      const replacement = new FakeWebSocket()
      internals(model)._socket = replacement
      internals(model)._reader = {
        recv: async () => JSON.stringify({ type: 'response.output_audio.delta', response_id: 'r2', delta: 'Yg==' }),
      }
      socket.push({ type: 'response.output_audio.delta', response_id: 'r1', delta: 'Yw==' })

      const next = await take(receiver, 1)
      expect((next[0] as BidiAudioDeltaEvent).audio).toEqual(new Uint8Array([99]))
      await receiver.return(undefined)
      await model.stop()
    })
  })

  describe('socket errors', () => {
    it('surfaces a mid-session socket error from receive with the close code and cause', async () => {
      const { model, socket } = createModel()
      await model.start()
      const receiver = model.receive()
      await take(receiver, 1)

      const cause = new Error('ECONNRESET')
      socket.emit('error', { error: cause })
      socket.emit('close', { code: 1006, reason: 'abnormal closure' })

      await expect(receiver.next()).rejects.toThrow(
        'code=<1006>, reason=<abnormal closure> | openai realtime connection closed'
      )
    })

    it('reports a clean close without a cause', async () => {
      const { model, socket } = createModel()
      await model.start()
      const receiver = model.receive()
      await take(receiver, 1)

      socket.emit('close', { code: 1000, reason: '' })

      await expect(receiver.next()).rejects.toThrow('code=<1000>, reason=<> | openai realtime connection closed')
    })

    it('drops the handshake listeners once the connection opens', async () => {
      const socket = new FakeWebSocket()
      socket.readyState = 0
      const model = new OpenAIRealtimeModel({
        modelId: MODEL_ID,
        transcriptionModelId: 'gpt-4o-transcribe',
        apiKey: API_KEY,
        websocket: () => socket,
      })
      const started = model.start()
      socket.emit('open', {})
      await started

      expect(socket.listenerCount('open')).toBe(0)
      expect(socket.listenerCount('error')).toBe(1)
    })

    it('throws when sending without a socket', async () => {
      const { model } = createModel()
      await model.start()
      internals(model)._socket = undefined

      await expect(model.send({ content: [new TextBlock('hi')] })).rejects.toThrow('model not started | no websocket')
    })

    it('waits for the write buffer to drain before resolving a send', async () => {
      const { model, socket } = createModel()
      await model.start()
      socket.bufferedAmount = 4_000_000

      const sending = model.send(new AudioDelta({ source: { bytes: new Uint8Array([1, 2, 3]) }, format: 'pcm' }))
      let settled = false
      void sending.then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(settled).toBe(false)

      socket.bufferedAmount = 0
      await sending
      expect(socket.sentEvents().at(-1)?.['type']).toBe('input_audio_buffer.append')
    })
  })
})
