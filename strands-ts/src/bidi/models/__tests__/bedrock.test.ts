/**
 * Tests for the Bedrock Nova Sonic bidirectional model provider.
 */

import { describe, expect, it, vi } from 'vitest'

import { ModelThrottledError } from '../../../errors.js'
import { JsonBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { AudioDelta } from '../../types/media.js'
import { BedrockNovaSonicModel } from '../bedrock.js'
import { ConnectionTimeoutError } from '../model.js'

import type { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime'
import type { ToolSpec } from '../../../tools/types.js'
import type { BidiMessage } from '../../types/content.js'
import type {
  BidiAudioDeltaEvent,
  BidiAudioStopEvent,
  BidiOutputEvent,
  BidiToolUseBlocksEvent,
  BidiTranscriptDeltaEvent,
} from '../../types/events.js'

type NovaEvent = Record<string, unknown>

/** One request chunk as the fake client sees it. */
interface NovaChunk {
  chunk: { bytes: Uint8Array }
}

/** The subset of the bidirectional stream command the fake client reads. */
interface NovaCommand {
  input: { modelId: string; body: AsyncIterable<NovaChunk> }
}

/** Wrap a Nova wire event in the response-stream chunk shape. */
function chunk(event: Record<string, unknown>): NovaChunk {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify({ event })) } }
}

/** Read a dot-separated path out of a recorded Nova wire event. */
function field(event: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((value, key) => (value == null ? undefined : (value as Record<string, unknown>)[key]), event)
}

/** Consume a request body so producers waiting on an ack are released. */
async function drain(body: AsyncIterable<NovaChunk>): Promise<void> {
  for await (const part of body) {
    void part
  }
}

/** Response stream the test feeds event by event, staying open until closed. */
class PushStream implements AsyncIterable<unknown> {
  private readonly _pending: unknown[] = []
  private _notify: (() => void) | undefined
  private _closed = false

  push(event: unknown): void {
    this._pending.push(event)
    this._notify?.()
    this._notify = undefined
  }

  close(): void {
    this._closed = true
    this._notify?.()
    this._notify = undefined
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      const next = this._pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this._closed) {
        return
      }
      await new Promise<void>((resolve) => {
        this._notify = resolve
      })
    }
  }
}

/** Stand-in for `BedrockRuntimeClient` that scripts the response stream and records the request. */
class FakeClient {
  /** Nova wire events pushed onto the request stream, in order. */
  readonly sent: NovaEvent[] = []
  readonly commands: NovaCommand[] = []
  readonly signals: (AbortSignal | undefined)[] = []
  send = vi.fn(async (command: NovaCommand, options?: { abortSignal?: AbortSignal }) => {
    this.commands.push(command)
    this.signals.push(options?.abortSignal)
    void this._drain(command.input.body)
    return { body: this._stream(this.commands.length - 1) }
  })

  /** @param _outputs - Response-stream events, or an open stream, for each successive connection. */
  constructor(private readonly _outputs: (unknown[] | PushStream)[] = []) {}

  /** Nova wire events pushed onto the request stream, filtered to one event key. */
  texts(): string[] {
    return this.sent.filter((event) => 'textInput' in event).map((event) => String(field(event, 'textInput.content')))
  }

  private _stream(call: number): AsyncIterable<unknown> {
    const output = this._outputs[call]
    return output instanceof PushStream ? output : this._iterate(output ?? [])
  }

  private async *_iterate(outputs: unknown[]): AsyncGenerator<unknown> {
    for (const output of outputs) {
      yield output
    }
  }

  private async _drain(body: AsyncIterable<NovaChunk>): Promise<void> {
    for await (const part of body) {
      this.sent.push((JSON.parse(new TextDecoder().decode(part.chunk.bytes)) as { event: NovaEvent }).event)
    }
  }
}

function newModel(outputs: unknown[] = [], options: Record<string, unknown> = {}): [BedrockNovaSonicModel, FakeClient] {
  const client = new FakeClient([outputs])
  const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient, ...options })
  return [model, client]
}

/** Let the background request-stream drain catch up. */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Let the receive loop and any deferred sends run to a standstill. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await tick()
  }
}

async function collect(events: AsyncIterable<BidiOutputEvent>): Promise<BidiOutputEvent[]> {
  const collected: BidiOutputEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

/** `count` user messages, each over the 50KB per-message cap and tagged with its index. */
function historyMessages(count: number): Message[] {
  return Array.from(
    { length: count },
    (_unused, index) => new Message({ role: 'user', content: [new TextBlock(`m${index + 1}${'y'.repeat(60 * 1024)}`)] })
  )
}

/** The `mN` tag of every history message the model replayed, oldest first. */
function replayedMarkers(client: FakeClient): string[] {
  return client
    .texts()
    .filter((text) => text.includes('y'))
    .map((text) => text.slice(0, 2))
}

const toolSpec: ToolSpec = {
  name: 'time_tool',
  description: 'Get the time',
  inputSchema: { type: 'object', properties: { zone: { type: 'string' } } },
}

describe('BedrockNovaSonicModel', () => {
  describe('configuration', () => {
    it('defaults the model id', () => {
      const [model] = newModel()
      expect(model.getConfig().modelId).toBe('amazon.nova-2-5-sonic')
    })

    it('uses an explicit model id', () => {
      const [model] = newModel([], { modelId: 'amazon.nova-sonic-v1:0' })
      expect(model.getConfig().modelId).toBe('amazon.nova-sonic-v1:0')
    })

    it('returns the config by reference', () => {
      const [model] = newModel()
      const config = model.getConfig()
      model.updateConfig({ temperature: 0.5 })
      expect(config.temperature).toBe(0.5)
    })

    it('rejects an invalid model id on update', () => {
      const [model] = newModel()
      expect(() => model.updateConfig({ modelId: '' })).toThrow('modelId must be a non-empty string')
    })

    it('declares the default restart timing', () => {
      const [model] = newModel()
      expect(model.getConnectionConfig()).toEqual({ restartAfterMs: 420_000 })
    })

    it('merges connection overrides over the defaults', () => {
      const [model] = newModel([], { connection: { autoRestart: false } })
      expect(model.getConnectionConfig()).toEqual({ restartAfterMs: 420_000, autoRestart: false })
    })

    it('replaces params on update', async () => {
      const [model, client] = newModel([], { params: { inferenceConfiguration: { temperature: 0.8 } } })
      model.updateConfig({ params: { inferenceConfiguration: { topP: 0.9 } } })
      await model.start()
      await tick()
      expect(client.sent[0]).toEqual({ sessionStart: { inferenceConfiguration: { topP: 0.9 } } })
    })

    it('accepts a well-formed region', () => {
      for (const region of ['us-east-1', 'ap-southeast-1', 'us-gov-east-1']) {
        const [model] = newModel([], { region })
        expect(model.region).toBe(region)
      }
    })

    it('rejects a malformed region', () => {
      for (const region of ['', 'x@attacker.com:443/#', 'us-east-1\n']) {
        expect(() => newModel([], { region })).toThrow('invalid AWS region')
      }
    })

    it('passes params to sessionStart', async () => {
      const [model, client] = newModel([], { params: { inferenceConfiguration: { maxTokens: 512 } } })
      await model.start()
      await tick()
      expect(client.sent[0]).toEqual({ sessionStart: { inferenceConfiguration: { maxTokens: 512 } } })
    })
  })

  describe('audio configuration', () => {
    it('defaults both streams to 16000 Hz mono pcm', () => {
      const [model] = newModel()
      expect(model.getAudioConfig()).toEqual({
        input: { sampleRate: 16000, channels: 1, format: 'pcm' },
        output: { sampleRate: 16000, channels: 1, format: 'pcm' },
      })
    })

    it('resolves explicit sample rates', () => {
      const [model] = newModel([], { audio: { input: { sampleRate: 8000 }, output: { sampleRate: 24000 } } })
      expect(model.getAudioConfig().input.sampleRate).toBe(8000)
      expect(model.getAudioConfig().output.sampleRate).toBe(24000)
    })

    it('requires a sample rate on a configured stream', () => {
      for (const direction of ['input', 'output']) {
        expect(() => newModel([], { audio: { [direction]: {} } })).toThrow(`audio.${direction}.sampleRate is required`)
      }
    })

    it.each(['input', 'output'])('rejects an unsupported %s sample rate', (direction) => {
      expect(() => newModel([], { audio: { [direction]: { sampleRate: 44100 } } })).toThrow(
        'Unsupported sample rate: 44100. Expected 8000, 16000, or 24000.'
      )
    })

    it('carries the output rate and voice into promptStart', async () => {
      const [model, client] = newModel([], { audio: { output: { sampleRate: 24000 } }, voice: 'tiffany' })
      await model.start()
      await tick()
      expect(field(client.sent[1], 'promptStart.audioOutputConfiguration')).toEqual({
        mediaType: 'audio/lpcm',
        sampleRateHertz: 24000,
        sampleSizeBits: 16,
        channelCount: 1,
        voiceId: 'tiffany',
        encoding: 'base64',
        audioType: 'SPEECH',
      })
    })
  })

  describe('connection lifecycle', () => {
    it('sends the initialization sequence', async () => {
      const [model, client] = newModel()
      await model.start({ systemPrompt: 'be brief' })
      await tick()

      expect(field(client.commands[0], 'input.modelId')).toBe('amazon.nova-2-5-sonic')
      expect(client.sent.map((event) => Object.keys(event)[0])).toEqual([
        'sessionStart',
        'promptStart',
        'contentStart',
        'textInput',
        'contentEnd',
      ])
      expect(field(client.sent[2], 'contentStart')).toMatchObject({
        type: 'TEXT',
        role: 'SYSTEM',
        interactive: false,
        textInputConfiguration: { mediaType: 'text/plain' },
      })
      expect(field(client.sent[3], 'textInput.content')).toBe('be brief')
    })

    it('adds tool configuration when tools are provided', async () => {
      const [model, client] = newModel()
      await model.start({ tools: [toolSpec] })
      await tick()

      const promptStart = field(client.sent[1], 'promptStart')
      expect(field(promptStart, 'toolUseOutputConfiguration')).toEqual({ mediaType: 'application/json' })
      expect(field(promptStart, 'toolConfiguration.tools')).toEqual([
        {
          toolSpec: {
            name: 'time_tool',
            description: 'Get the time',
            inputSchema: { json: JSON.stringify(toolSpec.inputSchema) },
          },
        },
      ])
    })

    it('rejects a second start', async () => {
      const [model] = newModel()
      await model.start()
      await expect(model.start()).rejects.toThrow('model already started | call stop before starting again')
    })

    it('rejects send before start', async () => {
      const [model] = newModel()
      await expect(model.send({ content: [new TextBlock('hi')] })).rejects.toThrow(
        'model not started | call start before sending'
      )
    })

    it('rejects receive before start', async () => {
      const [model] = newModel()
      await expect(collect(model.receive())).rejects.toThrow('model not started | call start before receiving')
    })

    it('sends the cleanup sequence on stop', async () => {
      const [model, client] = newModel()
      await model.start()
      await model.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([1, 2]) } }))
      await model.stop()
      await tick()

      expect(client.sent.slice(-3).map((event) => Object.keys(event)[0])).toEqual([
        'contentEnd',
        'promptEnd',
        'connectionEnd',
      ])
      expect(client.sent.at(-1)).toEqual({ connectionEnd: {} })
    })

    it('aborts the request on stop', async () => {
      const [model, client] = newModel()
      await model.start()
      const signal = client.signals[0]

      expect(signal?.aborted).toBe(false)
      await model.stop()
      expect(signal?.aborted).toBe(true)
    })

    it('destroys a client it created itself', async () => {
      const client = new FakeClient([[]])
      const destroy = vi.fn()
      const model = new BedrockNovaSonicModel({ region: 'us-east-1' })
      model['_createClient'] = () => Object.assign(client, { destroy }) as unknown as BedrockRuntimeClient
      await model.start()
      await model.stop()

      expect(destroy).toHaveBeenCalledTimes(1)
      // A later start() builds a fresh client rather than reusing the destroyed one.
      await model.start()
      expect(destroy).toHaveBeenCalledTimes(1)
    })

    it('stops cleanly after a failed start', async () => {
      const [model, client] = newModel()
      client.send.mockRejectedValueOnce(new Error('connection failed'))

      await expect(model.start()).rejects.toThrow('connection failed')
      await expect(model.stop()).resolves.toBeUndefined()
      // No cleanup events are sent into a stream that was never established.
      expect(client.sent).toEqual([])
    })

    it('is idempotent on stop', async () => {
      const [model] = newModel()
      await model.start()
      await model.stop()
      await expect(model.stop()).resolves.toBeUndefined()
    })
  })

  describe('send', () => {
    it('joins text blocks into one text input', async () => {
      const [model, client] = newModel()
      await model.start()
      await model.send({ content: [new TextBlock('one'), new TextBlock('two')] })
      await tick()

      const texts = client.sent
        .filter((event) => 'textInput' in event)
        .map((event) => field(event, 'textInput.content'))
      expect(texts).toEqual(['', 'one\ntwo'])
    })

    it('rejects image content', async () => {
      const [model] = newModel()
      await model.start()
      const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })
      await expect(model.send({ content: [image] })).rejects.toThrow('content not supported by Nova Sonic')
    })

    it('starts the audio container once and base64-encodes audio', async () => {
      const [model, client] = newModel()
      await model.start()
      await model.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([0, 1, 2]) } }))
      await model.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([3]) } }))
      await tick()

      const audioStarts = client.sent.filter((event) => field(event, 'contentStart.type') === 'AUDIO')
      expect(audioStarts).toHaveLength(1)
      expect(field(audioStarts[0], 'contentStart.audioInputConfiguration')).toEqual({
        mediaType: 'audio/lpcm',
        sampleRateHertz: 16000,
        sampleSizeBits: 16,
        channelCount: 1,
        audioType: 'SPEECH',
        encoding: 'base64',
      })

      const audioInputs = client.sent.filter((event) => 'audioInput' in event)
      expect(audioInputs.map((event) => field(event, 'audioInput.content'))).toEqual(['AAEC', 'Aw=='])
      expect(field(audioInputs[0], 'audioInput.contentName')).toBe(field(audioStarts[0], 'contentStart.contentName'))
    })

    it('unwraps a single tool result content block', async () => {
      const [model, client] = newModel()
      await model.start()
      await model.send({
        content: [
          new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new JsonBlock({ json: { time: 12 } })] }),
        ],
      })
      await tick()

      const toolResult = client.sent.find((event) => 'toolResult' in event)!.toolResult
      expect(JSON.parse(String(field(toolResult, 'content')))).toEqual({ json: { time: 12 } })

      const toolStart = field(
        client.sent.find((event) => field(event, 'contentStart.type') === 'TOOL'),
        'contentStart'
      )
      expect(toolStart).toMatchObject({
        interactive: false,
        type: 'TOOL',
        role: 'TOOL',
        toolResultInputConfiguration: {
          toolUseId: 't1',
          type: 'TEXT',
          textInputConfiguration: { mediaType: 'text/plain' },
        },
      })
    })

    it('sends multiple tool result content blocks as an array', async () => {
      const [model, client] = newModel()
      await model.start()
      await model.send({
        content: [
          new ToolResultBlock({
            toolUseId: 't1',
            status: 'success',
            content: [new TextBlock('a'), new TextBlock('b')],
          }),
        ],
      })
      await tick()

      const toolResult = client.sent.find((event) => 'toolResult' in event)!.toolResult
      expect(JSON.parse(String(field(toolResult, 'content')))).toEqual({ content: [{ text: 'a' }, { text: 'b' }] })
    })

    it('rejects unsupported tool result content', async () => {
      const [model] = newModel()
      await model.start()
      const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1]) } })
      await expect(
        model.send({ content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [image] })] })
      ).rejects.toThrow('Content type not supported by Nova Sonic')
    })
  })

  describe('message history', () => {
    it('replays text messages as non-interactive content', async () => {
      const [model, client] = newModel()
      await model.start({
        messages: [
          new Message({ role: 'user', content: [new TextBlock('hello')] }),
          new Message({ role: 'assistant', content: [new TextBlock('hi')] }),
        ],
      })
      await tick()

      const history = client.sent.filter((event) => field(event, 'contentStart.interactive') === false)
      expect(history.map((event) => field(event, 'contentStart.role'))).toEqual(['SYSTEM', 'USER', 'ASSISTANT'])
      const texts = client.sent
        .filter((event) => 'textInput' in event)
        .map((event) => field(event, 'textInput.content'))
      expect(texts).toEqual(['', 'hello', 'hi'])
    })

    it('drops leading non-user messages', async () => {
      const [model, client] = newModel()
      await model.start({
        messages: [
          new Message({ role: 'assistant', content: [new TextBlock('first')] }),
          new Message({ role: 'user', content: [new TextBlock('second')] }),
        ],
      })
      await tick()

      const texts = client.sent
        .filter((event) => 'textInput' in event)
        .map((event) => field(event, 'textInput.content'))
      expect(texts).toEqual(['', 'second'])
    })

    it('omits messages without text blocks', async () => {
      const [model, client] = newModel()
      await model.start({
        messages: [
          new Message({ role: 'user', content: [new TextBlock('keep')] }),
          new Message({ role: 'user', content: [new ToolUseBlock({ toolUseId: 't', name: 'x', input: {} })] }),
        ],
      })
      await tick()

      const texts = client.sent
        .filter((event) => 'textInput' in event)
        .map((event) => field(event, 'textInput.content'))
      expect(texts).toEqual(['', 'keep'])
    })
  })

  describe('receive', () => {
    it('yields a connection start event first', async () => {
      const [model] = newModel([])
      await model.start()
      const events = await collect(model.receive())
      expect(events[0]).toMatchObject({ type: 'bidiConnectionStart', model: 'amazon.nova-2-5-sonic' })
    })

    it('ends the generator when the service closes the stream', async () => {
      const [model] = newModel([])
      await model.start()
      expect(await collect(model.receive())).toHaveLength(1)
    })

    it('opens a response and transcript for user text', async () => {
      const [model] = newModel([
        chunk({ contentStart: { type: 'TEXT', role: 'USER', contentId: 'c1' } }),
        chunk({ textOutput: { role: 'USER', content: 'hello' } }),
        chunk({ textOutput: { role: 'USER', content: 'there' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTranscriptStart',
        'bidiTranscriptDelta',
        'bidiTranscriptDelta',
      ])
      // Word boundaries are preserved between chunks.
      expect(events.slice(3).map((event) => (event as BidiTranscriptDeltaEvent).delta)).toEqual(['hello', ' there'])
      expect(events[2]).toMatchObject({ role: 'user', contentId: 'c1' })
    })

    it('skips FINAL assistant text and uses speculative text', async () => {
      const [model] = newModel([
        chunk({
          contentStart: {
            type: 'TEXT',
            role: 'ASSISTANT',
            contentId: 'final',
            additionalModelFields: '{"generationStage":"FINAL"}',
          },
        }),
        chunk({ textOutput: { role: 'ASSISTANT', content: 'ignored' } }),
        chunk({
          contentStart: {
            type: 'TEXT',
            role: 'ASSISTANT',
            contentId: 'spec',
            additionalModelFields: '{"generationStage":"SPECULATIVE"}',
          },
        }),
        chunk({ textOutput: { role: 'ASSISTANT', content: 'kept' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTranscriptStart',
        'bidiTranscriptDelta',
      ])
      expect((events[3] as BidiTranscriptDeltaEvent).delta).toBe('kept')
    })

    it('decodes audio output into bytes with the output format', async () => {
      const [model] = newModel(
        [
          chunk({ contentStart: { type: 'AUDIO', role: 'ASSISTANT', contentId: 'a1' } }),
          chunk({ audioOutput: { content: 'AAEC' } }),
          chunk({ contentEnd: { type: 'AUDIO', stopReason: 'END_TURN' } }),
        ],
        { audio: { output: { sampleRate: 24000 } } }
      )
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiAudioStart',
        'bidiAudioDelta',
        'bidiAudioStop',
        'bidiResponseStop',
      ])
      const delta = events[3] as BidiAudioDeltaEvent
      expect(delta.audio).toEqual(new Uint8Array([0, 1, 2]))
      expect(delta).toMatchObject({ contentId: 'a1', format: 'pcm', sampleRate: 24000, channels: 1 })
      expect((events[4] as BidiAudioStopEvent).contentId).toBe('a1')
    })

    it('emits a barge-in and closes the open response', async () => {
      const [model] = newModel([
        chunk({ contentStart: { type: 'AUDIO', role: 'ASSISTANT', contentId: 'a1' } }),
        chunk({ contentEnd: { type: 'TEXT', stopReason: 'INTERRUPTED' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiAudioStart',
        'bidiBargeIn',
        'bidiAudioStop',
        'bidiResponseStop',
      ])
    })

    it('converts tool use events', async () => {
      const [model] = newModel([
        chunk({ toolUse: { toolUseId: 't1', toolName: 'time_tool', content: '{"zone":"UTC"}' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      const toolEvent = events[1] as BidiToolUseBlocksEvent
      expect(toolEvent.type).toBe('bidiToolUseBlocks')
      expect(toolEvent.toolUses).toHaveLength(1)
      expect(toolEvent.toolUses[0]).toMatchObject({ toolUseId: 't1', name: 'time_tool', input: { zone: 'UTC' } })
    })

    it('maps usage deltas to totals and details', async () => {
      const [model] = newModel([
        chunk({
          usageEvent: {
            details: {
              delta: {
                input: { speechTokens: 3, textTokens: 2 },
                output: { speechTokens: 7, textTokens: 1 },
              },
            },
          },
        }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events[1]).toMatchObject({
        type: 'bidiUsage',
        inputTokens: 5,
        outputTokens: 8,
        totalTokens: 13,
        inputTokenDetails: { audio: 3, text: 2 },
        outputTokenDetails: { audio: 7, text: 1 },
      })
    })

    it('keeps a tool-only response open until the next user content', async () => {
      const [model] = newModel([
        chunk({ contentStart: { type: 'TOOL', role: 'TOOL', contentId: 'c1' } }),
        chunk({ contentEnd: { type: 'TOOL', stopReason: 'TOOL_USE' } }),
        chunk({ contentStart: { type: 'TEXT', role: 'USER', contentId: 'c2' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiResponseStop',
        'bidiResponseStart',
        'bidiTranscriptStart',
      ])
    })

    it('closes a user transcript when the role changes', async () => {
      const [model] = newModel([
        chunk({ contentStart: { type: 'TEXT', role: 'USER', contentId: 'c1' } }),
        chunk({ contentStart: { type: 'AUDIO', role: 'ASSISTANT', contentId: 'a1' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTranscriptStart',
        'bidiTranscriptStop',
        'bidiAudioStart',
      ])
    })

    it('treats completionEnd as a state reset, not a turn boundary', async () => {
      const [model] = newModel([
        chunk({ completionStart: { completionId: 'x' } }),
        chunk({ contentStart: { type: 'TEXT', role: 'USER', contentId: 'c1' } }),
        chunk({ completionEnd: { completionId: 'x', stopReason: 'END_TURN' } }),
      ])
      await model.start()
      const events = await collect(model.receive())

      expect(events.map((event) => event.type)).toEqual([
        'bidiConnectionStart',
        'bidiResponseStart',
        'bidiTranscriptStart',
      ])
    })
  })

  describe('stream errors', () => {
    it('maps a model timeout to a connection timeout', async () => {
      const [model] = newModel([{ modelTimeoutException: { message: 'too slow' } }])
      await model.start()
      await expect(collect(model.receive())).rejects.toThrow(ConnectionTimeoutError)
    })

    it('maps validation InternalErrorCode=531 to a connection timeout', async () => {
      const [model] = newModel([{ validationException: { message: 'InternalErrorCode=531 silence' } }])
      await model.start()
      await expect(collect(model.receive())).rejects.toThrow(ConnectionTimeoutError)
    })

    it('maps other validation errors to a model error', async () => {
      const [model] = newModel([{ validationException: { message: 'bad request' } }])
      await model.start()
      await expect(collect(model.receive())).rejects.toThrow('bad request')
    })

    it('maps throttling to a throttled error', async () => {
      const [model] = newModel([{ throttlingException: { message: 'slow down' } }])
      await model.start()
      await expect(collect(model.receive())).rejects.toThrow(ModelThrottledError)
    })

    it('maps a thrown ThrottlingException to a throttled error', async () => {
      const client = new FakeClient()
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })
      const error = Object.assign(new Error('slow down'), { name: 'ThrottlingException' })
      client.send.mockImplementation((async (command: NovaCommand) => {
        void drain(command.input.body)
        return {
          body: {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(error),
            }),
          },
        }
      }) as unknown as typeof client.send)
      await model.start()
      await expect(collect(model.receive())).rejects.toThrow(ModelThrottledError)
    })
  })

  describe('history limits', () => {
    it('truncates a message over the 50KB per-message cap', async () => {
      const [model, client] = newModel()
      await model.start({ messages: [new Message({ role: 'user', content: [new TextBlock('x'.repeat(60 * 1024))] })] })
      await tick()

      const replayed = client.texts().find((text) => text.startsWith('x'))!
      expect(replayed).toHaveLength(50 * 1024)
    })

    it('replays every message that fits the 200KB total cap', async () => {
      const [model, client] = newModel()
      await model.start({ messages: historyMessages(4) })
      await tick()

      // Four messages truncated to 50KB each land exactly on the 200KB cap.
      expect(replayedMarkers(client)).toEqual(['m1', 'm2', 'm3', 'm4'])
    })

    it('drops the oldest messages over the 200KB total cap', async () => {
      const [model, client] = newModel()
      await model.start({ messages: historyMessages(5) })
      await tick()

      // The fifth message would push the total past 200KB, so the oldest is dropped.
      expect(replayedMarkers(client)).toEqual(['m2', 'm3', 'm4', 'm5'])
    })
  })

  describe('transcript formatting', () => {
    it('inserts a space between chunks that would otherwise run together', async () => {
      const [model] = newModel([
        chunk({ contentStart: { role: 'USER', type: 'TEXT', contentId: 'c1' } }),
        chunk({ textOutput: { role: 'USER', content: 'hello' } }),
        chunk({ textOutput: { role: 'USER', content: 'there' } }),
        chunk({ textOutput: { role: 'USER', content: ' friend' } }),
        chunk({ textOutput: { role: 'USER', content: 'ok ' } }),
        chunk({ textOutput: { role: 'USER', content: 'done' } }),
      ])
      await model.start()
      const deltas = (await collect(model.receive()))
        .filter((event) => event.type === 'bidiTranscriptDelta')
        .map((event) => (event as BidiTranscriptDeltaEvent).delta)

      expect(deltas).toEqual(['hello', ' there', ' friend', ' ok ', 'done'])
    })
  })

  describe('deferred tool results', () => {
    const USER_TEXT_START = { contentStart: { role: 'USER', type: 'TEXT', contentId: 'user-1' } }
    const ASSISTANT_AUDIO_START = { contentStart: { role: 'ASSISTANT', type: 'AUDIO', contentId: 'audio-1' } }
    const ASSISTANT_AUDIO_END = { contentEnd: { type: 'AUDIO', contentId: 'audio-1', stopReason: 'END_TURN' } }
    const BARGE_IN = { contentEnd: { type: 'TEXT', stopReason: 'INTERRUPTED' } }

    function toolUseEvent(toolUseId: string): Record<string, unknown> {
      return { toolUse: { toolUseId, toolName: 'time_tool', content: '{"zone": "UTC"}' } }
    }

    function toolResult(toolUseId: string): BidiMessage {
      return { content: [new ToolResultBlock({ toolUseId, status: 'success', content: [new TextBlock('12:00')] })] }
    }

    /**
     * Record tool uses on one connection, then restart onto an open stream the test drives.
     *
     * @returns The model, the fake client, and the previous and current connections' streams
     */
    async function startWithToolUseBeforeRestart(
      ...toolUseIds: string[]
    ): Promise<{ model: BedrockNovaSonicModel; client: FakeClient; previous: PushStream; current: PushStream }> {
      const previous = new PushStream()
      const current = new PushStream()
      const client = new FakeClient([previous, current])
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })

      await model.start()
      const draining = collect(model.receive())
      for (const toolUseId of toolUseIds) {
        previous.push(chunk(toolUseEvent(toolUseId)))
      }
      await settle()
      previous.close()
      await draining

      await model.restart()
      client.sent.length = 0
      return { model, client, previous, current }
    }

    it('tracks idle on the current connection', async () => {
      const stream = new PushStream()
      const client = new FakeClient([stream])
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })
      await model.start()

      const receiving = collect(model.receive())
      stream.push(chunk(USER_TEXT_START))
      await settle()
      // The user holds the turn, so the connection is no longer idle.
      stream.close()
      await receiving

      await model.send(toolResult('t1'))
      await tick()
      // No tool use was recorded, so the result goes out natively without waiting for idle.
      expect(client.sent.some((event) => 'toolResult' in event)).toBe(true)
      await model.stop()
    })

    it.each([false, true])('waits for the response to finish (bargeIn=%s)', async (bargeIn) => {
      const { model, client, current } = await startWithToolUseBeforeRestart('t1')
      const receiving = collect(model.receive())
      current.push(chunk(USER_TEXT_START))
      if (bargeIn) {
        current.push(chunk(ASSISTANT_AUDIO_START))
        current.push(chunk(BARGE_IN))
      }
      await settle()

      const sending = model.send(toolResult('t1'))
      await settle()
      expect(client.texts()).toEqual([])

      if (bargeIn) {
        // The user holds the turn after a barge-in until Nova answers.
        current.push(chunk(USER_TEXT_START))
        await settle()
        expect(client.texts()).toEqual([])
      }

      current.push(chunk(ASSISTANT_AUDIO_START))
      current.push(chunk(ASSISTANT_AUDIO_END))
      await sending
      expect(client.texts()).toHaveLength(1)

      current.close()
      await receiving
      await model.stop()
    })

    it('sends one deferred result per idle turn', async () => {
      const { model, client, current } = await startWithToolUseBeforeRestart('t1', 't2')
      const receiving = collect(model.receive())
      current.push(chunk(USER_TEXT_START))
      await settle()

      const sending = Promise.all([model.send(toolResult('t1')), model.send(toolResult('t2'))])
      await settle()

      for (const expected of [1, 2]) {
        current.push(chunk(ASSISTANT_AUDIO_START))
        current.push(chunk(ASSISTANT_AUDIO_END))
        await settle()
        expect(client.texts()).toHaveLength(expected)
      }

      await sending
      current.close()
      await receiving
      await model.stop()
    })

    it('ignores an idle turn from the previous connection reader', async () => {
      const { model, client, previous, current } = await startWithToolUseBeforeRestart('t1')
      const draining = collect(model.receive())
      current.push(chunk(USER_TEXT_START))
      await settle()

      const sending = model.send(toolResult('t1'))
      await settle()

      // A draining reader from the previous connection finishes its response.
      previous.push(chunk(ASSISTANT_AUDIO_START))
      previous.push(chunk(ASSISTANT_AUDIO_END))
      await settle()
      expect(client.texts()).toEqual([])

      current.push(chunk(ASSISTANT_AUDIO_START))
      current.push(chunk(ASSISTANT_AUDIO_END))
      await sending
      expect(client.texts()).toHaveLength(1)

      current.close()
      await draining
      await model.stop()
    })

    it('waits on the next connection across a restart', async () => {
      const previous = new PushStream()
      const current = new PushStream()
      const next = new PushStream()
      const client = new FakeClient([previous, current, next])
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })
      await model.start()
      const draining = collect(model.receive())
      previous.push(chunk(toolUseEvent('t1')))
      await settle()
      previous.close()
      await draining
      await model.restart()
      client.sent.length = 0

      const receiving = collect(model.receive())
      current.push(chunk(USER_TEXT_START))
      await settle()
      const sending = model.send(toolResult('t1'))
      await settle()

      current.close()
      await receiving
      await model.restart()
      client.sent.length = 0
      await settle()
      expect(client.texts()).toEqual([])

      // The next connection's reader reports it idle, releasing the deferred result.
      const resumed = collect(model.receive())
      await sending
      expect(client.texts()).toHaveLength(1)

      next.close()
      await resumed
      await model.stop()
    })

    it('sends the result anyway after the idle wait times out', async () => {
      // Real timers still advance, so the request-stream drain runs while the 30s wait is skipped.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { model, client, current } = await startWithToolUseBeforeRestart('t1', 't2')
        const receiving = collect(model.receive())
        current.push(chunk(USER_TEXT_START))
        await settle()

        const sending = model.send(toolResult('t1'))
        await vi.advanceTimersByTimeAsync(30_000)
        await sending
        expect(client.texts()).toHaveLength(1)

        // The timed-out wait is cancelled, so it cannot steal the next idle turn.
        current.push(chunk(ASSISTANT_AUDIO_START))
        current.push(chunk(ASSISTANT_AUDIO_END))
        await settle()
        await model.send(toolResult('t2'))
        expect(client.texts()).toHaveLength(2)

        current.close()
        await receiving
        await model.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('logs a send failure instead of raising', async () => {
      const { model, current } = await startWithToolUseBeforeRestart('t1')
      const receiving = collect(model.receive())
      await settle()
      // The connection is idle, so the deferred result is sent immediately - into a closed stream.
      model['_inputQueue'] = undefined

      await expect(model.send(toolResult('t1'))).resolves.toBeUndefined()

      current.close()
      await receiving
    })
  })

  describe('restart', () => {
    it('replays history onto a new connection', async () => {
      const [model, client] = newModel()
      await model.start()
      const first = model.getConfig().modelId
      await model.restart({ messages: [new Message({ role: 'user', content: [new TextBlock('replayed')] })] })
      await tick()

      expect(first).toBe('amazon.nova-2-5-sonic')
      expect(client.send).toHaveBeenCalledTimes(2)
      expect(client.texts()).toContain('replayed')
    })

    it('does not raise when restarted twice', async () => {
      const [model] = newModel()
      await model.start()
      await model.restart()
      await expect(model.restart()).resolves.toBeUndefined()
    })

    it('sends a tool result from an earlier connection as user text', async () => {
      const client = new FakeClient([
        [chunk({ toolUse: { toolUseId: 't1', toolName: 'time_tool', content: '{"zone":"UTC"}' } })],
      ])
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })
      await model.start()
      await collect(model.receive())
      await model.restart()
      // The new connection's reader reports the connection idle, releasing the deferred result.
      await collect(model.receive())

      await model.send({
        content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('12:00')] })],
      })
      await tick()

      const replayed = client.texts().find((text) => text.includes('A tool call finished'))
      expect(replayed).toContain('Tool: time_tool')
      expect(replayed).toContain('Arguments: {"zone":"UTC"}')
      expect(replayed).toContain('Status: success')
      expect(replayed).toContain('12:00')
      expect(client.sent.some((event) => 'toolResult' in event)).toBe(false)
    })

    it('clears tool uses on stop', async () => {
      const client = new FakeClient([[chunk({ toolUse: { toolUseId: 't1', toolName: 'time_tool', content: '{}' } })]])
      const model = new BedrockNovaSonicModel({ client: client as unknown as BedrockRuntimeClient })
      await model.start()
      await collect(model.receive())
      await model.stop()
      await model.start()
      await model.send({
        content: [new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('ok')] })],
      })
      await tick()

      // The tool use is forgotten, so the result is sent natively rather than replayed as text.
      expect(client.sent.some((event) => 'toolResult' in event)).toBe(true)
    })
  })
})
