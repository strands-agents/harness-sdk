/**
 * Error types for the Strands Agents TypeScript SDK.
 *
 * These error classes represent specific error conditions that can occur
 * during agent execution and model provider interactions.
 */

import type { Message } from './types/messages.js'
import type { JSONValue } from './types/json.js'

/**
 * Base exception class for all model-related errors.
 *
 * This class serves as the common base type for errors that originate from
 * model provider interactions. By catching ModelError, consumers can handle
 * all model-related errors uniformly while still having access to specific
 * error types through instanceof checks.
 */
export class ModelError extends Error {
  /**
   * Creates a new ModelError.
   *
   * @param message - Error message describing the model error
   * @param options - Optional error options including the cause
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ModelError'
  }
}

/**
 * Error thrown when input exceeds the model's context window.
 *
 * This error indicates that the combined length of the input (prompt, messages,
 * system prompt, and tool definitions) exceeds the maximum context window size
 * supported by the model.
 */
export class ContextWindowOverflowError extends ModelError {
  /**
   * Creates a new ContextWindowOverflowError.
   *
   * @param message - Error message describing the context overflow
   */
  constructor(message: string) {
    super(message)
    this.name = 'ContextWindowOverflowError'
  }
}

/**
 * Error thrown when the model reaches its maximum token limit during generation.
 *
 * This error indicates that the model stopped generating content because it reached
 * the maximum number of tokens allowed for the response. This is an unrecoverable
 * state that requires intervention, such as reducing the input size or adjusting
 * the max tokens parameter.
 */
export class MaxTokensError extends ModelError {
  /**
   * The partial assistant message that was generated before hitting the token limit.
   * This can be useful for understanding what the model was trying to generate.
   */
  public readonly partialMessage: Message

  /**
   * Creates a new MaxTokensError.
   *
   * @param message - Error message describing the max tokens condition
   * @param partialMessage - The partial assistant message generated before the limit
   */
  constructor(message: string, partialMessage: Message) {
    super(message)
    this.name = 'MaxTokensError'
    this.partialMessage = partialMessage
  }
}

/**
 * Error thrown when attempting to serialize a value that is not JSON-serializable.
 *
 * This error indicates that a value contains non-serializable types such as functions,
 * symbols, or undefined values that cannot be converted to JSON.
 */
export class JsonValidationError extends Error {
  /**
   * Creates a new JsonValidationError.
   *
   * @param message - Error message describing the validation failure
   */
  constructor(message: string) {
    super(message)
    this.name = 'JsonValidationError'
  }
}

/**
 * Error thrown when attempting to invoke an agent that is already processing an invocation.
 *
 * This error indicates that invoke() or stream() was called while the agent is already
 * executing. Agents can only process one invocation at a time to prevent state corruption.
 */
export class ConcurrentInvocationError extends Error {
  /**
   * Creates a new ConcurrentInvocationError.
   *
   * @param message - Error message describing the concurrent invocation attempt
   */
  constructor(message: string) {
    super(message)
    this.name = 'ConcurrentInvocationError'
  }
}

/**
 * Error a queued invoke() or stream() call rejects with when it is removed from the
 * agent's invocation queue before running.
 */
export class PendingInvocationCancelledError extends Error {
  /** The queue id of the cancelled invocation. */
  readonly pendingInvocationId: string

  constructor(pendingInvocationId: string) {
    super(`Queued invocation ${pendingInvocationId} was cancelled before it ran`)
    this.name = 'PendingInvocationCancelledError'
    this.pendingInvocationId = pendingInvocationId
  }
}

/**
 * Error thrown when a model provider returns a throttling or rate limit error.
 *
 * This error indicates that the model API has rate limited the request. Users can
 * handle this error in hooks to implement custom retry strategies using the
 * `AfterModelCallEvent.retry` mechanism.
 */
export class ModelThrottledError extends ModelError {
  /**
   * Creates a new ModelThrottledError.
   *
   * @param message - Error message describing the throttling condition
   * @param options - Optional error options including cause for error chaining
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelThrottledError'
  }
}

/**
 * Normalizes an unknown error value to an Error instance.
 *
 * This helper ensures that any thrown value (Error, string, number, etc.)
 * is converted to a proper Error object for consistent error handling.
 *
 * @param error - The error value to normalize
 * @returns An Error instance
 */
export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Serializes an Error to a JSON-compatible value.
 * Use {@link normalizeError} for the reverse direction.
 */
export function serializeError(error: Error): JSONValue {
  return error.message
}

/**
 * Error thrown when session operations fail.
 *
 * This error indicates failures in session storage operations such as
 * reading, writing, or managing session data.
 */
export class SessionError extends Error {
  /**
   * Creates a new SessionError.
   *
   * @param message - Error message describing the session error
   * @param options - Optional error options including cause for error chaining
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionError'
  }
}

/**
 * Thrown when a model provider's native token counting API fails.
 *
 * This error is used as internal control flow within provider `countTokens()` overrides.
 * When caught, the provider falls back to the base class heuristic estimation.
 */
export class ProviderTokenCountError extends ModelError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProviderTokenCountError'
  }
}

/**
 * Thrown when a tool fails validation during registration.
 */
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolValidationError'
  }
}

/**
 * Thrown when the model fails to produce structured output.
 * This occurs when the LLM refuses to use the structured output tool
 * even after being forced via toolChoice.
 */
export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StructuredOutputError'
  }
}

/**
 * Error thrown when a tool cannot be found by name.
 *
 * Thrown by {@link ToolRegistry.resolve} when the requested tool name doesn't
 * match any registered tool, even after underscore-to-hyphen normalization
 * and case-insensitive matching.
 */
export class ToolNotFoundError extends Error {
  /** The tool name that was requested but not found. */
  public readonly toolName: string

  /**
   * Creates a new ToolNotFoundError.
   *
   * @param toolName - The tool name that was not found
   */
  constructor(toolName: string) {
    super(`Tool '${toolName}' not found`)
    this.name = 'ToolNotFoundError'
    this.toolName = toolName
  }
}

/**
 * Internal control-flow mechanism for unwinding nested `yield*` generator chains
 * when cancellation is detected during model streaming.
 * Caught at the `_stream()` level and converted to an `AgentResult` with `stopReason: 'cancelled'`.
 * Not exported from the package — never thrown to users.
 */
export class CancelledError extends Error {
  constructor() {
    super('Agent invocation cancelled')
    this.name = 'CancelledError'
  }
}

/**
 * Thrown when a default value is read before one has been configured.
 *
 * Catch it to distinguish a missing-default condition from other runtime errors.
 */
export class DefaultNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefaultNotConfiguredError'
  }
}

/**
 * Error thrown when a storage operation fails.
 *
 * Wraps backend-specific errors (filesystem, S3, network) with a uniform type
 * that consumers can catch without knowing which backend is in use.
 */
export class StorageError extends Error {
  /**
   * Creates a new StorageError.
   *
   * @param message - Error message describing the storage failure
   * @param options - Optional error options including cause for error chaining
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageError'
  }
}

/**
 * Error thrown when checkpoint operations fail (e.g. an incompatible schema
 * version when resuming a durable run). See the experimental checkpoint module.
 */
export class CheckpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
}
