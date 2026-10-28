/**
 * Invocation queueing for agents using `'queue'`, `'cancelPrevious'`, or `'stopPrevious'`
 * concurrency.
 */

import { PendingInvocationCancelledError } from '../errors.js'
import type { Message } from '../types/messages.js'

/** Supported values for the `concurrentInvocationMode` parameter. */
export const CONCURRENT_INVOCATION_MODES = ['throw', 'cancelPrevious', 'stopPrevious', 'queue'] as const

/**
 * Behavior when `invoke()` or `stream()` is called while an invocation is already in
 * progress. Set agent-wide via `concurrentInvocationMode`, or per call via
 * `InvokeOptions.ifBusy`.
 *
 * - `'throw'`: reject the new call with `ConcurrentInvocationError` (default).
 * - `'cancelPrevious'`: latest wins — cancel the running invocation, displace queued
 *   latest-wins predecessors, and run this call next.
 * - `'stopPrevious'`: latest wins, gracefully — the running invocation finishes its current
 *   step and stops with `stopReason: 'superseded'`; queued latest-wins predecessors are
 *   displaced and this call runs next.
 * - `'queue'`: wait FIFO; the call runs as its own invocation when the current one
 *   finishes.
 *
 * An interrupt response is never a latest-wins caller: it continues the interrupted request,
 * so it waits as `'queue'` whatever the mode and is handed the turn while the interrupt is open.
 */
export type ConcurrentInvocationMode = (typeof CONCURRENT_INVOCATION_MODES)[number]

/** Concurrency modes under which a busy-time call waits in the queue. */
export type PendingInvocationMode = Exclude<ConcurrentInvocationMode, 'throw'>

/** A call waiting for the agent's turn, as listed by `agent.pendingInvocations`. Read-only. */
export interface PendingInvocation {
  /** Stable identifier for the waiting call, unique per agent (a render key; no API takes it). */
  readonly id: string
  /** The mode the call waits under. A call carrying interrupt responses always waits as `'queue'`. */
  readonly mode: PendingInvocationMode
  /** When the call entered the queue. */
  readonly submittedAt: Date
  /**
   * The call's input, normalized for display. Each message keeps its `trackingId` when it
   * lands in the transcript, though middleware may still rewrite the content (empty for
   * interrupt-response and checkpoint-resume input).
   */
  readonly messages: readonly Message[]
}

interface QueueEntry extends PendingInvocation {
  /** Whether the call carries interrupt responses, so it may run while an interrupt awaits one. */
  readonly resumesInterrupt: boolean
  signal?: AbortSignal
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
}

/**
 * Validates a concurrency mode value at runtime so an unrecognized value from an untyped
 * (JS) caller fails loudly.
 *
 * @internal
 */
export function validateConcurrentInvocationMode(value: unknown, paramName: string): ConcurrentInvocationMode {
  if (!CONCURRENT_INVOCATION_MODES.includes(value as ConcurrentInvocationMode)) {
    throw new Error(
      `Unsupported ${paramName} value: ${JSON.stringify(value)}. Supported values: ${CONCURRENT_INVOCATION_MODES.map((mode) => `"${mode}"`).join(', ')}`
    )
  }
  return value as ConcurrentInvocationMode
}

/** Modes that take the turn from the running invocation and displace each other when queued. */
function isLatestWins(mode: PendingInvocationMode): boolean {
  return mode === 'cancelPrevious' || mode === 'stopPrevious'
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

  /** Point-in-time view of the queued calls, in run order. */
  list(): readonly PendingInvocation[] {
    return this._entries.map(({ id, mode, submittedAt, messages }) =>
      Object.freeze({ id, mode, submittedAt: new Date(submittedAt), messages: Object.freeze([...messages]) })
    )
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
   * Adds a waiter. The promise resolves when the invocation lock is handed to it (via
   * {@link handoff}), or rejects when the entry is removed first.
   *
   * @param options - `mode` selects the queue behavior: `'cancelPrevious'` and
   *   `'stopPrevious'` insert at the front and displace queued entries of either mode
   *   (they reject as cancelled); aborting `cancelSignal` while queued removes the entry
   *   and rejects with {@link PendingInvocationCancelledError}
   */
  wait(options: {
    mode: PendingInvocationMode
    messages: readonly Message[]
    resumesInterrupt: boolean
    cancelSignal?: AbortSignal
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        id: `pending-${this._nextSequence++}`,
        mode: options.mode,
        submittedAt: new Date(),
        messages: options.messages,
        resumesInterrupt: options.resumesInterrupt,
        resolve,
        reject,
        cleanup: () => {},
      }

      if (options.cancelSignal?.aborted) {
        reject(new PendingInvocationCancelledError())
        return
      }
      if (options.cancelSignal) {
        entry.signal = options.cancelSignal
        this._armAbort(entry)
      }

      if (isLatestWins(entry.mode)) {
        for (const displaced of this._entries.filter((queued) => isLatestWins(queued.mode))) this._remove(displaced)
        this._entries.unshift(entry)
      } else {
        this._entries.push(entry)
      }
      for (const listener of [...this._enqueueListeners]) listener()
    })
  }

  /**
   * Hands the invocation lock to the next waiter, if any.
   *
   * @returns `true` when a waiter took ownership, `false` when the queue is empty
   */
  handoff(): boolean {
    const next = this._entries.shift()
    if (!next) return false
    next.cleanup()
    next.resolve()
    return true
  }

  /**
   * Hands the invocation lock to the first queued call that carries interrupt responses,
   * if any — the only kind of call that may run while an interrupt awaits its answer.
   *
   * @returns `true` when such a waiter took ownership
   */
  handoffResume(): boolean {
    const index = this._entries.findIndex((queued) => queued.resumesInterrupt)
    if (index === -1) return false
    const [next] = this._entries.splice(index, 1)
    next!.cleanup()
    next!.resolve()
    return true
  }

  /**
   * Whether a queued `'stopPrevious'` caller is waiting for the running invocation to stop.
   * Relies on latest-wins entries being front-inserted and removed at {@link handoff}, so a
   * stop entry can never sit behind the invocation that currently holds the turn.
   */
  hasStopRequest(): boolean {
    return this._entries.some((queued) => queued.mode === 'stopPrevious')
  }

  private _armAbort(entry: QueueEntry): void {
    const signal = entry.signal!
    const onAbort = (): void => this._remove(entry)
    signal.addEventListener('abort', onAbort, { once: true })
    entry.cleanup = (): void => signal.removeEventListener('abort', onAbort)
  }

  private _remove(entry: QueueEntry): void {
    const index = this._entries.indexOf(entry)
    if (index === -1) return
    this._entries.splice(index, 1)
    entry.cleanup()
    entry.reject(new PendingInvocationCancelledError())
  }
}
