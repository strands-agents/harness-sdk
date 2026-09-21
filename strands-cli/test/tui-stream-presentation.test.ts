import { describe, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers'

import { presentChatStream } from '../src/tui/stream-presentation.js'
import type { ChatEvent, ChatRunResult } from '../src/tui/chat/controller.js'

describe('presentChatStream', () => {
  it('reveals adaptive chunks while preserving event order', async () => {
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield { type: 'textDelta', text: 'Hello ' }
      yield { type: 'textDelta', text: 'smooth world' }
      yield { type: 'toolStart', toolUseId: 'tool-1', name: 'read', input: { path: 'file.txt' } }
      yield { type: 'reasoningDelta', text: 'Checking.' }
      return { stopReason: 'endTurn' }
    }
    const waits: number[] = []
    const stream = presentChatStream(source(), {
      maxBufferedText: 120,
      targetDrainFrames: 24,
      delay: async (milliseconds) => {
        waits.push(milliseconds)
        await Promise.resolve()
      },
    })
    const events: ChatEvent[] = []
    let result: ChatRunResult | undefined
    for (;;) {
      const next = await stream.next()
      if (next.done) {
        result = next.value
        break
      }
      events.push(next.value)
    }

    const toolIndex = events.findIndex((event) => event.type === 'toolStart')
    expect(
      events
        .slice(0, toolIndex)
        .map((event) => ('text' in event ? event.text : ''))
        .join('')
    ).toBe('Hello smooth world')
    expect(events.slice(0, toolIndex).every((event) => event.type === 'textDelta' && event.text.length <= 5)).toBe(true)
    expect(
      events
        .slice(toolIndex + 1)
        .map((event) => ('text' in event ? event.text : ''))
        .join('')
    ).toBe('Checking.')
    expect(waits).toContain(32)
    expect(result).toEqual({ stopReason: 'endTurn' })
  })

  it('backpressures source consumption while presentation is paused', async () => {
    const totalDeltas = 100
    let consumed = 0
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      for (let index = 0; index < totalDeltas; index++) {
        consumed++
        yield { type: 'textDelta', text: 'x' }
      }
      return { stopReason: 'endTurn' }
    }
    let releaseFrame: () => void = () => undefined
    const frameDelay = new Promise<void>((resolve) => {
      releaseFrame = resolve
    })
    const stream = presentChatStream(source(), {
      minChunkSize: 1,
      maxBufferedText: 8,
      targetDrainFrames: 4,
      delay: async () => frameDelay,
    })

    const first = await stream.next()
    const pending = stream.next()
    await vi.waitFor(() => expect(consumed).toBeGreaterThan(0))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(first.done).toBe(false)
    const presented = first.done || first.value.type !== 'textDelta' ? 0 : first.value.text.length
    expect(consumed - presented).toBeLessThanOrEqual(8)
    const pausedConsumption = consumed
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(consumed).toBe(pausedConsumption)

    releaseFrame()
    const events: ChatEvent[] = first.done ? [] : [first.value]
    let next = await pending
    while (!next.done) {
      events.push(next.value)
      next = await stream.next()
    }
    expect(events.map((event) => ('text' in event ? event.text : '')).join('')).toBe('x'.repeat(totalDeltas))
    expect(next.value).toEqual({ stopReason: 'endTurn' })
  })

  it('caps presentation delay for large bursts before a structural event', async () => {
    const burstSize = 10_000
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      for (let index = 0; index < burstSize; index++) {
        yield { type: 'textDelta', text: 'x' }
      }
      yield { type: 'toolStart', toolUseId: 'tool-1', name: 'read', input: { path: 'file.txt' } }
      return { stopReason: 'endTurn' }
    }
    const waits: number[] = []
    const stream = presentChatStream(source(), {
      delay: async (milliseconds) => {
        waits.push(milliseconds)
        await new Promise<void>((resolve) => setImmediate(resolve))
      },
    })
    const events: ChatEvent[] = []
    let next = await stream.next()
    while (!next.done) {
      events.push(next.value)
      next = await stream.next()
    }

    const toolIndex = events.findIndex((event) => event.type === 'toolStart')
    const textEvents = events.slice(0, toolIndex)
    expect(textEvents.map((event) => ('text' in event ? event.text : '')).join('')).toBe('x'.repeat(burstSize))
    expect(textEvents.some((event) => 'text' in event && event.text.length > 20)).toBe(true)
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.length).toBeLessThanOrEqual(8)
    expect(waits.every((milliseconds) => milliseconds === 32)).toBe(true)
    expect(next.value).toEqual({ stopReason: 'endTurn' })
  })

  it('uses the same bounded delay on either side of the buffer limit', async () => {
    const present = async (length: number): Promise<{ text: string; waits: number[] }> => {
      async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
        yield { type: 'textDelta', text: 'x'.repeat(length) }
        return { stopReason: 'endTurn' }
      }
      const waits: number[] = []
      const stream = presentChatStream(source(), {
        delay: async (milliseconds) => {
          waits.push(milliseconds)
        },
      })
      const chunks: string[] = []
      let next = await stream.next()
      while (!next.done) {
        if (next.value.type === 'textDelta') {
          chunks.push(next.value.text)
        }
        next = await stream.next()
      }
      return { text: chunks.join(''), waits }
    }

    const belowLimit = await present(479)
    const atLimit = await present(480)

    expect(belowLimit.text).toBe('x'.repeat(479))
    expect(atLimit.text).toBe('x'.repeat(480))
    expect(belowLimit.waits).toEqual(atLimit.waits)
    expect(belowLimit.waits.length).toBeGreaterThan(0)
    expect(belowLimit.waits.length).toBeLessThanOrEqual(8)
  })

  it('does not split grapheme clusters across presentation chunks', async () => {
    const family = '👨‍👩‍👧‍👦'
    const accented = 'e\u0301'
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield { type: 'textDelta', text: `A${family}${accented}` }
      return { stopReason: 'endTurn' }
    }
    const stream = presentChatStream(source(), {
      minChunkSize: 1,
      delay: async () => undefined,
    })
    const chunks: string[] = []
    let next = await stream.next()
    while (!next.done) {
      if (next.value.type === 'textDelta') {
        chunks.push(next.value.text)
      }
      next = await stream.next()
    }

    expect(chunks).toEqual(['A', family, accented])
  })

  it('preserves source errors after presenting buffered text', async () => {
    const sourceError = new Error('stream failed')
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield { type: 'textDelta', text: 'before failure' }
      throw sourceError
    }
    const stream = presentChatStream(source(), {
      delay: async () => undefined,
    })
    const events: ChatEvent[] = []
    let thrown: unknown
    try {
      for (;;) {
        const next = await stream.next()
        if (next.done) {
          break
        }
        events.push(next.value)
      }
    } catch (error) {
      thrown = error
    }

    expect(events.map((event) => ('text' in event ? event.text : '')).join('')).toBe('before failure')
    expect(thrown).toBe(sourceError)
  })

  it('ends presentation delays immediately when cancellation aborts the signal', async () => {
    async function* source(): AsyncGenerator<ChatEvent, ChatRunResult, undefined> {
      yield { type: 'textDelta', text: 'cancelled output' }
      return { stopReason: 'cancelled' }
    }
    const abort = new AbortController()
    const delay = vi.fn(async (_milliseconds: number, signal?: AbortSignal) => {
      abort.abort()
      expect(signal?.aborted).toBe(true)
    })
    const stream = presentChatStream(source(), { delay }, abort.signal)

    while (!(await stream.next()).done) {
      // Drain the presentation.
    }
    expect(delay).toHaveBeenCalled()
  })
})
