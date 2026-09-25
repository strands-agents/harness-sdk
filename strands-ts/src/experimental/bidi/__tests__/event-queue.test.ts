import { describe, expect, it } from 'vitest'
import { EventQueue } from '../event-queue.js'

describe('EventQueue', () => {
  it('preserves order and drains on clean close', async () => {
    const queue = new EventQueue<number>(2, 10)
    queue.push(1)
    queue.push(2)
    queue.close()
    queue.push(3)
    const received = []
    for await (const value of queue.receive()) received.push(value)
    expect(received).toEqual([1, 2])
  })

  it('wakes an empty receiver on close', async () => {
    const queue = new EventQueue<number>(2, 10)
    const pending = queue.receive().next()
    queue.close()
    expect(await pending).toEqual({ done: true, value: undefined })
  })

  it('propagates the original error and drops queued output', async () => {
    const queue = new EventQueue<number>(2, 10)
    const error = new Error('Disconnected')
    queue.push(1)
    queue.close(error)
    queue.close()
    await expect(queue.receive().next()).rejects.toBe(error)
  })

  it('bounds event count', () => {
    const queue = new EventQueue<number>(1, 10)
    queue.push(1)
    expect(() => queue.push(2)).toThrow('buffer is full')
  })

  it('bounds UTF-8 bytes and releases capacity when discarding or consuming', async () => {
    const queue = new EventQueue<string>(10, 5)
    queue.push('é')
    expect(() => queue.push('a')).toThrow('buffer is full')
    queue.discard((value) => value === 'é')
    queue.push('abc')
    const stream = queue.receive()
    expect((await stream.next()).value).toBe('abc')
    queue.push('def')
    queue.close()
    expect((await stream.next()).value).toBe('def')
    expect((await stream.next()).done).toBe(true)
  })
})
