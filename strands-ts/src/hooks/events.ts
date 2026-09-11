import type { LocalAgent, AgentResult, InvocationState, InvokeArgs } from '../types/agent.js'
import type { ContentBlock, Message, StopReason, ToolResultBlock } from '../types/messages.js'
import { type Tool, ToolStreamEvent } from '../tools/tool.js'
import type { JSONValue } from '../types/json.js'
import type { ModelStreamEvent } from '../models/streaming.js'
import type { Model } from '../models/model.js'
import { interruptFromAgent, type Interrupt, type Interruptible } from '../interrupt.js'
import type { InterruptParams } from '../types/interrupt.js'

/**
 * Agent hook events.
 *
 * All events extend {@link StreamEvent} with a `readonly type` discriminator
 * (camelCase of the class name) for switch-based narrowing. Constructor takes
 * a single data-object parameter. Most properties are readonly — writable fields
 * are the hook-driven control/data fields documented per event
 * (e.g. `cancel`, `retry`, `selectedTool`, `resume`, and mutable `toolUse` / `result`).
 *
 * All current events extend {@link HookableEvent} (which itself extends {@link StreamEvent}),
 * making them both streamable and subscribable via hook callbacks. {@link StreamEvent} exists
 * as the base class for potential future events that should be stream-only without hookability.
 *
 * ## Event categories
 *
 * **Lifecycle events** — Before/After pairs that bracket agent operations.
 * - Naming: `Before<Noun>Event` / `After<Noun>Event`
 * - `After*` events override `_shouldReverseCallbacks()` → `true` for cleanup ordering.
 * - Examples: {@link BeforeInvocationEvent}/{@link AfterInvocationEvent},
 *   {@link BeforeModelCallEvent}/{@link AfterModelCallEvent},
 *   {@link BeforeToolsEvent}/{@link AfterToolsEvent},
 *   {@link BeforeToolCallEvent}/{@link AfterToolCallEvent}
 *
 * **State-change events** — Signal that agent state was mutated.
 * - Naming: `<Noun><PastTense>Event`
 * - Examples: {@link InitializedEvent}, {@link MessageAddedEvent}
 *
 * **Data events** — Wrap data objects produced during agent execution.
 * Two sub-categories:
 *
 *   *Update events* — wrap transient streaming data from lower layers.
 *   - Naming: `<Source>StreamUpdateEvent`, payload field: `.event`
 *   - Examples: {@link ModelStreamUpdateEvent}, {@link ToolStreamUpdateEvent}
 *
 *   *Completion events* — wrap finished data after processing completes.
 *   - Naming: descriptive `<Noun>Event`, payload field matches data type
 *     (`.result` for results, `.message` for messages, `.contentBlock` for content blocks).
 *   - Examples: {@link ContentBlockEvent}, {@link ModelMessageEvent},
 *     {@link ToolResultEvent}, {@link AgentResultEvent}
 *
 * ## Field naming conventions
 *
 * | Field              | Usage                                            |
 * |--------------------|--------------------------------------------------|
 * | `agent`            | `LocalAgent` reference on all agent-loop events  |
 * | `invocationState`  | Per-invocation state — see below                 |
 * | `.event`           | Inner event in update wrappers                   |
 * | `.result`          | Finished result object                           |
 * | `.message`         | Message object                                   |
 * | `.contentBlock`    | Content block object                             |
 *
 * ## `invocationState` on events
 *
 * Every hookable event that fires **during** an invocation carries
 * {@link InvocationState} — the per-invocation mutable bag shared across hooks
 * and tools. This lets any callback (lifecycle, data, streaming, completion)
 * correlate back to the caller's request context (`userId`, `traceId`, etc.)
 * without closure workarounds.
 *
 * The only events without `invocationState` are the ones that fire **outside**
 * any invocation scope: {@link InitializedEvent} and `MultiAgentInitializedEvent`,
 * both of which fire at construction.
 *
 * New events should follow the same rule: carry `invocationState` unless the
 * event fires before any invocation exists.
 */

/**
 * Base class for all events yielded by `agent.stream()`.
 * Carries no hookability — subclasses that should be hookable extend {@link HookableEvent} instead.
 */
export abstract class StreamEvent {}

/**
 * Base class for events that can be subscribed to via the hook system.
 * Only events extending this class are dispatched to {@link HookRegistry} callbacks.
 * All current events extend this class. {@link StreamEvent} exists as the base for
 * potential future stream-only events that should not be hookable.
 */
export abstract class HookableEvent extends StreamEvent {
  /**
   * @internal
   * Check if callbacks should be reversed for this event.
   * Used by HookRegistry for callback ordering.
   */
  _shouldReverseCallbacks(): boolean {
    return false
  }
}

/**
 * Mutable tool-use descriptor carried on tool-call hook events.
 * Matches the shape of the tool use block the model emitted; hooks on
 * {@link BeforeToolCallEvent} may mutate its fields (or reassign the object)
 * to rewrite the input or tool name before the tool executes. The model-issued
 * tool-use ID remains the authoritative provider correlation key.
 */
export interface ToolUseData {
  name: string
  toolUseId: string
  input: JSONValue
}

/**
 * Event triggered when an agent has finished initialization.
 * Fired after the agent has been fully constructed and all built-in components have been initialized.
 */
export class InitializedEvent extends HookableEvent {
  readonly type = 'initializedEvent' as const
  readonly agent: LocalAgent

  constructor(data: { agent: LocalAgent }) {
    super()
    this.agent = data.agent
  }

  /**
   * Serializes for wire transport, excluding the agent reference.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<InitializedEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered at the beginning of a new agent request.
 * Fired before any model inference or tool execution occurs.
 */
export class BeforeInvocationEvent extends HookableEvent {
  readonly type = 'beforeInvocationEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to cancel this invocation.
   * When set to `true`, a default cancel message is used.
   * When set to a string, that string is used as the assistant response message.
   */
  cancel: boolean | string = false

  constructor(data: { agent: LocalAgent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BeforeInvocationEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered at the end of an agent request.
 * Fired after all processing completes, regardless of success or error.
 * Uses reverse callback ordering for proper cleanup semantics.
 */
export class AfterInvocationEvent extends HookableEvent {
  readonly type = 'afterInvocationEvent' as const
  readonly agent: LocalAgent
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to trigger a follow-up agent invocation with new input.
   * When set, after this event's callbacks complete the agent re-enters its loop
   * with these args as new input, under the same invocation lock. A fresh
   * {@link BeforeInvocationEvent}/{@link AfterInvocationEvent} pair fires for the
   * resumed run. Ignored if the invocation ended with an error.
   *
   * If multiple callbacks set `resume`, the last callback to run wins.
   */
  resume: InvokeArgs | undefined = undefined

  constructor(data: { agent: LocalAgent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.invocationState = data.invocationState
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference, invocationState,
   * and mutable resume field.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<AfterInvocationEvent, 'type'> {
    return { type: this.type }
  }
}

/**
 * Event triggered when the framework adds a message to the conversation history.
 * Fired for user input, assistant responses, and tool-result messages added
 * during agent execution. Does not fire for messages preloaded via
 * `AgentConfig.messages` or messages manually pushed to `agent.messages`.
 */
export class MessageAddedEvent extends HookableEvent {
  readonly type = 'messageAddedEvent' as const
  readonly agent: LocalAgent
  readonly message: Message
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; message: Message; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.message = data.message
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<MessageAddedEvent, 'type' | 'message'> {
    return { type: this.type, message: this.message }
  }
}

/**
 * Event triggered just before a tool is executed.
 * Fired after tool lookup but before execution begins.
 *
 * Hook callbacks can:
 * - Set {@link cancel} to prevent the tool from executing.
 * - Set {@link selectedTool} to execute a different tool in place of the registry's match.
 * - Mutate {@link toolUse} in place, or replace it wholesale, to rewrite the tool
 *   input or name before execution. If `name` is changed and `selectedTool` is
 *   not set, the tool is re-resolved from the registry under the new name.
 */
export class BeforeToolCallEvent extends HookableEvent implements Interruptible {
  readonly type = 'beforeToolCallEvent' as const
  readonly agent: LocalAgent
  toolUse: ToolUseData
  readonly tool: Tool | undefined
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to cancel this tool call.
   * When set to `true`, a default cancel message is used.
   * When set to a string, that string is used as the tool result error message.
   */
  cancel: boolean | string = false

  /**
   * Set by hook callbacks to execute a replacement tool instead of {@link tool}.
   * When undefined, the tool looked up from the registry (or re-resolved from a
   * mutated `toolUse.name`) is used.
   *
   * If multiple callbacks set `selectedTool`, the last callback to run wins.
   * Callbacks run in registration order for this event, so the last-registered
   * callback's value is the one used.
   */
  selectedTool: Tool | undefined = undefined

  constructor(data: {
    agent: LocalAgent
    toolUse: ToolUseData
    tool: Tool | undefined
    invocationState: InvocationState
  }) {
    super()
    this.agent = data.agent
    this.toolUse = data.toolUse
    this.tool = data.tool
    this.invocationState = data.invocationState
  }

  /**
   * Raises an interrupt for human-in-the-loop workflows.
   * If a response is available (from a previous resume), returns it immediately.
   * Otherwise, throws an InterruptError to halt agent execution.
   *
   * @param params - Interrupt parameters including name and optional reason
   * @returns The user's response when resuming from an interrupt
   */
  interrupt<T = JSONValue>(params: InterruptParams): T {
    return interruptFromAgent<T>(
      this.agent,
      `hook:beforeToolCall:${this.toolUse.toolUseId}:${params.name}`,
      params,
      'hook'
    )
  }

  /**
   * Serializes for wire transport, excluding the agent reference, tool instance,
   * invocationState, and mutable cancel / selectedTool fields.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BeforeToolCallEvent, 'type' | 'toolUse'> {
    return { type: this.type, toolUse: this.toolUse }
  }
}

/**
 * Event triggered after a tool execution completes.
 * Fired after tool execution finishes, whether successful or failed.
 * Uses reverse callback ordering for proper cleanup semantics.
 *
 * Hook callbacks can mutate {@link result} to rewrite the tool result before it
 * propagates to the model (e.g. to redact or truncate output).
 */
export class AfterToolCallEvent extends HookableEvent {
  readonly type = 'afterToolCallEvent' as const
  readonly agent: LocalAgent
  readonly toolUse: ToolUseData
  readonly tool: Tool | undefined

  /**
   * The tool result. Can be replaced by hook callbacks to transform the result
   * before it enters the conversation history.
   */
  result: ToolResultBlock

  readonly error?: Error
  readonly invocationState: InvocationState

  /**
   * Optional flag that can be set by hook callbacks to request a retry of the tool call.
   * When set to true, the agent will re-execute the tool.
   */
  retry?: boolean

  constructor(data: {
    agent: LocalAgent
    toolUse: ToolUseData
    tool: Tool | undefined
    result: ToolResultBlock
    invocationState: InvocationState
    error?: Error
  }) {
    super()
    this.agent = data.agent
    this.toolUse = data.toolUse
    this.tool = data.tool
    this.result = data.result
    this.invocationState = data.invocationState
    if (data.error !== undefined) {
      this.error = data.error
    }
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference, tool instance, invocationState, and mutable retry flag.
   * Converts Error to an extensible object for safe wire serialization.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<AfterToolCallEvent, 'type' | 'toolUse' | 'result'> & { error?: { message?: string } } {
    return {
      type: this.type,
      toolUse: this.toolUse,
      result: this.result,
      ...(this.error !== undefined && { error: { message: this.error.message } }),
    }
  }
}

/**
 * Event triggered just before the model is invoked.
 * Fired before sending messages to the model for inference.
 */
export class BeforeModelCallEvent extends HookableEvent {
  readonly type = 'beforeModelCallEvent' as const
  readonly agent: LocalAgent
  readonly model: Model
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to cancel this model call.
   * When set to `true`, a default cancel message is used.
   * When set to a string, that string is used as the assistant response message.
   */
  cancel: boolean | string = false

  /**
   * Projected input token count for the upcoming model call.
   * Computed by the agent loop from message metadata and token estimation.
   * Available for hooks and plugins (e.g. conversation managers) to make
   * proactive decisions about context management.
   */
  readonly projectedInputTokens?: number

  constructor(data: {
    agent: LocalAgent
    model: Model
    invocationState: InvocationState
    projectedInputTokens?: number
  }) {
    super()
    this.agent = data.agent
    this.model = data.model
    this.invocationState = data.invocationState
    if (data.projectedInputTokens !== undefined) {
      this.projectedInputTokens = data.projectedInputTokens
    }
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BeforeModelCallEvent, 'type' | 'projectedInputTokens'> {
    return {
      type: this.type,
      ...(this.projectedInputTokens !== undefined && { projectedInputTokens: this.projectedInputTokens }),
    }
  }
}

/**
 * Redaction information when guardrails block content.
 */
export interface Redaction {
  /**
   * The text to replace the user message with.
   * When present, indicates the last user message should be redacted with this text.
   */
  userMessage: string
}

/**
 * Response from a model invocation containing the message and stop reason.
 */
export interface ModelStopData {
  /**
   * The message returned by the model.
   */
  readonly message: Message
  /**
   * The reason the model stopped generating.
   */
  readonly stopReason: StopReason
  /**
   * Optional redaction info when guardrails blocked input.
   * When present, indicates the last user message was redacted.
   * The redacted message is available in `agent.messages` (last message).
   */
  readonly redaction?: Redaction
}

/**
 * Event triggered after the model invocation completes.
 * Fired after the model finishes generating a response, whether successful or failed.
 * Uses reverse callback ordering for proper cleanup semantics.
 *
 * Note: stopData may be undefined if an error occurs before the model completes.
 */
export class AfterModelCallEvent extends HookableEvent {
  readonly type = 'afterModelCallEvent' as const
  readonly agent: LocalAgent
  readonly model: Model
  readonly stopData?: ModelStopData
  readonly error?: Error
  readonly invocationState: InvocationState

  /**
   * 1-indexed count of model attempts for this turn, including the attempt
   * that just completed (or failed). The first call in a turn is `1`; each
   * subsequent retry increments by one.
   *
   * Retry strategies may rely on `attemptCount === 1` to mark the start of a
   * new retry sequence (e.g. to clear per-turn state carried over from a
   * previous turn). The agent loop guarantees this marker on every fresh turn.
   */
  readonly attemptCount: number

  /**
   * Optional flag that can be set by hook callbacks to request a retry of the model call.
   * When set to true, the agent will retry the model invocation.
   */
  retry?: boolean

  constructor(data: {
    agent: LocalAgent
    model: Model
    invocationState: InvocationState
    attemptCount: number
    stopData?: ModelStopData
    error?: Error
  }) {
    super()
    this.agent = data.agent
    this.model = data.model
    this.invocationState = data.invocationState
    this.attemptCount = data.attemptCount
    if (data.stopData !== undefined) {
      this.stopData = data.stopData
    }
    if (data.error !== undefined) {
      this.error = data.error
    }
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference, invocationState, and mutable retry flag.
   * Converts Error to an extensible object for safe wire serialization.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<AfterModelCallEvent, 'type' | 'stopData' | 'attemptCount'> & { error?: { message?: string } } {
    return {
      type: this.type,
      attemptCount: this.attemptCount,
      ...(this.stopData !== undefined && { stopData: this.stopData }),
      ...(this.error !== undefined && { error: { message: this.error.message } }),
    }
  }
}

/**
 * Event triggered for each streaming event from the model.
 * Wraps a {@link ModelStreamEvent} (transient streaming delta) during model inference.
 * Completed content blocks are handled separately by {@link ContentBlockEvent}
 * because they represent different granularities: partial deltas vs fully assembled results.
 */
export class ModelStreamUpdateEvent extends HookableEvent {
  readonly type = 'modelStreamUpdateEvent' as const
  readonly agent: LocalAgent
  readonly event: ModelStreamEvent
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; event: ModelStreamEvent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.event = data.event
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<ModelStreamUpdateEvent, 'type' | 'event'> {
    return { type: this.type, event: this.event }
  }
}

/**
 * Event triggered when a content block completes during model inference.
 * Wraps completed content blocks (TextBlock, ToolUseBlock, ReasoningBlock) from model streaming.
 * This is intentionally separate from {@link ModelStreamUpdateEvent}. The model's
 * `streamAggregated()` yields two kinds of output: {@link ModelStreamEvent} (transient
 * streaming deltas — partial data arriving while the model generates) and
 * {@link ContentBlock} (fully assembled results after all deltas accumulate).
 * These represent different granularities with different semantics, so they are
 * wrapped in distinct event classes rather than combined into a single event.
 */
export class ContentBlockEvent extends HookableEvent {
  readonly type = 'contentBlockEvent' as const
  readonly agent: LocalAgent
  readonly contentBlock: ContentBlock
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; contentBlock: ContentBlock; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.contentBlock = data.contentBlock
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<ContentBlockEvent, 'type' | 'contentBlock'> {
    return { type: this.type, contentBlock: this.contentBlock }
  }
}

/**
 * Event triggered when the model completes a full message.
 * Wraps the assembled message and stop reason after model streaming finishes.
 */
export class ModelMessageEvent extends HookableEvent {
  readonly type = 'modelMessageEvent' as const
  readonly agent: LocalAgent
  readonly message: Message
  readonly stopReason: StopReason
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; message: Message; stopReason: StopReason; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.message = data.message
    this.stopReason = data.stopReason
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<ModelMessageEvent, 'type' | 'message' | 'stopReason'> {
    return { type: this.type, message: this.message, stopReason: this.stopReason }
  }
}

/**
 * Event triggered when a tool execution completes.
 * Wraps the tool result block after a tool finishes execution.
 */
export class ToolResultEvent extends HookableEvent {
  readonly type = 'toolResultEvent' as const
  readonly agent: LocalAgent
  readonly result: ToolResultBlock
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; result: ToolResultBlock; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.result = data.result
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<ToolResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/**
 * Event triggered for each streaming progress event from a tool during execution.
 * Wraps a {@link ToolStreamEvent} with agent context, keeping the tool authoring
 * interface unchanged — tools construct `ToolStreamEvent` without knowledge of agents
 * or hooks, and the agent layer wraps them at the boundary.
 *
 * Consistent with {@link ModelStreamUpdateEvent} which wraps model streaming events
 * the same way.
 */
export class ToolStreamUpdateEvent extends HookableEvent {
  readonly type = 'toolStreamUpdateEvent' as const
  readonly agent: LocalAgent
  readonly event: ToolStreamEvent
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; event: ToolStreamEvent; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.event = data.event
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<ToolStreamUpdateEvent, 'type' | 'event'> {
    return { type: this.type, event: this.event }
  }
}

/**
 * Event triggered as the final event in the agent stream.
 * Wraps the agent result containing the stop reason and last message.
 */
export class AgentResultEvent extends HookableEvent {
  readonly type = 'agentResultEvent' as const
  readonly agent: LocalAgent
  readonly result: AgentResult
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; result: AgentResult; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.result = data.result
    this.invocationState = data.invocationState
  }

  /**
   * Serializes for wire transport, excluding the agent reference and invocationState.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<AgentResultEvent, 'type' | 'result'> {
    return { type: this.type, result: this.result }
  }
}

/**
 * Event emitted when an interrupt is raised during agent execution. The `interrupt.source`
 * field discriminates between tool-callback and hook-callback origins. One event fires
 * per unanswered interrupt at the moment the agent stops to wait for responses.
 */
export class InterruptEvent extends HookableEvent {
  readonly type = 'interruptEvent' as const
  readonly agent: LocalAgent
  readonly interrupt: Interrupt
  readonly invocationState: InvocationState

  constructor(data: { agent: LocalAgent; interrupt: Interrupt; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.interrupt = data.interrupt
    this.invocationState = data.invocationState
  }

  /** Serializes for wire transport, excluding agent and invocationState. */
  toJSON(): Pick<InterruptEvent, 'type'> & { interrupt: ReturnType<Interrupt['toJSON']> } {
    return { type: this.type, interrupt: this.interrupt.toJSON() }
  }
}

/**
 * Event triggered before executing tools.
 * Fired when the model returns tool use blocks that need to be executed.
 * Hook callbacks can set {@link cancel} to prevent all tools from executing.
 */
export class BeforeToolsEvent extends HookableEvent implements Interruptible {
  readonly type = 'beforeToolsEvent' as const
  readonly agent: LocalAgent
  readonly message: Message
  readonly invocationState: InvocationState

  /**
   * Set by hook callbacks to cancel all tool calls.
   * When set to `true`, a default cancel message is used.
   * When set to a string, that string is used as the tool result error message.
   */
  cancel: boolean | string = false

  constructor(data: { agent: LocalAgent; message: Message; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.message = data.message
    this.invocationState = data.invocationState
  }

  /**
   * Raises an interrupt for human-in-the-loop workflows.
   * If a response is available (from a previous resume), returns it immediately.
   * Otherwise, throws an InterruptError to halt agent execution.
   *
   * @param params - Interrupt parameters including name and optional reason
   * @returns The user's response when resuming from an interrupt
   */
  interrupt<T = JSONValue>(params: InterruptParams): T {
    return interruptFromAgent<T>(this.agent, `hook:beforeTools:${params.name}`, params, 'hook')
  }

  /**
   * Serializes for wire transport, excluding the agent reference, invocationState, and mutable cancel flag.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<BeforeToolsEvent, 'type' | 'message'> {
    return { type: this.type, message: this.message }
  }
}

/**
 * Event triggered after all tools complete execution.
 * Fired after tool results are collected and ready to be added to conversation.
 * Uses reverse callback ordering for proper cleanup semantics.
 */
export class AfterToolsEvent extends HookableEvent {
  readonly type = 'afterToolsEvent' as const
  readonly agent: LocalAgent
  readonly message: Message
  readonly invocationState: InvocationState

  /**
   * When set to `true`, the agent loop halts after this tool batch completes
   * without calling the model again and a default message
   * (`"Turn ended early by hook after tool execution"`) is appended as the
   * final assistant message. When set to a string, that string is used instead
   * of the default — the string becomes literal assistant content (a
   * `TextBlock`), not a reason or label. When set to a `ContentBlock[]`, those
   * blocks become the final assistant message content directly (shallow-copied).
   * Contrast with {@link BeforeToolCallEvent.cancel | cancel} fields on other events,
   * where the string is a cancellation reason.
   *
   * In all cases `stopReason` on the returned `AgentResult` is `'endTurn'`.
   */
  endTurn: boolean | string | ContentBlock[] = false

  constructor(data: { agent: LocalAgent; message: Message; invocationState: InvocationState }) {
    super()
    this.agent = data.agent
    this.message = data.message
    this.invocationState = data.invocationState
  }

  override _shouldReverseCallbacks(): boolean {
    return true
  }

  /**
   * Serializes for wire transport, excluding the agent reference, invocationState,
   * and mutable endTurn field.
   * Called automatically by JSON.stringify().
   */
  toJSON(): Pick<AfterToolsEvent, 'type' | 'message'> {
    return { type: this.type, message: this.message }
  }
}
