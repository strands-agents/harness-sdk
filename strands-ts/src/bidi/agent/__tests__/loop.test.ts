/**
 * Unit tests for the bidirectional agent loop.
 *
 * The loop is driven through `BidiAgent` against a scripted model whose `receive()` stream the
 * test feeds event by event.
 */

import { describe, expect, it, vi } from 'vitest'

import { BidiAgent } from '../agent.js'
import { BidiModel, ConnectionTimeoutError } from '../../models/model.js'
import { BidiConnectionRestartEvent } from '../../types/events.js'
import {
  BidiAfterConnectionRestartEvent,
  BidiAgentStopEvent,
  BidiBargeInEvent,
  BidiBeforeConnectionRestartEvent,
  BidiResponseStopEvent,
} from '../../hooks/events.js'
import { tool } from '../../../tools/tool-factory.js'
import { ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import { AudioDelta } from '../../types/media.js'

import type { BidiModelConfig, ConnectionConfig } from '../../models/configs.js'
import type { BidiContentDelta, BidiMessage } from '../../types/content.js'
import type { BidiOutputEvent } from '../../types/events.js'

/** Async channel a test fills to script a model's `receive()` stream. */
class EventChannel {
  private _events: (BidiOutputEvent | Error)[] = []
  private _closed = false
  private _notify: (() => void) | undefined

  /** Queue one event for the reader. */
  push(event: BidiOutputEvent | Error): void {
    this._events.push(event)
    this._wake()
  }

  /** End the stream. */
  close(): void {
    this._closed = true
    this._wake()
  }

  /** Drain the channel until it is closed. */
  async *iterate(): AsyncGenerator<BidiOutputEvent> {
    while (true) {
      while (this._events.length > 0) {
        const next = this._events.shift()!
        if (next instanceof Error) throw next
        yield next
      }
      if (this._closed) return
      await new Promise<void>((resolve) => {
        this._notify = resolve
      })
    }
  }

  private _wake(): void {
    const notify = this._notify
    this._notify = undefined
    notify?.()
  }
}

/** Model whose output stream and connection config the test controls. */
class ScriptedBidiModel extends BidiModel {
  readonly channel = new EventChannel()
  private readonly _connectionConfig: ConnectionConfig

  constructor(connectionConfig: ConnectionConfig = {}) {
    super()
    this._connectionConfig = connectionConfig
  }

  getConfig(): BidiModelConfig {
    return { modelId: 'scripted-model' }
  }

  override getConnectionConfig(): ConnectionConfig {
    return this._connectionConfig
  }

  updateConfig(): void {}

  start = vi.fn(async (): Promise<void> => {})
  stop = vi.fn(async (): Promise<void> => {})
  send = vi.fn(async (_content: BidiMessage | BidiContentDelta): Promise<void> => {})
  receive = vi.fn((): AsyncIterable<BidiOutputEvent> => this.channel.iterate())
}

/** Model that replaces its connection in place. */
class RestartableScriptedModel extends ScriptedBidiModel {
  restart = vi.fn(async (): Promise<void> => {})
}

/** Collect events from `receive()` until the stream ends or `count` events arrive. */
async function collect(agent: BidiAgent, count: number): Promise<BidiOutputEvent[]> {
  const events: BidiOutputEvent[] = []
  for await (const event of agent.receive()) {
    events.push(event)
    if (events.length >= count) break
  }
  return events
}

/** Drain `receive()` in the background so queued events are never back-pressured. */
function drain(agent: BidiAgent): BidiOutputEvent[] {
  const seen: BidiOutputEvent[] = []
  void (async () => {
    for await (const event of agent.receive()) {
      seen.push(event)
    }
  })().catch(() => {})
  return seen
}

/** One-shot latch a test opens to release a waiter. */
class Gate {
  private _open = false
  private readonly _waiters: (() => void)[] = []

  /** Whether the gate has been opened. */
  isOpen(): boolean {
    return this._open
  }

  /** Release every waiter. */
  open(): void {
    this._open = true
    for (const waiter of this._waiters.splice(0)) waiter()
  }

  /** Wait until the gate opens. */
  wait(): Promise<void> {
    if (this._open) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve)
    })
  }
}

/** Model whose reader blocks on a live stream and raises when the stream closes, like Nova. */
class StreamScriptedModel extends BidiModel {
  restartCalls = 0
  private _closed = new Gate()
  private _inbox: BidiOutputEvent[] = []
  private _arrived = new Gate()

  getConfig(): BidiModelConfig {
    return { modelId: 'stream-model' }
  }

  override getConnectionConfig(): ConnectionConfig {
    return {}
  }

  updateConfig(): void {}

  async start(): Promise<void> {
    this._closed = new Gate()
    this._inbox = []
    this._arrived = new Gate()
  }

  async stop(): Promise<void> {
    this._closed.open()
  }

  async restart(): Promise<void> {
    this.restartCalls += 1
    await this.stop()
    await this.start()
  }

  async send(): Promise<void> {}

  /** Queue one event for the live stream. */
  emit(event: BidiOutputEvent): void {
    this._inbox.push(event)
    this._arrived.open()
  }

  async *receive(): AsyncGenerator<BidiOutputEvent> {
    const closed = this._closed
    const inbox = this._inbox
    let arrived = this._arrived
    while (true) {
      while (inbox.length > 0) {
        if (closed.isOpen()) throw new Error('stream closed')
        yield inbox.shift()!
      }
      if (closed.isOpen()) throw new Error('stream closed')
      arrived = this._arrived === arrived ? new Gate() : this._arrived
      this._arrived = arrived
      await Promise.race([arrived.wait(), closed.wait()])
      if (closed.isOpen() && inbox.length === 0) throw new Error('stream closed')
    }
  }
}

/** Read the loop's internals; the Python tests drive the same private surface. */
interface LoopInternals {
  _generation: number
  _started: boolean
  _restarting: boolean
  _eventQueue: { push: (item: BidiOutputEvent) => void; send: (item: BidiOutputEvent) => Promise<void> }
  _restartTimer: { cancel: () => void }
  _restartConnection: (
    timeoutError: undefined,
    generation: number,
    options: { restartEvent: BidiConnectionRestartEvent }
  ) => Promise<boolean>
  _onRestartDeadline: () => Promise<void>
  _onRestartWarning: (timeLeftMs: number) => Promise<void>
  _accumulatedInputTokens: () => number
  _accumulatedOutputTokens: () => number
  _accumulatedTotalTokens: () => number
}

/** Reach the loop behind an agent. */
function internals(agent: BidiAgent): LoopInternals {
  return (agent as unknown as { _loop: LoopInternals })._loop
}

/** A reader event tagged so a test can tell which connection produced it. */
function taggedEvent(tag: string): BidiOutputEvent {
  return { type: 'bidiTranscriptDelta', delta: tag, role: 'assistant', contentId: 'assistant-transcript' }
}

describe('AgentLoop', () => {
  describe('start', () => {
    it('opens the connection with the prompt, tools, and history', async () => {
      const calculator = tool({ name: 'calculator', description: 'Adds', callback: () => 'ok' })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, systemPrompt: 'be brief', tools: [calculator] })

      await agent.start()

      expect(model.start).toHaveBeenCalledWith({
        systemPrompt: 'be brief',
        tools: [calculator.toolSpec],
        messages: agent.messages,
      })
      await agent.stop()
    })

    it('rejects a second start', async () => {
      const agent = new BidiAgent({ model: new ScriptedBidiModel() })
      await agent.start()

      await expect(agent.start()).rejects.toThrow('agent already started | call stop before starting again')
      await agent.stop()
    })

    it('propagates a connection failure', async () => {
      const model = new ScriptedBidiModel()
      model.start.mockRejectedValueOnce(new Error('connect failed'))
      const agent = new BidiAgent({ model })

      await expect(agent.start()).rejects.toThrow('connect failed')
    })
  })

  describe('send', () => {
    it('rejects before start', async () => {
      const agent = new BidiAgent({ model: new ScriptedBidiModel() })

      await expect(agent.send('hi')).rejects.toThrow('agent not started | call start before sending')
    })

    it('records a user message in history', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      await agent.send('hello')

      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]?.role).toBe('user')
      expect(model.send).toHaveBeenCalledTimes(1)
      await agent.stop()
    })

    it('does not record audio deltas in history', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      await agent.send(new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([1]) } }))

      expect(agent.messages).toHaveLength(0)
      expect(model.send).toHaveBeenCalledTimes(1)
      await agent.stop()
    })
  })

  describe('receive', () => {
    it('rejects before start', async () => {
      const agent = new BidiAgent({ model: new ScriptedBidiModel() })

      await expect(agent.receive().next()).rejects.toThrow('agent not started | call start before receiving')
    })

    it('forwards model events and completes the text block', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push({ type: 'bidiTextStart', contentId: 'c1' })
      model.channel.push({ type: 'bidiTextDelta', delta: 'he', contentId: 'c1' })
      model.channel.push({ type: 'bidiTextDelta', delta: 'llo', contentId: 'c1' })
      model.channel.push({ type: 'bidiTextStop', contentId: 'c1' })

      const events = await collect(agent, 5)

      expect(events.map((event) => event.type)).toEqual([
        'bidiTextStart',
        'bidiTextDelta',
        'bidiTextDelta',
        'bidiTextStop',
        'bidiTextBlock',
      ])
      expect(agent.messages).toHaveLength(1)
      expect(agent.messages[0]?.content[0]).toMatchObject({ text: 'hello' })
      expect(agent.messages[0]?.metadata?.custom).toEqual({ bidi: { kind: 'text', status: 'complete' } })
      await agent.stop()
    })

    it('completes a transcript block with its role', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push({ type: 'bidiTranscriptStart', role: 'user', contentId: 't1' })
      model.channel.push({ type: 'bidiTranscriptDelta', delta: 'spoken', role: 'user', contentId: 't1' })
      model.channel.push({ type: 'bidiTranscriptStop', role: 'user', contentId: 't1' })

      const events = await collect(agent, 4)

      expect(events[3]).toMatchObject({ type: 'bidiTranscriptBlock', transcript: 'spoken', role: 'user' })
      expect(agent.messages[0]?.role).toBe('user')
      await agent.stop()
    })

    it('forwards audio deltas untouched', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push({
        type: 'bidiAudioDelta',
        audio: new Uint8Array([1, 2]),
        format: 'pcm',
        sampleRate: 24000,
        channels: 1,
        contentId: 'a1',
      })

      const events = await collect(agent, 1)

      expect(events[0]).toMatchObject({ type: 'bidiAudioDelta', contentId: 'a1' })
      await agent.stop()
    })

    it('fires the response stop hook', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      const stops: string[] = []
      agent.addHook(BidiResponseStopEvent, (event) => {
        stops.push(event.responseId)
      })
      await agent.start()

      model.channel.push({ type: 'bidiResponseStart', responseId: 'r1' })
      model.channel.push({ type: 'bidiResponseStop', responseId: 'r1' })
      await collect(agent, 2)

      expect(stops).toEqual(['r1'])
      await agent.stop()
    })

    it('marks open blocks incomplete on barge-in and fires the hook', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      let bargedIn = false
      agent.addHook(BidiBargeInEvent, () => {
        bargedIn = true
      })
      await agent.start()

      model.channel.push({ type: 'bidiTextStart', contentId: 'c1' })
      model.channel.push({ type: 'bidiTextDelta', delta: 'partial', contentId: 'c1' })
      model.channel.push({ type: 'bidiBargeIn' })
      await collect(agent, 3)

      expect(bargedIn).toBe(true)
      expect(agent.messages[0]?.metadata?.custom).toEqual({ bidi: { kind: 'text', status: 'incomplete' } })
      await agent.stop()
    })

    it('surfaces a reader failure to the caller', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push(new Error('stream broke'))

      await expect(collect(agent, 1)).rejects.toThrow('stream broke')
      await agent.stop()
    })

    it('surfaces a connection timeout when auto restart is off', async () => {
      const model = new ScriptedBidiModel({ autoRestart: false })
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push(new ConnectionTimeoutError('connection expired'))

      await expect(collect(agent, 1)).rejects.toThrow('connection expired')
      await agent.stop()
    })
  })

  describe('tools', () => {
    it('runs a tool group and sends its results back', async () => {
      const calculator = tool({ name: 'calculator', description: 'Adds', callback: () => '4' })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, tools: [calculator] })
      await agent.start()
      drain(agent)

      model.channel.push({
        type: 'bidiToolUseBlocks',
        toolUses: [new ToolUseBlock({ toolUseId: 't1', name: 'calculator', input: {} })],
      })

      await vi.waitFor(() => {
        expect(model.send).toHaveBeenCalled()
      })
      const sent = model.send.mock.calls[0]?.[0] as BidiMessage
      expect(sent.content[0]).toBeInstanceOf(ToolResultBlock)
      await agent.stop()
    })

    it('records the dispatch placeholder and the tool result in history', async () => {
      const calculator = tool({ name: 'calculator', description: 'Adds', callback: () => '4' })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, tools: [calculator] })
      await agent.start()
      drain(agent)

      model.channel.push({
        type: 'bidiToolUseBlocks',
        toolUses: [new ToolUseBlock({ toolUseId: 't1', name: 'calculator', input: {} })],
      })
      await vi.waitFor(() => {
        expect(agent.messages).toHaveLength(4)
      })

      expect(agent.messages[1]?.metadata?.custom).toEqual({ bidi: { kind: 'toolDispatch' } })
      expect(agent.messages[3]?.metadata?.custom).toEqual({ bidi: { kind: 'toolResult' } })
      await agent.stop()
    })

    it('stops the connection instead of replying once cancelled', async () => {
      const calculator = tool({ name: 'calculator', description: 'Adds', callback: () => '4' })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, tools: [calculator] })
      await agent.start()
      const events = drain(agent)
      agent.cancel()

      model.channel.push({
        type: 'bidiToolUseBlocks',
        toolUses: [new ToolUseBlock({ toolUseId: 't1', name: 'calculator', input: {} })],
      })
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'bidiConnectionStop')).toBe(true)
      })

      expect(model.send).not.toHaveBeenCalled()
      await agent.stop()
    })
  })

  describe('restart', () => {
    it('restarts a restartable model on a connection timeout', async () => {
      const model = new RestartableScriptedModel()
      const agent = new BidiAgent({ model })
      const reasons: string[] = []
      agent.addHook(BidiBeforeConnectionRestartEvent, (event) => {
        reasons.push(event.reason)
      })
      agent.addHook(BidiAfterConnectionRestartEvent, (event) => {
        reasons.push(`after:${String(event.error?.message)}`)
      })
      await agent.start()

      model.channel.push(new ConnectionTimeoutError('connection expired'))
      const events = await collect(agent, 1)

      expect(events[0]).toMatchObject({ type: 'bidiConnectionRestart', reason: 'timeout' })
      expect(model.restart).toHaveBeenCalledTimes(1)
      expect(reasons).toEqual(['timeout', 'after:undefined'])
      await agent.stop()
    })

    it('stops and starts a model that cannot restart in place', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()

      model.channel.push(new ConnectionTimeoutError('connection expired'))
      await collect(agent, 1)

      expect(model.stop).toHaveBeenCalledTimes(1)
      expect(model.start).toHaveBeenCalledTimes(2)
      await agent.stop()
    })
  })

  describe('stop', () => {
    it('closes the connection and fires the agent stop hook', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      let stopped = false
      agent.addHook(BidiAgentStopEvent, () => {
        stopped = true
      })
      await agent.start()

      await agent.stop()

      expect(model.stop).toHaveBeenCalledTimes(1)
      expect(stopped).toBe(true)
    })

    it('allows a restart after stopping', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })

      await agent.start()
      await agent.stop()
      await agent.start()

      expect(model.start).toHaveBeenCalledTimes(2)
      await agent.stop()
    })
  })
})

describe('AgentLoop fencing and pairing', () => {
  describe('restart', () => {
    it('drops the stream-close error raised by a superseded reader', async () => {
      const model = new StreamScriptedModel()
      const agent = new BidiAgent({ model, systemPrompt: 'hi' })
      await agent.start()
      const loop = internals(agent)
      const reader = agent.receive()[Symbol.asyncIterator]()

      const first = taggedEvent('first')
      model.emit(first)
      expect((await reader.next()).value).toBe(first)

      // The restart closes the old stream, so the superseded reader raises; the error is fenced.
      await loop._restartConnection(undefined, loop._generation, {
        restartEvent: new BidiConnectionRestartEvent({
          type: 'bidiConnectionRestart',
          reason: 'scheduled',
          turnInterrupted: false,
        }),
      })
      expect(model.restartCalls).toBe(1)
      expect((await reader.next()).value).toMatchObject({ type: 'bidiConnectionRestart' })

      const second = taggedEvent('second')
      model.emit(second)
      expect((await reader.next()).value).toBe(second)

      await reader.return?.(undefined)
      await agent.stop()
    })

    it('counts usage once per event across a restart', async () => {
      const model = new StreamScriptedModel()
      const agent = new BidiAgent({ model })
      await agent.start()
      const loop = internals(agent)
      loop._restartTimer.cancel()
      const reader = agent.receive()[Symbol.asyncIterator]()

      model.emit({ type: 'bidiUsage', inputTokens: 60, outputTokens: 40, totalTokens: 100 })
      model.emit({ type: 'bidiUsage', inputTokens: 30, outputTokens: 20, totalTokens: 50 })
      await reader.next()
      await vi.waitFor(() => {
        expect(loop._accumulatedTotalTokens()).toBe(150)
      })

      // The old reader is parked mid-queue; resuming it must not re-record onto the new connection.
      const swap = loop._restartConnection(undefined, loop._generation, {
        restartEvent: new BidiConnectionRestartEvent({
          type: 'bidiConnectionRestart',
          reason: 'scheduled',
          turnInterrupted: false,
        }),
      })
      await reader.next()
      await swap
      expect(loop._accumulatedTotalTokens()).toBe(150)

      model.emit({ type: 'bidiUsage', inputTokens: 5, outputTokens: 5, totalTokens: 10 })
      await vi.waitFor(() => {
        expect(loop._accumulatedTotalTokens()).toBe(160)
      })
      expect(loop._accumulatedInputTokens()).toBe(95)
      expect(loop._accumulatedOutputTokens()).toBe(65)

      await reader.return?.(undefined)
      await agent.stop()
    })

    it('does not restart the model when the deadline fires after stop', async () => {
      const model = new RestartableScriptedModel()
      const agent = new BidiAgent({ model })
      await agent.start()
      const loop = internals(agent)
      loop._restartTimer.cancel()

      void loop._eventQueue.send(taggedEvent('queued'))
      await agent.stop()

      // The timer callback can still be in flight when stop() lands; it must decline the swap.
      await loop._onRestartDeadline()

      expect(model.restart).not.toHaveBeenCalled()
      expect(loop._restarting).toBe(false)
    })

    it('yields the restart event before surfacing a failed reactive restart', async () => {
      const model = new RestartableScriptedModel()
      model.receive = vi.fn((): AsyncIterable<BidiOutputEvent> => {
        throw new ConnectionTimeoutError('test timeout')
      })
      model.restart = vi.fn(async (): Promise<void> => {
        throw new Error('restart failed')
      })
      const agent = new BidiAgent({ model })
      await agent.start()
      const reader = agent.receive()[Symbol.asyncIterator]()

      expect((await reader.next()).value).toMatchObject({ type: 'bidiConnectionRestart', reason: 'timeout' })
      await expect(reader.next()).rejects.toThrow('restart failed')

      await agent.stop()
    })
  })

  describe('event queue', () => {
    it('delivers connection events in order on the shared queue', async () => {
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model })
      await agent.start()
      const loop = internals(agent)
      loop._restartTimer.cancel()

      const data: BidiOutputEvent = {
        type: 'bidiTranscriptDelta',
        delta: 'new-connection output',
        role: 'assistant',
        contentId: 'assistant-transcript',
      }
      let acked = false
      void loop._eventQueue.send(data).then(() => {
        acked = true
      })
      // The warning is pushed, not acked (it comes from the restart timer, which must not stall).
      await loop._onRestartWarning(10)
      expect(acked).toBe(false)

      const reader = agent.receive()[Symbol.asyncIterator]()
      expect((await reader.next()).value).toBe(data)
      expect((await reader.next()).value).toMatchObject({ type: 'bidiConnectionWarning', timeLeftMs: 10 })
      expect(acked).toBe(true)

      await reader.return?.(undefined)
      await agent.stop()
    })
  })

  describe('tools', () => {
    it('keeps tool exchanges paired when groups finish out of order', async () => {
      const gates = new Map<string, Gate>([
        ['first', new Gate()],
        ['second', new Gate()],
      ])
      const delayed = tool({
        name: 'delayed',
        description: 'Waits until the caller releases this tool',
        callback: async (input: unknown) => {
          const name = (input as { name: string }).name
          await gates.get(name)!.wait()
          return name
        },
      })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, tools: [delayed] })
      await agent.start()
      drain(agent)

      const names = ['first', 'second']
      const expected: [string, string[]][] = []
      for (const name of names) {
        model.channel.push({
          type: 'bidiToolUseBlocks',
          toolUses: [new ToolUseBlock({ toolUseId: name, name: 'delayed', input: { name } })],
        })
        expected.push(['assistant', [name]], ['user', [name]])
        await vi.waitFor(() => {
          expect(agent.messages).toHaveLength(expected.length)
        })
      }

      // Released in reverse: each group's exchange must still be recorded as an adjacent pair.
      for (const name of [...names].reverse()) {
        gates.get(name)!.open()
        expected.push(['assistant', [name]], ['user', [name]])
        await vi.waitFor(() => {
          expect(agent.messages).toHaveLength(expected.length)
        })
      }

      expect(
        agent.messages.map((message): [string, string[]] => [
          message.role,
          message.content.flatMap((block) =>
            block.type === 'toolUseBlock' || block.type === 'toolResultBlock' ? [block.toolUseId] : []
          ),
        ])
      ).toEqual(expected)

      await agent.stop()
    })

    it('records a tool group results in tool-use request order', async () => {
      const gates = new Map<string, Gate>([
        ['slow', new Gate()],
        ['fast', new Gate()],
      ])
      const delayed = tool({
        name: 'delayed',
        description: 'Waits until the caller releases this tool',
        callback: async (input: unknown) => {
          const name = (input as { name: string }).name
          await gates.get(name)!.wait()
          return name
        },
      })
      const model = new ScriptedBidiModel()
      const agent = new BidiAgent({ model, tools: [delayed] })
      await agent.start()
      const seen = drain(agent)

      model.channel.push({
        type: 'bidiToolUseBlocks',
        toolUses: [
          new ToolUseBlock({ toolUseId: 'slow', name: 'delayed', input: { name: 'slow' } }),
          new ToolUseBlock({ toolUseId: 'fast', name: 'delayed', input: { name: 'fast' } }),
        ],
      })

      // Completion order is the reverse of the request order.
      gates.get('fast')!.open()
      gates.get('slow')!.open()

      await vi.waitFor(() => {
        expect(model.send).toHaveBeenCalled()
      })

      const resultMessage = agent.messages.at(-1)!
      expect(resultMessage.content.map((block) => (block.type === 'toolResultBlock' ? block.toolUseId : ''))).toEqual([
        'slow',
        'fast',
      ])
      expect(seen.some((event) => (event as { type: string }).type === 'messageAddedEvent')).toBe(true)
      await agent.stop()
    })
  })

  describe('stop', () => {
    it('fires the agent stop hook even when cleanup fails', async () => {
      const model = new ScriptedBidiModel()
      model.stop = vi.fn(async (): Promise<void> => {
        throw new Error('cleanup failed')
      })
      const agent = new BidiAgent({ model })
      const received: string[] = []
      agent.addHook(BidiAgentStopEvent, () => {
        received.push('stop')
      })
      await agent.start()
      expect(received).toEqual([])

      await expect(agent.stop()).rejects.toThrow('cleanup failed')

      expect(model.stop).toHaveBeenCalledTimes(1)
      expect(received).toEqual(['stop'])
    })
  })
})
