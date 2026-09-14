import unittest.mock
from unittest.mock import ANY, MagicMock

import pytest

import strands
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.telemetry.metrics import Trace
from strands.tools.executors._executor import ToolExecutor
from strands.types._events import ToolCancelEvent, ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolUse


@pytest.fixture
def executor_cls():
    class ClsExecutor(ToolExecutor):
        def _execute(self, _agent, _tool_uses, _tool_results, _invocation_state):
            raise NotImplementedError

    return ClsExecutor


@pytest.fixture
def executor(executor_cls):
    return executor_cls()


@pytest.fixture
def tracer():
    with unittest.mock.patch.object(strands.tools.executors._executor, "get_tracer") as mock_get_tracer:
        yield mock_get_tracer.return_value


@pytest.mark.asyncio
async def test_executor_stream_yields_result(
    executor, agent, tool_results, invocation_state, hook_events, weather_tool, alist
):
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results

    tru_hook_events = hook_events
    exp_hook_events = [
        BeforeToolCallEvent(
            agent=agent,
            selected_tool=weather_tool,
            tool_use=tool_use,
            invocation_state=invocation_state,
        ),
        AfterToolCallEvent(
            agent=agent,
            selected_tool=weather_tool,
            tool_use=tool_use,
            invocation_state=invocation_state,
            result=exp_results[0],
            duration=ANY,
        ),
    ]
    assert tru_hook_events == exp_hook_events

    # Verify duration is a realistic positive value (mocked tool should complete in under 10s)
    after_event = tru_hook_events[1]
    assert isinstance(after_event.duration, float)
    assert 0 <= after_event.duration < 10


@pytest.mark.asyncio
async def test_executor_stream_runs_tool_registered_under_hook_renamed_tool_use(
    executor, agent, tool_results, invocation_state, hook_events, weather_tool, temperature_tool, alist
):
    def rename(event):
        if isinstance(event, BeforeToolCallEvent):
            event.tool_use["name"] = "temperature_tool"

    agent.hooks.add_callback(BeforeToolCallEvent, rename)
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "75F"}]}),
    ]
    assert tru_events == exp_events

    tru_after_tool = hook_events[-1].selected_tool
    exp_after_tool = temperature_tool
    assert tru_after_tool is exp_after_tool


@pytest.mark.asyncio
async def test_executor_stream_wraps_results(
    executor, agent, tool_results, invocation_state, hook_events, weather_tool, alist, agenerator
):
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    weather_tool.stream = MagicMock()
    weather_tool.stream.return_value = agenerator(
        ["value 1", {"nested": True}, {"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}]
    )

    tru_events = await alist(stream)
    exp_events = [
        ToolStreamEvent(tool_use, "value 1"),
        ToolStreamEvent(tool_use, {"nested": True}),
        ToolStreamEvent(tool_use, {"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}),
        ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}),
    ]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_executor_stream_passes_through_typed_events(
    executor, agent, tool_results, invocation_state, hook_events, weather_tool, alist, agenerator
):
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    weather_tool.stream = MagicMock()
    event_1 = ToolStreamEvent(tool_use, "value 1")
    event_2 = ToolStreamEvent(tool_use, {"nested": True})
    event_3 = ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]})
    weather_tool.stream.return_value = agenerator(
        [
            event_1,
            event_2,
            event_3,
        ]
    )

    tru_events = await alist(stream)
    assert tru_events[0] is event_1
    assert tru_events[1] is event_2

    # ToolResults are not passed through directly, they're unwrapped then wraped again
    assert tru_events[2] == event_3


@pytest.mark.asyncio
async def test_executor_stream_wraps_stream_events_if_no_result(
    executor, agent, tool_results, invocation_state, hook_events, weather_tool, alist, agenerator
):
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    weather_tool.stream = MagicMock()
    last_event = ToolStreamEvent(tool_use, "value 1")
    # Only ToolResultEvent can be the last value; all others are wrapped in ToolResultEvent
    weather_tool.stream.return_value = agenerator(
        [
            last_event,
        ]
    )

    tru_events = await alist(stream)
    exp_events = [last_event, ToolResultEvent(last_event)]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_executor_stream_yields_tool_error(
    executor, agent, tool_results, invocation_state, hook_events, exception_tool, alist
):
    tool_use = {"name": "exception_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [ToolResultEvent({"toolUseId": "1", "status": "error", "content": [{"text": "Error: Tool error"}]})]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results

    tru_hook_after_event = hook_events[-1]
    exp_hook_after_event = AfterToolCallEvent(
        agent=agent,
        selected_tool=exception_tool,
        tool_use=tool_use,
        invocation_state=invocation_state,
        result=exp_results[0],
        exception=unittest.mock.ANY,
        duration=ANY,
    )
    assert tru_hook_after_event == exp_hook_after_event

    # Verify duration is a realistic positive value
    assert isinstance(tru_hook_after_event.duration, float)
    assert 0 <= tru_hook_after_event.duration < 10


@pytest.mark.asyncio
async def test_executor_stream_yields_unknown_tool(executor, agent, tool_results, invocation_state, hook_events, alist):
    tool_use = {"name": "unknown_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "1", "status": "error", "content": [{"text": "Unknown tool: unknown_tool"}]})
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results

    tru_hook_after_event = hook_events[-1]
    exp_hook_after_event = AfterToolCallEvent(
        agent=agent,
        selected_tool=None,
        tool_use=tool_use,
        invocation_state=invocation_state,
        result=exp_results[0],
        exception=unittest.mock.ANY,
        duration=ANY,
    )
    assert tru_hook_after_event == exp_hook_after_event

    # Unknown tool still passes through middleware, so duration is measured
    assert isinstance(tru_hook_after_event.duration, float)
    assert 0 <= tru_hook_after_event.duration < 10


@pytest.mark.asyncio
async def test_executor_stream_with_trace(
    executor, tracer, agent, tool_results, cycle_trace, cycle_span, invocation_state, alist
):
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream_with_trace(agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results

    tracer.start_tool_call_span.assert_called_once_with(
        tool_use, cycle_span, custom_trace_attributes=agent.trace_attributes
    )
    tracer.end_tool_call_span.assert_called_once_with(
        tracer.start_tool_call_span.return_value,
        {"content": [{"text": "sunny"}], "status": "success", "toolUseId": "1"},
        error=None,
    )

    cycle_trace.add_child.assert_called_once()
    assert isinstance(cycle_trace.add_child.call_args[0][0], Trace)


@pytest.mark.asyncio
async def test_executor_stream_with_trace_marks_backgrounded_without_metrics_or_trace(
    executor, tracer, agent, tool_results, cycle_trace, cycle_span, invocation_state, alist, agenerator
):
    """A background dispatch acknowledgement marks its span but records no metrics and no cycle trace node."""
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    result = {"toolUseId": "1", "status": "success", "content": [{"text": "queued"}]}
    with unittest.mock.patch.object(
        ToolExecutor, "_stream", return_value=agenerator([ToolResultEvent(result, backgrounded=True)])
    ):
        stream = executor._stream_with_trace(agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state)
        await alist(stream)

    agent.event_loop_metrics.add_tool_usage.assert_not_called()
    cycle_trace.add_child.assert_not_called()
    tracer.start_tool_call_span.return_value.set_attribute.assert_called_once_with("strands.tool.backgrounded", True)
    tracer.end_tool_call_span.assert_called_once_with(tracer.start_tool_call_span.return_value, result, error=None)


@pytest.mark.asyncio
async def test_executor_stream_with_trace_records_metrics_on_interrupt(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, alist
):
    """Interrupted tool calls are recorded in metrics and cycle_trace with no message attached (issue #1063)."""
    tool_use: ToolUse = {"name": "interrupt_tool", "toolUseId": "test_tool_id", "input": {}}
    stream = executor._stream_with_trace(agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state)

    await alist(stream)

    agent.event_loop_metrics.add_tool_usage.assert_called_once()
    call_args = agent.event_loop_metrics.add_tool_usage.call_args
    tool_arg, _duration, trace_arg, success_arg, *rest = call_args.args
    assert tool_arg == tool_use
    assert success_arg is False
    assert rest == [] and "message" not in call_args.kwargs
    assert isinstance(trace_arg, Trace)
    cycle_trace.add_child.assert_called_once_with(trace_arg)


@pytest.mark.parametrize(
    ("cancel_tool", "cancel_message"),
    [(True, "tool cancelled by user"), ("user cancel message", "user cancel message")],
)
@pytest.mark.asyncio
async def test_executor_stream_cancel(
    cancel_tool, cancel_message, executor, agent, tool_results, invocation_state, alist
):
    def cancel_callback(event):
        event.cancel_tool = cancel_tool
        return event

    agent.hooks.add_callback(BeforeToolCallEvent, cancel_callback)
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolCancelEvent(tool_use, cancel_message),
        ToolResultEvent(
            {
                "toolUseId": "1",
                "status": "error",
                "content": [{"text": cancel_message}],
            },
        ),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_executor_stream_sets_span_attributes(
    executor, agent, tool_results, invocation_state, weather_tool, alist
):
    """Test that span attributes are set correctly when tool_spec is available."""
    with unittest.mock.patch("strands.tools.executors._executor.trace_api") as mock_trace_api:
        mock_span = unittest.mock.MagicMock()
        mock_trace_api.get_current_span.return_value = mock_span

        # Mock tool_spec with inputSchema containing json field
        with unittest.mock.patch.object(
            type(weather_tool), "tool_spec", new_callable=unittest.mock.PropertyMock
        ) as mock_tool_spec:
            mock_tool_spec.return_value = {
                "name": "weather_tool",
                "description": "Get weather information",
                "inputSchema": {"json": {"type": "object", "properties": {}}, "type": "object"},
            }

            tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
            stream = executor._stream(agent, tool_use, tool_results, invocation_state)

            await alist(stream)

            # Verify set_attribute was called with correct values
            calls = mock_span.set_attribute.call_args_list
            assert len(calls) == 2

            # Check description attribute
            assert calls[0][0][0] == "gen_ai.tool.description"
            assert calls[0][0][1] == "Get weather information"

            # Check json_schema attribute
            assert calls[1][0][0] == "gen_ai.tool.json_schema"
            # The serialize function should have been called on the json field


@pytest.mark.asyncio
async def test_executor_stream_handles_missing_json_in_input_schema(
    executor, agent, tool_results, invocation_state, weather_tool, alist
):
    """Test that span attributes handle inputSchema without json field gracefully."""
    with unittest.mock.patch("strands.tools.executors._executor.trace_api") as mock_trace_api:
        mock_span = unittest.mock.MagicMock()
        mock_trace_api.get_current_span.return_value = mock_span

        # Mock tool_spec with inputSchema but no json field
        with unittest.mock.patch.object(
            type(weather_tool), "tool_spec", new_callable=unittest.mock.PropertyMock
        ) as mock_tool_spec:
            mock_tool_spec.return_value = {
                "name": "weather_tool",
                "description": "Get weather information",
                "inputSchema": {"type": "object", "properties": {}},
            }

            tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
            stream = executor._stream(agent, tool_use, tool_results, invocation_state)

            # Should not raise an error - json_schema attribute just won't be set
            await alist(stream)

            # Verify only description attribute was set (not json_schema)
            calls = mock_span.set_attribute.call_args_list
            assert len(calls) == 1
            assert calls[0][0][0] == "gen_ai.tool.description"


@pytest.mark.asyncio
async def test_executor_stream_no_span_attributes_when_no_tool_spec(
    executor, agent, tool_results, invocation_state, alist
):
    """Test that no span attributes are set when tool_spec is None."""
    with unittest.mock.patch("strands.tools.executors._executor.trace_api") as mock_trace_api:
        mock_span = unittest.mock.MagicMock()
        mock_trace_api.get_current_span.return_value = mock_span

        # Use unknown tool which will have no tool_spec
        tool_use: ToolUse = {"name": "unknown_tool", "toolUseId": "1", "input": {}}
        stream = executor._stream(agent, tool_use, tool_results, invocation_state)

        await alist(stream)

        # Verify set_attribute was not called since tool_spec is None
        mock_span.set_attribute.assert_not_called()


@pytest.mark.asyncio
async def test_executor_stream_hook_interrupt(executor, agent, tool_results, invocation_state, alist):
    tool_use = {"name": "weather_tool", "toolUseId": "test_tool_id", "input": {}}

    interrupt = Interrupt(
        id="v1:before_tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
    )

    def interrupt_callback(event):
        event.interrupt("test_name", reason="test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [ToolInterruptEvent(tool_use, [interrupt])]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = []
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_executor_stream_hook_interrupt_resume(executor, agent, tool_results, invocation_state, alist):
    tool_use = {"name": "weather_tool", "toolUseId": "test_tool_id", "input": {}}

    interrupt = Interrupt(
        id="v1:before_tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
        response="test response",
    )
    agent._interrupt_state.interrupts[interrupt.id] = interrupt

    interrupt_response = {}

    def interrupt_callback(event):
        interrupt_response["response"] = event.interrupt("test_name", reason="test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent(
            {
                "toolUseId": "test_tool_id",
                "status": "success",
                "content": [{"text": "sunny"}],
            },
        ),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results

    tru_response = interrupt_response["response"]
    exp_response = "test response"
    assert tru_response == exp_response


@pytest.mark.asyncio
async def test_executor_stream_tool_interrupt(executor, agent, tool_results, invocation_state, alist):
    tool_use = {"name": "interrupt_tool", "toolUseId": "test_tool_id", "input": {}}

    interrupt = Interrupt(
        id="v1:tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
    )

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [ToolInterruptEvent(tool_use, [interrupt])]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = []
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_executor_stream_tool_interrupt_resume(executor, agent, tool_results, invocation_state, alist):
    tool_use = {"name": "interrupt_tool", "toolUseId": "test_tool_id", "input": {}}

    interrupt = Interrupt(
        id="v1:tool_call:test_tool_id:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
        response="test response",
    )
    agent._interrupt_state.interrupts[interrupt.id] = interrupt

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)
    exp_events = [
        ToolResultEvent(
            {
                "toolUseId": "test_tool_id",
                "status": "success",
                "content": [{"text": "test response"}],
            },
        ),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[-1].tool_result]
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_executor_stream_tool_interrupt_registers_on_agent(
    executor, agent, tool_results, invocation_state, alist
):
    """ToolInterruptEvent from a tool should register interrupts in the agent's _interrupt_state."""
    # Create a tool that yields a ToolInterruptEvent with an interrupt NOT pre-registered on the agent
    # (simulates _AgentAsTool propagating sub-agent interrupts).
    foreign_interrupt = Interrupt(id="sub-agent-interrupt-1", name="approval", reason="need approval")

    @strands.tool(name="agent_tool")
    def agent_tool_func():
        return "unused"

    async def mock_stream(_tool_use, _invocation_state, **_kwargs):
        yield ToolInterruptEvent(_tool_use, [foreign_interrupt])

    agent_tool_func.stream = mock_stream
    agent.tool_registry.register_tool(agent_tool_func)

    tool_use: ToolUse = {"name": "agent_tool", "toolUseId": "test_tool_id", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    events = await alist(stream)

    # Should yield the interrupt event
    assert len(events) == 1
    assert isinstance(events[0], ToolInterruptEvent)

    # The interrupt should now be registered on the agent's _interrupt_state
    assert "sub-agent-interrupt-1" in agent._interrupt_state.interrupts
    assert agent._interrupt_state.interrupts["sub-agent-interrupt-1"] is foreign_interrupt


@pytest.mark.asyncio
async def test_executor_stream_tool_interrupt_does_not_overwrite_existing(
    executor, agent, tool_results, invocation_state, alist
):
    """setdefault should not overwrite interrupts already in the agent's state (normal hook case)."""
    tool_use = {"name": "interrupt_tool", "toolUseId": "test_tool_id", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    # The interrupt_tool hook registered the interrupt via _Interruptible.interrupt().
    # The executor's setdefault should have been a no-op for this pre-registered interrupt.
    registered = agent._interrupt_state.interrupts
    assert len(registered) == 1
    interrupt = next(iter(registered.values()))
    assert interrupt.name == "test_name"
    assert interrupt.reason == "test reason"


@pytest.mark.asyncio
async def test_executor_stream_updates_invocation_state_with_agent(
    executor, agent, tool_results, invocation_state, weather_tool, alist
):
    """Test that invocation_state is updated with agent reference."""
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}

    # Start with empty invocation_state to verify agent is added
    empty_invocation_state = {}

    stream = executor._stream(agent, tool_use, tool_results, empty_invocation_state)
    await alist(stream)

    # Verify that the invocation_state was updated with the agent
    assert "agent" in empty_invocation_state
    assert empty_invocation_state["agent"] is agent


@pytest.mark.asyncio
async def test_executor_stream_decorated_tool_exception_in_hook(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that exceptions from @tool-decorated functions reach AfterToolCallEvent."""
    exception = ValueError("decorated tool error")

    @strands.tool(name="decorated_error_tool")
    def failing_tool():
        """A tool that raises an exception."""
        raise exception

    agent.tool_registry.register_tool(failing_tool)
    tool_use = {"name": "decorated_error_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.exception is exception


@pytest.mark.asyncio
async def test_executor_stream_decorated_tool_runtime_error_in_hook(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that RuntimeError from @tool-decorated functions reach AfterToolCallEvent."""
    exception = RuntimeError("runtime error from decorated tool")

    @strands.tool(name="runtime_error_tool")
    def runtime_error_tool():
        """A tool that raises a RuntimeError."""
        raise exception

    agent.tool_registry.register_tool(runtime_error_tool)
    tool_use = {"name": "runtime_error_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.exception is exception


@pytest.mark.asyncio
async def test_executor_stream_decorated_tool_no_exception_on_success(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that AfterToolCallEvent.exception is None when decorated tool succeeds."""

    @strands.tool(name="success_decorated_tool")
    def success_tool():
        """A tool that succeeds."""
        return "success"

    agent.tool_registry.register_tool(success_tool)
    tool_use = {"name": "success_decorated_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.exception is None
    assert after_event.result["status"] == "success"


@pytest.mark.asyncio
async def test_executor_stream_decorated_tool_error_result_without_exception(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that exception is None when a tool returns an error result without throwing."""

    @strands.tool(name="error_result_tool")
    def error_result_tool():
        """A tool that returns an error result dict without raising."""
        return {"status": "error", "content": [{"text": "something went wrong"}]}

    agent.tool_registry.register_tool(error_result_tool)
    tool_use = {"name": "error_result_tool", "toolUseId": "1", "input": {}}

    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.exception is None
    assert after_event.result["status"] == "error"


@pytest.mark.asyncio
async def test_executor_stream_no_retry_set(executor, agent, tool_results, invocation_state, alist):
    """Test default behavior when retry is not set - tool executes once."""
    call_count = {"count": 0}

    @strands.tool(name="counting_tool")
    def counting_tool():
        call_count["count"] += 1
        return f"attempt_{call_count['count']}"

    agent.tool_registry.register_tool(counting_tool)

    tool_use: ToolUse = {"name": "counting_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)

    # Tool should be called exactly once
    assert call_count["count"] == 1

    # Single result event with first attempt's content
    assert len(tru_events) == 1
    assert tru_events[0].tool_result == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_1"}]}

    # tool_results should contain the result
    assert len(tool_results) == 1
    assert tool_results[0] == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_1"}]}


@pytest.mark.asyncio
async def test_executor_stream_retry_true(executor, agent, tool_results, invocation_state, alist):
    """Test that retry=True causes tool re-execution."""
    call_count = {"count": 0}

    @strands.tool(name="counting_tool")
    def counting_tool():
        call_count["count"] += 1
        return f"attempt_{call_count['count']}"

    agent.tool_registry.register_tool(counting_tool)

    # Set retry=True on first call only
    def retry_once(event):
        if isinstance(event, AfterToolCallEvent) and call_count["count"] == 1:
            event.retry = True
        return event

    agent.hooks.add_callback(AfterToolCallEvent, retry_once)

    tool_use: ToolUse = {"name": "counting_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)

    # Tool should be called twice due to retry
    assert call_count["count"] == 2

    # Only final result is yielded (first attempt's result was discarded)
    assert len(tru_events) == 1
    assert tru_events[0].tool_result == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_2"}]}

    # tool_results only contains the final result
    assert len(tool_results) == 1
    assert tool_results[0] == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_2"}]}


@pytest.mark.parametrize("cancel_agent", [False, True])
@pytest.mark.asyncio
async def test_executor_stream_does_not_retry_cancelled_tool_result(
    cancel_agent, executor, agent, tool_results, invocation_state, alist
):
    """Test cancellation remains terminal when an after hook requests retry."""
    call_count = 0

    @strands.tool(name="cancelled_tool")
    def cancelled_tool():
        nonlocal call_count
        call_count += 1
        if cancel_agent:
            agent._cancel_signal.set()
        return {
            "status": "error",
            "content": [{"text": "cancelled"}],
            **({} if cancel_agent else {"cancelled": True}),
        }

    def retry_on_error(event):
        if isinstance(event, AfterToolCallEvent) and event.result["status"] == "error":
            event.retry = True
        return event

    agent.tool_registry.register_tool(cancelled_tool)
    agent.hooks.add_callback(AfterToolCallEvent, retry_on_error)
    tool_use: ToolUse = {"name": "cancelled_tool", "toolUseId": "1", "input": {}}

    tru_events = await alist(executor._stream(agent, tool_use, tool_results, invocation_state))

    assert call_count == 1
    assert len(tru_events) == 1
    assert tru_events[0].tool_result["status"] == "error"
    assert len(tool_results) == 1


@pytest.mark.asyncio
async def test_executor_stream_retry_true_emits_events_from_both_attempts(
    executor, agent, tool_results, invocation_state, alist
):
    """Test that ToolStreamEvents from discarded attempt ARE emitted, but ToolResultEvent is NOT.

    This validates the documented behavior: 'Streaming events from the discarded
    tool execution will have already been emitted to callers before the retry occurs.'

    Key distinction:
    - ToolStreamEvent (intermediate): Yielded immediately, visible from BOTH attempts
    - ToolResultEvent (final): Only yielded for the final attempt, discarded on retry
    """
    call_count = {"count": 0}

    @strands.tool(name="streaming_tool")
    def streaming_tool():
        return "unused"

    # Provide streaming implementation (same pattern as exception_tool fixture)
    async def tool_stream(_tool_use, _invocation_state, **kwargs):
        call_count["count"] += 1
        yield f"streaming_from_attempt_{call_count['count']}"
        yield ToolResultEvent(
            {"toolUseId": "1", "status": "success", "content": [{"text": f"result_{call_count['count']}"}]}
        )

    streaming_tool.stream = tool_stream
    agent.tool_registry.register_tool(streaming_tool)

    # Set retry=True on first call
    def retry_once(event):
        if isinstance(event, AfterToolCallEvent) and call_count["count"] == 1:
            event.retry = True
        return event

    agent.hooks.add_callback(AfterToolCallEvent, retry_once)

    tool_use: ToolUse = {"name": "streaming_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)

    # Tool called twice
    assert call_count["count"] == 2

    # Streaming events from BOTH attempts are emitted (documented behavior)
    stream_events = [e for e in tru_events if isinstance(e, ToolStreamEvent)]
    assert len(stream_events) == 2
    assert stream_events[0] == ToolStreamEvent(tool_use, "streaming_from_attempt_1")
    assert stream_events[1] == ToolStreamEvent(tool_use, "streaming_from_attempt_2")

    # Only final ToolResultEvent is emitted
    result_events = [e for e in tru_events if isinstance(e, ToolResultEvent)]
    assert len(result_events) == 1
    assert result_events[0].tool_result["content"][0]["text"] == "result_2"


@pytest.mark.asyncio
async def test_executor_stream_retry_false(executor, agent, tool_results, invocation_state, alist):
    """Test that explicitly setting retry=False does not retry."""
    call_count = {"count": 0}

    @strands.tool(name="counting_tool")
    def counting_tool():
        call_count["count"] += 1
        return f"attempt_{call_count['count']}"

    agent.tool_registry.register_tool(counting_tool)

    # Explicitly set retry=False
    def no_retry(event):
        if isinstance(event, AfterToolCallEvent):
            event.retry = False
        return event

    agent.hooks.add_callback(AfterToolCallEvent, no_retry)

    tool_use: ToolUse = {"name": "counting_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    tru_events = await alist(stream)

    # Tool should be called exactly once
    assert call_count["count"] == 1

    # Single result event
    assert len(tru_events) == 1
    assert tru_events[0].tool_result == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_1"}]}

    # tool_results should contain the result
    assert len(tool_results) == 1
    assert tool_results[0] == {"toolUseId": "1", "status": "success", "content": [{"text": "attempt_1"}]}


@pytest.mark.asyncio
async def test_executor_stream_retry_after_exception(executor, agent, tool_results, invocation_state, alist):
    """Test that retry=True works when tool raises an exception.

    Covers the exception path retry check.
    """
    call_count = {"count": 0}

    @strands.tool(name="flaky_tool")
    def flaky_tool():
        call_count["count"] += 1
        if call_count["count"] == 1:
            raise RuntimeError("First call fails")
        return "success"

    agent.tool_registry.register_tool(flaky_tool)

    # Retry once on error (check result status, not exception attribute)
    def retry_on_error(event):
        if isinstance(event, AfterToolCallEvent) and event.result.get("status") == "error" and call_count["count"] == 1:
            event.retry = True
        return event

    agent.hooks.add_callback(AfterToolCallEvent, retry_on_error)

    tool_use: ToolUse = {"name": "flaky_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    tru_events = await alist(stream)

    # Tool called twice (1 exception + 1 success)
    assert call_count["count"] == 2

    # Final result is success
    assert len(tru_events) == 1
    assert tru_events[0].tool_result["status"] == "success"


@pytest.mark.asyncio
async def test_executor_stream_retry_after_unknown_tool(executor, agent, tool_results, invocation_state, alist):
    """Test that retry=True triggers retry loop for unknown tool.

    Covers the unknown tool path retry check. Tool lookup happens before retry loop,
    so even after retry the tool remains unknown - this test verifies the retry
    mechanism is triggered, not that it resolves the unknown tool.
    """
    hook_call_count = {"count": 0}

    # Retry once on first unknown tool error
    def retry_once_on_unknown(event):
        if isinstance(event, AfterToolCallEvent):
            hook_call_count["count"] += 1
            # Retry only on first call
            if hook_call_count["count"] == 1:
                event.retry = True
        return event

    agent.hooks.add_callback(AfterToolCallEvent, retry_once_on_unknown)

    tool_use: ToolUse = {"name": "nonexistent_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    tru_events = await alist(stream)

    # Hook called twice (retry was triggered)
    assert hook_call_count["count"] == 2

    # Final result is still error (tool remains unknown after retry)
    assert len(tru_events) == 1
    assert tru_events[0].tool_result["status"] == "error"
    assert "Unknown tool" in tru_events[0].tool_result["content"][0]["text"]


@pytest.mark.asyncio
async def test_executor_stream_with_trace_error(
    executor, tracer, agent, tool_results, cycle_trace, cycle_span, invocation_state, alist
):
    """Test that _stream_with_trace passes the exception to end_tool_call_span when a tool fails."""
    tool_use: ToolUse = {"name": "exception_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream_with_trace(agent, tool_use, tool_results, cycle_trace, cycle_span, invocation_state)

    await alist(stream)

    tracer.end_tool_call_span.assert_called_once()
    call_args = tracer.end_tool_call_span.call_args
    assert call_args[0][1]["status"] == "error"
    error_arg = call_args[1].get("error")
    assert error_arg is not None
    assert isinstance(error_arg, RuntimeError)
    assert "Tool error" in str(error_arg)


@pytest.mark.asyncio
async def test_executor_stream_error_preserves_exception(executor, agent, tool_results, invocation_state, alist):
    """Test that _stream yields a ToolResultEvent with the exception preserved."""
    tool_use: ToolUse = {"name": "exception_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    events = await alist(stream)
    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert result_event.tool_result["status"] == "error"
    assert result_event.exception is not None
    assert isinstance(result_event.exception, RuntimeError)
    assert "Tool error" in str(result_event.exception)


@pytest.mark.asyncio
async def test_executor_stream_unknown_tool_has_exception(executor, agent, tool_results, invocation_state, alist):
    """Test that _stream yields a ToolResultEvent with exception for unknown tools."""
    tool_use: ToolUse = {"name": "nonexistent_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    events = await alist(stream)
    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert result_event.tool_result["status"] == "error"
    assert result_event.exception is not None
    assert "Unknown tool" in str(result_event.exception)


@pytest.mark.asyncio
async def test_executor_stream_cancel_no_exception(executor, agent, tool_results, invocation_state, alist):
    """Test that _stream yields a ToolResultEvent with no exception for cancelled tools."""

    def cancel_callback(event):
        event.cancel_tool = True
        return event

    agent.hooks.add_callback(BeforeToolCallEvent, cancel_callback)
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)

    events = await alist(stream)
    result_event = events[-1]
    assert isinstance(result_event, ToolResultEvent)
    assert result_event.tool_result["status"] == "error"
    assert result_event.exception is None


@pytest.mark.asyncio
async def test_executor_stream_cancel_after_hook_sees_no_exception(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that AfterToolCallEvent.exception is None when a tool is cancelled."""

    def cancel_callback(event):
        event.cancel_tool = "user denied permission"
        return event

    agent.hooks.add_callback(BeforeToolCallEvent, cancel_callback)
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.exception is None
    assert after_event.cancel_message == "user denied permission"


@pytest.mark.asyncio
async def test_executor_stream_cancel_duration_is_none(
    executor, agent, tool_results, invocation_state, hook_events, alist
):
    """Test that AfterToolCallEvent.duration is None when the tool is cancelled before execution."""

    def cancel_callback(event):
        event.cancel_tool = True
        return event

    agent.hooks.add_callback(BeforeToolCallEvent, cancel_callback)
    tool_use: ToolUse = {"name": "weather_tool", "toolUseId": "1", "input": {}}
    stream = executor._stream(agent, tool_use, tool_results, invocation_state)
    await alist(stream)

    after_event = hook_events[-1]
    assert isinstance(after_event, AfterToolCallEvent)
    assert after_event.duration is None
