import type { InterruptStateData } from '../../interrupt.js'

/** Lifecycle status owned by the generic in-process task engine. @internal */
export type TaskStatus = 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

/** Failure recorded by the generic in-process task engine. @internal */
export interface TaskFailure {
  /** Consumer-defined failure category, or an engine category such as `executionError` or `timeout`. */
  readonly type: string
  /** Human-readable failure detail. */
  readonly message: string
}

/** Options and callbacks for bounded in-process task execution. @internal */
export interface TaskEngineOptions<TInput, TResult> {
  /** Maximum number of task executions that may run concurrently. */
  readonly maxConcurrency: number
  /** Per-execution timeout in milliseconds, or `Infinity` to disable timeouts. */
  readonly timeout: number
  /** Runs one task execution and returns whether it completed, requires input, or failed. */
  readonly execute: (context: TaskExecutionContext<TInput>) => Promise<TaskOutcome<TResult>>
  /** Receives committed task updates without blocking or failing the engine. */
  readonly onTaskUpdated: (task: TaskRecord<TInput, TResult>) => void
}

/** Context supplied to one in-process task execution. @internal */
export interface TaskExecutionContext<TInput> {
  /** Identifier of the logical task. */
  readonly taskId: string
  /** The payload the task was submitted with. */
  readonly input: TInput
  /** Interrupt state supplied when resuming a task that requires input. */
  readonly state?: InterruptStateData
  /** Signal aborted when this execution should stop. */
  readonly cancelSignal: AbortSignal
}

/** Outcome returned by one in-process task execution. @internal */
export type TaskOutcome<TResult> =
  | {
      readonly status: 'completed'
      readonly result: TResult
    }
  | {
      readonly status: 'input_required'
      readonly state: InterruptStateData
    }
  | {
      readonly status: 'failed'
      readonly failure: TaskFailure
      readonly result?: TResult
    }

/**
 * Generic in-process task record.
 *
 * `input` and `result` belong to the consumer and are shared by reference; the engine never copies them.
 *
 * @internal
 */
export interface TaskRecord<TInput, TResult> {
  /** Identifier of the logical task. */
  readonly taskId: string
  /** The payload the task was submitted with. */
  readonly input: TInput
  /** Current task lifecycle status. */
  status: TaskStatus
  /** Interrupt state, required while the task needs input and retained while resuming. */
  state?: InterruptStateData
  /** Execution result, required while completed and optional while failed. */
  result?: TResult
  /** Failure details recorded when the task fails. */
  failure?: TaskFailure
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the latest transition. */
  lastUpdatedAt: string
}
