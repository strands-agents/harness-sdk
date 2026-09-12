"""Abstract base class for tool executors.

Tool executors are responsible for determining how tools are executed (e.g., concurrently, sequentially, with custom
thread pools, etc.).
"""

import abc
import logging
import threading
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal, cast

from opentelemetry import trace as trace_api

from ..._middleware.stages import ExecuteToolContext, ExecuteToolStage, MiddlewareInterruptResult
from ...hooks import AfterToolCallEvent, BeforeToolCallEvent
from ...interrupt import InterruptException
from ...telemetry.metrics import Trace
from ...telemetry.tracer import get_tracer, serialize
from ...types._events import ToolCancelEvent, ToolInterruptEvent, ToolResultEvent, ToolStreamEvent, TypedEvent
from ...types.agent import LocalAgent
from ...types.content import Message, _ensure_tracking_id
from ...types.tools import AgentTool, ToolChoice, ToolChoiceAuto, ToolConfig, ToolContext, ToolResult, ToolUse
from ..structured_output._structured_output_context import StructuredOutputContext

if TYPE_CHECKING:  # pragma: no cover
    from ...agent import Agent
    from ...background_tasks._background_tasks import _BackgroundTasks
    from ...background_tasks.in_process._manager import _MiddlewareInterrupt
    from ...experimental.bidi import BidiAgent

logger = logging.getLogger(__name__)


class ToolExecutor(abc.ABC):
    """Abstract base class for tool executors."""

    @staticmethod
    def _is_agent(agent: LocalAgent) -> bool:
        """Check if the local agent is a standard Agent instance.

        Note, we use a runtime import to avoid a circular dependency error.
        """
        from ...agent import Agent

        return isinstance(agent, Agent)

    @staticmethod
    def _should_retry(agent: LocalAgent, after_event: AfterToolCallEvent[LocalAgent]) -> bool:
        """Return whether a hook-requested retry should run.

        Cancellation is terminal: retrying a locally cancelled tool can spin indefinitely
        while delaying the caller's requested agent stop.
        """
        if not after_event.retry:
            return False
        if cast(dict[str, Any], after_event.result).get("cancelled") is True:
            return False
        if not ToolExecutor._is_agent(agent):
            return True
        return not cast("Agent", agent)._observe_cancellation()

    async def _execute_background(
        self,
        agent: "Agent",
        selected_tool: AgentTool,
        context: ToolContext[LocalAgent],
        middleware_interrupt: "_MiddlewareInterrupt",
        tool_guard: Callable[[AgentTool | None], None],
    ) -> ToolResult:
        """Execute one admitted background tool call through middleware and after-call hooks.

        BeforeToolCallEvent already fired at admission, so only the ExecuteToolStage chain and
        AfterToolCallEvent run here. Stream events reach the callback handler; the result is
        returned to the task manager rather than yielded.

        Args:
            agent: The agent that admitted the tool call.
            selected_tool: The tool to execute.
            context: Task-scoped tool context carrying the task's cancel signal and interrupt state.
            middleware_interrupt: Task-scoped ``interrupt()`` for ExecuteToolStage middleware.
            tool_guard: Rejects a middleware-substituted tool that cannot run in the background.

        Returns:
            The hook-transformed tool result.

        Raises:
            InterruptException: If the tool or middleware requests input.
        """
        tool_use = context.tool_use
        invocation_state = context.invocation_state
        tracer = get_tracer()
        while True:
            tool_start_time = time.monotonic()
            middleware_context = _BackgroundExecuteToolContext(
                agent=agent,
                tool=selected_tool,
                tool_use=dict(tool_use),  # type: ignore[arg-type]
                invocation_state=invocation_state,
                cancel_signal=context.cancel_signal,
                _interrupt_state=agent._interrupt_state,
                _background_interrupt=middleware_interrupt,
            )
            result_event: ToolResultEvent | None = None
            tool_call_span = tracer.start_tool_call_span(tool_use, custom_trace_attributes=agent.trace_attributes)
            with trace_api.use_span(tool_call_span):
                async for event in agent._middleware_registry.invoke(
                    ExecuteToolStage,
                    middleware_context,
                    _make_execute_tool_terminal({}, tool_context=context, tool_guard=tool_guard),
                ):
                    if isinstance(event, ToolInterruptEvent):
                        tracer.end_tool_call_span(tool_call_span, tool_result=None)
                        raise InterruptException(event.interrupts[0])
                    if isinstance(event, ToolResultEvent):
                        result_event = event
                    elif event.is_callback_event:
                        event.prepare(invocation_state=invocation_state)
                        agent.callback_handler(**event.as_dict())

            if result_event is None:
                raise RuntimeError(
                    "ExecuteToolStage middleware chain did not yield a ToolResultEvent. "
                    "Ensure middleware forwards events from next()."
                )
            tracer.end_tool_call_span(tool_call_span, result_event.tool_result, error=result_event.exception)
            # The cycle that dispatched this call has already ended, so the trace has no parent.
            agent.event_loop_metrics.add_tool_usage(
                tool_use,
                time.monotonic() - tool_start_time,
                Trace(f"Tool: {tool_use['name']}", raw_name=tool_use["name"]),
                result_event.tool_result.get("status") == "success",
                Message(role="user", content=[{"toolResult": result_event.tool_result}]),
            )
            after_event, _ = await agent.hooks.invoke_callbacks_async(
                AfterToolCallEvent[LocalAgent](
                    agent=agent,
                    selected_tool=selected_tool,
                    tool_use=tool_use,
                    invocation_state=invocation_state,
                    result=result_event.tool_result,
                    exception=result_event.exception,
                    duration=time.monotonic() - tool_start_time,
                )
            )
            if after_event.retry and not context.cancel_signal.is_set():
                logger.debug("tool_name=<%s> | retry requested, retrying background tool call", tool_use["name"])
                continue
            return after_event.result

    @staticmethod
    async def _stream(
        agent: "Agent | BidiAgent",
        tool_use: ToolUse,
        tool_results: list[ToolResult],
        invocation_state: dict[str, Any],
        structured_output_context: StructuredOutputContext | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Stream tool events.

        This method adds additional logic to the stream invocation including:

        - Tool lookup and validation
        - Before/after hook execution
        - Tracing and metrics collection
        - Error handling and recovery
        - Interrupt handling for human-in-the-loop workflows

        Args:
            agent: The agent (Agent or BidiAgent) for which the tool is being executed.
            tool_use: Metadata and inputs for the tool to be executed.
            tool_results: List of tool results from each tool execution.
            invocation_state: Context for the tool invocation.
            structured_output_context: Context for structured output management.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Tool events with the last being the tool result.
        """
        logger.debug("tool_use=<%s> | streaming", tool_use)
        tool_name = tool_use["name"]
        structured_output_context = structured_output_context or StructuredOutputContext()

        tool_func = _lookup_tool(agent, tool_name)
        tool_spec = tool_func.tool_spec if tool_func is not None else None

        current_span = trace_api.get_current_span()
        if current_span and tool_spec is not None:
            current_span.set_attribute("gen_ai.tool.description", tool_spec["description"])
            input_schema = tool_spec["inputSchema"]
            if "json" in input_schema:
                current_span.set_attribute("gen_ai.tool.json_schema", serialize(input_schema["json"]))

        invocation_state.update(
            {
                "agent": agent,
                "model": agent.model,
                "messages": agent.messages,
                "system_prompt": agent.system_prompt,
                "tool_config": ToolConfig(  # for backwards compatibility
                    tools=[{"toolSpec": tool_spec} for tool_spec in agent.tool_registry.get_all_tool_specs()],
                    toolChoice=cast(ToolChoice, {"auto": ToolChoiceAuto()}),
                ),
            }
        )

        # A BidiAgent has no cancellation signal; an inert event keeps the middleware and tool
        # contracts non-optional.
        cancel_signal = cast("Agent", agent).cancel_signal if ToolExecutor._is_agent(agent) else threading.Event()
        background_tasks: _BackgroundTasks | None = getattr(agent, "_background_tasks", None)

        # Retry loop for tool execution - hooks can set after_event.retry = True to retry
        while True:
            before_event, interrupts = await agent.hooks.invoke_callbacks_async(
                BeforeToolCallEvent[LocalAgent](
                    agent=agent,
                    selected_tool=tool_func,
                    tool_use=tool_use,
                    invocation_state=invocation_state,
                )
            )

            if interrupts:
                yield ToolInterruptEvent(tool_use, interrupts)
                return

            if before_event.cancel_tool:
                cancel_message = (
                    before_event.cancel_tool if isinstance(before_event.cancel_tool, str) else "tool cancelled by user"
                )
                yield ToolCancelEvent(tool_use, cancel_message)

                cancel_result: ToolResult = {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": cancel_message}],
                }

                after_event, _ = await agent.hooks.invoke_callbacks_async(
                    AfterToolCallEvent[LocalAgent](
                        agent=agent,
                        selected_tool=None,
                        tool_use=tool_use,
                        invocation_state=invocation_state,
                        result=cancel_result,
                        cancel_message=cancel_message,
                    )
                )
                yield ToolResultEvent(after_event.result)
                tool_results.append(after_event.result)
                return

            try:
                tool_start_time = time.monotonic()
                selected_tool = before_event.selected_tool
                tool_use = before_event.tool_use
                invocation_state = before_event.invocation_state

                if selected_tool is tool_func and tool_use["name"] != tool_name:
                    selected_tool = _lookup_tool(agent, tool_use["name"])

                tool_use, route = _route_background(
                    background_tasks, tool_use, tool_func, selected_tool, invocation_state
                )
                if route is True:
                    assert background_tasks is not None
                    # No AfterToolCallEvent for the dispatch acknowledgement; the background
                    # run emits it when the tool actually executes.
                    # Keyed by the assistant message that requested the tool, so a resubmission of the
                    # same request within that message returns the existing task.
                    pass_id = _ensure_tracking_id(agent.messages[-1])
                    result = await background_tasks.submit_tool_call(
                        tool_use, invocation_state, pass_id, cast(AgentTool, selected_tool)
                    )
                    yield ToolResultEvent(result, backgrounded=True)
                    tool_results.append(result)
                    return
                admission_error = route

                if not selected_tool:
                    # Unknown tool: log here, but do NOT short-circuit. The middleware chain
                    # still runs with ctx.tool = None (matching TS), so middleware can observe
                    # or mock the call; the terminal produces the unknown-tool error result.
                    if tool_func == selected_tool:
                        logger.error(
                            "tool_name=<%s>, available_tools=<%s> | tool not found in registry",
                            tool_name,
                            list(agent.tool_registry.registry.keys()),
                        )
                    else:
                        logger.debug(
                            "tool_name=<%s>, tool_use_id=<%s> | a hook resulted in a non-existing tool call",
                            tool_name,
                            str(tool_use.get("toolUseId")),
                        )
                if structured_output_context.is_enabled:
                    kwargs["structured_output_context"] = structured_output_context

                # Run tool execution through the ExecuteToolStage middleware chain. The
                # terminal streams the tool and yields a plain ToolResultEvent as the last
                # (result) event; middleware can transform inputs/result, short-circuit with
                # a cached result, or gate execution behind an interrupt. A shallow copy of
                # tool_use guards its top-level keys (e.g. name, toolUseId) from accidental
                # in-place edits; its `input` can hold arbitrary, non-copyable objects (e.g.
                # the agent injected on direct tool calls) so it is shared by reference.
                # Middleware wanting an isolated tool_use should pass one via replace().
                middleware_context = ExecuteToolContext(
                    agent=agent,
                    tool=selected_tool,
                    tool_use=dict(tool_use),  # type: ignore[arg-type]
                    invocation_state=invocation_state,
                    cancel_signal=cancel_signal,
                    _interrupt_state=agent._interrupt_state,
                )

                result_event: ToolResultEvent | None = None
                async for event in agent._middleware_registry.invoke(
                    ExecuteToolStage,
                    middleware_context,
                    _make_execute_tool_terminal(kwargs, admission_error),
                ):
                    # Tool-originated interrupt: a ToolInterruptEvent yielded from tool.stream()
                    # (including sub-agent interrupts propagated via _AgentAsTool). Distinct from
                    # the middleware-initiated InterruptException handled below — this one rides
                    # the event stream rather than unwinding it. Register its interrupts so
                    # _interrupt_state.resume() can locate them by id, surface the event, and
                    # short-circuit here: a halted tool has no result, so the after-hook and the
                    # result handling below are intentionally skipped.
                    if isinstance(event, ToolInterruptEvent):
                        for interrupt in event.interrupts:
                            agent._interrupt_state.interrupts.setdefault(interrupt.id, interrupt)
                        yield event
                        return

                    # Capture the result but keep draining: middleware may yield trailing
                    # events after it, and the last ToolResultEvent wins (matching the model
                    # stage). It is re-emitted only after AfterToolCallEvent runs, since hooks
                    # may rewrite it. All non-result events flow through as they arrive.
                    if isinstance(event, ToolResultEvent):
                        result_event = event
                    else:
                        yield event

                if result_event is None:
                    raise RuntimeError(
                        "ExecuteToolStage middleware chain did not yield a ToolResultEvent. "
                        "Ensure middleware forwards events from next()."
                    )

                result = result_event.tool_result
                exception = result_event.exception

                tool_duration = time.monotonic() - tool_start_time
                after_event, _ = await agent.hooks.invoke_callbacks_async(
                    AfterToolCallEvent[LocalAgent](
                        agent=agent,
                        selected_tool=selected_tool,
                        tool_use=tool_use,
                        invocation_state=invocation_state,
                        result=result,
                        exception=exception,
                        duration=tool_duration,
                    )
                )

                if ToolExecutor._should_retry(agent, after_event):
                    logger.debug("tool_name=<%s> | retry requested, retrying tool call", tool_name)
                    continue

                yield ToolResultEvent(after_event.result, exception=after_event.exception)
                tool_results.append(after_event.result)
                return

            except InterruptException as interrupt_exception:
                # Middleware-initiated interrupt (context.interrupt() with no response yet).
                # interrupt() is read-only, so this handler is the single place the interrupt
                # is registered before surfacing a ToolInterruptEvent to halt the agent,
                # matching how hook/tool interrupts are reported.
                agent._interrupt_state.interrupts.setdefault(
                    interrupt_exception.interrupt.id, interrupt_exception.interrupt
                )
                yield ToolInterruptEvent(tool_use, [interrupt_exception.interrupt])
                return

            except Exception as e:
                logger.exception("tool_name=<%s> | failed to process tool", tool_name)
                tool_duration = time.monotonic() - tool_start_time
                error_result: ToolResult = {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": f"Error: {str(e)}"}],
                }

                after_event, _ = await agent.hooks.invoke_callbacks_async(
                    AfterToolCallEvent[LocalAgent](
                        agent=agent,
                        selected_tool=selected_tool,
                        tool_use=tool_use,
                        invocation_state=invocation_state,
                        result=error_result,
                        exception=e,
                        duration=tool_duration,
                    )
                )
                if ToolExecutor._should_retry(agent, after_event):
                    logger.debug("tool_name=<%s> | retry requested after exception, retrying tool call", tool_name)
                    continue
                yield ToolResultEvent(after_event.result, exception=after_event.exception)
                tool_results.append(after_event.result)
                return

    @staticmethod
    async def _stream_with_trace(
        agent: "Agent",
        tool_use: ToolUse,
        tool_results: list[ToolResult],
        cycle_trace: Trace,
        cycle_span: Any,
        invocation_state: dict[str, Any],
        structured_output_context: StructuredOutputContext | None = None,
        **kwargs: Any,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute tool with tracing and metrics collection.

        Args:
            agent: The agent for which the tool is being executed.
            tool_use: Metadata and inputs for the tool to be executed.
            tool_results: List of tool results from each tool execution.
            cycle_trace: Trace object for the current event loop cycle.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for the tool invocation.
            structured_output_context: Context for structured output management.
            **kwargs: Additional keyword arguments for future extensibility.

        Yields:
            Tool events with the last being the tool result.
        """
        tool_name = tool_use["name"]
        structured_output_context = structured_output_context or StructuredOutputContext()

        tracer = get_tracer()

        tool_call_span = tracer.start_tool_call_span(
            tool_use, cycle_span, custom_trace_attributes=agent.trace_attributes
        )
        tool_trace = Trace(f"Tool: {tool_name}", parent_id=cycle_trace.id, raw_name=tool_name)
        tool_start_time = time.time()

        with trace_api.use_span(tool_call_span):
            async for event in ToolExecutor._stream(
                agent, tool_use, tool_results, invocation_state, structured_output_context, **kwargs
            ):
                yield event

            if isinstance(event, ToolInterruptEvent):
                tool_duration = time.time() - tool_start_time
                if ToolExecutor._is_agent(agent):
                    agent.event_loop_metrics.add_tool_usage(tool_use, tool_duration, tool_trace, False)
                cycle_trace.add_child(tool_trace)
                tracer.end_tool_call_span(tool_call_span, tool_result=None)
                return

            result_event = cast(ToolResultEvent, event)
            result = result_event.tool_result

            tool_success = result.get("status") == "success"
            tool_duration = time.time() - tool_start_time
            message = Message(role="user", content=[{"toolResult": result}])
            # A background dispatch acknowledgement is not the tool running; the run records its own
            # metrics and trace, so the ack only marks its span.
            if result_event.backgrounded:
                tool_call_span.set_attribute("strands.tool.backgrounded", True)
            else:
                if ToolExecutor._is_agent(agent):
                    agent.event_loop_metrics.add_tool_usage(tool_use, tool_duration, tool_trace, tool_success, message)
                cycle_trace.add_child(tool_trace)

            tracer.end_tool_call_span(tool_call_span, result, error=result_event.exception)

    @abc.abstractmethod
    # pragma: no cover
    def _execute(
        self,
        agent: "Agent",
        tool_uses: list[ToolUse],
        tool_results: list[ToolResult],
        cycle_trace: Trace,
        cycle_span: Any,
        invocation_state: dict[str, Any],
        structured_output_context: "StructuredOutputContext | None" = None,
    ) -> AsyncGenerator[TypedEvent, None]:
        """Execute the given tools according to this executor's strategy.

        Args:
            agent: The agent for which tools are being executed.
            tool_uses: Metadata and inputs for the tools to be executed.
            tool_results: List of tool results from each tool execution.
            cycle_trace: Trace object for the current event loop cycle.
            cycle_span: Span object for tracing the cycle.
            invocation_state: Context for the tool invocation.
            structured_output_context: Context for structured output management.

        Yields:
            Events from the tool execution stream.
        """
        pass


def _route_background(
    background_tasks: "_BackgroundTasks | None",
    tool_use: ToolUse,
    requested_tool: AgentTool | None,
    selected_tool: AgentTool | None,
    invocation_state: dict[str, Any],
) -> tuple[ToolUse, "Literal[True] | ToolResult | None"]:
    """Decide whether a tool call runs in the background.

    Returns the tool use to execute and either True (dispatch), an admission error result, or None
    (run in the foreground). Only model-driven calls carry a cycle id; direct tool calls always run
    inline.
    """
    if background_tasks is None or "event_loop_cycle_id" not in invocation_state:
        return tool_use, None
    # Routing strips the selection flag from the input; copy first so the assistant message in
    # history keeps the model's original request.
    tool_use = cast(ToolUse, dict(tool_use))
    return tool_use, background_tasks.route_tool_call(tool_use, requested_tool, selected_tool)


def _lookup_tool(agent: "Agent | BidiAgent", tool_name: str) -> AgentTool | None:
    """Resolve a tool by name, preferring dynamic tools over the static registry.

    Also used after BeforeToolCallEvent: a hook that renames ``tool_use`` without selecting a
    tool runs the tool registered under the new name, so routing and AfterToolCallEvent see it.
    """
    dynamic_tool = agent.tool_registry.dynamic_tools.get(tool_name)
    return dynamic_tool if dynamic_tool is not None else agent.tool_registry.registry.get(tool_name)


def _make_execute_tool_terminal(
    extra_kwargs: dict[str, Any],
    preset_result: ToolResult | None = None,
    *,
    tool_context: ToolContext[LocalAgent] | None = None,
    tool_guard: Callable[[AgentTool | None], None] | None = None,
) -> "Any":
    """Build the terminal for the ExecuteToolStage middleware chain.

    The terminal streams the resolved tool and yields a plain ``ToolResultEvent`` as its
    last (result) event, matching the SDK-wide "last event is the result" convention.
    Intermediate ``ToolStreamEvent``s flow through unchanged. A tool-originated
    ``ToolInterruptEvent`` flows through as a normal event; the Output-phase adapter and
    the executor both recognize it as a control-flow signal rather than a result.

    A raw exception from ``tool.stream()`` is converted to an error ``ToolResultEvent`` here,
    inside the terminal, so ExecuteToolStage middleware always observes a result rather than a
    thrown exception (matching the TypeScript SDK). ``InterruptException`` is re-raised so a
    tool-raised interrupt still halts the agent instead of becoming an error result.

    All events are derived from ``ctx.tool_use`` (the possibly Input-transformed value the tool
    actually ran with), so the streamed, wrapped, and error events agree on identity fields
    (e.g. ``toolUseId``) even when an Input handler rewrote them.

    Args:
        extra_kwargs: Extra keyword arguments forwarded to ``tool.stream()``.
        preset_result: Error result yielded in place of running the tool, so middleware and the
            after-hook still observe a rejected call.
        tool_context: Task-scoped context handed to the tool instead of the one it would derive
            from ``invocation_state`` (background execution only).
        tool_guard: Validates the tool the middleware chain settled on before it runs.

    Returns:
        An async generator function suitable as a middleware terminal.
    """

    async def terminal(ctx: ExecuteToolContext) -> AsyncGenerator[TypedEvent, None]:
        tool_use = ctx.tool_use

        if tool_guard is not None:
            tool_guard(ctx.tool)

        if preset_result is not None:
            yield ToolResultEvent(preset_result, exception=ValueError(preset_result["content"][0]["text"]))
            return

        # Unknown tool (not in the registry): the chain still ran so middleware could observe
        # or mock it, but with no tool to invoke the terminal yields the error result. The
        # message/exception mirror the pre-middleware unknown-tool contract.
        if ctx.tool is None:
            tool_name = tool_use["name"]
            yield ToolResultEvent(
                {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": f"Unknown tool: {tool_name}"}],
                },
                exception=Exception(f"Unknown tool: {tool_name}"),
            )
            return

        # Mirrors ToolExecutor._stream's original dispatch: built-in AgentTools yield
        # TypedEvents directly (ending in a ToolResultEvent); other tools yield raw values
        # we wrap in ToolStreamEvent, and their last raw value is the result.
        yielded_any = False
        last_raw_event: Any = None
        stream_kwargs = {**extra_kwargs, "_tool_context": tool_context} if tool_context is not None else extra_kwargs
        try:
            async for event in ctx.tool.stream(tool_use, ctx.invocation_state, **stream_kwargs):
                if isinstance(event, ToolInterruptEvent):
                    yield event
                    return

                if isinstance(event, ToolResultEvent):
                    # Re-emit so the exception decorated tools attach rides along as the result.
                    yield ToolResultEvent(event.tool_result, exception=event.exception)
                    return

                if isinstance(event, ToolStreamEvent):
                    yield event
                else:
                    yield ToolStreamEvent(tool_use, event)
                yielded_any = True
                last_raw_event = event
        except InterruptException:
            # A tool-raised interrupt must halt the agent — let it unwind rather than
            # becoming an error result (matches TS re-throwing InterruptError).
            raise
        except Exception as error:
            # Convert a raw tool failure to an error result inside the terminal so middleware
            # sees a result, not an exception. The executor's after-hook still receives the
            # exception via the ToolResultEvent below.
            logger.exception("tool_name=<%s> | tool execution failed", tool_use["name"])
            yield ToolResultEvent(
                {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": f"Error: {error}"}],
                },
                exception=error,
            )
            return

        # Non-SDK tool: no ToolResultEvent was emitted, so the last raw value is the result.
        # A tool that streamed nothing at all has no result — surface an error result rather
        # than a null one so the agent can continue (matches the pre-middleware degradation).
        if not yielded_any:
            yield ToolResultEvent(
                {
                    "toolUseId": str(tool_use.get("toolUseId")),
                    "status": "error",
                    "content": [{"text": f"Tool '{tool_use['name']}' did not return a result"}],
                }
            )
            return
        yield ToolResultEvent(cast(ToolResult, last_raw_event))

    return terminal


@dataclass
class _BackgroundExecuteToolContext(ExecuteToolContext):
    """ExecuteToolStage context for a background task.

    ``interrupt()`` resolves against the task's own interrupt state, which the task manager
    persists with the task, rather than the agent's live interrupt state.
    """

    _background_interrupt: "_MiddlewareInterrupt" = field(repr=False)

    def interrupt(self, name: str, *, reason: Any = None, response: Any = None) -> MiddlewareInterruptResult:
        """Request task-scoped human-in-the-loop input."""
        return self._background_interrupt(name, reason=reason, response=response)
