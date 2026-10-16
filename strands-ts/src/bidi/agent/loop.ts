/**
 * Concurrent loop driving a bidirectional model connection.
 *
 * The loop handles the events received from the model and executes tools when given a tool use
 * request.
 *
 * @internal
 */

import { logger } from '../../logging/logger.js'
import { Queue } from '../../queue.js'
import { InterruptError } from '../../interrupt.js'
import { Message, TextBlock, ToolResultBlock } from '../../types/messages.js'
import { Tracer } from '../../telemetry/tracer.js'
import { TaskGroup } from '../async/task-group.js'
import { TaskPool } from '../async/task-pool.js'
import { stopAll } from '../async/stop-all.js'
import { MessageAddedEvent } from '../../hooks/events.js'
import {
  BidiAfterConnectionRestartEvent,
  BidiAgentStopEvent,
  BidiBargeInEvent as BidiBargeInHookEvent,
  BidiBeforeConnectionRestartEvent,
  BidiResponseStopEvent as BidiResponseStopHookEvent,
} from '../hooks/events.js'
import { ConnectionTimeoutError, isRestartable } from '../models/model.js'
import { BidiConnectionRestartEvent, BidiConnectionStopEvent, BidiConnectionWarningEvent } from '../types/events.js'
import {
  addBargeInEvent,
  endConnectionSpan,
  endResponseSpan,
  endRestartSpan,
  endSessionSpan,
  startConnectionSpan,
  startResponseSpan,
  startRestartSpan,
  startSessionSpan,
} from '../telemetry.js'
import { StreamedReasoningBlock, StreamedTextBlock, StreamedTranscriptBlock } from './blocks.js'
import { RestartTimer, resolveDeadlineMs } from './restart-timer.js'

import type { Span } from '@opentelemetry/api'
import type { InvocationState } from '../../types/agent.js'
import type { ToolUseBlock } from '../../types/messages.js'
import type { ToolSpec } from '../../tools/types.js'
import type { BidiMessage, BidiToolMetadata } from '../types/content.js'
import type { BidiModelStartOptions } from '../models/model.js'
import type { AudioDelta } from '../types/media.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { BidiAgent } from './agent.js'

/** Bound on awaiting a superseded reader after its stream is closed before cancelling it. */
const MODEL_RESTART_STOP_TIMEOUT_S = 2

/** Fixed advance notice, in milliseconds before a scheduled restart, for the warning event. */
const MODEL_RESTART_WARNING_MS = 10_000

/** Max seconds a proactive restart waits for a turn boundary before forcing the swap. */
const MODEL_RESTART_TURN_TIMEOUT_S = 10

/** Placeholder recorded in history while a dispatched tool call is still running. */
const TOOL_DISPATCH_PLACEHOLDER = 'Tool call started. Its result will follow in a separate tool exchange.'

/**
 * A model-reader error tagged with the connection generation it was raised on.
 *
 * `receive()` uses the tag to drop the error if the connection was superseded before it was
 * consumed.
 *
 * @internal
 */
class ReaderError {
  /** Connection generation the error was raised on. */
  readonly generation: number

  /** The failure raised by the reader. */
  readonly error: unknown

  /**
   * @param generation - Connection generation the error was raised on.
   * @param error - The failure raised by the reader.
   */
  constructor(generation: number, error: unknown) {
    this.generation = generation
    this.error = error
  }
}

/** Entries the loop queues for `receive()` to drain. */
type LoopQueueItem = BidiOutputEvent | ReaderError | Error

/**
 * Promise-based latch, the analog of `asyncio.Event`.
 *
 * @internal
 */
class Latch {
  private _set: boolean
  private _waiters: (() => void)[] = []

  /**
   * @param initiallySet - Whether the latch starts open.
   */
  constructor(initiallySet = false) {
    this._set = initiallySet
  }

  /** Whether the latch is open. */
  isSet(): boolean {
    return this._set
  }

  /** Open the latch, releasing every waiter. */
  set(): void {
    this._set = true
    const waiters = this._waiters
    this._waiters = []
    for (const waiter of waiters) waiter()
  }

  /** Close the latch so later waiters block. */
  clear(): void {
    this._set = false
  }

  /**
   * Wait until the latch is open.
   *
   * @returns Promise resolving once the latch opens.
   */
  wait(): Promise<void> {
    if (this._set) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this._waiters.push(resolve)
    })
  }
}

/** Sentinel resolved by {@link whenAborted} so a pending await can be abandoned. */
const ABORTED = Symbol('aborted')

/** One aborted-promise per signal; a task awaits thousands of times and must not stack listeners. */
const abortedPromises = new WeakMap<AbortSignal, Promise<typeof ABORTED>>()

/**
 * Resolve once a signal aborts.
 *
 * Cancellation is cooperative in TypeScript, so every await inside a pooled task races this.
 *
 * @param signal - Signal to watch.
 * @returns Promise resolving to the {@link ABORTED} sentinel.
 */
function whenAborted(signal: AbortSignal): Promise<typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)

  let aborted = abortedPromises.get(signal)
  if (aborted === undefined) {
    aborted = new Promise<typeof ABORTED>((resolve) => {
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
    })
    abortedPromises.set(signal, aborted)
  }
  return aborted
}

/** A pending sleep whose timer can be cleared when the race it entered is already decided. */
interface Sleep {
  promise: Promise<void>
  cancel: () => void
}

/** Resolve after the given seconds, leaving the timer clearable. */
function sleep(seconds: number): Sleep {
  let handle: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, seconds * 1000)
  })
  return {
    promise,
    cancel: (): void => {
      if (handle !== undefined) clearTimeout(handle)
    },
  }
}

/**
 * Owns the model connection and the concurrent tasks that pump it.
 *
 * @internal
 */
export class AgentLoop {
  private readonly _agent: BidiAgent
  private _started = false
  private _taskPool = new TaskPool()
  private _eventQueue = new Queue<LoopQueueItem>()
  private _invocationState: InvocationState = {}
  private _modelTask: Promise<void> | undefined

  /** Gate the sending of events to the model; closed while the connection restarts. */
  private readonly _sendGate = new Latch()

  private readonly _tracer = new Tracer()
  private _sessionSpan: Span | undefined
  private _responseSpan: Span | undefined

  // Session totals = baseline (finished connections) + current (this connection).
  private _currentInputTokens = 0
  private _currentOutputTokens = 0
  private _currentTotalTokens = 0
  private _currentCacheReadTokens = 0
  private _baselineInputTokens = 0
  private _baselineOutputTokens = 0
  private _baselineTotalTokens = 0
  private _baselineCacheReadTokens = 0

  private readonly _restartTimer: RestartTimer
  private _restarting = false
  private _generation = 0

  private _responseActive = false
  private _awaitingResponse = false
  private readonly _turnComplete = new Latch(true)

  private _responseStartMs: number | undefined
  private _timeToFirstAudioMs: number | undefined

  /**
   * @param agent - The agent that owns this loop.
   */
  constructor(agent: BidiAgent) {
    this._agent = agent
    this._restartTimer = new RestartTimer(
      (timeLeftMs) => this._onRestartWarning(timeLeftMs),
      () => this._onRestartDeadline()
    )
  }

  /**
   * Connect to the model and start the loop's background tasks.
   *
   * @param invocationState - Caller-supplied state threaded through hooks and tools.
   * @throws {@link Error} If the loop is already started, or the model connection fails.
   */
  async start(invocationState?: InvocationState): Promise<void> {
    if (this._started) {
      throw new Error('loop already started | call stop before starting again')
    }

    const agent = this._agent
    const systemPrompt = this._systemPrompt()
    this._sessionSpan = startSessionSpan(this._tracer, agent.name, {
      ...(agent.model.modelId !== undefined && { modelId: agent.model.modelId }),
      tools: agent.toolNames,
      ...(systemPrompt !== undefined && { systemPrompt }),
    })
    const connectionSpan = startConnectionSpan(this._tracer, {
      ...(this._sessionSpan !== undefined && { parentSpan: this._sessionSpan }),
      ...(agent.model.modelId !== undefined && { modelId: agent.model.modelId }),
    })

    try {
      await agent.model.start(this._startOptions())
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      if (connectionSpan !== undefined) {
        endConnectionSpan(this._tracer, connectionSpan, failure)
      }
      if (this._sessionSpan !== undefined) {
        endSessionSpan(this._tracer, this._sessionSpan, { error: failure })
        this._sessionSpan = undefined
      }
      throw error
    }

    // The connection span measures the connect, not the session: end it as soon as start succeeds.
    if (connectionSpan !== undefined) {
      endConnectionSpan(this._tracer, connectionSpan)
    }

    this._resetTokenTracking()
    this._responseActive = false
    this._awaitingResponse = false
    this._turnComplete.set()

    this._eventQueue = new Queue<LoopQueueItem>()
    this._taskPool = new TaskPool()
    this._invocationState = invocationState ?? {}
    this._invocationState['requestState'] ??= {}

    const generation = this._generation
    this._modelTask = this._taskPool.create((signal) => this._runModel(generation, signal))

    this._sendGate.set()
    this._started = true
    this._armRestartTimer()
  }

  /**
   * Stop the loop, cancelling its background tasks and closing the connection.
   *
   * @throws The first failure raised while tearing down tasks or the model connection.
   */
  async stop(): Promise<void> {
    this._started = false
    this._sendGate.clear()
    this._restartTimer.cancel()
    this._turnComplete.set()
    const invocationState = this._invocationState
    this._invocationState = {}
    // Dispose before cancelling: a producer blocked on back-pressure would never see the abort.
    this._eventQueue.dispose()

    try {
      await stopAll(
        () => this._taskPool.cancel(),
        () => this._agent.model.stop()
      )
    } finally {
      if (this._sessionSpan !== undefined) {
        endSessionSpan(this._tracer, this._sessionSpan, {
          inputTokens: this._accumulatedInputTokens(),
          outputTokens: this._accumulatedOutputTokens(),
          totalTokens: this._accumulatedTotalTokens(),
          cacheReadInputTokens: this._accumulatedCacheReadTokens(),
        })
        this._sessionSpan = undefined
      }
      await this._agent._invokeCallbacks(new BidiAgentStopEvent({ agent: this._agent, invocationState }))
    }
  }

  /**
   * Send content to the model over the live connection.
   *
   * User messages are recorded in history. The tool runner records tool results with their
   * corresponding tool uses. Deltas are not recorded.
   *
   * @param content - A complete message or a streamed audio delta.
   * @throws {@link Error} If the loop has not been started.
   */
  async send(content: BidiMessage | AudioDelta): Promise<void> {
    if (!this._started) {
      throw new Error('loop not started | call start before sending')
    }

    await this._sendGate.wait()

    if (!(content instanceof Object && 'content' in content)) {
      await this._agent.model.send(content)
      return
    }

    const message = content as BidiMessage
    const first = message.content[0]
    if (first !== undefined && !(first instanceof ToolResultBlock)) {
      await this._agent._appendMessages(new Message({ role: 'user', content: [...message.content] }))
      this._awaitingResponse = true
      this._updateTurnState()
    }

    await this._agent.model.send(message)
  }

  /**
   * Yield output events as the model produces them.
   *
   * @returns Generator of output events.
   * @throws {@link Error} If the loop has not been started, or the reader failed.
   */
  async *receive(): AsyncGenerator<BidiOutputEvent> {
    if (!this._started) {
      throw new Error('loop not started | call start before receiving')
    }

    while (true) {
      await this._eventQueue.wait()
      const entry = this._eventQueue.shift()
      if (entry === undefined) continue

      const item = entry.data
      entry.ack()

      if (item instanceof ReaderError) {
        if (item.generation !== this._generation) {
          logger.debug('generation mismatch | dropping error from superseded connection')
          continue
        }
        const error = item.error
        if (error instanceof ConnectionTimeoutError && this._autoRestartEnabled()) {
          const restartEvent = new BidiConnectionRestartEvent({
            type: 'bidiConnectionRestart',
            reason: 'timeout',
            timeoutError: error,
            turnInterrupted: !this._turnComplete.isSet(),
          })
          try {
            await this._restartConnection(error, item.generation, { restartEvent })
          } catch (restartError) {
            yield restartEvent
            throw restartError
          }
          continue
        }
        throw error
      }

      if (item instanceof Error) {
        throw item
      }

      yield item

      if (item.type === 'bidiConnectionStop' && item.reason === 'userRequest') {
        return
      }
    }
  }

  /** Whether the provider allows the loop to restart its connection automatically. */
  private _autoRestartEnabled(): boolean {
    return this._agent.model.getConnectionConfig().autoRestart ?? true
  }

  /** Arm the proactive restart timer when the provider declares a deadline. */
  private _armRestartTimer(): void {
    if (!this._autoRestartEnabled()) return
    const deadlineMs = resolveDeadlineMs(this._agent.model.getConnectionConfig())
    if (deadlineMs === undefined) return
    this._restartTimer.arm(deadlineMs, MODEL_RESTART_WARNING_MS)
  }

  /** Queue the advance warning ahead of a scheduled restart. */
  private _onRestartWarning(timeLeftMs: number): Promise<void> {
    // Push, like the restart event: an ack-wait would stall the timer behind an idle receiver.
    this._eventQueue.push(new BidiConnectionWarningEvent({ type: 'bidiConnectionWarning', timeLeftMs }))
    return Promise.resolve()
  }

  /** Swap the connection at the next turn boundary, or force it after the turn timeout. */
  private async _onRestartDeadline(): Promise<void> {
    const generation = this._generation
    await this._awaitTurnBoundary()

    const restartEvent = new BidiConnectionRestartEvent({
      type: 'bidiConnectionRestart',
      reason: 'scheduled',
      turnInterrupted: !this._turnComplete.isSet(),
    })

    try {
      await this._restartConnection(undefined, generation, { restartEvent })
    } catch (error) {
      this._eventQueue.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Wait at most {@link MODEL_RESTART_TURN_TIMEOUT_S} for the current turn to finish. */
  private async _awaitTurnBoundary(): Promise<void> {
    if (this._turnComplete.isSet()) return
    const timer = sleep(MODEL_RESTART_TURN_TIMEOUT_S)
    try {
      await Promise.race([this._turnComplete.wait(), timer.promise])
    } finally {
      timer.cancel()
    }
    if (!this._turnComplete.isSet()) {
      logger.warn(`timeout_s=<${MODEL_RESTART_TURN_TIMEOUT_S}> | forcing restart without a turn boundary`)
    }
  }

  /**
   * Replace the live connection, declining when the loop stopped or already restarted.
   *
   * @param timeoutError - The timeout that triggered a reactive restart, if any.
   * @param generation - Connection generation the restart was requested for.
   * @param options - The restart event to queue for receivers.
   * @returns Whether the restart ran.
   * @throws The failure raised while restarting.
   */
  private async _restartConnection(
    timeoutError: ConnectionTimeoutError | undefined,
    generation: number,
    options: { restartEvent: BidiConnectionRestartEvent }
  ): Promise<boolean> {
    if (!this._started) {
      logger.debug('loop stopped | declining connection restart')
      return false
    }
    if (generation !== this._generation) {
      logger.debug('generation mismatch | declining connection restart')
      return false
    }
    if (this._restarting) {
      logger.debug('restart in progress | declining connection restart')
      return false
    }

    this._restarting = true
    try {
      this._restartTimer.cancel()
      this._sendGate.clear()

      // Pushed, not sent: a reactive restart runs inside receive(), so waiting for the
      // receiver to acknowledge this event would deadlock against its own consumer.
      this._eventQueue.push(options.restartEvent)
      if (!this._started) {
        logger.debug('loop stopped | declining connection restart')
        return false
      }

      this._foldTokenBaseline()

      await this._agent._invokeCallbacks(
        new BidiBeforeConnectionRestartEvent({
          agent: this._agent,
          invocationState: this._invocationState,
          reason: options.restartEvent.reason,
          ...(timeoutError !== undefined && { timeoutError }),
        })
      )

      await this._swapConnection(timeoutError, options.restartEvent.reason)

      this._responseActive = false
      this._awaitingResponse = false
      this._turnComplete.set()
      this._armRestartTimer()
      this._sendGate.set()
      return true
    } finally {
      this._restarting = false
    }
  }

  /**
   * Fence the current reader, restart the model, and start a fresh reader.
   *
   * @param timeoutError - The timeout that triggered a reactive restart, if any.
   * @param reason - Why the connection is being replaced.
   * @throws The failure raised while restarting the model.
   */
  private async _swapConnection(
    timeoutError: ConnectionTimeoutError | undefined,
    reason: 'timeout' | 'scheduled'
  ): Promise<void> {
    const restartSpan = startRestartSpan(this._tracer, {
      ...(this._sessionSpan !== undefined && { parentSpan: this._sessionSpan }),
      reason,
      ...(timeoutError !== undefined && { errorMessage: timeoutError.message }),
    })

    let failure: Error | undefined
    try {
      const previousReader = this._modelTask
      this._generation += 1
      const generation = this._generation

      await this._restartModel(timeoutError)
      await this._waitForModelTask(previousReader)

      this._modelTask = this._taskPool.create((signal) => this._runModel(generation, signal))
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      throw error
    } finally {
      endRestartSpan(this._tracer, restartSpan, failure)
      await this._agent._invokeCallbacks(
        new BidiAfterConnectionRestartEvent({
          agent: this._agent,
          invocationState: this._invocationState,
          reason,
          ...(failure !== undefined && { error: failure }),
        })
      )
    }
  }

  /** Restart the model in place when it supports it, else stop and start it again. */
  private async _restartModel(timeoutError: ConnectionTimeoutError | undefined): Promise<void> {
    const startOptions: BidiModelStartOptions = {
      ...this._startOptions(),
      ...(timeoutError?.restartConfig ?? {}),
    }

    const model = this._agent.model
    if (isRestartable(model)) {
      await model.restart(startOptions)
      return
    }

    await model.stop()
    await model.start(startOptions)
  }

  /** Reap a superseded reader, bounded by {@link MODEL_RESTART_STOP_TIMEOUT_S}. */
  private async _waitForModelTask(task: Promise<void> | undefined): Promise<void> {
    if (task === undefined) return
    const timer = sleep(MODEL_RESTART_STOP_TIMEOUT_S)
    try {
      await Promise.race([task, timer.promise])
    } catch (error) {
      logger.debug(`error=<${String(error)}> | superseded model reader failed`)
    } finally {
      timer.cancel()
    }
  }

  /** Options used to open, restart, or reopen the model connection. */
  private _startOptions(): BidiModelStartOptions {
    const systemPrompt = this._systemPrompt()
    return {
      ...(systemPrompt !== undefined && { systemPrompt }),
      tools: this._toolSpecs(),
      messages: this._agent.messages,
    }
  }

  /** The agent's system prompt flattened to the string the model expects. */
  private _systemPrompt(): string | undefined {
    const prompt = this._agent.systemPrompt
    if (prompt === undefined) return undefined
    if (typeof prompt === 'string') return prompt

    const text = prompt.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('')
    return text === '' ? undefined : text
  }

  /** Specs for every tool registered on the agent. */
  private _toolSpecs(): ToolSpec[] {
    return this._agent.toolRegistry.list().map((tool) => tool.toolSpec)
  }

  /** Session input tokens across every connection. */
  private _accumulatedInputTokens(): number {
    return this._baselineInputTokens + this._currentInputTokens
  }

  /** Session output tokens across every connection. */
  private _accumulatedOutputTokens(): number {
    return this._baselineOutputTokens + this._currentOutputTokens
  }

  /** Session total tokens across every connection. */
  private _accumulatedTotalTokens(): number {
    return this._baselineTotalTokens + this._currentTotalTokens
  }

  /** Session cache-read tokens across every connection. */
  private _accumulatedCacheReadTokens(): number {
    return this._baselineCacheReadTokens + this._currentCacheReadTokens
  }

  /** Clear both the baseline and the current connection's token counters. */
  private _resetTokenTracking(): void {
    this._currentInputTokens = 0
    this._currentOutputTokens = 0
    this._currentTotalTokens = 0
    this._currentCacheReadTokens = 0
    this._baselineInputTokens = 0
    this._baselineOutputTokens = 0
    this._baselineTotalTokens = 0
    this._baselineCacheReadTokens = 0
  }

  /** Fold the finished connection's tokens into the session baseline. */
  private _foldTokenBaseline(): void {
    this._baselineInputTokens += this._currentInputTokens
    this._baselineOutputTokens += this._currentOutputTokens
    this._baselineTotalTokens += this._currentTotalTokens
    this._baselineCacheReadTokens += this._currentCacheReadTokens
    this._currentInputTokens = 0
    this._currentOutputTokens = 0
    this._currentTotalTokens = 0
    this._currentCacheReadTokens = 0
  }

  /** Accumulate a usage report from the model. */
  private _recordUsage(event: Extract<BidiOutputEvent, { type: 'bidiUsage' }>): void {
    this._currentInputTokens += event.inputTokens
    this._currentOutputTokens += event.outputTokens
    this._currentTotalTokens += event.totalTokens
    this._currentCacheReadTokens += event.inputTokenDetails?.cacheRead ?? 0
  }

  /** Latch the turn as complete only when neither side of the exchange is pending. */
  private _updateTurnState(): void {
    if (this._responseActive || this._awaitingResponse) {
      this._turnComplete.clear()
      return
    }
    this._turnComplete.set()
  }

  /**
   * Read model events, maintain history, and queue output for `receive()`.
   *
   * @param generation - The connection generation this reader belongs to.
   * @param signal - Cancellation signal from the task pool.
   */
  private async _runModel(generation: number, signal: AbortSignal): Promise<void> {
    if (generation !== this._generation) return

    const agent = this._agent
    const blocks = new Map<string, StreamedTextBlock>()
    let failure: Error | undefined
    let reader: AsyncIterator<BidiOutputEvent> | undefined
    let pendingNext: Promise<IteratorResult<BidiOutputEvent, unknown>> | undefined

    try {
      // Opened inside the try, like Python: a provider that raises on `receive()` must surface
      // through the event queue rather than rejecting the pooled task.
      reader = agent.model.receive()[Symbol.asyncIterator]()
      while (true) {
        pendingNext = reader.next()
        const next = await Promise.race([pendingNext, whenAborted(signal)])
        if (next === ABORTED || signal.aborted) return
        pendingNext = undefined
        if (next.done === true) break
        const event = next.value
        if (generation !== this._generation) return

        const emitted: BidiOutputEvent[] = [event]

        switch (event.type) {
          case 'bidiResponseStart': {
            if (this._responseSpan !== undefined) {
              endResponseSpan(this._tracer, this._responseSpan)
            }
            this._responseSpan = startResponseSpan(this._tracer, event.responseId, this._sessionSpan)
            this._responseStartMs = Date.now()
            this._timeToFirstAudioMs = undefined
            this._responseActive = true
            this._updateTurnState()
            break
          }

          case 'bidiTextStart': {
            const block = new StreamedTextBlock(event.contentId)
            blocks.set(event.contentId, block)
            await agent._appendMessages(block.message)
            break
          }

          case 'bidiReasoningStart': {
            const block = new StreamedReasoningBlock(event.contentId)
            blocks.set(event.contentId, block)
            await agent._appendMessages(block.message)
            break
          }

          case 'bidiTranscriptStart': {
            const block = new StreamedTranscriptBlock(event.contentId, event.role)
            blocks.set(event.contentId, block)
            await agent._appendMessages(block.message)
            if (event.role === 'user') {
              this._awaitingResponse = true
              this._updateTurnState()
            }
            break
          }

          case 'bidiTextDelta':
          case 'bidiReasoningDelta':
          case 'bidiTranscriptDelta': {
            blocks.get(event.contentId)?.append(event.delta)
            break
          }

          case 'bidiTextStop':
          case 'bidiReasoningStop':
          case 'bidiTranscriptStop': {
            const block = blocks.get(event.contentId)
            if (block !== undefined) {
              blocks.delete(event.contentId)
              await agent._updateMessage(block.toMessage())
              emitted.push(block.toEvent())
            }
            break
          }

          case 'bidiAudioDelta': {
            if (this._timeToFirstAudioMs === undefined && this._responseStartMs !== undefined) {
              this._timeToFirstAudioMs = Date.now() - this._responseStartMs
            }
            break
          }

          case 'bidiBargeIn': {
            addBargeInEvent(this._responseSpan)
            this._responseActive = false
            this._updateTurnState()
            for (const block of blocks.values()) {
              await agent._updateMessage(block.toMessage({ complete: false }), { strict: false })
            }
            blocks.clear()
            await agent._invokeCallbacks(new BidiBargeInHookEvent({ agent, invocationState: this._invocationState }))
            break
          }

          case 'bidiResponseStop': {
            if (this._responseSpan !== undefined) {
              endResponseSpan(this._tracer, this._responseSpan, {
                ...(this._timeToFirstAudioMs !== undefined && {
                  timeToFirstAudioMs: this._timeToFirstAudioMs,
                }),
              })
              this._responseSpan = undefined
            }
            this._responseActive = false
            this._awaitingResponse = false
            this._updateTurnState()
            await agent._invokeCallbacks(
              new BidiResponseStopHookEvent({
                agent,
                invocationState: this._invocationState,
                responseId: event.responseId,
              })
            )
            break
          }

          case 'bidiToolUseBlocks': {
            const dispatchMetadata: BidiToolMetadata = { kind: 'toolDispatch' }
            await agent._appendMessages(
              new Message({ role: 'assistant', content: [...event.toolUses] }),
              new Message({
                role: 'user',
                content: event.toolUses.map(
                  (toolUse) =>
                    new ToolResultBlock({
                      toolUseId: toolUse.toolUseId,
                      content: [new TextBlock(TOOL_DISPATCH_PLACEHOLDER)],
                      status: 'success',
                    })
                ),
                metadata: { custom: { bidi: { ...dispatchMetadata } } },
              })
            )
            break
          }

          case 'bidiUsage': {
            this._recordUsage(event)
            break
          }

          default:
            break
        }

        for (const output of emitted) {
          if (generation !== this._generation) return
          if (!(await this._queue(output, signal))) return
        }

        if (event.type === 'bidiToolUseBlocks') {
          const toolUses = [...event.toolUses]
          void this._taskPool.create((toolSignal) => this._runTools(toolUses, toolSignal))
        }
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
      this._eventQueue.push(new ReaderError(generation, error))
    } finally {
      // Close the provider generator so its own `finally` runs; an abandoned `next()` keeps the
      // generator busy, so the close request can only be fired, never awaited.
      const closing = reader?.return?.()
      if (pendingNext !== undefined) {
        pendingNext.catch(() => {})
        void closing?.catch(() => {})
      } else if (closing !== undefined) {
        try {
          await closing
        } catch (error) {
          logger.debug(`error=<${String(error)}> | model reader close failed`)
        }
      }

      for (const block of blocks.values()) {
        await agent._updateMessage(block.toMessage({ complete: false }), { strict: false })
      }
      blocks.clear()

      if (this._responseSpan !== undefined) {
        endResponseSpan(this._tracer, this._responseSpan, {
          ...(this._timeToFirstAudioMs !== undefined && { timeToFirstAudioMs: this._timeToFirstAudioMs }),
          ...(failure !== undefined && { error: failure }),
        })
        this._responseSpan = undefined
      }
    }
  }

  /**
   * Execute one group of tool calls and send their results back to the model.
   *
   * @param toolUses - Tool calls requested in a single model turn.
   * @param signal - Cancellation signal from the task pool.
   */
  private async _runTools(toolUses: ToolUseBlock[], signal: AbortSignal): Promise<void> {
    const agent = this._agent
    const toolMetadata: BidiToolMetadata = { kind: 'toolResult' }
    const assistantMessage = new Message({ role: 'assistant', content: [...toolUses] })
    const toolResultBlocks: ToolResultBlock[] = []

    try {
      const group = new TaskGroup()
      group.createTask(async () => {
        for await (const event of agent._toolExecutor.execute(
          {
            agent,
            middlewareRegistry: agent._middlewareRegistry,
            tracer: agent._tracer,
            meter: agent._meter,
            cancelSignal: agent.cancelSignal,
          },
          {
            toolUseBlocks: toolUses,
            toolResultBlocks,
            invocationState: this._invocationState,
            assistantMessage,
          }
        )) {
          if (!(await this._queue(event as unknown as BidiOutputEvent, signal))) return
        }

        const pending = Object.values(agent._interruptState.interrupts)
        if (pending.length > 0) {
          agent._interruptState.deactivate()
          throw new Error(
            `interrupts=<${pending.map((interrupt) => interrupt.name).join(', ')}> | tool interrupts are not supported in bidi`
          )
        }
      })
      await group.join()

      // Python builds the results from the task list, i.e. in request order; the executor streams
      // them in completion order, so re-pair them with their tool uses before recording.
      const orderedResults = this._orderToolResults(toolUses, toolResultBlocks)
      const toolResultMessage = new Message({
        role: 'user',
        content: orderedResults,
        metadata: { custom: { bidi: { ...toolMetadata } } },
      })
      await agent._appendMessages(assistantMessage, toolResultMessage)

      // Python queues `ToolResultMessageEvent` here; `strands.types._events` has no TS counterpart,
      // so the TS core event for a recorded tool-result message is used instead.
      if (
        !(await this._queue(
          new MessageAddedEvent({
            agent,
            message: toolResultMessage,
            invocationState: this._invocationState,
          }) as unknown as BidiOutputEvent,
          signal
        ))
      ) {
        return
      }

      if (agent.cancelSignal.aborted) {
        await this._queue(
          new BidiConnectionStopEvent({
            type: 'bidiConnectionStop',
            connectionId: this._connectionId(),
            reason: 'userRequest',
          }),
          signal
        )
        return
      }

      if (signal.aborted) return

      await this.send({ content: orderedResults })
    } catch (error) {
      if (error instanceof InterruptError) {
        agent._interruptState.deactivate()
        this._eventQueue.push(
          new Error(
            `interrupts=<${error.interrupts.map((interrupt) => interrupt.name).join(', ')}> | tool interrupts are not supported in bidi`
          )
        )
        return
      }
      this._eventQueue.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Re-order tool results into the order their tool uses were requested in.
   *
   * @param toolUses - Tool calls requested in a single model turn.
   * @param results - Tool results in executor completion order.
   * @returns The results paired with `toolUses`, with any unmatched result appended.
   */
  private _orderToolResults(toolUses: ToolUseBlock[], results: ToolResultBlock[]): ToolResultBlock[] {
    const remaining = [...results]
    const ordered: ToolResultBlock[] = []
    for (const toolUse of toolUses) {
      const index = remaining.findIndex((result) => result.toolUseId === toolUse.toolUseId)
      if (index === -1) continue
      ordered.push(...remaining.splice(index, 1))
    }
    return [...ordered, ...remaining]
  }

  /**
   * Queue one entry for `receive()`, abandoning the wait when the task is cancelled.
   *
   * @param item - Entry to hand to the receiver.
   * @param signal - Cancellation signal from the task pool.
   * @returns Whether the entry was consumed rather than abandoned.
   */
  private async _queue(item: LoopQueueItem, signal: AbortSignal): Promise<boolean> {
    const delivered = await Promise.race([this._eventQueue.send(item).then(() => true), whenAborted(signal)])
    return delivered === true && !signal.aborted
  }

  /** Identifier reported on connection lifecycle events. */
  private _connectionId(): string {
    return this._agent.id
  }
}
