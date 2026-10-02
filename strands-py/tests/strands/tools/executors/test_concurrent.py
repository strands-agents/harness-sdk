import asyncio

import pytest

import strands
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.tools.executors import ConcurrentToolExecutor
from strands.tools.structured_output._structured_output_context import StructuredOutputContext
from strands.types._events import ToolInterruptEvent, ToolResultEvent


@pytest.fixture
def executor():
    return ConcurrentToolExecutor()


@pytest.fixture
def structured_output_context():
    return StructuredOutputContext(structured_output_model=None)


@pytest.mark.asyncio
async def test_concurrent_executor_execute(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    tool_uses = [
        {"name": "weather_tool", "toolUseId": "1", "input": {}},
        {"name": "temperature_tool", "toolUseId": "2", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    tru_events = sorted(await alist(stream), key=lambda event: event.tool_use_id)
    exp_events = [
        ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]}),
        ToolResultEvent({"toolUseId": "2", "status": "success", "content": [{"text": "75F"}]}),
    ]
    assert tru_events == exp_events

    tru_results = sorted(tool_results, key=lambda result: result.get("toolUseId"))
    exp_results = [exp_events[0].tool_result, exp_events[1].tool_result]
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_concurrent_executor_preserves_tool_use_result_order(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    @strands.tool(name="slow_order_tool")
    async def slow_order_tool():
        await asyncio.sleep(0.05)
        return "slow"

    @strands.tool(name="fast_order_tool")
    async def fast_order_tool():
        return "fast"

    agent.tool_registry.register_tool(slow_order_tool)
    agent.tool_registry.register_tool(fast_order_tool)

    tool_uses = [
        {"name": "slow_order_tool", "toolUseId": "slow", "input": {}},
        {"name": "fast_order_tool", "toolUseId": "fast", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    await alist(stream)

    assert [result["toolUseId"] for result in tool_results] == ["slow", "fast"]


@pytest.mark.asyncio
async def test_concurrent_executor_interrupt(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    interrupt = Interrupt(
        id="v1:before_tool_call:test_tool_id_1:78714d6c-613c-5cf4-bf25-7037569941f9",
        name="test_name",
        reason="test reason",
    )

    def interrupt_callback(event):
        if event.tool_use["name"] == "weather_tool":
            event.interrupt("test_name", "test reason")

    agent.hooks.add_callback(BeforeToolCallEvent, interrupt_callback)

    tool_uses = [
        {"name": "weather_tool", "toolUseId": "test_tool_id_1", "input": {}},
        {"name": "temperature_tool", "toolUseId": "test_tool_id_2", "input": {}},
    ]

    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    tru_events = sorted(await alist(stream), key=lambda event: event.tool_use_id)
    exp_events = [
        ToolInterruptEvent(tool_uses[0], [interrupt]),
        ToolResultEvent({"toolUseId": "test_tool_id_2", "status": "success", "content": [{"text": "75F"}]}),
    ]
    assert tru_events == exp_events

    tru_results = tool_results
    exp_results = [exp_events[1].tool_result]
    assert tru_results == exp_results


@pytest.mark.asyncio
async def test_concurrent_executor_reraises_exceptions(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    """Test that hook re-raised exceptions propagate and cancel remaining tasks."""

    def reraise_callback(event):
        if event.exception is not None:
            raise event.exception

    agent.hooks.add_callback(AfterToolCallEvent, reraise_callback)

    tool_uses = [
        {"name": "exception_tool", "toolUseId": "1", "input": {}},
        {"name": "slow_tool", "toolUseId": "2", "input": {}},
    ]

    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    with pytest.raises(RuntimeError, match="Tool error"):
        await alist(stream)

    assert tool_results == []


class Abort(BaseException):
    pass


def raising_tool(exception):
    @strands.tool(name="raise_tool")
    def func():
        pass

    async def mock_stream(_tool_use, _invocation_state):
        raise exception
        yield  # make generator

    func.stream = mock_stream
    return func


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "exception",
    [Abort("stop"), asyncio.CancelledError()],
    ids=["base_exception", "cancelled_error"],
)
async def test_concurrent_executor_propagates_base_exception(
    exception,
    executor,
    agent,
    tool_results,
    cycle_trace,
    cycle_span,
    invocation_state,
    structured_output_context,
    alist,
):
    # guards against a BaseException raised by a tool being dropped (#4713)
    agent.tool_registry.register_tool(raising_tool(exception))

    tool_uses = [{"name": "raise_tool", "toolUseId": "1", "input": {}}]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    with pytest.raises(type(exception)):
        await alist(stream)

    assert tool_results == []


@pytest.mark.asyncio
async def test_concurrent_executor_base_exception_cancels_running_tools(
    executor,
    agent,
    tool_results,
    cycle_trace,
    cycle_span,
    invocation_state,
    structured_output_context,
    alist,
):
    # guards against a BaseException raised by a tool being dropped (#4713)
    agent.tool_registry.register_tool(raising_tool(Abort("stop")))

    tool_uses = [
        {"name": "slow_tool", "toolUseId": "1", "input": {}},
        {"name": "raise_tool", "toolUseId": "2", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    with pytest.raises(Abort):
        await asyncio.wait_for(alist(stream), timeout=1)

    assert tool_results == []


@pytest.mark.asyncio
async def test_concurrent_executor_base_exception_discards_completed_results(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
):
    # guards against a BaseException raised by a tool being dropped (#4713)
    @strands.tool(name="late_raise_tool")
    async def late_raise_tool():
        await asyncio.sleep(0.05)
        raise Abort("stop")

    agent.tool_registry.register_tool(late_raise_tool)

    tool_uses = [
        {"name": "weather_tool", "toolUseId": "1", "input": {}},
        {"name": "late_raise_tool", "toolUseId": "2", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    tru_events = []
    with pytest.raises(Abort):
        async for event in stream:
            tru_events.append(event)

    exp_events = [ToolResultEvent({"toolUseId": "1", "status": "success", "content": [{"text": "sunny"}]})]
    assert tru_events == exp_events
    assert tool_results == []


@pytest.mark.asyncio
async def test_concurrent_executor_cancellation_cancels_running_tools(
    executor, agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    tool_uses = [
        {"name": "slow_tool", "toolUseId": "1", "input": {}},
        {"name": "slow_tool", "toolUseId": "2", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )

    consumer = asyncio.create_task(alist(stream))
    await asyncio.sleep(0.05)
    consumer.cancel()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(consumer, timeout=1)

    assert tool_results == []
