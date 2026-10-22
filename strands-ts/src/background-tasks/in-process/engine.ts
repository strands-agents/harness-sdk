import type { InterruptStateData } from '../../interrupt.js'
import type { ToolResultBlockData } from '../../types/messages.js'
import { BackgroundTaskNotFoundError } from '../errors.js'
import { TaskEngine, TaskNotFoundError } from './task-engine.js'
import type { TaskExecutionContext, TaskOutcome, TaskRecord } from './task-types.js'
import type { BackgroundTaskFailureType } from '../types.js'
import type { InProcessTaskEngineOptions, InProcessTaskRecord } from './types.js'

interface ToolTaskInput {
  readonly toolUseId: string
  readonly toolName: string
  readonly invocationStateId: string
}

type ToolTaskRecord = TaskRecord<ToolTaskInput, ToolResultBlockData>

/**
 * Runs and tracks bounded tool-shaped tasks.
 *
 * This compatibility facade preserves the original background-task engine contract while delegating
 * scheduling to the generic {@link TaskEngine}.
 *
 * @internal
 */
export class InProcessTaskEngine {
  private readonly _engine: TaskEngine<ToolTaskInput, ToolResultBlockData>

  /**
   * Creates an in-process task engine.
   *
   * @param options - Execution limits and callbacks supplied by the task manager.
   * @throws TypeError if the concurrency or timeout configuration is invalid.
   */
  constructor(options: InProcessTaskEngineOptions) {
    const execute = async (context: TaskExecutionContext<ToolTaskInput>): Promise<TaskOutcome<ToolResultBlockData>> => {
      const input = context.input
      const outcome = await options.execute({
        taskId: context.taskId,
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        invocationStateId: input.invocationStateId,
        ...(context.state !== undefined && { state: context.state }),
        cancelSignal: context.cancelSignal,
      })
      // Preserve the original engine's snapshot contract: an uncopyable result fails execution.
      return globalThis.structuredClone(outcome)
    }

    this._engine = new TaskEngine({
      maxConcurrency: options.maxConcurrency,
      timeout: options.timeout,
      execute,
      onTaskUpdated: (record): void => options.onTaskUpdated(toLegacyRecord(record)),
    })
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
    return toLegacyRecord(this._engine.submit(admission))
  }

  /** Gets a task by ID. */
  get(taskId: string): InProcessTaskRecord | undefined {
    const record = this._engine.get(taskId)
    return record ? toLegacyRecord(record) : undefined
  }

  /** Lists the tasks tracked by this engine. */
  list(): readonly InProcessTaskRecord[] {
    return this._engine.list().map((record) => toLegacyRecord(record))
  }

  /** Removes a terminal task. */
  remove(taskId: string): void {
    try {
      this._engine.remove(taskId)
    } catch (error) {
      throwLegacyError(taskId, error)
    }
  }

  /** Cancels a non-terminal task and aborts its active execution. */
  cancel(taskId: string, options: { readonly reason: string }): InProcessTaskRecord {
    try {
      return toLegacyRecord(this._engine.cancel(taskId, options))
    } catch (error) {
      throwLegacyError(taskId, error)
    }
  }

  /** Waits until no tasks are queued or executing. */
  async waitForIdle(options?: { readonly cancelSignal?: AbortSignal }): Promise<void> {
    await this._engine.waitForIdle(options)
  }

  /** Applies interrupt responses to a task with `input_required` status. */
  resume(
    taskId: string,
    update: (state: InterruptStateData) => {
      readonly state: InterruptStateData
      readonly ready: boolean
    }
  ): InProcessTaskRecord {
    try {
      return toLegacyRecord(this._engine.resume(taskId, update))
    } catch (error) {
      throwLegacyError(taskId, error)
    }
  }
}

function toLegacyRecord(record: ToolTaskRecord): InProcessTaskRecord {
  const input = record.input
  return {
    taskId: record.taskId,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    invocationStateId: input.invocationStateId,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
    ...(record.state !== undefined && { state: globalThis.structuredClone(record.state) }),
    ...(record.result !== undefined && { result: globalThis.structuredClone(record.result) }),
    ...(record.failure !== undefined && {
      failure: {
        type: record.failure.type as BackgroundTaskFailureType,
        message:
          record.failure.message === 'Task execution failed'
            ? 'Background task execution failed'
            : record.failure.message,
      },
    }),
  }
}

function throwLegacyError(taskId: string, error: unknown): never {
  if (error instanceof TaskNotFoundError) throw new BackgroundTaskNotFoundError(taskId)
  if (error instanceof Error && error.message.startsWith('Task ')) {
    throw new Error(error.message.replace('Task ', 'Background task '))
  }
  throw error
}
