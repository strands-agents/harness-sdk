/**
 * Unit tests for the bidirectional task group.
 */

import { describe, expect, it, vi } from 'vitest'
import { TaskGroup } from '../task-group.js'
import { CancelledError } from '../../../errors.js'

/** A promise plus its resolver, the analog of Python's `asyncio.Event`. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((resolveFn) => {
    resolve = resolveFn
  })
  return { promise, resolve }
}

/** Resolve once the task that aborts on `signal` has settled. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

describe('TaskGroup', () => {
  describe('join', () => {
    it('runs every task to completion', async () => {
      const task = vi.fn(async () => {})
      const group = new TaskGroup()

      group.createTask(task)
      await group.join()

      expect(task).toHaveBeenCalledOnce()
    })

    it('propagates a task failure and cancels its siblings', async () => {
      const group = new TaskGroup()
      let waitCancelled = false

      const waitTask = group.createTask(async (signal) => {
        await waitForAbort(signal)
        waitCancelled = signal.aborted
      })
      const failTask = group.createTask(async () => {
        throw new Error('test error')
      })

      await expect(group.join()).rejects.toThrow('test error')
      await Promise.all([waitTask, failTask])
      expect(waitCancelled).toBe(true)
    })

    it('ignores a task that cancels itself', async () => {
      const group = new TaskGroup()

      group.createTask(async () => {
        throw new CancelledError()
      })

      await expect(group.join()).resolves.toBeUndefined()
    })
  })

  describe('cancel', () => {
    it('cancels its tasks and reports the cancellation to join', async () => {
      const blocked = deferred()
      const group = new TaskGroup()
      let observedAbort = false

      group.createTask(async (signal) => {
        await Promise.race([blocked.promise, waitForAbort(signal)])
        observedAbort = signal.aborted
      })

      await group.cancel()

      expect(observedAbort).toBe(true)
      await expect(group.join()).rejects.toBeInstanceOf(CancelledError)
      blocked.resolve()
    })
  })
})
