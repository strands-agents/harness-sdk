/**
 * Manage a group of async tasks.
 *
 * This mirrors the structured concurrency of Python's `asyncio.TaskGroup`: tasks run
 * concurrently, the first failure cancels the siblings, and the failure propagates to the
 * caller. Cancellation is cooperative — tasks receive the group's {@link AbortSignal} and are
 * expected to settle once it aborts.
 *
 * @internal
 */

import { CancelledError } from '../../errors.js'
import { isCancellation } from './cancellation.js'

/** A unit of work managed by a {@link TaskGroup}; receives the group's cancellation signal. */
export type TaskGroupTask = (signal: AbortSignal) => Promise<void>

/**
 * Runs tasks concurrently and cancels the remaining ones as soon as any task fails.
 *
 * @internal
 */
export class TaskGroup {
  private readonly _controller = new AbortController()
  private readonly _tasks = new Set<Promise<void>>()
  private _cancelled = false
  private _failure: unknown

  /** Signal that aborts when a task fails or the group is cancelled. */
  get signal(): AbortSignal {
    return this._controller.signal
  }

  /**
   * Start a task and add it to the group.
   *
   * A failure is recorded and aborts the group's signal; the returned promise never rejects, so
   * failures surface only through {@link join}.
   *
   * @param task - Work to run with the group's cancellation signal
   * @returns A promise that settles when the task settles
   */
  createTask(task: TaskGroupTask): Promise<void> {
    const pending = task(this._controller.signal).catch((error: unknown) => {
      if (isCancellation(error)) return
      if (this._failure === undefined) {
        this._failure = error
      }
      this._controller.abort()
    })

    this._tasks.add(pending)
    void pending.finally(() => this._tasks.delete(pending))
    return pending
  }

  /**
   * Wait for every task in the group, cancelling the rest if one fails.
   *
   * @throws The first task failure, or {@link CancelledError} if the group was cancelled
   */
  async join(): Promise<void> {
    while (this._tasks.size > 0) {
      await Promise.all([...this._tasks])
    }

    if (this._cancelled) {
      throw new CancelledError()
    }
    if (this._failure !== undefined) {
      throw this._failure
    }
  }

  /**
   * Cancel every task in the group and wait for them to settle.
   *
   * A later {@link join} rejects with {@link CancelledError}, matching the caller-cancelled path
   * of a structured task group.
   */
  async cancel(): Promise<void> {
    this._cancelled = true
    this._controller.abort()

    while (this._tasks.size > 0) {
      await Promise.all([...this._tasks])
    }
  }
}
