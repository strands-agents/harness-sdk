import type { SpanContext } from '@opentelemetry/api'
import { context, trace } from '@opentelemetry/api'
import type { MemoryStore } from '../types.js'
import type { MessageData, ContentBlockData } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import { logger } from '../../logging/logger.js'
import { normalizeError } from '../../errors.js'
import type { Tracer } from '../../telemetry/tracer.js'
import type { MemoryMessageFilter } from './types.js'
import type { ResolvedExtractionConfig } from './resolve-extraction-config.js'

/**
 * A store paired with its fully-resolved extraction config.
 * @internal
 */
export interface ExtractionBinding {
  /** The memory store to extract into. */
  store: MemoryStore
  /** The store's fully-resolved extraction config (triggers, extractor, filter). */
  config: ResolvedExtractionConfig
}

/**
 * Number of consecutive save failures after which a store backs off (stops trying every turn).
 * @internal
 */
export const SAVE_FAILURES_BEFORE_BACKOFF = 10

/**
 * While backed off, a store retries only once every this many save attempts (a probe).
 * @internal
 */
export const BACKOFF_PROBE_INTERVAL = 3

/** A buffered message and its sequence number. */
interface BufferedMessage {
  seq: number
  message: MessageData
}

/** The kind of a content block (e.g. 'text', 'toolUse'), used to match it against a filter. */
function _blockKind(block: ContentBlockData): string {
  // A text block is `{ text: string }`; every other block is a single-key wrapper (`{ toolUse }`, …).
  if ('text' in block) return 'text'
  return Object.keys(block)[0] ?? ''
}

/**
 * Removes excluded content blocks, and drops any message left empty. Does not mutate the input.
 * Carries each message's sequence number through so it stays aligned with the filtered batch.
 */
function _filterMessages(buffered: BufferedMessage[], filter: MemoryMessageFilter): BufferedMessage[] {
  const exclude = new Set<string>(filter.exclude)
  const result: BufferedMessage[] = []
  for (const { seq, message } of buffered) {
    const content = message.content.filter((block) => !exclude.has(_blockKind(block)))
    if (content.length > 0) {
      result.push({
        seq,
        message: {
          role: message.role,
          content,
          ...(message.metadata !== undefined && { metadata: message.metadata }),
        },
      })
    }
  }
  return result
}

/**
 * Saves conversation messages to memory stores, in the background, without slowing the agent down.
 *
 * How it works, in three pieces:
 *
 * 1. **The buffer.** Every message the agent produces is copied into one shared list (`_pending`).
 *    Each gets a number (`seq`) that only ever counts up, so we can tell which messages are newer.
 *    We keep our own copy here (rather than reading the agent's live message list) because the agent
 *    can delete old messages to stay within its context window; our copy means we never lose one
 *    before it's saved.
 *
 * 2. **Per-store progress.** Each store can save at its own pace, so we remember, per store, the
 *    `seq` of the last message it has already saved (`_marks`). When a store saves, it only looks at
 *    messages newer than that number, so the same message is never saved twice to the same store.
 *
 * 3. **One save at a time per store.** A store might be asked to save again while a previous save is
 *    still running. We chain each store's saves one after another (`_chains`) so they can't overlap
 *    or run out of order.
 *
 * If a store fails to save {@link SAVE_FAILURES_BEFORE_BACKOFF} times in a row, it backs off: instead
 * of trying every turn, it retries only once every {@link BACKOFF_PROBE_INTERVAL} attempts (a probe).
 * A successful probe clears the failure streak and resumes normal saving - so a transient outage
 * recovers on its own and the messages buffered during it are saved once the store comes back. A
 * permanently broken store keeps probing and logs an error each time, surfacing the misconfiguration.
 *
 * Saving itself either runs the store's extractor to pull out facts, or hands the raw messages to the
 * store - see {@link _write}.
 * @internal
 */
export class ExtractionCoordinator {
  private readonly _stores: MemoryStore[]
  /** Per store: its resolved extraction config (triggers, extractor, filter). */
  private readonly _storeToExtractionConfig = new Map<MemoryStore, ResolvedExtractionConfig>()
  private readonly _defaultModel: Model
  private readonly _tracer: Tracer
  /** The shared list of messages waiting to be saved, oldest first. Each is tagged with its `seq`. */
  private _pending: BufferedMessage[] = []
  /** The number to give the next message added to the buffer. Only ever increases. */
  private _nextSeq = 0
  /** Per store: the `seq` of the last message that store has already saved. Starts at -1 (saved none). */
  private readonly _marks = new Map<MemoryStore, number>()
  /** Per store: a promise for that store's currently-running save, so the next save waits its turn. */
  private readonly _chains = new Map<MemoryStore, Promise<void>>()
  /** Per store: how many saves have failed in a row. Reset to 0 on a successful save. */
  private readonly _consecutiveFailures = new Map<MemoryStore, number>()
  /** Per store: while backed off, counts save requests so we can let every Nth through as a probe. */
  private readonly _backoffCounters = new Map<MemoryStore, number>()

  /**
   * @param stores - The extraction-configured stores this coordinator manages, each with its resolved config
   * @param defaultModel - Model for extractors that don't configure their own (`agent.auxModel > agent.model`)
   * @param tracer - Tracer for extraction spans, shared with the {@link MemoryManager}
   */
  constructor(stores: ExtractionBinding[], defaultModel: Model, tracer: Tracer) {
    this._stores = stores.map((s) => s.store)
    this._defaultModel = defaultModel
    this._tracer = tracer
    for (const { store, config } of stores) {
      this._storeToExtractionConfig.set(store, config)
      this._marks.set(store, -1)
    }
  }

  /** Adds a message to the buffer. */
  record(message: MessageData): void {
    this._pending.push({ seq: this._nextSeq++, message })
  }

  /**
   * Saves this store's unsaved messages, in the background. Queued behind the store's previous save so
   * two never run at once. Failures are logged and swallowed - saving must never break the agent loop.
   * The returned promise is for {@link flush}; callers (triggers) ignore it so they don't block.
   */
  process(store: MemoryStore): Promise<void> {
    if (!this._shouldAttempt(store)) {
      return Promise.resolve()
    }
    // Capture the agent span synchronously: this runs inside the live agent span (via the trigger
    // hook), but the save itself runs detached after that span may have ended.
    const linkContext = this._tracer.currentSpanContext()
    return this._enqueue(store, linkContext)
  }

  /** Queues a save for the store behind its previous one, so saves never overlap or reorder. */
  private _enqueue(store: MemoryStore, linkContext?: SpanContext): Promise<void> {
    const previous = this._chains.get(store) ?? Promise.resolve()
    const next = previous.then(() => this._extract(store, linkContext))
    this._chains.set(store, next)
    return next
  }

  /**
   * Whether to attempt a save now. A healthy store always attempts. A backed-off store (too many
   * failures in a row) attempts only once every {@link BACKOFF_PROBE_INTERVAL} requests - a probe to
   * see if it has recovered - and skips the rest.
   */
  private _shouldAttempt(store: MemoryStore): boolean {
    if ((this._consecutiveFailures.get(store) ?? 0) < SAVE_FAILURES_BEFORE_BACKOFF) {
      return true
    }
    const count = (this._backoffCounters.get(store) ?? 0) + 1
    this._backoffCounters.set(store, count)
    return count % BACKOFF_PROBE_INTERVAL === 0
  }

  /**
   * Saves every store's remaining messages and waits for all saves to finish. Call this once at a
   * boundary you control - typically app shutdown - to make sure nothing in the buffer is lost.
   *
   * It first tells every store to save (even one whose trigger hasn't fired this turn, or one that is
   * backed off - flush bypasses backoff so a recovered store still writes its backlog); stores with
   * nothing to save do nothing. Then it waits, re-checking until no new save has started, so saves
   * that begin while we're waiting are also covered.
   */
  async flush(): Promise<void> {
    for (const store of this._stores) {
      void this._enqueue(store)
    }
    for (;;) {
      const inFlight = [...this._chains.values()]
      await Promise.all(inFlight)
      // If nothing new started while we waited, everything is done.
      if (this._chains.size === inFlight.length && [...this._chains.values()].every((p, i) => p === inFlight[i])) {
        return
      }
    }
  }

  private async _extract(store: MemoryStore, linkContext?: SpanContext): Promise<void> {
    const mark = this._marks.get(store) ?? -1
    const fresh = this._pending.filter((buffered) => buffered.seq > mark)
    if (fresh.length === 0) {
      return
    }

    // Mark these messages as saved before we start saving, so a queued save behind this one won't
    // pick them up again. If the save fails we put the mark back (below) and they retry.
    const highestSeq = fresh[fresh.length - 1]!.seq
    this._marks.set(store, highestSeq)

    const config = this._storeToExtractionConfig.get(store)!
    const filtered = _filterMessages(fresh, config.filter)

    const span = this._tracer.startMemoryExtractSpan({
      storeName: store.name,
      messageCount: filtered.length,
      filteredCount: fresh.length - filtered.length,
      ...(config.extractor && { extractor: config.extractor.constructor.name }),
      ...(linkContext && { agentSpanContext: linkContext }),
    })

    let saveError: unknown
    let entryCount = 0
    try {
      if (filtered.length > 0) {
        // Set the extract span active so the model-extractor's invoke span parents under it.
        const write = (): Promise<number> => this._write(store, filtered)
        entryCount = span ? await context.with(trace.setSpan(context.active(), span), write) : await write()
        // A successful write clears the failure streak and ends any backoff. Only a real write counts
        // as recovery - a fully-filtered (empty) turn never touched the backend, so it leaves backoff
        // state untouched (it still advances the mark above; those messages had nothing to save).
        this._consecutiveFailures.set(store, 0)
        this._backoffCounters.delete(store)
      }
    } catch (err) {
      saveError = err
      this._onSaveFailed(store, mark, err)
    } finally {
      this._trim()
    }

    // End the span after the save resolves and best-effort, so span bookkeeping is decoupled from the
    // save outcome and can never break this detached background task.
    try {
      if (saveError === undefined) {
        this._tracer.endMemoryExtractSpan(span, { entryCount })
      } else {
        this._tracer.endMemoryExtractSpan(span, { error: normalizeError(saveError) })
      }
    } catch (err) {
      logger.debug(`store=<${store.name}>, reason=<${normalizeError(err).message}> | memory extract span end failed`)
    }
  }

  /**
   * Handles a failed save. Puts the mark back so the messages retry next time. Once a store has failed
   * {@link SAVE_FAILURES_BEFORE_BACKOFF} times in a row it logs an error and enters backoff (it then
   * retries only on probes - see {@link _shouldAttempt}); before that it logs a warning. The messages
   * stay buffered either way, so a store that recovers saves them.
   */
  private _onSaveFailed(store: MemoryStore, markBeforeSave: number, err: unknown): void {
    const failures = (this._consecutiveFailures.get(store) ?? 0) + 1
    this._consecutiveFailures.set(store, failures)
    this._marks.set(store, markBeforeSave)
    const reason = normalizeError(err).message

    if (failures >= SAVE_FAILURES_BEFORE_BACKOFF) {
      logger.error(
        `store=<${store.name}>, failures=<${failures}>, reason=<${reason}> | memory store save failing repeatedly`
      )
    } else {
      logger.warn(`store=<${store.name}>, reason=<${reason}> | memory extraction failed`)
    }
  }

  /**
   * Saves the messages to the store, one of two ways:
   * - store has an extractor: run it to pull out facts, then write each fact via `add`.
   * - no extractor: hand the raw messages to `addMessages` so the store keeps their roles.
   *
   * Fact writes run in parallel. If any fails we throw, which makes the caller retry the whole batch
   * next time - so a fact that already saved may be written again (stores should expect duplicates).
   *
   * @returns The number of entries written (extracted facts, or raw messages).
   */
  private async _write(store: MemoryStore, buffered: BufferedMessage[]): Promise<number> {
    const extractor = this._storeToExtractionConfig.get(store)!.extractor
    const messages = buffered.map((buffer) => buffer.message)

    if (extractor) {
      const entries = await extractor.extract(messages, {
        defaultModel: this._defaultModel,
        tracer: this._tracer,
      })
      const settled = await Promise.allSettled(entries.map((entry) => store.add!(entry.content, entry.metadata)))
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          `failed to write ${failures.length} of ${entries.length} extracted entries`
        )
      }
      return entries.length
    }

    // Pass each message's sequence number so a store can build an idempotency key surviving retries.
    await store.addMessages!(messages, { sequenceNumbers: buffered.map((buffer) => buffer.seq) })
    return messages.length
  }

  /**
   * Removes messages from the buffer once every store has saved them (so none still needs them).
   *
   * A store that hasn't saved a message yet - because its trigger hasn't fired, or it's failing and
   * waiting to recover - keeps that message buffered. So a store stuck failing for good slowly grows
   * the buffer; that surfaces as repeated error logs and is bounded by the (non-persisted) session.
   */
  private _trim(): void {
    let minMark = Infinity
    for (const store of this._stores) {
      minMark = Math.min(minMark, this._marks.get(store) ?? -1)
    }
    if (minMark === Infinity) {
      return
    }
    this._pending = this._pending.filter((buffered) => buffered.seq > minMark)
  }
}
