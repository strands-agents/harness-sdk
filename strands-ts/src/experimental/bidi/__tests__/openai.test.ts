import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIRealtimeModel } from '../models/openai.js'
import { Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { ContextWindowOverflowError, ModelError, ModelThrottledError } from '../../../errors.js'
import type { BidiStartOptions } from '../model.js'
import type { OpenAIRealtimeModelConfig } from '../models/openai.js'

// The real OpenAI SDK serializes and parses messages over this in-memory transport.
class TestWebSocket extends EventTarget {
  static instances: TestWebSocket[] = []
  sent: Record<string, unknown>[] = []
  bufferedAmount = 0
  readyState = 0
  closed = false
  constructor(readonly url: string) {
    super()
    TestWebSocket.instances.push(this)
  }
  send(data: string): void {
    if (this.closed || this.readyState !== 1) throw new Error('Socket is not open')
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  open(): void {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  message(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  close(): void {
    this.closed = true
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

function createModel(config: Partial<OpenAIRealtimeModelConfig> = {}): OpenAIRealtimeModel {
  return new OpenAIRealtimeModel({
    modelId: 'test-realtime',
    ...config,
    clientConfig: { apiKey: 'ek_test_token', dangerouslyAllowBrowser: true },
  })
}

async function connect(model: OpenAIRealtimeModel, options?: BidiStartOptions): Promise<TestWebSocket> {
  const count = TestWebSocket.instances.length
  const started = model.start(options)
  await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(count + 1))
  const socket = TestWebSocket.instances[count]!
  socket.open()
  socket.message({ type: 'session.created', session: { id: 'session-1', type: 'realtime' } })
  socket.message({ type: 'session.updated', session: { id: 'session-1', type: 'realtime' } })
  await started
  return socket
}

function created(socket: TestWebSocket, id = 'response-1'): void {
  socket.message({ type: 'response.created', response: { id } })
}

function finished(socket: TestWebSocket, output: unknown[] = [], status = 'completed'): void {
  socket.message({ type: 'response.done', response: { id: 'response-1', status, output } })
}

describe('OpenAIRealtimeModel', () => {
  let model: OpenAIRealtimeModel
  beforeEach(() => {
    TestWebSocket.instances = []
    vi.stubGlobal('WebSocket', TestWebSocket)
    model = createModel()
  })
  afterEach(async () => {
    await model.stop()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe('connection lifecycle', () => {
    it('configures voice, audio, instructions, tools, and history through the OpenAI SDK', async () => {
      model.updateConfig({ modelId: 'test-realtime', voice: 'cedar' })
      const socket = await connect(model, {
        systemPrompt: 'Be concise',
        tools: [{ name: 'lookup', description: 'Look up stock' }],
        messages: [new Message({ role: 'assistant', content: [new TextBlock('Welcome')] })],
      })
      expect(socket.url).toContain('model=test-realtime')
      expect(socket.sent).toEqual([
        {
          type: 'session.update',
          session: {
            type: 'realtime',
            model: 'test-realtime',
            output_modalities: ['audio'],
            instructions: 'Be concise',
            tools: [
              {
                type: 'function',
                name: 'lookup',
                description: 'Look up stock',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: { model: 'whisper-1' },
                turn_detection: { type: 'server_vad', create_response: false, interrupt_response: true },
              },
              output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'cedar' },
            },
          },
        },
        {
          type: 'conversation.item.create',
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Welcome' }] },
        },
      ])
      const stream = model.receive()
      expect(await stream.next()).toEqual({
        done: false,
        value: { type: 'bidiConnectionStart', connectionId: 'session-1', model: 'test-realtime' },
      })
      await stream.return(undefined)
      expect(socket.closed).toBe(true)
    })

    it('waits for configuration acknowledgement and rejects concurrent startup', async () => {
      const started = model.start()
      await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1))
      const socket = TestWebSocket.instances[0]!
      socket.open()
      await expect(model.send(new TextBlock('Too early'))).rejects.toThrow('not ready')
      await expect(model.start()).rejects.toThrow('already active')
      expect(() => model.updateConfig({ modelId: 'other' })).toThrow('Stop')
      const rejected = expect(started).rejects.toThrow('stopped')
      await model.stop()
      await rejected
    })

    it('bounds startup even if credentials never resolve', async () => {
      vi.useFakeTimers()
      model = new OpenAIRealtimeModel({
        modelId: 'test',
        startupTimeoutMs: 10,
        clientConfig: {
          apiKey: () => new Promise<string>(() => {}),
          dangerouslyAllowBrowser: true,
        },
      })
      const rejected = expect(model.start()).rejects.toThrow('startup timed out')
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(TestWebSocket.instances).toHaveLength(0)
    })

    it('closes a connection whose credentials resolve after cancellation', async () => {
      let resolve!: (key: string) => void
      model = new OpenAIRealtimeModel({
        modelId: 'test',
        clientConfig: {
          apiKey: () =>
            new Promise<string>((ready) => {
              resolve = ready
            }),
          dangerouslyAllowBrowser: true,
        },
      })
      const controller = new AbortController()
      const rejected = expect(model.start({ cancelSignal: controller.signal })).rejects.toThrow('cancelled')
      controller.abort()
      await rejected
      resolve('ek_test_token')
      await vi.waitFor(() => expect(TestWebSocket.instances[0]?.closed).toBe(true))
    })

    it('does not open a socket for an already aborted signal', async () => {
      await expect(model.start({ cancelSignal: AbortSignal.abort() })).rejects.toThrow('cancelled')
      expect(TestWebSocket.instances).toHaveLength(0)
    })

    it('aborts a live session and preserves the cancellation reason', async () => {
      const controller = new AbortController()
      const socket = await connect(model, { cancelSignal: controller.signal })
      const stream = model.receive()
      await stream.next()
      const reason = new Error('Caller finished')
      const waiting = expect(stream.next()).rejects.toMatchObject({
        message: 'Realtime session cancelled',
        cause: reason,
      })
      controller.abort(reason)
      await waiting
      expect(socket.closed).toBe(true)
    })

    it('rejects request-response APIs and receiving before startup', async () => {
      expect(model.stateful).toBe(true)
      expect(() => model.stream()).toThrow('Regular streaming is not supported')
      await expect(model.receive().next()).rejects.toThrow('Start the Realtime session')
      expect(() => createModel({ startupTimeoutMs: 2147483648 })).toThrow('32-bit timer')
    })

    it('wakes a blocked receiver on stop and permits a fresh connection', async () => {
      const first = await connect(model)
      const stream = model.receive()
      await stream.next()
      const waiting = stream.next()
      await model.stop()
      expect(await waiting).toEqual({
        done: false,
        value: { type: 'bidiConnectionStop', connectionId: 'session-1', reason: 'userRequest' },
      })
      const second = await connect(model)
      await stream.return(undefined)
      expect(first.closed).toBe(true)
      expect(second.closed).toBe(false)
    })

    it('rejects a second event consumer', async () => {
      await connect(model)
      const stream = model.receive()
      await stream.next()
      await expect(model.receive().next()).rejects.toThrow('one consumer')
      await stream.return(undefined)
    })

    it('propagates unexpected transport closure to a waiting receiver', async () => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      const waiting = expect(stream.next()).rejects.toThrow('closed unexpectedly')
      socket.close()
      await waiting
    })

    it.each([
      ['rate_limit_exceeded', ModelThrottledError],
      ['context_length_exceeded', ContextWindowOverflowError],
      ['invalid_request_error', ModelError],
    ])('classifies %s and preserves the SDK error as cause', async (code, ErrorClass) => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      socket.message({ type: 'error', error: { type: 'error', code, message: code } })
      const failure = stream.next()
      await expect(failure).rejects.toBeInstanceOf(ErrorClass)
      await expect(failure).rejects.toMatchObject({ cause: expect.any(Error) })
      expect(socket.closed).toBe(true)
    })

    it.each([0, -1, Infinity, NaN, 1.5])('rejects invalid limits: %s', (limit) => {
      expect(() => createModel({ maxBufferedEvents: limit })).toThrow('positive safe integers')
    })
  })

  describe('input and output', () => {
    it.each(['failed', 'incomplete'])('surfaces a %s response instead of completing normally', async (status) => {
      const socket = await connect(model)
      created(socket)
      finished(socket, [], status)
      await expect(model.receive().next()).rejects.toThrow(`Realtime response ${status}`)
      expect(socket.closed).toBe(true)
    })

    it('cancels a response whose creation arrives after speech has started', async () => {
      const socket = await connect(model)
      await model.send(new TextBlock('Hello'))
      socket.message({ type: 'input_audio_buffer.speech_started' })
      created(socket)
      expect(socket.sent.at(-1)).toEqual({ type: 'response.cancel', response_id: 'response-1' })
    })

    it('sends text, PCM, and images and avoids overlapping response requests', async () => {
      const socket = await connect(model)
      await model.send(new TextBlock('Hello'))
      await model.send({ type: 'audioDelta', format: 'pcm', source: { bytes: new Uint8Array([0, 1]) } })
      await model.send(new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2]) } }))
      expect(socket.sent.slice(1)).toEqual([
        {
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        },
        { type: 'response.create' },
        { type: 'input_audio_buffer.append', audio: 'AAE=' },
        {
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_image', image_url: 'data:image/png;base64,AQI=' }],
          },
        },
      ])
      created(socket)
      finished(socket)
      expect(socket.sent.filter((event) => event.type === 'response.create')).toHaveLength(2)
    })

    it('rejects unaligned PCM and unsupported images without breaking the session', async () => {
      const socket = await connect(model)
      await expect(
        model.send({ type: 'audioDelta', format: 'pcm', source: { bytes: new Uint8Array(1) } })
      ).rejects.toThrow('PCM16')
      await expect(
        model.send(new ImageBlock({ format: 'png', source: { url: 'https://example.com/image.png' } }))
      ).rejects.toThrow('PNG or JPEG bytes')
      expect(socket.closed).toBe(false)
    })

    it('normalizes response, audio, transcripts, and usage', async () => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      created(socket)
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-1', delta: 'AAE=' })
      socket.message({ type: 'response.output_audio.done', response_id: 'response-1' })
      socket.message({
        type: 'response.output_audio_transcript.delta',
        item_id: 'item-1',
        content_index: 0,
        delta: 'Hi',
      })
      socket.message({
        type: 'response.output_audio_transcript.done',
        item_id: 'item-1',
        content_index: 0,
        transcript: 'Hi',
      })
      socket.message({
        type: 'response.done',
        response: {
          id: 'response-1',
          status: 'completed',
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      })
      const events = []
      for (let index = 0; index < 9; index++) events.push((await stream.next()).value)
      expect(events).toEqual([
        { type: 'bidiResponseStart', responseId: 'response-1' },
        { type: 'bidiAudioStart' },
        { type: 'bidiAudioDelta', audio: 'AAE=', format: 'pcm', sampleRate: 24000, channels: 1 },
        { type: 'bidiAudioStop' },
        { type: 'bidiTranscriptStart', contentId: 'item-1:0', role: 'assistant' },
        { type: 'bidiTranscriptDelta', contentId: 'item-1:0', role: 'assistant', delta: 'Hi' },
        { type: 'bidiTranscriptStop', contentId: 'item-1:0', role: 'assistant', transcript: 'Hi' },
        { type: 'bidiUsage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        { type: 'bidiResponseStop', responseId: 'response-1' },
      ])
    })

    it('purges queued audio on barge-in and suppresses late audio from the interrupted response', async () => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      created(socket)
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-1', delta: 'OLD' })
      socket.message({ type: 'input_audio_buffer.speech_started' })
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-1', delta: 'LATE' })
      socket.message({ type: 'input_audio_buffer.speech_stopped' })
      socket.message({ type: 'input_audio_buffer.committed' })
      finished(socket, [], 'cancelled')
      created(socket, 'response-2')
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-1', delta: 'LATER' })
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-2', delta: 'NEW' })
      const events = []
      for (let index = 0; index < 6; index++) events.push((await stream.next()).value)
      expect(events).toEqual([
        { type: 'bidiResponseStart', responseId: 'response-1' },
        { type: 'bidiBargeIn', reason: 'userSpeech' },
        { type: 'bidiResponseStop', responseId: 'response-1' },
        { type: 'bidiResponseStart', responseId: 'response-2' },
        { type: 'bidiAudioStart' },
        { type: 'bidiAudioDelta', audio: 'NEW', format: 'pcm', sampleRate: 24000, channels: 1 },
      ])
    })

    it('terminates on a slow-consumer event overflow', async () => {
      model.updateConfig({ modelId: 'test', maxBufferedEvents: 1 })
      const socket = await connect(model)
      created(socket)
      await expect(model.receive().next()).rejects.toThrow('buffer is full')
      expect(socket.closed).toBe(true)
    })

    it('terminates on a slow-consumer byte overflow', async () => {
      const socket = await connect(model)
      created(socket)
      socket.message({ type: 'response.output_audio.delta', response_id: 'response-1', delta: 'a'.repeat(1048576) })
      await expect(model.receive().next()).rejects.toThrow('buffer is full')
      expect(socket.closed).toBe(true)
    })

    it('bounds outbound writes and propagates synchronous SDK send failures', async () => {
      const socket = await connect(model)
      socket.bufferedAmount = 1048576
      await expect(model.send(new TextBlock('Hello'))).rejects.toThrow('outbound buffer')
      expect(socket.closed).toBe(true)
      const second = await connect(model)
      second.readyState = 0
      await expect(model.send(new TextBlock('Hello'))).rejects.toThrow('could not send data')
      expect(second.closed).toBe(true)
    })
  })

  describe('tool calls', () => {
    const call = (id: string): object => ({
      type: 'function_call',
      call_id: id,
      name: 'lookup',
      arguments: '{"sku":"shirt"}',
    })
    const result = (id: string): ToolResultBlock =>
      new ToolResultBlock({ toolUseId: id, status: 'success', content: [new TextBlock('In stock')] })

    it('waits for completed calls and all batch results before requesting one response', async () => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      created(socket)
      await stream.next()
      socket.message({ ...call('call-1'), type: 'response.function_call_arguments.done' })
      expect(socket.sent.filter((event) => event.type === 'response.create')).toHaveLength(0)
      finished(socket, [call('call-1'), call('call-2')])
      expect((await stream.next()).value).toEqual({
        type: 'toolUseStream',
        delta: { type: 'toolUseInputDelta', input: '{"sku":"shirt"}' },
        currentToolUse: { toolUseId: 'call-1', name: 'lookup', input: { sku: 'shirt' } },
      })
      expect((await stream.next()).value).toEqual({
        type: 'toolUseStream',
        delta: { type: 'toolUseInputDelta', input: '{"sku":"shirt"}' },
        currentToolUse: { toolUseId: 'call-2', name: 'lookup', input: { sku: 'shirt' } },
      })
      await model.send(result('call-1'))
      expect(socket.sent.filter((event) => event.type === 'response.create')).toHaveLength(0)
      await model.send(result('call-2'))
      expect(socket.sent.slice(-3)).toEqual([
        {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call-1',
            output: JSON.stringify(result('call-1').toJSON().toolResult),
          },
        },
        {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: 'call-2',
            output: JSON.stringify(result('call-2').toJSON().toolResult),
          },
        },
        { type: 'response.create' },
      ])
      await expect(model.send(result('call-1'))).rejects.toThrow('pending Realtime call ID')
    })

    it('does not dispatch partial tool calls from cancelled responses', async () => {
      const socket = await connect(model)
      const stream = model.receive()
      await stream.next()
      created(socket)
      await stream.next()
      finished(socket, [{ ...call('call-1'), arguments: '{' }], 'cancelled')
      expect((await stream.next()).value).toEqual({ type: 'bidiResponseStop', responseId: 'response-1' })
      await expect(model.send(result('call-1'))).rejects.toThrow('pending Realtime call ID')
    })

    it('reports malformed completed tool arguments as a model failure', async () => {
      const socket = await connect(model)
      created(socket)
      finished(socket, [{ ...call('call-1'), arguments: '{' }])
      await expect(model.receive().next()).rejects.toBeInstanceOf(ModelError)
      expect(socket.closed).toBe(true)
    })

    it('replays tool history with the original call ID', async () => {
      const socket = await connect(model, {
        messages: [
          new Message({
            role: 'assistant',
            content: [new ToolUseBlock({ toolUseId: 'old-call', name: 'lookup', input: {} })],
          }),
          new Message({ role: 'user', content: [result('old-call')] }),
        ],
      })
      expect(socket.sent.slice(1).map((event) => event.item)).toEqual([
        { type: 'function_call', call_id: 'old-call', name: 'lookup', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'old-call',
          output: JSON.stringify(result('old-call').toJSON().toolResult),
        },
      ])
    })
  })
})
