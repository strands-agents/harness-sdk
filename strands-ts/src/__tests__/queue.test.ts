import { beforeEach, describe, expect, it } from 'vitest'
import { Queue } from '../queue.js'

describe('Queue', () => {
  let queue: Queue<{ value: string }>

  beforeEach(() => {
    queue = new Queue<{ value: string }>()
  })

  describe('push and shift', () => {
    it('dequeues in FIFO order', () => {
      const data1 = { value: 'first' }
      const data2 = { value: 'second' }

      queue.push(data1)
      queue.push(data2)

      expect(queue.shift()?.data).toBe(data1)
      expect(queue.shift()?.data).toBe(data2)
    })

    it('returns undefined when empty', () => {
      expect(queue.shift()).toBeUndefined()
    })

    it('provides a no-op ack for fire-and-forget pushes', () => {
      queue.push({ value: 'a' })
      const entry = queue.shift()!
      expect(() => entry.ack()).not.toThrow()
    })
  })

  describe('send', () => {
    it('resolves when consumer calls ack', async () => {
      const data = { value: 'a' }
      let resolved = false

      const waiting = queue.send(data).then(() => {
        resolved = true
      })

      await Promise.resolve()
      expect(resolved).toBe(false)

      const entry = queue.shift()!
      expect(entry.data).toBe(data)

      await Promise.resolve()
      expect(resolved).toBe(false)

      entry.ack()
      await waiting
      expect(resolved).toBe(true)
    })
  })

  describe('size', () => {
    it('reflects the current number of entries', () => {
      expect(queue.size).toBe(0)

      queue.push({ value: 'a' })
      queue.push({ value: 'b' })
      expect(queue.size).toBe(2)

      queue.shift()
      expect(queue.size).toBe(1)
    })
  })

  describe('wait', () => {
    it('resolves immediately when entries are available', async () => {
      queue.push({ value: 'a' })

      await queue.wait()

      expect(queue.size).toBe(1)
    })

    it('blocks until data is pushed', async () => {
      let resolved = false

      const waiting = queue.wait().then(() => {
        resolved = true
      })

      await Promise.resolve()
      expect(resolved).toBe(false)

      queue.push({ value: 'a' })

      await waiting
      expect(resolved).toBe(true)
    })

    it('blocks until data is sent', async () => {
      let resolved = false

      const waiting = queue.wait().then(() => {
        resolved = true
      })

      await Promise.resolve()
      expect(resolved).toBe(false)

      // Don't await send — it won't resolve until ack
      const sending = queue.send({ value: 'a' })

      await waiting
      expect(resolved).toBe(true)

      // Clean up: ack so send resolves
      queue.shift()!.ack()
      await sending
    })
  })

  describe('dispose', () => {
    it('resolves pending send acks and drains entries', async () => {
      let resolved = false
      const sending = queue.send({ value: 'a' }).then(() => {
        resolved = true
      })

      await Promise.resolve()
      expect(resolved).toBe(false)
      expect(queue.size).toBe(1)

      queue.dispose()

      await sending
      expect(resolved).toBe(true)
      expect(queue.size).toBe(0)
    })

    it('causes future send calls to resolve immediately', async () => {
      queue.dispose()

      await queue.send({ value: 'a' })

      expect(queue.size).toBe(0)
    })
  })
})
