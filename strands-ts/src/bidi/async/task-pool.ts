/**
 * Manage a pool of active async tasks.
 *
 * This is particularly useful for cancelling multiple tasks at once. Cancellation is cooperative
 * — tasks receive the pool's {@link AbortSignal} and are expected to settle once it aborts.
 *
 * @internal
 */

import { isCancellation } from './cancellation.js'

/** A unit of work managed by a {@link TaskPool}; receives the pool's cancellation signal. */
export type TaskPoolTask = (signal: AbortSignal) => Promise<void>

/**
 * Tracks active tasks so they can all be cancelled together.
 *
 * @internal
 */
export class TaskPool {
  private readonly _controller = new AbortController()
  private readonly _tasks = new Set<Promise<void>>()

  /** Number of active tasks. */
  get size(): number {
    return this._tasks.size
  }

  /**
   * Start a task and add it to the pool.
   *
   * The task is removed from the pool once it settles.
   *
   * @param task - Work to run with the pool's cancellation signal
   * @returns A promise that settles when the task settles
   */
  create(task: TaskPoolTask): Promise<void> {
    const pending = task(this._controller.signal)

    this._tasks.add(pending)
    void pending.catch(() => {}).finally(() => this._tasks.delete(pending))
    return pending
  }

  /**
   * Cancel all active tasks in the pool and wait for them to settle.
   *
   * @throws The first non-cancellation failure raised by a task
   */
  async cancel(): Promise<void> {
    this._controller.abort()

    const pending = [...this._tasks]
    this._tasks.clear()

    const results = await Promise.allSettled(pending)
    for (const result of results) {
      if (result.status === 'rejected' && !isCancellation(result.reason)) {
        throw result.reason
      }
    }
  }
}
