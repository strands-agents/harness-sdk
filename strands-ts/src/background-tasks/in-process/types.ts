import type { InterruptStateData } from '../../interrupt.js'
import type { ToolResultBlockData } from '../../types/messages.js'
import type { BackgroundTaskFailureType, BackgroundTaskStatus } from '../types.js'

/** Options and callbacks for bounded in-process task execution. @internal */
export interface InProcessTaskEngineOptions {
  /** Maximum number of task executions that may run concurrently. */
  readonly maxConcurrency: number
  /** Per-execution timeout in milliseconds, or `Infinity` to disable timeouts. */
  readonly timeout: number
  /** Runs one task execution and returns whether it completed, requires input, or failed. */
  readonly execute: (context: InProcessTaskExecutionContext) => Promise<InProcessTaskExecutionOutcome>
  /** Receives committed task updates without blocking or failing the engine. */
  readonly onTaskUpdated: (task: InProcessTaskRecord) => void
}

/** Context supplied to one in-process task execution. @internal */
export interface InProcessTaskExecutionContext {
  /** Identifier of the logical task. */
  readonly taskId: string
  /** Identifier of the tool use. */
  readonly toolUseId: string
  /** Tool name from the original model request. */
  readonly toolName: string
  /** Identifier of the manager-owned live execution state. */
  readonly invocationStateId: string
  /** Interrupt state supplied when resuming a task that requires input. */
  readonly state?: InterruptStateData
  /** Signal aborted when this execution should stop. */
  readonly cancelSignal: AbortSignal
}

/** Outcome returned by one in-process task execution. @internal */
export type InProcessTaskExecutionOutcome =
  | {
      readonly status: 'completed'
      readonly result: ToolResultBlockData
    }
  | {
      readonly status: 'input_required'
      readonly state: InterruptStateData
    }
  | {
      readonly status: 'failed'
      readonly failure: {
        readonly type: BackgroundTaskFailureType
        readonly message: string
      }
      readonly result?: ToolResultBlockData
    }

/** In-process task record. @internal */
export interface InProcessTaskRecord {
  /** Identifier of the logical task. */
  readonly taskId: string
  /** Identifier of the tool use. */
  readonly toolUseId: string
  /** Tool name from the original model request. */
  readonly toolName: string
  /** Identifier of the manager-owned live execution state. */
  readonly invocationStateId: string
  /** Current task lifecycle status. */
  status: BackgroundTaskStatus
  /** Interrupt state, required while the task needs input and retained while resuming. */
  state?: InterruptStateData
  /** Execution result, required while completed and optional while failed. */
  result?: ToolResultBlockData
  /** Failure details recorded when the task fails. */
  failure?: {
    readonly type: BackgroundTaskFailureType
    readonly message: string
  }
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string
  /** ISO-8601 timestamp of the latest transition. */
  lastUpdatedAt: string
}
