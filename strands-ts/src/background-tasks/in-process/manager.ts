import type { Agent } from '../../agent/agent.js'
import type { ToolUseData } from '../../hooks/events.js'
import { InterruptError, InterruptState } from '../../interrupt.js'
import { createMiddlewareInterrupt } from '../../middleware/interrupt.js'
import type { ExecuteToolContext } from '../../middleware/index.js'
import type { InvocationState } from '../../types/agent.js'
import { InterruptResponseContent, type InterruptParams, type InterruptResponse } from '../../types/interrupt.js'
import type { JSONValue } from '../../types/json.js'
import { TextBlock, type ToolResultBlock } from '../../types/messages.js'
import type { Tool, ToolContext } from '../../tools/tool.js'
import { BackgroundTaskNotFoundError, BackgroundTaskTimeoutError } from '../errors.js'
import { assertTimerDelay } from '../timer.js'
import { InProcessTaskEngine } from './engine.js'
import {
  type InProcessTaskExecutionContext,
  type InProcessTaskExecutionOutcome,
  type InProcessTaskRecord,
} from './types.js'
import type { BackgroundTaskManager } from '../manager.js'
import { isTaskStatusTerminal, type BackgroundTask } from '../types.js'

interface LiveToolExecution {
  readonly toolUse: ToolUseData
  readonly invocationState: InvocationState
  readonly tool: Tool
}

/** Configures in-process background task execution. @internal */
export interface InProcessTaskManagerConfig {
  /** Maximum number of physically executing background tasks. Defaults to `4`. */
  readonly maxConcurrency?: number
  /** Per-execution timeout in milliseconds. Defaults to `Infinity`. */
  readonly timeout?: number
  readonly onTaskUpdated?: (task: BackgroundTask) => void
}

/** Executes approved tool calls as in-process background tasks. @internal */
export class InProcessTaskManager implements BackgroundTaskManager {
  private readonly _agent: Agent
  private readonly _executeTool
  private readonly _engine: InProcessTaskEngine
  private readonly _executions = new Map<string, LiveToolExecution>()
  private readonly _taskIdBySubmission = new Map<string, string>()
  private readonly _taskWaiters = new Map<string, Set<(task: BackgroundTask) => void>>()

  constructor(
    agent: Agent,
    executeTool: (
      tool: Tool,
      context: ToolContext,
      middlewareInterrupt: ExecuteToolContext['interrupt']
    ) => Promise<ToolResultBlock>,
    config: InProcessTaskManagerConfig = {}
  ) {
    this._agent = agent
    this._executeTool = executeTool
    this._engine = new InProcessTaskEngine({
      maxConcurrency: config.maxConcurrency ?? 4,
      timeout: config.timeout ?? Infinity,
      execute: (context): Promise<InProcessTaskExecutionOutcome> => this._executeToolTask(context),
      onTaskUpdated: (record): void => {
        const task = toBackgroundTask(record)
        if (isTaskStatusTerminal(record.status)) {
          this._executions.delete(record.invocationStateId)
        }
        if (record.status === 'input_required' || isTaskStatusTerminal(record.status)) {
          this._notifyTaskWaiters(task)
        }
        config.onTaskUpdated?.(task)
      },
    })
  }

  async submit(
    toolUse: Readonly<ToolUseData>,
    invocationState: InvocationState,
    passId: string,
    tool: Tool
  ): Promise<BackgroundTask> {
    const submissionKey = JSON.stringify([passId, toolUse.toolUseId])
    const existingTaskId = this._taskIdBySubmission.get(submissionKey)
    if (existingTaskId) return toBackgroundTask(this._engine.get(existingTaskId)!)

    const invocationStateId = globalThis.crypto.randomUUID()
    this._executions.set(invocationStateId, {
      toolUse: globalThis.structuredClone(toolUse),
      invocationState,
      tool,
    })
    const record = this._engine.submit({
      toolName: toolUse.name,
      toolUseId: toolUse.toolUseId,
      invocationStateId,
    })
    this._taskIdBySubmission.set(submissionKey, record.taskId)
    return toBackgroundTask(record)
  }

  async get(taskId: string): Promise<BackgroundTask | undefined> {
    const record = this._engine.get(taskId)
    return record ? toBackgroundTask(record) : undefined
  }

  async list(): Promise<readonly BackgroundTask[]> {
    return this._engine.list().map(toBackgroundTask)
  }

  hasTasks(): boolean {
    return this._taskIdBySubmission.size > 0
  }

  async cancel(taskId: string): Promise<BackgroundTask> {
    return toBackgroundTask(this._engine.cancel(taskId, { reason: 'Cancellation requested' }))
  }

  async wait(taskId: string): Promise<BackgroundTask> {
    const current = this._engine.get(taskId)
    if (!current) throw new BackgroundTaskNotFoundError(taskId)
    if (current.status === 'input_required' || isTaskStatusTerminal(current.status)) {
      return toBackgroundTask(current)
    }

    return new Promise<BackgroundTask>((resolve) => {
      const waiters = this._taskWaiters.get(taskId) ?? new Set()
      const onTaskUpdated = (task: BackgroundTask): void => {
        waiters.delete(onTaskUpdated)
        if (waiters.size === 0) this._taskWaiters.delete(taskId)
        resolve(task)
      }
      waiters.add(onTaskUpdated)
      this._taskWaiters.set(taskId, waiters)
    })
  }

  async waitForIdle(options?: { readonly timeout?: number }): Promise<void> {
    const timeout = options?.timeout
    if (timeout !== undefined) assertTimerDelay('wait timeout', timeout)
    if (timeout === undefined) return this._engine.waitForIdle()

    const cancelSignal = AbortSignal.timeout(timeout)
    try {
      await this._engine.waitForIdle({ cancelSignal })
    } catch (error) {
      if (error === cancelSignal.reason) throw new BackgroundTaskTimeoutError(timeout)
      throw error
    }
  }

  async resume(taskId: string, responses: readonly InterruptResponse[]): Promise<BackgroundTask> {
    return toBackgroundTask(
      this._engine.resume(taskId, (state) => {
        const taskState = InterruptState.fromJSON(state)
        taskState.resume(
          responses.map(
            (response) =>
              new InterruptResponseContent({
                interruptId: response.interruptId,
                response: response.response,
              })
          )
        )
        return {
          state: taskState.toJSON(),
          ready: taskState.getUnansweredInterrupts().length === 0,
        }
      })
    )
  }

  async remove(taskIds: readonly string[]): Promise<void> {
    const uniqueTaskIds = new Set(taskIds)
    for (const taskId of uniqueTaskIds) {
      const task = this._engine.get(taskId)
      if (!task) throw new BackgroundTaskNotFoundError(taskId)
      if (!isTaskStatusTerminal(task.status)) {
        throw new Error(`Background task '${taskId}' cannot be removed before reaching a terminal status`)
      }
    }
    for (const taskId of uniqueTaskIds) {
      this._engine.remove(taskId)
    }
    for (const [submissionKey, taskId] of this._taskIdBySubmission) {
      if (uniqueTaskIds.has(taskId)) this._taskIdBySubmission.delete(submissionKey)
    }
  }

  private async _executeToolTask(context: InProcessTaskExecutionContext): Promise<InProcessTaskExecutionOutcome> {
    const execution = this._executions.get(context.invocationStateId)
    if (!execution) throw new Error('Background task live execution state is unavailable')
    const interruptState = context.state ? InterruptState.fromJSON(context.state) : new InterruptState()
    try {
      return toolTaskOutcome(
        await this._executeTool(
          execution.tool,
          {
            agent: this._agent,
            invocationState: execution.invocationState,
            cancelSignal: context.cancelSignal,
            toolUse: execution.toolUse,
            interrupt: <T = JSONValue>(params: InterruptParams): T =>
              interruptTool<T>(interruptState, context.taskId, params),
          },
          createMiddlewareInterrupt(interruptState, `middleware:${context.taskId}`)
        )
      )
    } catch (error) {
      if (error instanceof InterruptError) {
        const taskOwnsInterrupts =
          error.interrupts.length > 0 &&
          error.interrupts.every(
            (interrupt) =>
              (interrupt.source === 'middleware' || interrupt.source === 'tool') &&
              interrupt.id.startsWith(`${interrupt.source}:${context.taskId}:`)
          )
        if (!taskOwnsInterrupts) throw error

        for (const interrupt of error.interrupts) interruptState.registerInterrupt(interrupt)
        interruptState.activate()
        return { status: 'input_required', state: interruptState.toJSON() }
      }
      throw error
    }
  }

  private _notifyTaskWaiters(task: BackgroundTask): void {
    const waiters = this._taskWaiters.get(task.taskId)
    if (!waiters) return
    for (const waiter of waiters) waiter(task)
  }
}

function toolTaskOutcome(resultBlock: ToolResultBlock): InProcessTaskExecutionOutcome {
  const result = resultBlock.toJSON().toolResult
  if (resultBlock.status === 'success') return { status: 'completed', result }
  return {
    status: 'failed',
    failure: {
      type: 'toolError',
      message:
        resultBlock.error?.message ??
        resultBlock.content.find((content): content is TextBlock => content instanceof TextBlock)?.text ??
        'Tool returned an error without a message',
    },
    result,
  }
}

function interruptTool<T>(state: InterruptState, taskId: string, params: InterruptParams): T {
  const interrupt = state.getOrCreateInterrupt(
    `tool:${taskId}:${params.name}`,
    params.name,
    params.reason,
    params.response,
    'tool'
  )
  if (interrupt.response !== undefined) return interrupt.response as T
  throw new InterruptError(interrupt)
}

function toBackgroundTask(record: InProcessTaskRecord): BackgroundTask {
  const interrupts = record.state ? InterruptState.fromJSON(record.state).getUnansweredInterrupts() : []
  return {
    taskId: record.taskId,
    toolUseId: record.toolUseId,
    toolName: record.toolName,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ...(record.result && {
      result: { content: record.result.content },
    }),
    ...(record.failure && {
      error: {
        type: record.failure.type,
        message: record.failure.message,
      },
    }),
    ...(interrupts.length > 0 && { interrupts }),
  }
}
