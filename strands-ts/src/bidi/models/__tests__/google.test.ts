import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isNode } from '../../../__fixtures__/environment.js'

import { ModelThrottledError } from '../../../errors.js'
import { encodeBase64 } from '../../../types/media.js'
import { AudioDelta } from '../../types/media.js'
import { GoogleGeminiLiveModel } from '../google.js'
import { ConnectionTimeoutError } from '../model.js'

import type { LiveServerMessage } from '@google/genai'
import type { BidiOutputEvent } from '../../types/events.js'

const fakeSession = {
  sendClientContent: vi.fn(),
  sendRealtimeInput: vi.fn(),
  sendToolResponse: vi.fn(),
  // The SDK fires onclose once the socket is torn down; stop() waits for it.
  close: vi.fn(() => closeConnection()),
}

let connectParams: Record<string, unknown>
let emit: (message: LiveServerMessage) => void
let fail: (event: { message: string; error?: unknown }) => void
let closeConnection: () => void

const defaultConnect = async (params: Record<string, unknown>) => {
  connectParams = params
  const callbacks = params.callbacks as {
    onmessage: (message: LiveServerMessage) => void
    onerror: (event: unknown) => void
    onclose: () => void
  }
  emit = callbacks.onmessage
  fail = callbacks.onerror as typeof fail
  closeConnection = callbacks.onclose
  return fakeSession
}

const connect = vi.fn(defaultConnect)

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = { connect }
  },
}))

const modelId = 'gemini-live-2.5-flash-preview'

function createModel(options: Record<string, unknown> = {}): GoogleGeminiLiveModel {
  return new GoogleGeminiLiveModel({ modelId, apiKey: 'test-key', ...options })
}

/** Start the model, collect events emitted for the given server messages, then close. */
async function collect(model: GoogleGeminiLiveModel, messages: LiveServerMessage[]): Promise<BidiOutputEvent[]> {
  const events: BidiOutputEvent[] = []
  const reader = (async () => {
    for await (const event of model.receive()) {
      events.push(event)
    }
  })()
  for (const message of messages) {
    emit(message)
  }
  closeConnection()
  await reader
  return events
}

/** Flush pending microtasks and timers so a parked `stop()` can be observed. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** `type` plus `role` for role-bearing events, so a long bracketing sequence reads compactly. */
function labels(events: BidiOutputEvent[]): string[] {
  return events.map((event) => {
    const role = (event as { role?: string }).role
    return role === undefined ? event.type : `${event.type}:${role}`
  })
}

/** Content id of one event, for identity assertions across a sequence. */
function contentIdOf(event: BidiOutputEvent | undefined): string | undefined {
  return (event as { contentId?: string } | undefined)?.contentId
}

/** Response ids of every response-start event, in receive order. */
function responseIds(events: BidiOutputEvent[]): string[] {
  return events
    .filter((event) => event.type === 'bidiResponseStart')
    .map((event) => (event as { responseId: string }).responseId)
}

describe('GoogleGeminiLiveModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connect.mockImplementation(defaultConnect)
    if (isNode) vi.stubEnv('GEMINI_API_KEY', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('constructor', () => {
    it('exposes the model configuration', () => {
      const model = createModel({ params: { temperature: 0.5 } })

      expect(model.getConfig().modelId).toBe(modelId)
      expect(model.getConfig().params).toEqual({ temperature: 0.5 })
    })

    it('declares a proactive restart window', () => {
      expect(createModel().getConfig().connection).toEqual({ restartAfterMs: 540_000 })
    })

    it('allows overriding the restart window', () => {
      const model = createModel({ connection: { restartAfterMs: 60 } })

      expect(model.getConfig().connection).toEqual({ restartAfterMs: 60 })
    })

    it('rejects an empty model id', () => {
      expect(() => new GoogleGeminiLiveModel({ modelId: '', apiKey: 'test-key' })).toThrow(
        'modelId must be a non-empty string'
      )
    })

    // Browsers have no process.env, so environment fallback is a Node-only behavior.
    it.runIf(isNode)('resolves the api key from the environment', () => {
      vi.stubEnv('GEMINI_API_KEY', 'env-key')

      expect(() => new GoogleGeminiLiveModel({ modelId })).not.toThrow()
    })

    it('requires an api key when none is available', () => {
      expect(() => new GoogleGeminiLiveModel({ modelId })).toThrow('Gemini API key is required')
    })

    it('accepts a preconfigured client', () => {
      const model = new GoogleGeminiLiveModel({ modelId, client: { live: { connect } } as never })

      expect(model.getConfig().modelId).toBe(modelId)
    })

    it('resolves audio defaults', () => {
      expect(createModel().getAudioConfig()).toEqual({
        input: { sampleRate: 16000, channels: 1, format: 'pcm' },
        output: { sampleRate: 24000, channels: 1, format: 'pcm' },
      })
    })

    it('honors a custom input sample rate', () => {
      const model = createModel({ audio: { input: { sampleRate: 24000 } } })

      expect(model.getAudioConfig().input.sampleRate).toBe(24000)
    })

    it('rejects a non-positive sample rate', () => {
      expect(() => createModel({ audio: { input: { sampleRate: 0 } } })).toThrow(
        'Unsupported sample rate: 0. Expected a positive value.'
      )
    })
  })

  describe('updateConfig', () => {
    it('merges overrides into the configuration', () => {
      const model = createModel()

      model.updateConfig({ params: { temperature: 0.1 } })

      expect(model.getConfig().params).toEqual({ temperature: 0.1 })
    })

    it('rejects an invalid model id', () => {
      const model = createModel()

      expect(() => model.updateConfig({ modelId: '' })).toThrow('modelId must be a non-empty string')
    })
  })

  describe('start', () => {
    it('connects with transcription, compression, and resumption config', async () => {
      const model = createModel()

      await model.start({ systemPrompt: 'be brief' })

      expect(connectParams.model).toBe(modelId)
      expect(connectParams.config).toMatchObject({
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        systemInstruction: 'be brief',
      })
    })

    it('formats tools as function declarations', async () => {
      const model = createModel()
      const inputSchema = { type: 'object' as const, properties: { city: { type: 'string' as const } } }

      await model.start({ tools: [{ name: 'weather', description: 'get weather', inputSchema }] })

      expect((connectParams.config as Record<string, unknown>).tools).toEqual([
        { functionDeclarations: [{ name: 'weather', description: 'get weather', parameters: inputSchema }] },
      ])
    })

    it('applies params over the defaults', async () => {
      const model = createModel({ params: { responseModalities: ['TEXT'] } })

      await model.start()

      expect((connectParams.config as Record<string, unknown>).responseModalities).toEqual(['TEXT'])
    })

    it('adds a voice when configured', async () => {
      const model = createModel({ voice: 'Puck' })

      await model.start()

      expect((connectParams.config as Record<string, unknown>).speechConfig).toEqual({
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } },
      })
    })

    it('replays text history and enables client-content history', async () => {
      const model = createModel()

      await model.start({
        messages: [
          { role: 'user', content: [{ type: 'textBlock', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'textBlock', text: 'hello' }] },
        ] as never,
      })

      expect((connectParams.config as Record<string, unknown>).historyConfig).toEqual({
        initialHistoryInClientContent: true,
      })
      expect(fakeSession.sendClientContent).toHaveBeenCalledWith({
        turns: [
          { role: 'user', parts: [{ text: 'hi' }] },
          { role: 'model', parts: [{ text: 'hello' }] },
        ],
        turnComplete: true,
      })
    })

    it('rejects a second start', async () => {
      const model = createModel()
      await model.start()

      await expect(model.start()).rejects.toThrow('model already started')
    })
  })

  describe('receive', () => {
    it('requires a started connection', async () => {
      const model = createModel()

      await expect(model.receive().next()).rejects.toThrow('model not started')
    })

    it('emits a connection start event first', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [])

      expect(events[0]).toMatchObject({ type: 'bidiConnectionStart', model: modelId })
    })

    it('brackets audio output and completes the response', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { data: encodeBase64(new Uint8Array([1, 2, 3])) } as LiveServerMessage,
        { serverContent: { turnComplete: true } } as LiveServerMessage,
      ])

      const types = events.map((event) => event.type)
      expect(types).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiAudioStart',
        'bidiAudioDelta',
        'bidiAudioStop',
        'bidiResponseStop',
      ])
      const delta = events.find((event) => event.type === 'bidiAudioDelta')
      expect(delta).toMatchObject({ audio: new Uint8Array([1, 2, 3]), sampleRate: 24000, channels: 1, format: 'pcm' })
    })

    it('emits assistant text with start, delta, and stop', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { serverContent: { modelTurn: { parts: [{ text: 'hello' }] } } } as LiveServerMessage,
        { serverContent: { turnComplete: true } } as LiveServerMessage,
      ])

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTextStart',
        'bidiTextDelta',
        'bidiTextStop',
        'bidiResponseStop',
      ])
    })

    it('emits reasoning events for thought parts', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { serverContent: { modelTurn: { parts: [{ text: 'thinking', thought: true }] } } } as LiveServerMessage,
      ])

      expect(events.map((event) => event.type)).toContain('bidiReasoningDelta')
    })

    it('emits input and output transcripts', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { serverContent: { inputTranscription: { text: 'who are you' } } } as LiveServerMessage,
        { serverContent: { outputTranscription: { text: 'a model' } } } as LiveServerMessage,
        { serverContent: { turnComplete: true } } as LiveServerMessage,
      ])

      const transcripts = events.filter((event) => event.type === 'bidiTranscriptDelta')
      expect(transcripts).toHaveLength(2)
      expect(transcripts.map((event) => (event as { role: string }).role)).toEqual(['user', 'assistant'])
      expect(events.filter((event) => event.type === 'bidiTranscriptStop')).toHaveLength(2)
    })

    it('opens a user transcript on an activity start signal', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [{ voiceActivity: { voiceActivityType: 'ACTIVITY_START' } } as never])

      expect(events.map((event) => event.type)).toEqual(['bidiConnectionStart', 'bidiTranscriptStart'])
    })

    it('emits a barge-in event and stops audio when interrupted', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { data: encodeBase64(new Uint8Array([1])) } as LiveServerMessage,
        { serverContent: { interrupted: true } } as LiveServerMessage,
      ])

      expect(events.map((event) => event.type)).toContain('bidiBargeIn')
      expect(events.map((event) => event.type)).toContain('bidiAudioStop')
    })

    it('accumulates tool names and emits tool uses', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { toolCall: { functionCalls: [{ id: 'call-1', name: 'weather', args: { city: 'Rome' } }] } } as never,
      ])

      expect(events.at(-1)).toMatchObject({
        type: 'bidiToolUseBlocks',
        toolUses: [{ toolUseId: 'call-1', name: 'weather', input: { city: 'Rome' } }],
      })
    })

    it('maps usage metadata with modality details', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        {
          usageMetadata: {
            promptTokenCount: 10,
            responseTokenCount: 5,
            totalTokenCount: 15,
            cachedContentTokenCount: 2,
            thoughtsTokenCount: 3,
            promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 10 }],
            responseTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
          },
        } as never,
      ])

      expect(events.at(-1)).toMatchObject({
        type: 'bidiUsage',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: { audio: 10, cacheRead: 2 },
        outputTokenDetails: { text: 5, reasoning: 3 },
      })
    })

    it('tracks the session resumption handle', async () => {
      const model = createModel()
      await model.start()

      await collect(model, [{ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } } as never])
      await model.stop()
      await model.restart()

      expect((connectParams.config as Record<string, unknown>).sessionResumption).toEqual({ handle: 'handle-1' })
    })

    it('raises a connection timeout on go-away', async () => {
      const model = createModel()
      await model.start()
      const reader = model.receive()
      await reader.next()

      emit({ goAway: { timeLeft: '10s' } } as LiveServerMessage)

      await expect(reader.next()).rejects.toThrow(ConnectionTimeoutError)
    })

    it('maps a throttling transport error', async () => {
      const model = createModel()
      await model.start()
      const reader = model.receive()
      await reader.next()

      fail({ message: 'RESOURCE_EXHAUSTED: quota exceeded' })

      await expect(reader.next()).rejects.toThrow(ModelThrottledError)
    })

    it('binds turn state to the reader that started it', async () => {
      const model = createModel()
      await model.start()
      const first = model.receive()
      await first.next()
      emit({ serverContent: { modelTurn: { parts: [{ text: 'first' }] } } } as LiveServerMessage)
      await first.next()

      await model.stop()
      await model.start()
      const second = await collect(model, [
        { serverContent: { modelTurn: { parts: [{ text: 'second' }] } } } as LiveServerMessage,
      ])

      // A fresh connection opens its own response and text blocks rather than continuing the
      // previous reader's turn.
      expect(second.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTextStart',
        'bidiTextDelta',
      ])
    })
  })

  describe('send', () => {
    it('requires a started connection', async () => {
      const model = createModel()

      await expect(model.send({ content: [{ type: 'textBlock', text: 'hi' }] } as never)).rejects.toThrow(
        'model not started'
      )
    })

    it('sends text as a completed user turn', async () => {
      const model = createModel()
      await model.start()

      await model.send({ content: [{ type: 'textBlock', text: 'hi' }] } as never)

      expect(fakeSession.sendClientContent).toHaveBeenCalledWith({
        turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
        turnComplete: true,
      })
    })

    it('sends audio deltas as realtime input', async () => {
      const model = createModel()
      await model.start()

      await model.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([4, 5]) } }))

      expect(fakeSession.sendRealtimeInput).toHaveBeenCalledWith({
        audio: { data: encodeBase64(new Uint8Array([4, 5])), mimeType: 'audio/pcm;rate=16000' },
      })
    })

    it('unwraps a single tool result content block', async () => {
      const model = createModel()
      await model.start()
      await collect(model, [{ toolCall: { functionCalls: [{ id: 'call-1', name: 'weather' }] } } as never])

      await model.send({
        content: [
          { type: 'toolResultBlock', toolUseId: 'call-1', content: [{ type: 'jsonBlock', json: { temp: 20 } }] },
        ],
      } as never)

      expect(fakeSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{ id: 'call-1', name: 'weather', response: { json: { temp: 20 } } }],
      })
    })

    it('wraps multiple tool result content blocks in an array', async () => {
      const model = createModel()
      await model.start()
      await collect(model, [{ toolCall: { functionCalls: [{ id: 'call-1', name: 'weather' }] } } as never])

      await model.send({
        content: [
          {
            type: 'toolResultBlock',
            toolUseId: 'call-1',
            content: [
              { type: 'textBlock', text: 'warm' },
              { type: 'jsonBlock', json: { temp: 20 } },
            ],
          },
        ],
      } as never)

      expect(fakeSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [
          { id: 'call-1', name: 'weather', response: { result: [{ text: 'warm' }, { json: { temp: 20 } }] } },
        ],
      })
    })

    it('rejects unsupported tool result content', async () => {
      const model = createModel()
      await model.start()

      await expect(
        model.send({
          content: [{ type: 'toolResultBlock', toolUseId: 'call-1', content: [{ type: 'imageBlock', format: 'png' }] }],
        } as never)
      ).rejects.toThrow('Content type not supported by Gemini Live API')
    })

    it('rejects unsupported content blocks', async () => {
      const model = createModel()
      await model.start()

      await expect(model.send({ content: [{ type: 'videoBlock' }] } as never)).rejects.toThrow(
        'content not supported by Gemini Live'
      )
    })

    it('rejects a tool result for an unknown tool use id', async () => {
      const model = createModel()
      await model.start()

      await expect(
        model.send({
          content: [{ type: 'toolResultBlock', toolUseId: 'missing-1', content: [{ type: 'textBlock', text: 'ok' }] }],
        } as never)
      ).rejects.toThrow('toolUseId=<missing-1> | unknown tool use id')
    })

    it('rejects a send once the session is gone', async () => {
      const model = createModel()
      await model.start()
      // A socket that never reports closed keeps stop() parked after it dropped the session.
      fakeSession.close.mockImplementationOnce(() => {})
      const stopping = model.stop()
      await tick()

      await expect(model.send({ content: [{ type: 'textBlock', text: 'hi' }] } as never)).rejects.toThrow(
        'model session closed'
      )

      closeConnection()
      await stopping
    })
  })

  describe('stop', () => {
    it('waits for the socket close callback', async () => {
      const model = createModel()
      await model.start()
      fakeSession.close.mockImplementationOnce(() => {})
      let stopped = false

      const stopping = model.stop().then(() => {
        stopped = true
      })
      await tick()
      expect(stopped).toBe(false)

      closeConnection()
      await stopping

      expect(stopped).toBe(true)
    })

    it('closes the session and clears the connection', async () => {
      const model = createModel()
      await model.start()

      await model.stop()

      expect(fakeSession.close).toHaveBeenCalledTimes(1)
      await expect(model.receive().next()).rejects.toThrow('model not started')
    })

    it('is idempotent', async () => {
      const model = createModel()
      await model.start()

      await model.stop()
      await model.stop()

      expect(fakeSession.close).toHaveBeenCalledTimes(1)
    })
  })

  describe('restart', () => {
    it('resumes via an explicit handle without replaying history', async () => {
      const model = createModel()
      await model.start()

      await model.restart({
        liveSessionHandle: 'handle-2',
        messages: [{ role: 'user', content: [{ type: 'textBlock', text: 'hi' }] }] as never,
      })

      expect((connectParams.config as Record<string, unknown>).sessionResumption).toEqual({ handle: 'handle-2' })
      expect(fakeSession.sendClientContent).not.toHaveBeenCalled()
    })

    it('starts fresh and replays history without a handle', async () => {
      const model = createModel()
      await model.start()

      await model.restart({ messages: [{ role: 'user', content: [{ type: 'textBlock', text: 'hi' }] }] as never })

      expect((connectParams.config as Record<string, unknown>).sessionResumption).toEqual({ handle: undefined })
      expect(fakeSession.sendClientContent).toHaveBeenCalledWith({
        turns: [{ role: 'user', parts: [{ text: 'hi' }] }],
        turnComplete: true,
      })
    })

    it('falls back to a fresh session when the handle is refused', async () => {
      const model = createModel()
      await model.start()
      connect.mockRejectedValueOnce(new Error('invalid handle'))

      await model.restart({ liveSessionHandle: 'stale', messages: [] })

      expect(connect).toHaveBeenCalledTimes(3)
      expect((connectParams.config as Record<string, unknown>).sessionResumption).toEqual({ handle: undefined })
    })

    it('preserves outstanding tool names across the restart', async () => {
      const model = createModel()
      await model.start()
      await collect(model, [{ toolCall: { functionCalls: [{ id: 'call-1', name: 'weather' }] } } as never])

      await model.restart()
      await model.send({
        content: [{ type: 'toolResultBlock', toolUseId: 'call-1', content: [{ type: 'textBlock', text: 'ok' }] }],
      } as never)

      expect(fakeSession.sendToolResponse).toHaveBeenCalledWith({
        functionResponses: [{ id: 'call-1', name: 'weather', response: { text: 'ok' } }],
      })
    })
  })

  describe('turn bracketing', () => {
    const serverContent = (content: Record<string, unknown>): LiveServerMessage => ({ serverContent: content }) as never
    const audio = (bytes: number[], content?: Record<string, unknown>): LiveServerMessage =>
      ({
        data: encodeBase64(new Uint8Array(bytes)),
        ...(content === undefined ? {} : { serverContent: content }),
      }) as never

    it.each(['generationComplete', 'interrupted', 'turnComplete'])(
      'stops audio once at the %s boundary',
      async (ending) => {
        const model = createModel()
        await model.start()

        const events = await collect(model, [
          audio([1]),
          audio([2], { [ending]: true }),
          serverContent({ turnComplete: true }),
          audio([3]),
        ])

        expect(labels(events)).toEqual([
          'bidiConnectionStart',
          'bidiResponseStart',
          'bidiAudioStart',
          'bidiAudioDelta',
          ...(ending === 'interrupted' ? ['bidiBargeIn'] : []),
          'bidiAudioDelta',
          'bidiAudioStop',
          'bidiResponseStop',
          'bidiResponseStart',
          'bidiAudioStart',
          'bidiAudioDelta',
        ])
        const [first, second] = events.filter((event) => event.type === 'bidiAudioStart')
        expect(contentIdOf(first)).toBeTypeOf('string')
        expect(contentIdOf(second)).not.toBe(contentIdOf(first))
      }
    )

    it('emits a finished input transcription before the turn completes', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        serverContent({ inputTranscription: { text: 'Question', finished: true } }),
        serverContent({ outputTranscription: { text: 'Answer' } }),
      ])

      expect(labels(events)).toEqual([
        'bidiConnectionStart',
        'bidiTranscriptStart:user',
        'bidiTranscriptDelta:user',
        'bidiTranscriptStop:user',
        'bidiResponseStart',
        'bidiTranscriptStart:assistant',
        'bidiTranscriptDelta:assistant',
      ])
      expect(new Set(events.slice(1, 4).map(contentIdOf)).size).toBe(1)
    })

    it('completes transcription fragments at the turn boundary', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        serverContent({ inputTranscription: { text: 'how ' } }),
        serverContent({ inputTranscription: { text: 'are you?' } }),
        serverContent({ outputTranscription: { text: 'I am ' } }),
        serverContent({ outputTranscription: { text: 'doing well.' } }),
        serverContent({ turnComplete: true }),
      ])

      expect(labels(events)).toEqual([
        'bidiConnectionStart',
        'bidiTranscriptStart:user',
        'bidiTranscriptDelta:user',
        'bidiTranscriptDelta:user',
        'bidiResponseStart',
        'bidiTranscriptStart:assistant',
        'bidiTranscriptDelta:assistant',
        'bidiTranscriptDelta:assistant',
        'bidiTranscriptStop:user',
        'bidiTranscriptStop:assistant',
        'bidiResponseStop',
      ])
    })

    it('preserves a new utterance when the previous turn completes', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { voiceActivity: { voiceActivityType: 'ACTIVITY_START' } } as LiveServerMessage,
        serverContent({ inputTranscription: { text: 'First question' } }),
        serverContent({ outputTranscription: { text: 'First answer' } }),
        { voiceActivity: { voiceActivityType: 'ACTIVITY_END' } } as LiveServerMessage,
        { voiceActivity: { voiceActivityType: 'ACTIVITY_START' } } as LiveServerMessage,
        serverContent({ inputTranscription: { text: 'Second question' }, interrupted: true }),
        serverContent({ turnComplete: true }),
        serverContent({ outputTranscription: { text: 'Second answer' } }),
        serverContent({ turnComplete: true }),
      ])

      expect(labels(events)).toEqual([
        'bidiConnectionStart',
        'bidiTranscriptStart:user',
        'bidiTranscriptDelta:user',
        'bidiResponseStart',
        'bidiTranscriptStart:assistant',
        'bidiTranscriptDelta:assistant',
        'bidiTranscriptStart:user',
        'bidiBargeIn',
        'bidiTranscriptDelta:user',
        'bidiTranscriptStop:user',
        'bidiTranscriptStop:assistant',
        'bidiResponseStop',
        'bidiResponseStart',
        'bidiTranscriptStart:assistant',
        'bidiTranscriptDelta:assistant',
        'bidiTranscriptStop:user',
        'bidiTranscriptStop:assistant',
        'bidiResponseStop',
      ])
      const starts = events.filter((event) => labels([event])[0] === 'bidiTranscriptStart:user').map(contentIdOf)
      const stops = events.filter((event) => labels([event])[0] === 'bidiTranscriptStop:user').map(contentIdOf)
      // The completing turn closes its own utterance; the newer one survives until the next turn.
      expect(stops).toEqual(starts)
      expect(responseIds(events)[0]).not.toBe(responseIds(events)[1])
    })

    it('preserves a user transcription already in progress on barge-in', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        serverContent({ modelTurn: { parts: [{ text: 'Answer' }] } }),
        serverContent({ inputTranscription: { text: 'Just one', finished: false } }),
        serverContent({ interrupted: true, inputTranscription: { text: ' second', finished: false } }),
      ])

      expect(labels(events.slice(-2))).toEqual(['bidiBargeIn', 'bidiTranscriptDelta:user'])
      const started = events.find((event) => labels([event])[0] === 'bidiTranscriptStart:user')
      expect(contentIdOf(events.at(-1))).toBe(contentIdOf(started))
      expect(events.at(-1)).toMatchObject({ delta: ' second' })
    })

    it('completes an activity that carried no transcript text', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [
        { voiceActivity: { voiceActivityType: 'ACTIVITY_START' } } as LiveServerMessage,
        serverContent({ turnComplete: true }),
      ])

      expect(labels(events)).toEqual(['bidiConnectionStart', 'bidiTranscriptStart:user', 'bidiTranscriptStop:user'])
      expect(contentIdOf(events[1])).toBe(contentIdOf(events[2]))
    })

    it.each([false, true])(
      'emits nothing for a turn complete without an open response (interrupted=%s)',
      async (interrupted) => {
        const model = createModel()
        await model.start()

        const events = await collect(model, [serverContent({ interrupted }), serverContent({ turnComplete: true })])

        expect(labels(events)).toEqual(['bidiConnectionStart', ...(interrupted ? ['bidiBargeIn'] : [])])
      }
    )

    it('emits nothing for an empty message', async () => {
      const model = createModel()
      await model.start()

      const events = await collect(model, [{} as LiveServerMessage])

      expect(labels(events)).toEqual(['bidiConnectionStart'])
    })

    it.each([false, true])(
      'gives the tool handoff and its continuation separate responses (completeWithToolCall=%s)',
      async (completeWithToolCall) => {
        const model = createModel()
        await model.start()

        const toolCall = {
          toolCall: { functionCalls: [{ id: 'tool-1', name: 'time_tool', args: {} }] },
          ...(completeWithToolCall ? { serverContent: { turnComplete: true } } : {}),
        } as LiveServerMessage
        const events = await collect(model, [
          serverContent({ inputTranscription: { text: 'What time is it?' } }),
          toolCall,
          ...(completeWithToolCall ? [] : [serverContent({ turnComplete: true })]),
          serverContent({ outputTranscription: { text: 'It is noon.' } }),
          serverContent({ turnComplete: true }),
        ])

        expect(labels(events)).toEqual([
          'bidiConnectionStart',
          'bidiTranscriptStart:user',
          'bidiTranscriptDelta:user',
          'bidiResponseStart',
          'bidiToolUseBlocks',
          'bidiTranscriptStop:user',
          'bidiResponseStop',
          'bidiResponseStart',
          'bidiTranscriptStart:assistant',
          'bidiTranscriptDelta:assistant',
          'bidiTranscriptStop:assistant',
          'bidiResponseStop',
        ])
        const [handoffId, continuationId] = responseIds(events)
        expect(handoffId).not.toBe(continuationId)
      }
    )

    it.each([false, true])(
      'keeps receive order for the first transcript after assistant output (finished=%s)',
      async (finished) => {
        const model = createModel()
        await model.start()

        const events = await collect(model, [
          serverContent({ outputTranscription: { text: 'Answer' } }),
          serverContent({ inputTranscription: { text: 'Question', finished } }),
          serverContent({ turnComplete: true }),
        ])

        expect(labels(events)).toEqual([
          'bidiConnectionStart',
          'bidiResponseStart',
          'bidiTranscriptStart:assistant',
          'bidiTranscriptDelta:assistant',
          'bidiTranscriptStart:user',
          'bidiTranscriptDelta:user',
          // `finished` only moves the stop between batches (transcription vs turn complete),
          // so the order a reader observes is the same either way.
          'bidiTranscriptStop:user',
          'bidiTranscriptStop:assistant',
          'bidiResponseStop',
        ])
      }
    )
  })
})
