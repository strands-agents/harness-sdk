/** Raised when a background task ID is not found. @internal */
export class BackgroundTaskNotFoundError extends Error {
  /**
   * @param taskId - ID that could not be found.
   */
  constructor(taskId: string) {
    super(`Background task '${taskId}' was not found`)
    this.name = 'BackgroundTaskNotFoundError'
  }
}

/** Raised when waiting for background tasks exceeds the configured timeout. @internal */
export class BackgroundTaskTimeoutError extends Error {
  /**
   * @param timeout - Wait timeout in milliseconds.
   */
  constructor(timeout: number) {
    super(`Timed out waiting for background tasks after ${timeout}ms`)
    this.name = 'BackgroundTaskTimeoutError'
  }
}
