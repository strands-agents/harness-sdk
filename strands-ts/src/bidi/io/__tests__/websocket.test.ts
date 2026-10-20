/**
 * Tests for WebSocket input and output streams.
 */

import { describe, expect, it, vi } from 'vitest'

import { ImageBlock } from '../../../types/media.js'
import { TextBlock } from '../../../types/messages.js'
import { BidiAudioDeltaEvent, BidiTextDeltaEvent } from '../../types/events.js'
import { AudioDelta } from '../../types/media.js'
import { WebSocketIO } from '../websocket.js'

import type { BidiAgent } from '../../agent/agent.js'
import type { BidiOutputEvent } from '../../types/events.js'
import type { BidiWebSocket, BidiWebSocketEvent } from '../configs.js'

const agent = {} as BidiAgent

// Compile-time check that the platform WebSocket satisfies the structural type.
const _platformSocket: BidiWebSocket = undefined as unknown as WebSocket

/** Socket stand-in that dispatches events to registered listeners. */
class FakeSocket implements BidiWebSocket {
  readyState = 1
  readonly sent: string[] = []
  readonly closes: number[] = []
  private readonly _listeners = new Map<string, ((event: BidiWebSocketEvent) => void)[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closes.push(code ?? 1000)
  }

  addEventListener(type: string, listener: (event: BidiWebSocketEvent) => void): void {
    const listeners = this._listeners.get(type) ?? []
    listeners.push(listener)
    this._listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: BidiWebSocketEvent) => void): void {
    this._listeners.set(
      type,
      (this._listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
    )
  }

  /** Count listeners registered for `type`. */
  listenerCount(type: string): number {
    return (this._listeners.get(type) ?? []).length
  }

  /** Deliver one inbound text frame. */
  receive(frame: string): void {
    this._dispatch('message', { type: 'message', data: frame })
  }

  /** Close the connection from the far end. */
  remoteClose(): void {
    this.readyState = 3
    this._dispatch('close', { type: 'close' })
  }

  /** Report a transport error. */
  fail(message: string): void {
    this._dispatch('error', { type: 'error', message })
  }

  private _dispatch(type: string, event: BidiWebSocketEvent): void {
    for (const listener of [...(this._listeners.get(type) ?? [])]) listener(event)
  }
}

describe('WebSocketIO', () => {
  describe('input', () => {
    it('reads a JSON string frame as text', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify('hello there'))

      await expect(input.read()).resolves.toBe('hello there')
    })

    it('reads a text object frame as a text block', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify({ text: 'hello there' }))

      await expect(input.read()).resolves.toEqual(new TextBlock('hello there'))
    })

    it('reads an array frame as ordered blocks', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify(['look at this', { image: { format: 'png', source: { bytes: 'AQID' } } }]))

      await expect(input.read()).resolves.toEqual([
        'look at this',
        new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } }),
      ])
    })

    it('reads an audio delta frame with base64 bytes', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify({ audioDelta: { format: 'pcm', source: { bytes: 'AQID' } } }))

      await expect(input.read()).resolves.toEqual(
        new AudioDelta({ format: 'pcm', source: { bytes: new Uint8Array([1, 2, 3]) } })
      )
    })

    it('reads frames in arrival order', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify('first'))
      socket.receive(JSON.stringify('second'))

      await expect(input.read()).resolves.toBe('first')
      await expect(input.read()).resolves.toBe('second')
    })

    it('resolves a read awaited before the frame arrives', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      const read = input.read()
      socket.receive(JSON.stringify('hello there'))

      await expect(read).resolves.toBe('hello there')
    })

    it('skips a malformed frame with a warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive('{ not json')
      socket.receive(JSON.stringify({ unsupported: true }))
      socket.receive(JSON.stringify('hello there'))

      await expect(input.read()).resolves.toBe('hello there')
      expect(warn).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith('type=<string>, length=<10> | ignoring malformed websocket frame')
      warn.mockRestore()
    })

    it('logs a transport error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.fail('connection reset')

      expect(warn).toHaveBeenCalledWith('error=<connection reset> | websocket error')
      warn.mockRestore()
    })

    it('rejects a pending read when the socket closes', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      const read = input.read()
      socket.remoteClose()

      await expect(read).rejects.toThrow('websocket closed')
      await expect(input.read()).rejects.toThrow('websocket closed')
    })

    it('drains queued frames before reporting the close', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      socket.receive(JSON.stringify('hello there'))
      socket.remoteClose()

      await expect(input.read()).resolves.toBe('hello there')
      await expect(input.read()).rejects.toThrow('websocket closed')
    })

    it('wakes a pending read on stop', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)
      const read = input.read()

      await input.stop?.()

      await expect(read).rejects.toThrow('websocket closed')
    })

    it('rejects a read when the socket is already closed at start', async () => {
      const socket = new FakeSocket()
      socket.readyState = 3
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      await expect(input.read()).rejects.toThrow('websocket closed')
    })

    it('removes its listeners on stop and leaves the socket open', async () => {
      const socket = new FakeSocket()
      const input = new WebSocketIO({ socket }).input()
      await input.start?.(agent)

      expect(socket.listenerCount('message')).toBe(1)

      await input.stop?.()

      expect(socket.listenerCount('message')).toBe(0)
      expect(socket.listenerCount('close')).toBe(0)
      expect(socket.listenerCount('error')).toBe(0)
      expect(socket.closes).toEqual([])
    })
  })

  describe('output', () => {
    it('sends an event class as JSON', async () => {
      const socket = new FakeSocket()
      const output = new WebSocketIO({ socket }).output()

      await output.write(new BidiTextDeltaEvent({ type: 'bidiTextDelta', delta: 'hi', contentId: 'c1' }))

      expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'bidiTextDelta', delta: 'hi', contentId: 'c1' })
    })

    it('base64-encodes audio from an event class', async () => {
      const socket = new FakeSocket()
      const output = new WebSocketIO({ socket }).output()

      await output.write(
        new BidiAudioDeltaEvent({
          type: 'bidiAudioDelta',
          audio: new Uint8Array([1, 2, 3]),
          format: 'pcm',
          sampleRate: 24000,
          channels: 1,
          contentId: 'c1',
        })
      )

      expect(JSON.parse(socket.sent[0]!)).toEqual({
        type: 'bidiAudioDelta',
        audio: 'AQID',
        format: 'pcm',
        sampleRate: 24000,
        channels: 1,
        contentId: 'c1',
      })
    })

    it('base64-encodes audio from a plain event object', async () => {
      const socket = new FakeSocket()
      const output = new WebSocketIO({ socket }).output()
      const event: BidiOutputEvent = {
        type: 'bidiAudioDelta',
        audio: new Uint8Array([1, 2, 3]),
        format: 'pcm',
        sampleRate: 24000,
        channels: 1,
        contentId: 'c1',
      }

      await output.write(event)

      expect(JSON.parse(socket.sent[0]!)).toEqual({
        type: 'bidiAudioDelta',
        audio: 'AQID',
        format: 'pcm',
        sampleRate: 24000,
        channels: 1,
        contentId: 'c1',
      })
    })

    it('sends a plain event object as JSON', async () => {
      const socket = new FakeSocket()
      const output = new WebSocketIO({ socket }).output()

      await output.write({ type: 'bidiConnectionStop', connectionId: 'x1', reason: 'userRequest' })

      expect(JSON.parse(socket.sent[0]!)).toEqual({
        type: 'bidiConnectionStop',
        connectionId: 'x1',
        reason: 'userRequest',
      })
    })

    it('drops an event when the socket is not open', async () => {
      const socket = new FakeSocket()
      socket.readyState = 3
      const output = new WebSocketIO({ socket }).output()

      await output.write({ type: 'bidiConnectionStop', connectionId: 'x1', reason: 'userRequest' })

      expect(socket.sent).toEqual([])
    })
  })
})
