import { describe, expect, it } from 'vitest'
import { AsyncLock } from '../async-lock.js'

describe('AsyncLock', () => {
  it('serializes critical sections in FIFO order', async () => {
    const lock = new AsyncLock()
    const order: number[] = []

    async function task(id: number, delayMs: number): Promise<void> {
      using _release = await lock.acquire()
      order.push(id)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    // Start three tasks "concurrently". Despite descending delays, the lock
    // forces them to run one at a time in acquisition order.
    await Promise.all([task(1, 15), task(2, 10), task(3, 5)])

    expect(order).toStrictEqual([1, 2, 3])
  })

  it('prevents overlap of holders', async () => {
    const lock = new AsyncLock()
    let active = 0
    let maxActive = 0

    async function task(): Promise<void> {
      using _release = await lock.acquire()
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    }

    await Promise.all([task(), task(), task(), task()])

    expect(maxActive).toBe(1)
  })

  it('releases the lock even if the holder throws', async () => {
    const lock = new AsyncLock()

    try {
      using _release = await lock.acquire()
      throw new Error('boom')
    } catch {
      // swallow; the `using` handle is disposed as the block unwinds
    }

    // A subsequent acquire must resolve (would hang if the lock leaked).
    using _release2 = await lock.acquire()
    expect(true).toBe(true)
  })
})
