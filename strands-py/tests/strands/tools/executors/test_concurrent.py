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
