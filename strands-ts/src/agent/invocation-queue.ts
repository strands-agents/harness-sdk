/**
 * Invocation queueing for agents using `'queue'`, `'cancelPrevious'`, or `'inject'`
 * concurrency.
 */

import { PendingInvocationCancelledError } from '../errors.js'
import type { AgentResult, InvokeArgs } from '../types/agent.js'

/** Supported values for the `concurrentInvocationMode` parameter. */
export const CONCURRENT_INVOCATION_MODES = ['throw', 'cancelPrevious', 'queue', 'inject'] as const

/**
 * Behavior when `invoke()` or `stream()` is called while an invocation is already in
 * progress. Set agent-wide via `concurrentInvocationMode`, or per call via
 * `InvokeOptions.ifBusy`.
 *
 * - `'throw'`: reject the new call with `ConcurrentInvocationError` (default).
 * - `'cancelPrevious'`: latest wins — cancel the running invocation, displace queued
 *   `'cancelPrevious'` predecessors, and run this call next.
 * - `'queue'`: wait FIFO; the call runs as its own invocation when the current one
 *   finishes.
 * - `'inject'`: join the running invocation — the input is added to the conversation
 *   before its next model request, and the call resolves with that invocation's result.
 */
export type ConcurrentInvocationMode = (typeof CONCURRENT_INVOCATION_MODES)[number]

/** Concurrency modes under which a busy-time call waits in the queue. */
export type PendingInvocationMode = Exclude<ConcurrentInvocationMode, 'throw'>

/** A queued invocation, as surfaced by `agent.pendingInvocations`. */
export interface PendingInvocation {
  /** Queue-unique identifier, usable with `agent.cancelPending(id)`. */
  readonly id: string
  /** When the call entered the queue. */
  readonly submittedAt: Date
  /**
   * How the call will be handled once the agent is free. An `'inject'` call that missed
   * the invocation it meant to join is reported as `'queue'`.
   */
  readonly mode: PendingInvocationMode
}

/** A pending `'inject'` call removed from the queue by the running invocation. */
export interface InjectedInvocation {
  readonly id: string
  readonly args: InvokeArgs
  /** Settles the caller with the absorbing invocation's result. */
  readonly resolve: (result: AgentResult) => void
  /** Settles the caller with the absorbing invocation's error. */
  readonly reject: (error: Error) => void
  /**
   * Returns the call to the front of the queue as a `'queue'` entry, so it runs as its
   * own invocation once the turn is released. Used when the absorbing invocation ends
   * before the input reached the model. A call whose `cancelSignal` aborted meanwhile
   * rejects instead.
   */
  readonly requeue: () => void
}

interface QueueEntry extends PendingInvocation {
  mode: PendingInvocationMode
  args: InvokeArgs
  signal?: AbortSignal
  resolve: (absorbed?: AgentResult) => void
  reject: (error: Error) => void
  cleanup: () => void
}

/**
 * FIFO queue of invocations waiting for the agent's invocation lock. All mutating
 * methods are synchronous, so no interleaving can observe a half-applied transition.
 *
 * @internal
 */
export class InvocationQueue {
  private readonly _entries: QueueEntry[] = []
  private _nextSequence = 1
  private readonly _enqueueListeners = new Set<() => void>()

  get size(): number {
    return this._entries.length
  }

  /** Immutable view of the queued entries, in run order. */
  list(): readonly PendingInvocation[] {
    return this._entries.map(({ id, submittedAt, mode }) => Object.freeze({ id, submittedAt, mode }))
  }

  /**
   * Registers a listener invoked whenever an invocation enters the queue.
   *
   * @returns A function that detaches the listener
   */
  onEnqueue(listener: () => void): () => void {
    this._enqueueListeners.add(listener)
    return (): void => {
      this._enqueueListeners.delete(listener)
    }
  }

  /**
   * Adds a waiter. The promise resolves with `undefined` when the invocation lock is
   * handed to it (via {@link handoff}), with the absorbing invocation's result when an
   * `'inject'` entry is taken by the running invocation (via {@link takeInjects}), or
   * rejects when the entry is removed first.
   *
   * @param args - The invocation arguments
   * @param options - `mode` selects the queue behavior: `'cancelPrevious'` inserts at
   *   the front and displaces queued `'cancelPrevious'` entries (they reject as
   *   cancelled); aborting `cancelSignal` while queued removes the entry and rejects
   *   with {@link PendingInvocationCancelledError}
   */
  wait(
    args: InvokeArgs,
    options: { mode: PendingInvocationMode; cancelSignal?: AbortSignal }
  ): Promise<AgentResult | undefined> {
    const id = `pending-${this._nextSequence++}`
    return new Promise<AgentResult | undefined>((resolve, reject) => {
      const entry: QueueEntry = {
        id,
        submittedAt: new Date(),
        mode: options.mode,
        args,
        resolve,
        reject,
        cleanup: () => {},
      }

      if (options.cancelSignal?.aborted) {
        reject(new PendingInvocationCancelledError(id))
        return
      }
      if (options.cancelSignal) {
        entry.signal = options.cancelSignal
        this._armAbort(entry)
      }

      if (entry.mode === 'cancelPrevious') {
        for (const displaced of this._entries.filter((e) => e.mode === 'cancelPrevious')) this._remove(displaced)
        this._entries.unshift(entry)
      } else {
        this._entries.push(entry)
      }
      for (const listener of [...this._enqueueListeners]) listener()
    })
  }

  /**
   * Hands the invocation lock to the next waiter, if any. `'inject'` entries still
   * queued here missed the invocation they meant to join: they become `'queue'` entries
   * and run as their own invocations rather than joining the next turn owner.
   *
   * @returns `true` when a waiter took ownership, `false` when the queue is empty
   */
  handoff(): boolean {
    const next = this._entries.shift()
    if (!next) return false
    for (const entry of this._entries) {
      if (entry.mode === 'inject') entry.mode = 'queue'
    }
    next.cleanup()
    next.resolve()
    return true
  }

  /**
   * Removes every queued `'inject'` entry, in submission order, for the running
   * invocation to absorb. Their callers settle via the returned handles.
   */
  takeInjects(): InjectedInvocation[] {
    const injects = this._entries.filter((entry) => entry.mode === 'inject')
    for (const entry of injects) {
      this._entries.splice(this._entries.indexOf(entry), 1)
      entry.cleanup()
    }
    return injects.map((entry) => ({
      id: entry.id,
      args: entry.args,
      resolve: entry.resolve,
      reject: entry.reject,
      requeue: (): void => {
        if (entry.signal?.aborted) {
          entry.reject(new PendingInvocationCancelledError(entry.id))
          return
        }
        entry.mode = 'queue'
        if (entry.signal) this._armAbort(entry)
        this._entries.unshift(entry)
      },
    }))
  }

  private _armAbort(entry: QueueEntry): void {
    const signal = entry.signal!
    const onAbort = (): void => this._remove(entry)
    signal.addEventListener('abort', onAbort, { once: true })
    entry.cleanup = (): void => signal.removeEventListener('abort', onAbort)
  }

  /**
   * Removes a queued entry by id, rejecting its caller with
   * {@link PendingInvocationCancelledError}.
   *
   * @returns `true` when the entry was found and removed
   */
  cancel(id: string): boolean {
    const entry = this._entries.find((e) => e.id === id)
    if (!entry) return false
    this._remove(entry)
    return true
  }

  private _remove(entry: QueueEntry): void {
    const index = this._entries.indexOf(entry)
    if (index === -1) return
    this._entries.splice(index, 1)
    entry.cleanup()
    entry.reject(new PendingInvocationCancelledError(entry.id))
  }
}
