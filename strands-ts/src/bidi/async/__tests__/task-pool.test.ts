/**
 * Unit tests for the bidirectional task pool.
 */

import { describe, expect, it } from 'vitest'
import { TaskPool } from '../task-pool.js'

/** Resolve once the task that aborts on `signal` has settled. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('TaskPool', () => {
  describe('size', () => {
    it('starts empty', () => {
      expect(new TaskPool().size).toBe(0)
    })
  })

  describe('create', () => {
    it('tracks a task until it settles', async () => {
      const pool = new TaskPool()
      let release: () => void = () => {}
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })

      const task = pool.create(async () => {
        await blocked
      })
      expect(pool.size).toBe(1)

      release()
      await task
      // The pool drops the task in a callback chained onto it, so it clears a tick later.
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(pool.size).toBe(0)
    })
  })

  describe('cancel', () => {
    it('cancels its tasks and empties the pool', async () => {
      const pool = new TaskPool()
      let settled = false

      const task = pool.create(async (signal) => {
        await waitForAbort(signal)
        settled = true
      })

      await pool.cancel()

      expect(pool.size).toBe(0)
      await task
      expect(settled).toBe(true)
    })
  })
})
