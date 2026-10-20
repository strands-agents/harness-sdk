/**
 * Unit tests for the bidirectional agent.
 *
 * The agent loop is a separate unit with its own tests, so it is mocked here and the tests
 * assert what the agent delegates to it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BidiAgent } from '../agent.js'
import { BedrockNovaSonicModel } from '../../models/bedrock.js'
import { BidiModel } from '../../models/model.js'
import type { BidiModelConfig } from '../../models/configs.js'
import type { BidiMessage, BidiContentDelta } from '../../types/content.js'
import type { BidiOutputEvent } from '../../types/events.js'
import type { BidiAgentInput } from '../../types/agent.js'
import type { BidiInputStream, BidiOutputStream } from '../../types/io.js'
import { AudioDelta } from '../../types/media.js'
import { BidiConnectionStartEvent } from '../../types/events.js'
import { Message, TextBlock, systemPromptFromData, systemPromptToData } from '../../../types/messages.js'
import type { SystemContentBlockData } from '../../../types/messages.js'
import { ImageBlock } from '../../../types/media.js'
import { Sandbox } from '../../../sandbox/base.js'
import type { ExecutionResult, FileInfo, StreamChunk } from '../../../sandbox/types.js'
import { InitializedEvent } from '../../../hooks/events.js'
import type { LocalAgent } from '../../../types/agent.js'
import type { Plugin } from '../../../plugins/plugin.js'

const loop = vi.hoisted(() => ({
  start: vi.fn<(invocationState?: unknown) => void>(),
  stop: vi.fn<() => void>(),
  send: vi.fn<(content: unknown) => void>(),
  receive: vi.fn<() => void>(),
  events: [] as unknown[],
  /** When set, the fake receive() parks on this promise after draining `events`. */
  hold: undefined as Promise<void> | undefined,
}))

vi.mock('../loop.js', () => ({
  AgentLoop: class {
    async start(invocationState?: unknown): Promise<void> {
      loop.start(invocationState)
    }
    async stop(): Promise<void> {
      loop.stop()
    }
    async send(content: unknown): Promise<void> {
      loop.send(content)
    }
    async *receive(): AsyncGenerator<unknown> {
      loop.receive()
      for (const event of loop.events) {
        yield event
      }
      if (loop.hold !== undefined) await loop.hold
    }
  },
}))

/** Minimal bidirectional model standing in for a provider. */
class FakeBidiModel extends BidiModel {
  private _config: BidiModelConfig

  constructor(config: BidiModelConfig = { modelId: 'mock-model' }) {
    super()
    this._config = config
  }

  updateConfig(modelConfig: BidiModelConfig): void {
    this._config = { ...this._config, ...modelConfig }
  }

  getConfig(): BidiModelConfig {
    return { ...this._config }
  }

  start = vi.fn(async (): Promise<void> => {})
  stop = vi.fn(async (): Promise<void> => {})
  send = vi.fn(async (_content: BidiMessage | BidiContentDelta): Promise<void> => {})
  receive = vi.fn(async function* (): AsyncGenerator<BidiOutputEvent> {})
}

/** Environment-neutral sandbox: this file also runs in the browser, where the host sandbox cannot load. */
class StubSandbox extends Sandbox {
  // eslint-disable-next-line require-yield
  async *executeStreaming(): AsyncGenerator<StreamChunk | ExecutionResult> {
    throw new Error('not implemented')
  }
  // eslint-disable-next-line require-yield
  async *executeCodeStreaming(): AsyncGenerator<StreamChunk | ExecutionResult> {
    throw new Error('not implemented')
  }
  async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented')
  }
  async writeFile(): Promise<void> {}
  async removeFile(): Promise<void> {}
  async listFiles(): Promise<FileInfo[]> {
    return []
  }
}

/** Build a started agent, since most behaviour requires an open connection. */
async function startedAgent(): Promise<BidiAgent> {
  const agent = new BidiAgent({ model: new FakeBidiModel() })
  await agent.start()
  return agent
}

describe('BidiAgent', () => {
  beforeEach(() => {
    loop.start.mockClear()
    loop.stop.mockClear()
    loop.send.mockClear()
    loop.receive.mockClear()
    loop.events = []
    loop.hold = undefined
  })

  describe('constructor', () => {
    it('initializes from a model', () => {
      const model = new FakeBidiModel()
      const agent = new BidiAgent({ model })

      expect(agent.model).toBe(model)
      expect(agent.systemPrompt).toBeUndefined()
      expect(agent.sessionManager).toBeUndefined()
      expect(agent.messages).toEqual([])
      expect(agent.id).toBe('default')
      expect(agent.name).toBe('Strands Agents')
      expect(agent.description).toBeUndefined()
    })

    it('applies configuration', () => {
      const agent = new BidiAgent({
        model: new FakeBidiModel(),
        systemPrompt: 'You are a helpful assistant.',
        id: 'test_agent',
        name: 'tester',
        description: 'a test agent',
      })

      expect(agent.systemPrompt).toBe('You are a helpful assistant.')
      expect(agent.id).toBe('test_agent')
      expect(agent.name).toBe('tester')
      expect(agent.description).toBe('a test agent')
    })

    it('retains system prompt content blocks', () => {
      const agent = new BidiAgent({ model: new FakeBidiModel(), systemPrompt: 'initial prompt' })

      const blocks: SystemContentBlockData[] = [{ text: 'updated prompt' }, { cachePoint: { cacheType: 'default' } }]

      agent.systemPrompt = systemPromptFromData(blocks)

      expect(systemPromptToData(agent.systemPrompt!)).toEqual(blocks)
    })

    it('accepts conversation history as messages or their JSON form', () => {
      const agent = new BidiAgent({
        model: new FakeBidiModel(),
        messages: [{ role: 'user', content: [{ text: 'Earlier message' }] }],
      })

      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]).toBeInstanceOf(Message)
      expect(agent.messages[0]?.role).toBe('user')
    })

    it('defaults to Nova Sonic when no model is given', () => {
      const agent = new BidiAgent()

      expect(agent.model).toBeInstanceOf(BedrockNovaSonicModel)
      expect(agent.model.getConfig().modelId).toBe('amazon.nova-2-5-sonic')
    })

    it('resolves a model id string to Nova Sonic', () => {
      const agent = new BidiAgent({ model: 'custom-model' })

      expect(agent.model).toBeInstanceOf(BedrockNovaSonicModel)
      expect(agent.model.getConfig().modelId).toBe('custom-model')
    })

    it('rejects an unsupported model', () => {
      expect(() => new BidiAgent({ model: 123 as unknown as BidiModel })).toThrow(
        'model must be a BidiModel, string, or undefined'
      )
    })

    it('fires the initialized hook and attaches plugins', async () => {
      const events: InitializedEvent[] = []
      const plugin: Plugin = {
        name: 'test-plugin',
        initAgent: vi.fn((agent: LocalAgent) => {
          agent.addHook(InitializedEvent, (event) => {
            events.push(event)
          })
        }),
      }

      const agent = new BidiAgent({ model: new FakeBidiModel(), plugins: [plugin] })
      await agent.start()

      expect(plugin.initAgent).toHaveBeenCalledWith(agent)
      expect(events).toHaveLength(1)
    })
  })

  describe('properties', () => {
    it('generates a session id without a session manager', () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      expect(agent.sessionId).toMatch(/^[0-9a-f]{8}$/)
      expect(agent.sessionId).toBe(agent.sessionId)
    })

    it('delegates the session id to the session manager', () => {
      const sessionManager = { sessionId: 'test-session', name: 'session', initAgent: vi.fn() }
      const agent = new BidiAgent({
        model: new FakeBidiModel(),
        sessionManager: sessionManager as unknown as never,
      })

      expect(agent.sessionId).toBe('test-session')
    })

    it('defaults storage to undefined', () => {
      expect(new BidiAgent({ model: new FakeBidiModel() }).storage).toBeUndefined()
    })

    it('returns the configured storage', () => {
      const storage = {} as never
      expect(new BidiAgent({ model: new FakeBidiModel(), storage }).storage).toBe(storage)
    })

    it('has no context manager', () => {
      expect(new BidiAgent({ model: new FakeBidiModel() }).contextManager).toBeUndefined()
    })

    it('uses the configured sandbox', () => {
      const sandbox = new StubSandbox()

      expect(new BidiAgent({ model: new FakeBidiModel(), sandbox }).sandbox).toBe(sandbox)
    })

    it('exposes metrics and tool names', () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      expect(agent.metrics).toBeDefined()
      expect(agent.toolNames).toEqual([])
      expect(agent.tool).toBeDefined()
    })
  })

  describe('cancel', () => {
    it('sets the signal and is idempotent', () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const signal = agent.cancelSignal

      expect(signal.aborted).toBe(false)

      agent.cancel()
      agent.cancel()

      expect(signal.aborted).toBe(true)
    })

    it('composes an external cancel signal passed to start', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const external = new AbortController()

      await agent.start({ cancelSignal: external.signal })
      expect(agent.cancelSignal.aborted).toBe(false)
      external.abort()

      expect(agent.cancelSignal.aborted).toBe(true)
    })

    it('reports an already-aborted external signal as cancelled', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      await agent.start({ cancelSignal: AbortSignal.abort() })

      expect(agent.cancelSignal.aborted).toBe(true)
    })

    it('clears the signal on stop so the agent can be reused', async () => {
      const agent = await startedAgent()
      agent.cancel()

      await agent.stop()

      expect(agent.cancelSignal.aborted).toBe(false)
    })
  })

  describe('lifecycle', () => {
    it('starts the loop with the invocation state', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const invocationState = { userId: 'user_123' }

      await agent.start({ invocationState })

      expect(loop.start).toHaveBeenCalledWith(invocationState)
    })

    it('rejects a second start', async () => {
      const agent = await startedAgent()

      await expect(agent.start()).rejects.toThrow('agent already started | call stop before starting again')
    })

    it('stops the loop and allows a restart', async () => {
      const agent = await startedAgent()

      await agent.stop()
      await agent.start()

      expect(loop.stop).toHaveBeenCalledOnce()
      expect(loop.start).toHaveBeenCalledTimes(2)
    })

    it('stops on async dispose', async () => {
      {
        await using agent = await startedAgent()
        expect(agent).toBeDefined()
      }

      expect(loop.stop).toHaveBeenCalledOnce()
    })
  })

  describe('send', () => {
    it.each([
      ['string', 'Hello'],
      ['text data', { text: 'Hello' }],
      ['text block', new TextBlock('Hello')],
      ['single-item list', ['Hello']],
    ])('normalizes %s into a user message', async (_name, input) => {
      const agent = await startedAgent()

      await agent.send(input)

      expect(loop.send).toHaveBeenCalledOnce()
      const sent = loop.send.mock.calls[0]?.[0] as BidiMessage
      expect(sent.content).toEqual([new TextBlock('Hello')])
    })

    it('forwards an audio delta instance unchanged', async () => {
      const agent = await startedAgent()
      const delta = new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([0, 255]) } })

      await agent.send(delta)

      expect(loop.send).toHaveBeenCalledWith(delta)
    })

    it('normalizes audio delta data', async () => {
      const agent = await startedAgent()

      await agent.send({ audioDelta: { format: 'pcm', source: { bytes: new Uint8Array([0, 255]) } } })

      const sent = loop.send.mock.calls[0]?.[0] as AudioDelta
      expect(sent).toBeInstanceOf(AudioDelta)
      expect(sent.format).toBe('pcm')
    })

    it('normalizes image data into a user message', async () => {
      const agent = await startedAgent()

      await agent.send({ image: { format: 'jpeg', source: { bytes: new Uint8Array([1]) } } })

      const sent = loop.send.mock.calls[0]?.[0] as BidiMessage
      expect(sent.content[0]).toBeInstanceOf(ImageBlock)
    })

    it('preserves block order in a list', async () => {
      const agent = await startedAgent()
      const image = new ImageBlock({ format: 'jpeg', source: { bytes: new Uint8Array([1]) } })

      await agent.send(['Use these details.', image, { text: 'Order number: 123.' }])

      const sent = loop.send.mock.calls[0]?.[0] as BidiMessage
      expect(sent.content).toEqual([new TextBlock('Use these details.'), image, new TextBlock('Order number: 123.')])
    })

    it.each([
      ['undefined', undefined],
      ['a number', 123],
      ['an audio block', { audio: { format: 'pcm', source: { bytes: new Uint8Array([1]) } } }],
      ['a bare media payload', { format: 'pcm', source: { bytes: new Uint8Array([1]) } }],
      ['a document', { document: { format: 'txt', name: 'test', source: { bytes: new Uint8Array([1]) } } }],
      ['two content keys', { text: 'Hello', image: { format: 'jpeg', source: { bytes: new Uint8Array([1]) } } }],
      ['an empty object', {}],
      ['an empty list', []],
      ['a nested list', [new TextBlock('Hello'), [new TextBlock('Nested')]]],
      [
        'a delta inside a list',
        [new TextBlock('Hello'), new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([1]) } })],
      ],
    ])('rejects %s', async (_name, input) => {
      const agent = await startedAgent()

      await expect(agent.send(input as never)).rejects.toThrow(/invalid input/)
      expect(loop.send).not.toHaveBeenCalled()
    })

    it('rejects sending before start', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      await expect(agent.send('Hello')).rejects.toThrow('agent not started | call start before sending')
    })

    it('passes loop failures through unchanged', async () => {
      const agent = await startedAgent()
      const error = new Error('model failure')
      loop.send.mockImplementationOnce(() => {
        throw error
      })

      await expect(agent.send('Hello')).rejects.toBe(error)
    })
  })

  describe('receive', () => {
    it('yields the events the loop produces', async () => {
      const event = new BidiConnectionStartEvent({
        type: 'bidiConnectionStart',
        connectionId: 'connection-1',
        model: 'mock-model',
      })
      loop.events = [event]
      const agent = await startedAgent()

      const received: BidiOutputEvent[] = []
      for await (const output of agent.receive()) {
        received.push(output)
      }

      expect(received).toEqual([event])
    })

    it('rejects receiving before start', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      await expect(agent.receive().next()).rejects.toThrow('agent not started | call start before receiving')
    })
  })

  describe('run', () => {
    it('pumps inputs into the model and events into the outputs', async () => {
      const event = new BidiConnectionStartEvent({
        type: 'bidiConnectionStart',
        connectionId: 'connection-1',
        model: 'mock-model',
      })
      loop.events = [event]
      const agent = new BidiAgent({ model: new FakeBidiModel() })

      const input: BidiInputStream = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        read: vi.fn(async () => 'Hello'),
      }
      const written: BidiOutputEvent[] = []
      const output: BidiOutputStream = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        write: vi.fn(async (value: BidiOutputEvent) => {
          written.push(value)
        }),
      }

      await agent.run({ inputs: [input], outputs: [output] })

      expect(input.start).toHaveBeenCalledWith(agent)
      expect(output.start).toHaveBeenCalledWith(agent)
      expect(written).toEqual([event])
      expect(input.stop).toHaveBeenCalledOnce()
      expect(output.stop).toHaveBeenCalledOnce()
      expect(loop.stop).toHaveBeenCalledOnce()
    })

    it('accepts an async iterable input and a callback output', async () => {
      const event = new BidiConnectionStartEvent({
        type: 'bidiConnectionStart',
        connectionId: 'connection-1',
        model: 'mock-model',
      })
      loop.events = [event]
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const returned = vi.fn()
      async function* chunks(): AsyncGenerator<BidiAgentInput> {
        try {
          yield 'first'
          yield 'second'
        } finally {
          returned()
        }
      }
      const seen: BidiOutputEvent[] = []

      await agent.run({ inputs: [chunks()], outputs: [(value) => void seen.push(value)] })

      expect(loop.send.mock.calls.map(([content]) => content)).toEqual([
        { content: [new TextBlock('first')] },
        { content: [new TextBlock('second')] },
      ])
      expect(seen).toEqual([event])
      expect(returned).toHaveBeenCalledOnce()
    })

    it('keeps running after an iterable input is exhausted until cancelled', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const controller = new AbortController()
      async function* chunks(): AsyncGenerator<BidiAgentInput> {
        yield 'only'
      }
      const output: BidiOutputStream = { stop: vi.fn(async () => {}), write: vi.fn(async () => {}) }
      loop.hold = new Promise<void>(() => {})

      const run = agent.run({ inputs: [chunks()], outputs: [output], cancelSignal: controller.signal })
      await vi.waitFor(() => expect(loop.send).toHaveBeenCalledOnce())
      expect(loop.stop).not.toHaveBeenCalled()
      controller.abort()
      await run

      expect(output.stop).toHaveBeenCalledOnce()
      expect(loop.stop).toHaveBeenCalledOnce()
    })

    it('ends the run and stops the agent when the cancel signal aborts', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const controller = new AbortController()
      const input: BidiInputStream = {
        stop: vi.fn(async () => {}),
        read: vi.fn(() => new Promise<BidiAgentInput>(() => {})),
      }
      const output: BidiOutputStream = { stop: vi.fn(async () => {}), write: vi.fn(async () => {}) }

      const run = agent.run({ inputs: [input], outputs: [output], cancelSignal: controller.signal })
      controller.abort()
      await run

      expect(agent.cancelSignal.aborted).toBe(false)
      expect(input.stop).toHaveBeenCalledOnce()
      expect(output.stop).toHaveBeenCalledOnce()
      expect(loop.stop).toHaveBeenCalledOnce()
    })

    it('stops the streams and the agent when an input fails', async () => {
      const agent = new BidiAgent({ model: new FakeBidiModel() })
      const input: BidiInputStream = {
        stop: vi.fn(async () => {}),
        read: vi.fn(async () => {
          throw new Error('input failure')
        }),
      }
      const output: BidiOutputStream = { stop: vi.fn(async () => {}), write: vi.fn(async () => {}) }

      await expect(agent.run({ inputs: [input], outputs: [output] })).rejects.toThrow('input failure')

      expect(input.stop).toHaveBeenCalledOnce()
      expect(output.stop).toHaveBeenCalledOnce()
      expect(loop.stop).toHaveBeenCalledOnce()
    })
  })
})
