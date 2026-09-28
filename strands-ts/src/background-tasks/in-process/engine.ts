import { normalizeError } from '../../errors.js'
import { BackgroundTaskNotFoundError } from '../errors.js'
import { assertTimerDelay } from '../timer.js'
import type { InterruptStateData } from '../../interrupt.js'
import { isTaskStatusTerminal } from '../types.js'
import type { InProcessTaskEngineOptions, InProcessTaskExecutionOutcome, InProcessTaskRecord } from './types.js'

const DEFAULT_EXECUTION_FAILURE_MESSAGE = 'Background task execution failed'

interface ActiveExecution {
  readonly controller: AbortController
  timeout?: ReturnType<typeof setTimeout>
}

/** Runs and tracks bounded in-process tasks. @internal */
export class InProcessTaskEngine {
  private readonly _options: InProcessTaskEngineOptions
  private readonly _tasks = new Map<string, InProcessTaskRecord>()
  private readonly _queue = new Set<string>()
  private readonly _activeExecutions = new Map<string, ActiveExecution>()
  private readonly _idleWaiters = new Set<() => void>()

  /**
   * Creates an in-process task engine.
   *
   * @param options - Execution limits and callbacks supplied by the task manager.
   * @throws TypeError if the concurrency or timeout configuration is invalid.
   */
  constructor(options: InProcessTaskEngineOptions) {
    if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
      throw new TypeError(`maxConcurrency must be a positive finite integer, got ${options.maxConcurrency}`)
    }
    if (options.timeout !== Infinity) assertTimerDelay('timeout', options.timeout)
    this._options = options
  }

  /**
   * Submits a task for execution.
   *
   * @param admission - Tool execution details.
   * @returns A snapshot of the admitted task.
   */
  submit(admission: {
    readonly toolUseId: string
    readonly toolName: string
    readonly invocationStateId: string
  }): InProcessTaskRecord {
    const now = new Date().toISOString()
    const stored: InProcessTaskRecord = {
      taskId: globalThis.crypto.randomUUID(),
      ...admission,
      status: 'queued',
      createdAt: now,
      lastUpdatedAt: now,
    }
    this._tasks.set(stored.taskId, stored)
    this._notifyTaskUpdated(stored)
    this._scheduleTask(stored.taskId)
    return globalThis.structuredClone(stored)
  }

  /**
   * Gets a task by ID.
   *
   * @param taskId - ID of the task to retrieve.
   * @returns A snapshot of the task, or `undefined` when it does not exist.
   */
  get(taskId: string): InProcessTaskRecord | undefined {
    const task = this._tasks.get(taskId)
    return task ? globalThis.structuredClone(task) : undefined
  }

  /**
   * Lists the tasks tracked by this engine.
   *
   * @returns Snapshots of the tracked tasks.
   */
  list(): readonly InProcessTaskRecord[] {
    return [...this._tasks.values()].map((task) => globalThis.structuredClone(task))
  }

  /**
   * Removes a terminal task.
   *
   * @param taskId - ID of the task to remove.
   * @throws Error if the task does not exist or has not reached a terminal state.
   */
  remove(taskId: string): void {
    const task = this._requireTask(taskId)
    if (!isTaskStatusTerminal(task.status)) {
      throw new Error(`Background task '${taskId}' cannot be removed before reaching a terminal status`)
    }
    this._tasks.delete(taskId)
  }

  /**
   * Cancels a non-terminal task and aborts its active execution.
   *
   * @param taskId - ID of the task to cancel.
   * @param options - Cancellation options passed to the active execution.
   * @returns A snapshot of the cancelled task, or the unchanged task if it was already terminal.
   * @throws Error if the task does not exist.
   */
  cancel(taskId: string, options: { readonly reason: string }): InProcessTaskRecord {
    const current = this._requireTask(taskId)
    if (isTaskStatusTerminal(current.status)) return globalThis.structuredClone(current)
    const task = this._updateTask(taskId, (record) => {
      record.status = 'cancelled'
      delete record.state
      return true
    })!
    this._queue.delete(taskId)
    const activeExecution = this._activeExecutions.get(taskId)
    if (activeExecution?.timeout) {
      clearTimeout(activeExecution.timeout)
    }
    activeExecution?.controller.abort(options.reason)
    this._wakeIdleWaiters()
    return task
  }

  /**
   * Waits until no tasks are queued or executing.
   *
   * @param options - Optional cancellation signal for the wait.
   * @returns A promise that resolves when the engine is idle.
   * @throws The cancellation signal's reason if the wait is aborted.
   */
  async waitForIdle(options?: { readonly cancelSignal?: AbortSignal }): Promise<void> {
    const cancelSignal = options?.cancelSignal
    while (this._queue.size > 0 || this._activeExecutions.size > 0) {
      if (cancelSignal?.aborted) throw cancelSignal.reason
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          this._idleWaiters.delete(onIdle)
          reject(cancelSignal!.reason)
        }
        const onIdle = (): void => {
          cancelSignal?.removeEventListener('abort', onAbort)
          resolve()
        }
        this._idleWaiters.add(onIdle)
        cancelSignal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /**
   * Applies interrupt responses to a task with `input_required` status.
   *
   * The task remains `input_required` while interrupts are unanswered and is queued for
   * execution once the updated interrupt state is ready.
   *
   * @param taskId - ID of the task requiring input.
   * @param update - Applies interrupt responses to the task state and reports when it is ready.
   * @returns A snapshot of the updated task.
   * @throws BackgroundTaskNotFoundError if the task does not exist.
   * @throws Error if the task does not require input or has no state.
   */
  resume(
    taskId: string,
    update: (state: InterruptStateData) => {
      readonly state: InterruptStateData
      readonly ready: boolean
    }
  ): InProcessTaskRecord {
    const task = this._updateTask(taskId, (record) => {
      if (record.status !== 'input_required') {
        throw new Error(
          `Background task '${taskId}' cannot be resumed: status is '${record.status}', not 'input_required'`
        )
      }
      if (record.state === undefined) {
        throw new Error(`Background task '${taskId}' cannot be resumed: interrupt state is missing`)
      }
      const resumed = update(record.state)
      record.state = resumed.state
      if (resumed.ready) record.status = 'queued'
      return true
    })!
    if (task.status === 'queued') this._scheduleTask(taskId)
    return task
  }

  private _scheduleTask(taskId: string): void {
    if (this._activeExecutions.has(taskId)) return
    this._queue.add(taskId)
    this._startQueuedTasks()
  }

  private _startQueuedTasks(): void {
    while (this._activeExecutions.size < this._options.maxConcurrency && this._queue.size > 0) {
      const taskId = this._queue.values().next().value!
      this._queue.delete(taskId)
      const activeExecution: ActiveExecution = {
        controller: new AbortController(),
      }
      this._activeExecutions.set(taskId, activeExecution)
      void this._execute(taskId, activeExecution)
        .finally(() => {
          if (activeExecution.timeout) clearTimeout(activeExecution.timeout)
          this._activeExecutions.delete(taskId)
          if (this._tasks.get(taskId)?.status === 'queued') {
            this._queue.add(taskId)
          }
          this._wakeIdleWaiters()
          this._startQueuedTasks()
        })
        .catch(() => undefined)
    }
  }

  private async _execute(taskId: string, activeExecution: ActiveExecution): Promise<void> {
    const working = this._updateTask(taskId, (task) => {
      task.status = 'working'
      return true
    })!

    if (Number.isFinite(this._options.timeout)) {
      activeExecution.timeout = setTimeout(() => {
        delete activeExecution.timeout
        this._timeoutTask(taskId, activeExecution)
      }, this._options.timeout)
    }

    let outcome: InProcessTaskExecutionOutcome
    try {
      outcome = await this._options.execute({
        taskId,
        toolUseId: working.toolUseId,
        toolName: working.toolName,
        invocationStateId: working.invocationStateId,
        ...(working.state !== undefined && { state: working.state }),
        cancelSignal: activeExecution.controller.signal,
      })
    } catch (error) {
      outcome = {
        status: 'failed',
        failure: {
          type: 'executionError',
          message: getExecutionFailureMessage(error),
        },
      }
    }
    this._finishOutcome(taskId, outcome)
  }

  private _finishOutcome(taskId: string, outcome: InProcessTaskExecutionOutcome): void {
    if (outcome.status === 'input_required') {
      this._updateTask(taskId, (record) => {
        if (record.status !== 'working') return false
        record.status = 'input_required'
        record.state = outcome.state
        return true
      })
      return
    }

    this._updateTask(taskId, (record) => {
      if (record.status !== 'working') return false
      if (outcome.status === 'failed') {
        record.status = 'failed'
        delete record.state
        record.failure = {
          type: outcome.failure.type,
          message: outcome.failure.message || DEFAULT_EXECUTION_FAILURE_MESSAGE,
        }
        if (outcome.result !== undefined) {
          record.result = outcome.result
        }
        return true
      }
      record.status = 'completed'
      delete record.state
      record.result = outcome.result
      return true
    })
  }

  private _timeoutTask(taskId: string, activeExecution: ActiveExecution): void {
    const reason = `Timed out after ${this._options.timeout}ms`
    const task = this._updateTask(taskId, (record) => {
      if (record.status !== 'working') return false
      record.status = 'failed'
      delete record.state
      record.failure = {
        type: 'timeout',
        message: reason,
      }
      return true
    })
    if (task) activeExecution.controller.abort(reason)
  }

  private _updateTask(taskId: string, update: (task: InProcessTaskRecord) => boolean): InProcessTaskRecord | undefined {
    const current = this._requireTask(taskId)

    const next = globalThis.structuredClone(current)
    if (!update(next)) return undefined

    next.lastUpdatedAt = new Date().toISOString()
    const stored = globalThis.structuredClone(next)
    this._tasks.set(taskId, stored)
    this._notifyTaskUpdated(stored)

    return globalThis.structuredClone(stored)
  }

  private _requireTask(taskId: string): InProcessTaskRecord {
    const task = this._tasks.get(taskId)
    if (!task) throw new BackgroundTaskNotFoundError(taskId)
    return task
  }

  private _notifyTaskUpdated(task: InProcessTaskRecord): void {
    const taskSnapshot = globalThis.structuredClone(task)
    void Promise.resolve()
      .then(() => this._options.onTaskUpdated(taskSnapshot))
      .catch(() => undefined)
  }

  private _wakeIdleWaiters(): void {
    for (const resolve of this._idleWaiters) resolve()
    this._idleWaiters.clear()
  }
}

function getExecutionFailureMessage(error: unknown): string {
  try {
    return normalizeError(error).message || DEFAULT_EXECUTION_FAILURE_MESSAGE
  } catch {
    return DEFAULT_EXECUTION_FAILURE_MESSAGE
  }
}
