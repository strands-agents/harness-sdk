"""This module implements the central event loop.

The event loop allows agents to:

1. Process conversation messages
2. Execute tools based on model requests
3. Handle errors and recovery strategies
4. Manage recursive execution cycles
"""

import copy
import logging
import uuid
from collections.abc import AsyncGenerator, Callable
from typing import TYPE_CHECKING, Any

from opentelemetry import trace as trace_api

from .._middleware.stages import InvokeModelContext, InvokeModelStage
from ..agent import _continuation
from ..experimental.checkpoint import Checkpoint, CheckpointPosition
from ..hooks import AfterModelCallEvent, AfterToolsEvent, BeforeModelCallEvent, BeforeToolsEvent
from ..interrupt import InterruptException, PendingToolExecution
from ..telemetry.metrics import Trace, _total_prompt_tokens
from ..telemetry.tracer import Tracer, get_tracer
from ..tools._validator import validate_and_prepare_tools
from ..tools.structured_output._structured_output_context import StructuredOutputContext
from ..types._events import (
    EventLoopStopEvent,
    ForceStopEvent,
    ModelMessageEvent,
    ModelStopReason,
    StartEvent,
    StartEventLoopEvent,
    StructuredOutputEvent,
    ToolInterruptEvent,
    ToolResultEvent,
    ToolResultMessageEvent,
    TypedEvent,
)
from ..types.agent import Limits
from ..types.content import Message, Messages, split_system_prompt
from ..types.event_loop import Metrics, Usage
from ..types.exceptions import (
    ContextWindowOverflowException,
    EventLoopException,
    MaxTokensReachedException,
    StructuredOutputException,
)
from ..types.streaming import StopReason
from ..types.tools import ToolResult, ToolUse
from ._recover_message_on_max_tokens_reached import recover_message_on_max_tokens_reached
from ._retry import ModelRetryStrategy
from .streaming import stream_messages

if TYPE_CHECKING:
    from pydantic import BaseModel

    from ..agent import Agent
    from ..interrupt import Interrupt

logger = logging.getLogger(__name__)

MAX_ATTEMPTS = 6
INITIAL_DELAY = 4
MAX_DELAY = 240  # 4 minutes


def _check_limits(agent: "Agent", limits: Limits | None) -> StopReason | None:
    """Evaluate per-invocation budget caps against the current invocation's metrics.

    Reads from ``EventLoopMetrics.latest_agent_invocation`` (scoped to the current
    invocation) so caps don't fire prematurely on the second invoke against a reused
    agent. Priority on simultaneous trip: turns -> total_tokens -> output_tokens.

    Args:
        agent: The agent whose metrics to read.
        limits: The configured caps, or ``None`` for no caps.

    Returns:
        The matching ``StopReason`` if a cap has been reached, otherwise ``None``.
    """
    if not limits:
        return None
    invocation = agent.event_loop_metrics.latest_agent_invocation
    if invocation is None:
        return None

    cycle_count = len(invocation.cycles)
    output_tokens = invocation.usage.get("outputTokens", 0)
    total_tokens = invocation.usage.get("totalTokens", 0)

    turns_cap = limits.get("turns")
    if turns_cap is not None and cycle_count >= turns_cap:
        return "limit_turns"
    total_cap = limits.get("total_tokens")
    if total_cap is not None and total_tokens >= total_cap:
        return "limit_total_tokens"
    output_cap = limits.get("output_tokens")
    if output_cap is not None and output_tokens >= output_cap:
        return "limit_output_tokens"
    return None


def _has_tool_use_in_latest_message(messages: "Messages") -> bool:
    """Check if the latest message contains any ToolUse content blocks.

    Args:
        messages: List of messages in the conversation.

    Returns:
        True if the latest message contains at least one ToolUse content block, False otherwise.
    """
    if len(messages) > 0:
        latest_message = messages[-1]
        content_blocks = latest_message.get("content", [])

        for content_block in content_blocks:
            if "toolUse" in content_block:
                return True

    return False


async def _estimate_input_tokens(agent: "Agent") -> int:
    """Estimate the input token count for the next model call.

    Reads the total prompt the model processed (including cached tokens) plus outputTokens from the
    last assistant message's metadata as a known baseline, then estimates only new messages added
    after it. Falls back to full estimation when no metadata is available (cold start or first call).
    On cold start, tool specs are resolved lazily so that the caller does not need to resolve them
    before BeforeModelCallEvent.

    Args:
        agent: The agent instance with messages and model.

    Returns:
        Estimated input token count.
    """
    messages = agent.messages

    # Find the last assistant message with usage metadata
    last_assistant_idx = -1
    for i, msg in reversed(list(enumerate(messages))):
        if msg.get("role") == "assistant" and msg.get("metadata", {}).get("usage"):
            last_assistant_idx = i
            break

    if last_assistant_idx >= 0:
        usage = messages[last_assistant_idx]["metadata"]["usage"]
        known_baseline = _total_prompt_tokens(usage) + usage["outputTokens"]
        new_messages = messages[last_assistant_idx + 1 :]
        if not new_messages:
            return known_baseline
        # System prompt and tool spec tokens are already included in the baseline
        return known_baseline + await agent.model.count_tokens(new_messages)

    # Cold start: resolve tool specs lazily for estimation only
    tool_specs = agent.tool_registry.get_all_tool_specs()
    return await agent.model.count_tokens(
        messages,
        tool_specs=tool_specs,
        system_prompt=agent.system_prompt,
        system_prompt_content=agent._system_prompt_content,
    )


def _build_checkpoint_stop_event(
    agent: "Agent",
    position: CheckpointPosition,
    cycle_index: int,
    message: Message,
    request_state: Any,
) -> EventLoopStopEvent:
    """Build a checkpoint stop event. Used at ``after_model`` and ``after_tools``."""
    checkpoint = Checkpoint(
        position=position,
        cycle_index=cycle_index,
    )
    return EventLoopStopEvent(
        "checkpoint",
        message,
        agent.event_loop_metrics,
        request_state,
        checkpoint=checkpoint,
    )


async def event_loop_cycle(
    agent: "Agent",
    invocation_state: dict[str, Any],
    structured_output_context: StructuredOutputContext | None = None,
    limits: Limits | None = None,
) -> AsyncGenerator[TypedEvent, None]:
    """Execute a single cycle of the event loop.

    This core function processes a single conversation turn, handling model inference, tool execution, and error
    recovery. It manages the entire lifecycle of a conversation turn, including:

    1. Initializing cycle state and metrics
    2. Checking execution limits
    3. Processing messages with the model
    4. Handling tool execution requests
    5. Managing recursive calls for multi-turn tool interactions
    6. Collecting and reporting metrics
    7. Error handling and recovery

    Args:
        agent: The agent for which the cycle is being executed.
        invocation_state: Additional arguments including:

            - request_state: State maintained across cycles
            - event_loop_cycle_id: Unique ID for this cycle
            - event_loop_cycle_span: Current tracing Span for this cycle
        structured_output_context: Optional context for structured output management.
        limits: Optional per-invocation budget caps. Checked at the top of this cycle
            (after tools from the previous cycle have run to completion). See
            :class:`~strands.types.agent.Limits`.

    Yields:
        Model and tool stream events. The final ``EventLoopStopEvent`` payload
        (``event["stop"]``) is a 7-tuple:

            - StopReason: Reason the model stopped generating (e.g., "tool_use", "checkpoint")
            - Message: The generated message from the model
            - EventLoopMetrics: Updated metrics for the event loop
            - Any: Updated request state
            - Sequence[Interrupt] | None: Interrupts raised during the cycle, if any
            - BaseModel | None: Structured output result, if any
            - Checkpoint | None: Checkpoint captured when stop_reason == "checkpoint"

    Raises:
        EventLoopException: If an error occurs during execution
        ContextWindowOverflowException: If the input is too large for the model
    """
    structured_output_context = structured_output_context or StructuredOutputContext()

    # Caps are positive and use >= semantics, so a trip implies at least one prior cycle
    # ran — meaning agent.messages[-1] exists.
    limit_stop_reason = _check_limits(agent, limits)
    if limit_stop_reason is not None:
        if "request_state" not in invocation_state:
            invocation_state["request_state"] = {}
        yield EventLoopStopEvent(
            limit_stop_reason,
            agent.messages[-1],
            agent.event_loop_metrics,
            invocation_state["request_state"],
        )
        return

    # Initialize cycle state
    invocation_state["event_loop_cycle_id"] = uuid.uuid4()

    # Initialize state and get cycle trace
    if "request_state" not in invocation_state:
        invocation_state["request_state"] = {}

    # Consume the resume marker (one-shot).
    resume_context = agent._checkpoint
    if resume_context is not None:
        agent._checkpoint = None
        # after_tools means that cycle finished; resume increments cycle_index.
        next_cycle = (
            resume_context.cycle_index + 1 if resume_context.position == "after_tools" else resume_context.cycle_index
        )
        agent._checkpoint_cycle_index = next_cycle
        agent._checkpoint_resume_position = resume_context.position

    attributes = {"event_loop_cycle_id": str(invocation_state.get("event_loop_cycle_id"))}
    cycle_start_time, cycle_trace = agent.event_loop_metrics.start_cycle(attributes=attributes)
    invocation_state["event_loop_cycle_trace"] = cycle_trace

    yield StartEvent()
    yield StartEventLoopEvent()

    # Create tracer span for this event loop cycle
    tracer = get_tracer()
    cycle_span = tracer.start_event_loop_cycle_span(
        invocation_state=invocation_state,
        messages=agent.messages,
        parent_span=agent.trace_span,
        custom_trace_attributes=agent.trace_attributes,
    )
    invocation_state["event_loop_cycle_span"] = cycle_span

    with trace_api.use_span(cycle_span, end_on_exit=False):
        try:
            # Resume a tool interrupt by replaying its stored message instead of calling the model.
            pending_tool_execution = agent._interrupt_state.pending_tool_execution
            if agent._interrupt_state.activated and pending_tool_execution is not None:
                stop_reason: StopReason = "tool_use"
                message = pending_tool_execution.assistant_message
            # Skip model invocation if the latest message contains ToolUse
            elif _has_tool_use_in_latest_message(agent.messages):
                stop_reason = "tool_use"
                message = agent.messages[-1]
            else:
                model_events = _handle_model_execution(
                    agent, cycle_span, cycle_trace, invocation_state, tracer, structured_output_context
                )
                async for model_event in model_events:
                    if not isinstance(model_event, ModelStopReason):
                        yield model_event

                stop_reason, message, *_ = model_event["stop"]
                yield ModelMessageEvent(message=message)
        except Exception as e:
            tracer.end_span_with_error(cycle_span, str(e), e)
            raise

        try:
            if stop_reason == "max_tokens":
                raise MaxTokensReachedException(
                    message=(
                        "Model stopped generating due to maximum token limit. "
                        "The partial message has been added to the conversation history. "
                        "You can continue by calling the agent again. "
                        "For more information see: "
                        "https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/#maxtokensreachedexception"
                    )
                )

            if stop_reason == "tool_use":
                # Emit after_model checkpoint, unless we just resumed from one or a tool interrupt.
                if (
                    agent._checkpointing
                    and not agent._observe_cancellation()
                    and agent._interrupt_state.pending_tool_execution is None
                ):
                    resume_position = agent._checkpoint_resume_position
                    agent._checkpoint_resume_position = None
                    if resume_position != "after_model":
                        cycle_index = agent._checkpoint_cycle_index
                        agent.event_loop_metrics.end_cycle(cycle_start_time, cycle_trace)
                        if cycle_span:
                            tracer.end_event_loop_cycle_span(span=cycle_span, message=message)
                        yield _build_checkpoint_stop_event(
                            agent=agent,
                            position="after_model",
                            cycle_index=cycle_index,
                            message=message,
                            request_state=invocation_state["request_state"],
                        )
                        return

                # Handle tool execution
                tool_events = _handle_tool_execution(
                    stop_reason,
                    message,
                    agent=agent,
                    cycle_trace=cycle_trace,
                    cycle_span=cycle_span,
                    cycle_start_time=cycle_start_time,
                    invocation_state=invocation_state,
                    tracer=tracer,
                    structured_output_context=structured_output_context,
                    limits=limits,
                )
                async for tool_event in tool_events:
                    yield tool_event

                return

            # End the cycle and return results
            agent.event_loop_metrics.end_cycle(cycle_start_time, cycle_trace, attributes)

            # Force structured output tool call if LLM didn't use it automatically
            if structured_output_context.is_enabled and stop_reason == "end_turn":
                if structured_output_context.force_attempted:
                    raise StructuredOutputException(
                        "The model failed to invoke the structured output tool even after it was forced."
                    )
                structured_output_context.set_forced_mode()
                logger.debug("Forcing structured output tool")
                await agent._append_messages(
                    {"role": "user", "content": [{"text": structured_output_context.structured_output_prompt}]}
                )

                tracer.end_event_loop_cycle_span(cycle_span, message)
                events = recurse_event_loop(
                    agent=agent,
                    invocation_state=invocation_state,
                    structured_output_context=structured_output_context,
                    limits=limits,
                )
                async for typed_event in events:
                    yield typed_event
                return

            tracer.end_event_loop_cycle_span(cycle_span, message)
            yield EventLoopStopEvent(stop_reason, message, agent.event_loop_metrics, invocation_state["request_state"])
        except (
            StructuredOutputException,
            EventLoopException,
            ContextWindowOverflowException,
            MaxTokensReachedException,
            InterruptException,
        ) as e:
            # These exceptions should bubble up directly rather than get wrapped in an EventLoopException
            tracer.end_span_with_error(cycle_span, str(e), e)
            raise
        except Exception as e:
            tracer.end_span_with_error(cycle_span, str(e), e)
            # Handle any other exceptions
            yield ForceStopEvent(reason=e)
            logger.error("exception=<%s> | event loop cycle failed", type(e).__name__)
            logger.debug("event loop cycle failed", exc_info=True)
            raise EventLoopException(e, invocation_state["request_state"]) from e


async def recurse_event_loop(
    agent: "Agent",
    invocation_state: dict[str, Any],
    structured_output_context: StructuredOutputContext | None = None,
    limits: Limits | None = None,
) -> AsyncGenerator[TypedEvent, None]:
    """Make a recursive call to event_loop_cycle with the current state.

    This function is used when the event loop needs to continue processing after tool execution.

    Args:
        agent: Agent for which the recursive call is being made.
        invocation_state: Arguments to pass through event_loop_cycle
        structured_output_context: Optional context for structured output management.
        limits: Optional per-invocation budget caps. See :class:`~strands.types.agent.Limits`.

    Yields:
        Results from event_loop_cycle where the last result contains:

            - StopReason: Reason the model stopped generating
            - Message: The generated message from the model
            - EventLoopMetrics: Updated metrics for the event loop
            - Any: Updated request state
    """
    cycle_trace = invocation_state["event_loop_cycle_trace"]

    # Recursive call trace
    recursive_trace = Trace("Recursive call", parent_id=cycle_trace.id)
    cycle_trace.add_child(recursive_trace)

    yield StartEvent()

    events = event_loop_cycle(
        agent=agent,
        invocation_state=invocation_state,
        structured_output_context=structured_output_context,
        limits=limits,
    )
    async for event in events:
        yield event

    recursive_trace.end()


async def _invoke_before_model_call_hooks(agent: "Agent", event: BeforeModelCallEvent) -> BeforeModelCallEvent:
    """Run BeforeModelCallEvent hooks, raising any interrupt they registered.

    No tool execution is pending at this point, so resuming re-enters the same model call.
    """
    event, interrupts = await agent.hooks.invoke_callbacks_async(event)
    if not interrupts:
        return event
    for interrupt in interrupts:
        agent._interrupt_state.interrupts.setdefault(interrupt.id, interrupt)
    raise InterruptException(interrupts[0])


async def _handle_model_execution(
    agent: "Agent",
    cycle_span: Any,
    cycle_trace: Trace,
    invocation_state: dict[str, Any],
    tracer: Tracer,
    structured_output_context: StructuredOutputContext,
) -> AsyncGenerator[TypedEvent, None]:
    """Handle model execution with retry logic for throttling exceptions.

    Executes the model inference with automatic retry handling for throttling exceptions.
    Manages tracing, hooks, and metrics collection throughout the process.

    Args:
        agent: The agent executing the model.
        cycle_span: Span object for tracing the cycle.
        cycle_trace: Trace object for the current event loop cycle.
        invocation_state: State maintained across cycles.
        tracer: Tracer instance for span management.
        structured_output_context: Context for structured output management.

    Yields:
        Model stream events and throttle events during retries.

    Raises:
        ModelThrottledException: If max retry attempts are exceeded.
        Exception: Any other model execution errors.
    """
    # Create a trace for the stream_messages call
    stream_trace = Trace("stream_messages", parent_id=cycle_trace.id)
    cycle_trace.add_child(stream_trace)

    # Retry loop - actual retry logic is handled by retry_strategy hook
    # Hooks control when to stop retrying via the event.retry flag
    while True:
        try:
            # Estimate input tokens for the upcoming model call (non-fatal)
            projected_input_tokens: int | None = None
            try:
                projected_input_tokens = await _estimate_input_tokens(agent)
            except Exception as e:
                logger.debug("error=<%s> | token estimation failed, proceeding without estimate", e)

            before_model_call_event = BeforeModelCallEvent(
                agent=agent,
                invocation_state=invocation_state,
                projected_input_tokens=projected_input_tokens,
            )
            model_continuation: Messages | None = None
            try:
                before_model_call_event = await _invoke_before_model_call_hooks(agent, before_model_call_event)
                model_continuation = await _continuation.prepare(
                    before_model_call_event,
                    agent._convert_prompt_to_messages,
                )
            finally:
                if model_continuation is None:
                    await _continuation.abandon(
                        before_model_call_event,
                        RuntimeError(
                            "Agent stream closed before continuation input was incorporated into agent history"
                        ),
                    )

            if before_model_call_event.cancel:
                await _continuation.abandon(
                    before_model_call_event,
                    RuntimeError("Continuation abandoned by BeforeModelCallEvent"),
                )
                cancel_text = (
                    before_model_call_event.cancel
                    if isinstance(before_model_call_event.cancel, str)
                    else "model call denied by hook"
                )
                message: Message = {"role": "assistant", "content": [{"text": cancel_text}]}
                stop_reason: StopReason = "end_turn"
                usage: Usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
                metrics: Metrics = {"latencyMs": 0}

                after_model_call_event = AfterModelCallEvent(
                    agent=agent,
                    invocation_state=invocation_state,
                    stop_response=AfterModelCallEvent.ModelStopResponse(
                        stop_reason=stop_reason,
                        message=message,
                    ),
                )
                await agent.hooks.invoke_callbacks_async(after_model_call_event)

                if after_model_call_event.retry:
                    continue
                yield ModelStopReason(stop_reason=stop_reason, message=message, usage=usage, metrics=metrics)
                break

            if model_continuation is not None:
                await agent._append_continuation_messages(model_continuation, before_model_call_event)
                try:
                    projected_input_tokens = await _estimate_input_tokens(agent)
                except Exception as error:
                    projected_input_tokens = None
                    logger.debug(
                        "error=<%s> | token estimation failed after continuation input, proceeding without estimate",
                        error,
                    )

            if structured_output_context.forced_mode:
                tool_spec = structured_output_context.get_tool_spec()
                tool_specs = [tool_spec] if tool_spec else []
            else:
                tool_specs = agent.tool_registry.get_all_tool_specs()

            # Build middleware context with defensive copies to prevent accidental mutation.
            # invocation_state is intentionally shared by reference (hooks/tools write to it).
            # Prefer the content-block form when present: it is the authoritative superset
            # (it carries the text AND structural blocks like cachePoints). Falling back to the
            # plain string would silently drop cachePoints.
            system_prompt_value = (
                agent._system_prompt_content if agent._system_prompt_content is not None else agent.system_prompt
            )
            middleware_context = InvokeModelContext(
                agent=agent,
                messages=copy.deepcopy(agent.messages),
                system_prompt=copy.deepcopy(system_prompt_value),
                tool_specs=copy.deepcopy(tool_specs),
                tool_choice=copy.deepcopy(structured_output_context.tool_choice),
                invocation_state=invocation_state,
                model=agent.model,
                projected_input_tokens=projected_input_tokens,
            )

            # Snapshot model state before the chain so middleware mutations to
            # agent._model_state (before or after next()) cannot leak into the model call.
            # The terminal streams against this snapshot; we write it back after the entire
            # chain completes (success only). model_state is intentionally NOT on the context.
            model_state_snapshot = copy.deepcopy(agent._model_state)

            # Run through middleware chain. The last yielded event is ModelStopReason
            # which serves as both the streaming result event and the middleware result.
            last_event = None
            async for event in agent._middleware_registry.invoke(
                InvokeModelStage,
                middleware_context,
                _make_invoke_model_terminal(agent, cycle_span, tracer, model_state_snapshot),
            ):
                last_event = event
                yield event

            if last_event is None:
                raise RuntimeError(
                    "Middleware chain did not yield a result event. Ensure middleware forwards events from next()."
                )

            # Write the post-stream model state back to the agent. Skipped on error
            # (exception propagates and we never reach here), matching TS semantics.
            agent._model_state = model_state_snapshot

            # The last event from the chain is ModelStopReason (the authoritative result)
            stop_reason, message, usage, metrics = last_event["stop"]

            invocation_state.setdefault("request_state", {})

            # Attach metadata to the assistant message immediately so it's
            # available to all downstream consumers (hooks, events, state).
            message["metadata"] = {
                "usage": usage,
                "metrics": metrics,
            }

            after_model_call_event = AfterModelCallEvent(
                agent=agent,
                invocation_state=invocation_state,
                stop_response=AfterModelCallEvent.ModelStopResponse(
                    stop_reason=stop_reason,
                    message=message,
                ),
            )

            await agent.hooks.invoke_callbacks_async(after_model_call_event)

            # Check if hooks want to retry the model call
            if after_model_call_event.retry:
                agent.event_loop_metrics.update_usage(usage)
                logger.debug(
                    "stop_reason=<%s>, retry_requested=<True> | hook requested model retry",
                    stop_reason,
                )
                continue  # Retry the model call

            if stop_reason == "max_tokens":
                message = recover_message_on_max_tokens_reached(message)

            break  # Success! Break out of retry loop

        except InterruptException:
            raise
        except Exception as e:
            after_model_call_event = AfterModelCallEvent(
                agent=agent,
                invocation_state=invocation_state,
                exception=e,
            )
            await agent.hooks.invoke_callbacks_async(after_model_call_event)

            # Emit backwards-compatible events if retry strategy supports it
            if (
                isinstance(agent._retry_strategy, ModelRetryStrategy)
                and agent._retry_strategy._backwards_compatible_event_to_yield
            ):
                yield agent._retry_strategy._backwards_compatible_event_to_yield

            # Check if hooks want to retry the model call
            if after_model_call_event.retry:
                logger.debug(
                    "exception=<%s>, retry_requested=<True> | hook requested model retry",
                    type(e).__name__,
                )

                continue  # Retry the model call

            # No retry requested, raise the exception
            yield ForceStopEvent(reason=e)
            raise e

    try:
        # Add message in trace and mark the end of the stream messages trace
        stream_trace.add_message(message)
        stream_trace.end()

        # Add the response message to the conversation
        await agent._append_messages(message)

        # Update metrics
        agent.event_loop_metrics.update_usage(usage)
        agent.event_loop_metrics.update_metrics(metrics)

    except Exception as e:
        yield ForceStopEvent(reason=e)
        logger.error("exception=<%s> | event loop cycle failed", type(e).__name__)
        logger.debug("event loop cycle failed", exc_info=True)
        raise EventLoopException(e, invocation_state["request_state"]) from e


def _make_invoke_model_terminal(
    agent: "Agent", cycle_span: Any, tracer: Tracer, model_state: dict[str, Any]
) -> "Callable[[InvokeModelContext], AsyncGenerator[Any, None]]":
    """Create the terminal function for InvokeModelStage middleware.

    Streams against ``model_state`` (a snapshot owned by the caller) rather than
    ``agent._model_state`` directly, so middleware cannot influence model state. The
    caller writes this dict back to the agent after the chain completes successfully.
    """

    async def terminal(ctx: InvokeModelContext) -> AsyncGenerator[Any, None]:
        # Observe a linked external cancel signal before the model call so the stream's
        # first between-chunk checkpoint sees a cancellation requested by an earlier hook.
        agent._observe_cancellation()

        system_prompt_str, system_prompt_content = split_system_prompt(ctx.system_prompt)

        model_id = ctx.model.config.get("model_id") if hasattr(ctx.model, "config") else None
        model_invoke_span = tracer.start_model_invoke_span(
            messages=ctx.messages,
            parent_span=cycle_span,
            model_id=model_id,
            custom_trace_attributes=agent.trace_attributes,
            system_prompt=system_prompt_str,
            system_prompt_content=system_prompt_content,
        )
        with trace_api.use_span(model_invoke_span, end_on_exit=False):
            try:
                async for event in stream_messages(
                    ctx.model,
                    system_prompt_str,
                    ctx.messages,
                    ctx.tool_specs,
                    system_prompt_content=system_prompt_content,
                    tool_choice=ctx.tool_choice,
                    invocation_state=ctx.invocation_state,
                    model_state=model_state,
                    dynamic_trailing_blocks=ctx.dynamic_trailing_blocks,
                    cancel_signal=agent._cancel_signal,
                    agent_metadata=agent._metadata,
                ):
                    yield event

                stop_reason, message, usage, metrics = event["stop"]
                tracer.end_model_invoke_span(model_invoke_span, message, usage, metrics, stop_reason)
            except Exception as e:
                tracer.end_span_with_error(model_invoke_span, str(e), e)
                raise

    return terminal


async def _stop_for_interrupts(
    agent: "Agent",
    message: Message,
    tool_results: list[ToolResult],
    interrupts: list["Interrupt"],
    cycle_start_time: float,
    cycle_trace: Trace,
    cycle_span: Any,
    invocation_state: dict[str, Any],
    tracer: Tracer,
    structured_output_result: "BaseModel | None" = None,
) -> AsyncGenerator[TypedEvent, None]:
    """Persist interrupt state and emit the interrupt stop event.

    Shared by both the pre-execution and post-execution interrupt paths
    so interrupt persistence logic lives in one place.
    """
    # Session state stored on AfterInvocationEvent.
    agent._interrupt_state.pending_tool_execution = PendingToolExecution(
        assistant_message=message,
        completed_tool_results=tool_results,
    )
    agent._interrupt_state.activate()

    agent.event_loop_metrics.end_cycle(cycle_start_time, cycle_trace)
    yield EventLoopStopEvent(
        "interrupt",
        message,
        agent.event_loop_metrics,
        invocation_state["request_state"],
        interrupts,
        structured_output=structured_output_result,
    )
    # End the cycle span before yielding the recursive cycle.
    if cycle_span:
        tracer.end_event_loop_cycle_span(span=cycle_span, message=message)


async def _handle_tool_execution(
    stop_reason: StopReason,
    message: Message,
    agent: "Agent",
    cycle_trace: Trace,
    cycle_span: Any,
    cycle_start_time: float,
    invocation_state: dict[str, Any],
    tracer: Tracer,
    structured_output_context: StructuredOutputContext,
    limits: Limits | None = None,
) -> AsyncGenerator[TypedEvent, None]:
    """Handles the execution of tools requested by the model during an event loop cycle.

    Args:
        stop_reason: The reason the model stopped generating.
        message: The message from the model that may contain tool use requests.
        agent: Agent for which tools are being executed.
        cycle_trace: Trace object for the current event loop cycle.
        cycle_span: Span object for tracing the cycle (type may vary).
        cycle_start_time: Start time of the current cycle.
        invocation_state: Additional keyword arguments, including request state.
        tracer: Tracer instance for span management.
        structured_output_context: Optional context for structured output management.
        limits: Optional per-invocation budget caps. See :class:`~strands.types.agent.Limits`.

    Yields:
        Tool stream events along with events yielded from a recursive call to the event loop. The last event is a tuple
        containing:
            - The stop reason,
            - The updated message,
            - The updated event loop metrics,
            - The updated request state.
    """
    tool_uses: list[ToolUse] = [content["toolUse"] for content in message["content"] if "toolUse" in content]
    tool_results: list[ToolResult] = []

    # Merge tool results from a resumed tool interrupt.
    pending_tool_execution = agent._interrupt_state.pending_tool_execution
    if agent._interrupt_state.activated and pending_tool_execution is not None:
        tool_results.extend(pending_tool_execution.completed_tool_results)

        # Filter to only the interrupted tools when resuming from interrupt (tool uses without results)
        tool_use_ids = {tool_result["toolUseId"] for tool_result in tool_results}
        tool_uses = [tool_use for tool_use in tool_uses if tool_use["toolUseId"] not in tool_use_ids]

    before_tools_event = BeforeToolsEvent(
        agent=agent,
        message=message,
        invocation_state=invocation_state,
    )
    before_tools_event, interrupts = await agent.hooks.invoke_callbacks_async(before_tools_event)

    if interrupts:
        async for interrupt_event in _stop_for_interrupts(
            agent,
            message,
            tool_results,
            interrupts,
            cycle_start_time,
            cycle_trace,
            cycle_span,
            invocation_state,
            tracer,
        ):
            yield interrupt_event
        return

    cancel_message = None
    if before_tools_event.cancel:
        cancel_message = (
            before_tools_event.cancel if isinstance(before_tools_event.cancel, str) else "Tool cancelled by hook"
        )
    elif agent._observe_cancellation():
        cancel_message = "Tool execution cancelled"

    structured_output_result = None
    try:
        if cancel_message:
            logger.debug("tool_count=<%d> | cancellation detected before tool execution", len(tool_uses))
            for tool_use in tool_uses:
                cancel_result: ToolResult = {
                    "toolUseId": tool_use["toolUseId"],
                    "status": "error",
                    "content": [{"text": cancel_message}],
                }
                tool_results.append(cancel_result)
                yield ToolResultEvent(cancel_result)
        else:
            pending_tool_use_ids = {tool_use["toolUseId"] for tool_use in tool_uses}
            validated_tool_uses: list[ToolUse] = []
            validation_results: list[ToolResult] = []
            invalid_tool_use_ids: list[str] = []
            validate_and_prepare_tools(message, validated_tool_uses, validation_results, invalid_tool_use_ids)
            tool_uses = [
                tool_use
                for tool_use in validated_tool_uses
                if tool_use["toolUseId"] in pending_tool_use_ids and tool_use["toolUseId"] not in invalid_tool_use_ids
            ]
            tool_results.extend(result for result in validation_results if result["toolUseId"] in pending_tool_use_ids)

            tool_events = agent.tool_executor._execute(
                agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
            )
            async for tool_event in tool_events:
                if isinstance(tool_event, ToolInterruptEvent):
                    interrupts.extend(tool_event["tool_interrupt_event"]["interrupts"])

                yield tool_event

            if structured_output_context.is_enabled:
                if structured_output_result := structured_output_context.extract_result(tool_uses):
                    yield StructuredOutputEvent(structured_output=structured_output_result)
                    structured_output_context.stop_loop = True
    finally:
        # Always pair BeforeToolsEvent with AfterToolsEvent, even on cancel/interrupt/error paths.
        tool_result_message: Message = {
            "role": "user",
            "content": [{"toolResult": result} for result in tool_results],
        }
        after_tools_event = AfterToolsEvent(agent=agent, message=tool_result_message, invocation_state=invocation_state)
        try:
            after_tools_event, _ = await agent.hooks.invoke_callbacks_async(after_tools_event)
        except Exception:
            # Persist pending interrupts before re-raising so they aren't lost.
            if interrupts:
                agent._interrupt_state.pending_tool_execution = PendingToolExecution(
                    assistant_message=message,
                    completed_tool_results=tool_results,
                )
                agent._interrupt_state.activate()
            raise

    invocation_state["event_loop_parent_cycle_id"] = invocation_state["event_loop_cycle_id"]

    if interrupts:
        async for interrupt_event in _stop_for_interrupts(
            agent,
            message,
            tool_results,
            interrupts,
            cycle_start_time,
            cycle_trace,
            cycle_span,
            invocation_state,
            tracer,
            structured_output_result,
        ):
            yield interrupt_event
        return

    # Reset interrupt state if tools ran so the next cycle starts clean.
    if not agent._observe_cancellation():
        agent._interrupt_state.end_tool_cycle()
    # Update stored results so replay filter skips already-executed tools on next resume.
    elif cancel_message is None:
        agent._interrupt_state.set_pending_tool_results(tool_results)

    await agent._append_messages(tool_result_message)

    yield ToolResultMessageEvent(message=tool_result_message)

    # End the cycle span before yielding the recursive cycle.
    if cycle_span:
        tracer.end_event_loop_cycle_span(span=cycle_span, message=message, tool_result_message=tool_result_message)

    agent.event_loop_metrics.end_cycle(cycle_start_time, cycle_trace)

    # Hook requested halt: exit without calling the model again.
    if after_tools_event.end_turn:
        end_turn_value = after_tools_event.end_turn
        if isinstance(end_turn_value, list):
            end_turn_content = list(end_turn_value)
        elif isinstance(end_turn_value, str):
            end_turn_content = [{"text": end_turn_value}]
        else:
            end_turn_content = [{"text": "Turn ended early by hook after tool execution"}]
        end_turn_message: Message = {"role": "assistant", "content": end_turn_content}
        await agent._append_messages(end_turn_message)
        yield EventLoopStopEvent(
            "end_turn",
            end_turn_message,
            agent.event_loop_metrics,
            invocation_state["request_state"],
            structured_output=structured_output_result,
        )
        return

    if invocation_state["request_state"].get("stop_event_loop", False) or structured_output_context.stop_loop:
        yield EventLoopStopEvent(
            stop_reason,
            message,
            agent.event_loop_metrics,
            invocation_state["request_state"],
            structured_output=structured_output_result,
        )
        return

    if agent._observe_cancellation():
        yield EventLoopStopEvent(
            "cancelled",
            message,
            agent.event_loop_metrics,
            invocation_state["request_state"],
        )
        return

    # Emit after_tools checkpoint. Only fires on tool_use cycles: a model that
    # returns end_turn first never reaches this branch.
    if agent._checkpointing:
        cycle_index = agent._checkpoint_cycle_index
        agent._checkpoint_cycle_index = cycle_index + 1
        yield _build_checkpoint_stop_event(
            agent=agent,
            position="after_tools",
            cycle_index=cycle_index,
            message=message,
            request_state=invocation_state["request_state"],
        )
        return

    events = recurse_event_loop(
        agent=agent,
        invocation_state=invocation_state,
        structured_output_context=structured_output_context,
        limits=limits,
    )
    async for event in events:
        yield event
