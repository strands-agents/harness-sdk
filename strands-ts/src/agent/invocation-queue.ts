/**
 * Invocation queueing for agents using `'enqueue'` or `'cancelPrevious'` concurrency.
 */

import { PendingInvocationCancelledError } from '../errors.js'
import type { InvokeArgs } from '../types/agent.js'

/** Supported values for the `concurrentInvocationMode` parameter. */
export const CONCURRENT_INVOCATION_MODES = ['throw', 'enqueue', 'cancelPrevious'] as const

/**
 * Behavior when `invoke()` or `stream()` is called while an invocation is already in
 * progress. Set agent-wide via `concurrentInvocationMode`, or per call via
 * `InvokeOptions.ifBusy`.
 *
 * - `'throw'`: reject the new call with `ConcurrentInvocationError` (default).
 * - `'enqueue'`: queue the new call FIFO; it runs as its own invocation when the
 *   current one finishes.
 * - `'cancelPrevious'`: cancel the running invocation via `agent.cancel()` and run
 *   this call next, ahead of any queued invocations.
 */
export type ConcurrentInvocationMode = (typeof CONCURRENT_INVOCATION_MODES)[number]

/** A queued invocation, as surfaced by `agent.pendingInvocations`. */
export interface PendingInvocation {
  /** Queue-unique identifier, usable with `agent.cancelPending(id)`. */
  readonly id: string
  /** When the call entered the queue. */
  readonly submittedAt: Date
  /** Short text preview of the call's input. */
  readonly preview: string
}

interface QueueEntry extends PendingInvocation {
  supersedes: boolean
  resolve: () => void
  reject: (error: Error) => void
  cleanup: () => void
}

const PREVIEW_MAX_CHARS = 500

function truncatePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const codePoints = [...collapsed]
  return codePoints.length <= PREVIEW_MAX_CHARS ? collapsed : `${codePoints.slice(0, PREVIEW_MAX_CHARS).join('')}\u2026`
}

function textOf(element: unknown): string[] {
  if (typeof element !== 'object' || element === null) return []
  if ('text' in element && typeof element.text === 'string') return [element.text]
  if ('content' in element && Array.isArray(element.content)) return element.content.flatMap(textOf)
  return []
}

/** Derives a short preview from invocation arguments. */
export function previewInvokeArgs(args: InvokeArgs): string {
  if (typeof args === 'string') return truncatePreview(args)
  if (Array.isArray(args)) {
    const text = args.flatMap(textOf).join(' ').trim()
    if (text.length > 0) return truncatePreview(text)
  }
  return '[structured input]'
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
    return this._entries.map(({ id, submittedAt, preview }) => Object.freeze({ id, submittedAt, preview }))
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
   * Adds a waiter and returns a promise that resolves when the invocation lock is
   * handed to it (via {@link handoff}), or rejects when the entry is removed first.
   *
   * @param args - The invocation arguments, used to derive the entry's preview
   * @param options - `supersede` inserts at the front of the queue and displaces any
   *   queued superseding entries (they reject as cancelled); aborting `cancelSignal`
   *   while queued removes the entry and rejects with
   *   {@link PendingInvocationCancelledError}
   */
  wait(args: InvokeArgs, options?: { supersede?: boolean; cancelSignal?: AbortSignal }): Promise<void> {
    const id = `pending-${this._nextSequence++}`
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        id,
        submittedAt: new Date(),
        preview: previewInvokeArgs(args),
        supersedes: options?.supersede === true,
        resolve,
        reject,
        cleanup: () => {},
      }

      const signal = options?.cancelSignal
      if (signal) {
        if (signal.aborted) {
          reject(new PendingInvocationCancelledError(id))
          return
        }
        const onAbort = (): void => this._remove(entry)
        signal.addEventListener('abort', onAbort, { once: true })
        entry.cleanup = (): void => signal.removeEventListener('abort', onAbort)
      }

      if (entry.supersedes) {
        for (const displaced of this._entries.filter((e) => e.supersedes)) this._remove(displaced)
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
