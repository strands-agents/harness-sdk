import type { ToolUseData } from '../hooks/events.js'
import type { Tool } from '../tools/tool.js'
import type { InvocationState } from '../types/agent.js'
import type { InterruptResponse } from '../types/interrupt.js'
import type { BackgroundTask } from './types.js'

/** Background task lifecycle operations used by an Agent integration. @internal */
export interface BackgroundTaskManager {
  /**
   * Submits an approved tool call for background execution.
   *
   * Repeated submission of the same pending tool call returns its existing task; removing that task allows the
   * submission to create a new task.
   */
  submit(
    toolUse: Readonly<ToolUseData>,
    invocationState: InvocationState,
    passId: string,
    tool: Tool
  ): Promise<BackgroundTask>
  /** Gets one task by its stable identifier. */
  get(taskId: string): Promise<BackgroundTask | undefined>
  /** Lists the tasks currently tracked by the manager. */
  list(): Promise<readonly BackgroundTask[]>
  /** Whether the manager is tracking any tasks (including terminal ones not yet removed). */
  hasTasks(): boolean
  /**
   * Requests cancellation of one task.
   *
   * @throws BackgroundTaskNotFoundError if the task does not exist.
   */
  cancel(taskId: string): Promise<BackgroundTask>
  /**
   * Waits until one task requires input or reaches a terminal state.
   *
   * @throws BackgroundTaskNotFoundError if the task does not exist.
   */
  wait(taskId: string): Promise<BackgroundTask>
  /**
   * Waits until the manager has no queued or executing tasks.
   *
   * Tasks in `input_required` do not block this wait.
   *
   * @throws TypeError if the timeout is invalid.
   * @throws BackgroundTaskTimeoutError if the configured wait timeout elapses.
   */
  waitForIdle(options?: { readonly timeout?: number }): Promise<void>
  /**
   * Applies interrupt responses to one task that requires input.
   *
   * @throws BackgroundTaskNotFoundError if the task does not exist.
   * @throws Error if the task cannot accept the interrupt responses.
   */
  resume(taskId: string, responses: readonly InterruptResponse[]): Promise<BackgroundTask>
  /**
   * Removes terminal tasks.
   *
   * @throws BackgroundTaskNotFoundError if a task does not exist.
   * @throws Error if a task has not reached a terminal state.
   */
  remove(taskIds: readonly string[]): Promise<void>
}
