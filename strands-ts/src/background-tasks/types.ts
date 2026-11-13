import type { Interrupt } from '../interrupt.js'
import type { Tool } from '../tools/tool.js'
import type { ToolResultContentData } from '../types/messages.js'

/** Configures background tool execution. */
export interface BackgroundTasksConfig {
  /**
   * Wait for background work before an invocation returns. Defaults to `true`.
   * Skipped while another invocation is queued: the queued caller runs immediately
   * and outstanding task results are delivered during a later invocation's passes.
   */
  readonly waitForCompletion?: boolean
  /** Tools or registered tool names whose execution mode is selected by the model. Defaults to `['*']`. */
  readonly agentic?: readonly (Tool | string)[]
  /** Tools or registered tool names that always execute in the background. */
  readonly always?: readonly (Tool | string)[]
  /** Tools or registered tool names that never execute in the background. */
  readonly never?: readonly (Tool | string)[]
  /** Maximum number of physically executing background tasks. Defaults to `4`. */
  readonly maxConcurrency?: number
  /** Per-execution timeout in milliseconds. Defaults to `Infinity`. */
  readonly timeout?: number
}

/** Background task lifecycle status. @internal */
export type BackgroundTaskStatus = 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

/** Background task failure category. @internal */
export type BackgroundTaskFailureType = 'toolError' | 'executionError' | 'timeout'

/** Read-only snapshot of a background task. @internal */
export interface BackgroundTask {
  /** Stable identifier for task inspection and cancellation. */
  readonly taskId: string
  /** Tool-use identifier from the original model request. */
  readonly toolUseId: string
  /** Tool name from the original model request. */
  readonly toolName: string
  /** Current task lifecycle status. */
  readonly status: BackgroundTaskStatus
  /** ISO timestamp recorded when the task was admitted. */
  readonly createdAt: string
  /** ISO timestamp recorded at the latest task state change. */
  readonly lastUpdatedAt: string
  /** Tool result when execution produced one. */
  readonly result?: {
    /** Tool-result content blocks. */
    readonly content: readonly ToolResultContentData[]
  }
  /** Task failure details. */
  readonly error?: {
    /** Failure category. */
    readonly type: BackgroundTaskFailureType
    /** Failure message. */
    readonly message: string
  }
  /** Unanswered interrupts when the task requires input. */
  readonly interrupts?: readonly Readonly<Interrupt>[]
}

/**
 * Checks whether a background task status is terminal.
 *
 * @param status - Status to check.
 * @returns Whether the status is terminal.
 * @internal
 */
export function isTaskStatusTerminal(status: BackgroundTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
