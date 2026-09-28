import type { MiddlewareStage } from './types.js'
import type {
  LocalAgent,
  AgentStreamEvent,
  InvocationState,
  InvokeArgs,
  InvokeOptions,
  AgentResult,
} from '../types/agent.js'
import type { Message, SystemPrompt, ToolResultBlock } from '../types/messages.js'
import type { ToolSpec, ToolChoice } from '../tools/types.js'
import type { Model, StreamAggregatedResult } from '../models/model.js'
import type { ToolUseData } from '../hooks/events.js'
import type { Tool } from '../tools/tool.js'
import type { InterruptParams } from '../types/interrupt.js'
import type { JSONValue } from '../types/json.js'

/**
 * Result returned by `interrupt()` in middleware contexts.
 * Returns an object to allow future extension (e.g., cached data, metadata)
 * without a breaking change to callers.
 */
export interface MiddlewareInterruptResult<T = JSONValue> {
  /**
   * The resolved response value from the interrupt.
   * The generic `T` is a caller assertion — the actual value is whatever the user
   * passed in `InterruptResponseContent.response` (a `JSONValue`). No runtime
   * validation is performed; callers are responsible for ensuring the shape matches.
   */
  response: T
}

/**
 * Interface for middleware contexts that support interrupts.
 * Unlike the hook/tool `Interruptible`, middleware interrupts return a wrapper
 * object to allow non-breaking additions in the future.
 */
export interface MiddlewareInterruptible {
  /**
   * Request a human-in-the-loop interrupt.
   *
   * On first execution (no prior response), throws `InterruptError` to halt the agent.
   * On resume (after the user provides a response), returns the response wrapped in
   * `MiddlewareInterruptResult`.
   *
   * @param params - Interrupt parameters (name, optional reason, optional preemptive response)
   * @returns The user's response wrapped in `{ response: T }`
   * @throws InterruptError when no response has been provided yet
   */
  interrupt<T = JSONValue>(params: InterruptParams): MiddlewareInterruptResult<T>
}

/**
 * Creates a new middleware stage token with Input/Wrap/Output phase sub-tokens.
 * The returned object is frozen and used as a Map key by the registry.
 *
 * @param name - Human-readable name for debugging/logging
 * @returns A frozen MiddlewareStage object carrying the Context/Event/Result type parameters
 */
export function createStage<TContext, TResult, TEvent>(name: string): MiddlewareStage<TContext, TResult, TEvent> {
  // Partially constructed; all required fields are assigned via Object.assign before Object.freeze below.
  const stage = { name } as MiddlewareStage<TContext, TResult, TEvent>
  const input = Object.freeze({ _phase: 'input' as const, _stage: stage })
  const wrap = Object.freeze({ _phase: 'wrap' as const, _stage: stage })
  const output = Object.freeze({ _phase: 'output' as const, _stage: stage })
  return Object.freeze(Object.assign(stage, { Input: input, Wrap: wrap, Output: output }))
}

/**
 * Context passed to model-stage middleware.
 * All inputs to the model call are explicit — middleware can inspect and transform
 * any of them by passing a modified context to next(). Collection fields are
 * defensive copies; invocationState and model are shared references.
 */
export interface InvokeModelContext {
  /** The agent instance (escape hatch for advanced use cases). */
  readonly agent: LocalAgent
  /** The model this call invokes. Initialized from agent.model and replaceable per call. */
  readonly model: Model
  /** The messages to send to the model. */
  readonly messages: readonly Message[]
  /** System prompt to guide the model's behavior. */
  readonly systemPrompt?: SystemPrompt
  /** Tool specifications available to the model. */
  readonly toolSpecs: readonly ToolSpec[]
  /** Controls how the model selects tools. */
  readonly toolChoice?: ToolChoice
  /** Per-invocation state. Shared by reference — mutations are visible to hooks, tools, and AgentResult. */
  readonly invocationState: InvocationState
  /** Estimated input token count for this model call, or undefined if estimation failed. */
  readonly projectedInputTokens?: number

  /**
   * How many trailing blocks of the last user message are rebuilt on every call.
   *
   * Producers add to this; a provider placing cache points keeps its own ahead of the
   * count, since a prefix that changes every call is never read back. Counted from the end of the
   * message so it survives a provider's content cleaning, which only drops earlier blocks.
   */
  readonly dynamicTrailingBlocks?: number
}

/**
 * Result from model-stage middleware.
 * The return value of the async generator.
 */
export interface InvokeModelResult {
  /** The aggregated result from the model stream. */
  readonly result: StreamAggregatedResult
}

/**
 * Context passed to tool-stage middleware.
 * Contains everything needed to understand and potentially modify the tool call.
 */
export interface ExecuteToolContext extends MiddlewareInterruptible {
  /** The agent instance (escape hatch for advanced use cases). */
  readonly agent: LocalAgent
  /** The resolved tool implementation, or undefined if not found. */
  readonly tool: Tool | undefined
  /** The tool use request (name, toolUseId, input). */
  readonly toolUse: ToolUseData
  /** Per-invocation state. Shared by reference — mutations are visible to hooks, tools, and AgentResult. */
  readonly invocationState: InvocationState
  /** Executor-owned cancellation signal for this tool call; middleware can observe but cannot replace it. */
  readonly cancelSignal: AbortSignal
}

/**
 * Result from tool-stage middleware.
 * The return value of the async generator.
 */
export interface ExecuteToolResult {
  /** The tool result block from execution. */
  readonly result: ToolResultBlock
}

/**
 * Context passed to agent-stream-stage middleware.
 * Wraps the entire agent output stream at the outermost interception point.
 *
 * @internal Not part of the public API. The contract for this context (particularly
 * around copy vs. reference semantics for `args` and `options`) is not yet finalized.
 */
export interface AgentStreamContext extends MiddlewareInterruptible {
  /** The agent instance (escape hatch for advanced use cases). */
  readonly agent: LocalAgent
  /** The invocation arguments passed to agent.stream(). Shared by reference. */
  readonly args: InvokeArgs
  /** Per-invocation options (cancel signal, structured output, etc.). Shared by reference. */
  readonly options?: InvokeOptions
}

/**
 * Result from agent-stream-stage middleware.
 * The return value of the async generator.
 *
 * @internal Not part of the public API.
 */
export interface AgentStreamResult {
  /** The final agent result from the stream. */
  readonly result: AgentResult
}

/**
 * Built-in stage wrapping core model invocation.
 * Middleware registered for this stage can rate-limit, cache, or transform model inputs.
 */
export const InvokeModelStage = createStage<InvokeModelContext, InvokeModelResult, AgentStreamEvent>('invokeModel')

/**
 * Built-in stage wrapping individual tool execution.
 * Middleware registered for this stage can add telemetry, validate inputs, or mock responses.
 */
export const ExecuteToolStage = createStage<ExecuteToolContext, ExecuteToolResult, AgentStreamEvent>('executeTool')

/**
 * Built-in stage wrapping the entire agent output stream.
 * Middleware registered for this stage can filter, transform, or inject events.
 *
 * @internal Not part of the public API. The context contract for this stage is not
 * yet finalized — particularly around copy vs. reference semantics for args/options.
 */
export const AgentStreamStage = createStage<AgentStreamContext, AgentStreamResult, AgentStreamEvent>('agentStream')
