import asyncio

import pytest

import strands
from strands import Agent
from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent
from strands.interrupt import Interrupt
from strands.tools.executors import ConcurrentToolExecutor
from strands.tools.structured_output._structured_output_context import StructuredOutputContext
from strands.types._events import ToolInterruptEvent, ToolResultEvent
from tests.fixtures.mocked_model_provider import MockedModelProvider


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


@pytest.mark.parametrize("max_concurrency", [0, -1, 1.5, "2", True])
def test_concurrent_executor_max_concurrency_rejects_non_positive(max_concurrency):
    with pytest.raises(TypeError, match="max_concurrency must be a positive"):
        ConcurrentToolExecutor(max_concurrency=max_concurrency)


def test_concurrent_executor_max_concurrency_is_keyword_only():
    with pytest.raises(TypeError):
        ConcurrentToolExecutor(2)


@pytest.mark.asyncio
async def test_concurrent_executor_max_concurrency_bounds_batch(
    agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    tool_count = 6
    entered = [asyncio.Event() for _ in range(tool_count)]
    release = asyncio.Event()
    active = 0
    peak = 0

    def make_tool(index):
        @strands.tool(name=f"bounded_tool_{index}")
        async def func():
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered[index].set()
            await release.wait()
            active -= 1
            return f"result_{index}"

        return func

    for index in range(tool_count):
        agent.tool_registry.register_tool(make_tool(index))

    executor = ConcurrentToolExecutor(max_concurrency=2)
    tool_uses = [{"name": f"bounded_tool_{index}", "toolUseId": str(index), "input": {}} for index in range(tool_count)]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )
    consume = asyncio.create_task(alist(stream))

    await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered[:2])), timeout=5)
    assert active == 2
    assert all(not event.is_set() for event in entered[2:])

    release.set()
    await asyncio.wait_for(consume, timeout=5)

    assert peak == 2
    assert [result["toolUseId"] for result in tool_results] == [str(index) for index in range(tool_count)]


@pytest.mark.asyncio
async def test_concurrent_executor_max_concurrency_admits_waiting_work(
    agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    """A completed execution frees its slot while a peer is still running."""
    first_release = asyncio.Event()
    gate = asyncio.Event()
    entered_second = asyncio.Event()
    entered_third = asyncio.Event()

    @strands.tool(name="first_gate_tool")
    async def first_gate_tool():
        await first_release.wait()
        return "first"

    @strands.tool(name="second_gate_tool")
    async def second_gate_tool():
        entered_second.set()
        await gate.wait()
        return "second"

    @strands.tool(name="third_gate_tool")
    async def third_gate_tool():
        entered_third.set()
        await gate.wait()
        return "third"

    agent.tool_registry.register_tool(first_gate_tool)
    agent.tool_registry.register_tool(second_gate_tool)
    agent.tool_registry.register_tool(third_gate_tool)

    executor = ConcurrentToolExecutor(max_concurrency=2)
    tool_uses = [
        {"name": "first_gate_tool", "toolUseId": "1", "input": {}},
        {"name": "second_gate_tool", "toolUseId": "2", "input": {}},
        {"name": "third_gate_tool", "toolUseId": "3", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )
    consume = asyncio.create_task(alist(stream))

    await asyncio.wait_for(entered_second.wait(), timeout=5)
    assert not entered_third.is_set()

    first_release.set()
    await asyncio.wait_for(entered_third.wait(), timeout=5)
    assert not gate.is_set()

    gate.set()
    await asyncio.wait_for(consume, timeout=5)
    assert [result["toolUseId"] for result in tool_results] == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_concurrent_executor_max_concurrency_releases_slot_on_error(
    agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    """A handled tool error frees its slot for waiting work."""
    entered = asyncio.Event()

    @strands.tool(name="after_error_tool")
    async def after_error_tool():
        entered.set()
        return "after"

    agent.tool_registry.register_tool(after_error_tool)

    executor = ConcurrentToolExecutor(max_concurrency=1)
    tool_uses = [
        {"name": "exception_tool", "toolUseId": "err", "input": {}},
        {"name": "after_error_tool", "toolUseId": "after", "input": {}},
    ]
    stream = executor._execute(
        agent, tool_uses, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context
    )
    await asyncio.wait_for(alist(stream), timeout=5)

    assert entered.is_set()
    assert [result["toolUseId"] for result in tool_results] == ["err", "after"]


@pytest.mark.asyncio
async def test_concurrent_executor_max_concurrency_is_per_batch(
    agent, tool_results, cycle_trace, cycle_span, invocation_state, structured_output_context, alist
):
    """Consecutive batches get independent admission budgets."""
    entered = [asyncio.Event() for _ in range(3)]
    release = asyncio.Event()
    active = 0
    peak = 0

    def make_tool(index):
        @strands.tool(name=f"batch_tool_{index}")
        async def func():
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered[index].set()
            await release.wait()
            active -= 1
            return index

        return func

    for index in range(3):
        agent.tool_registry.register_tool(make_tool(index))

    executor = ConcurrentToolExecutor(max_concurrency=2)
    tool_uses = [{"name": f"batch_tool_{index}", "toolUseId": str(index), "input": {}} for index in range(3)]
    for _ in range(2):
        for event in entered:
            event.clear()
        release.clear()

        batch_results: list = []
        stream = executor._execute(
            agent, tool_uses, batch_results, cycle_trace, cycle_span, invocation_state, structured_output_context
        )
        consume = asyncio.create_task(alist(stream))
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered[:2])), timeout=5)
        release.set()
        await asyncio.wait_for(consume, timeout=5)
        assert [result["toolUseId"] for result in batch_results] == ["0", "1", "2"]

    assert peak == 2


@pytest.mark.asyncio
async def test_concurrent_executor_max_concurrency_agent_batch():
    """A bounded executor admits tool uses in stages while keeping the batch parallel."""
    two_entered = asyncio.Event()
    release = asyncio.Event()
    active = 0
    entered = 0
    peak = 0

    @strands.tool
    async def gated_tool() -> str:
        nonlocal active, entered, peak
        active += 1
        entered += 1
        peak = max(peak, active)
        if entered == 2:
            two_entered.set()
        await release.wait()
        active -= 1
        return "done"

    mock_provider = MockedModelProvider(
        [
            {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "gated_tool", "toolUseId": "1", "input": {}}},
                    {"toolUse": {"name": "gated_tool", "toolUseId": "2", "input": {}}},
                    {"toolUse": {"name": "gated_tool", "toolUseId": "3", "input": {}}},
                ],
            },
            {"role": "assistant", "content": [{"text": "final answer"}]},
        ]
    )
    agent = Agent(model=mock_provider, tools=[gated_tool], tool_executor=ConcurrentToolExecutor(max_concurrency=2))

    run = asyncio.create_task(agent.invoke_async("go"))
    await asyncio.wait_for(two_entered.wait(), timeout=5)
    assert entered == 2

    release.set()
    result = await asyncio.wait_for(run, timeout=5)

    assert entered == 3
    assert peak == 2
    tool_results = [block for message in agent.messages for block in message["content"] if "toolResult" in block]
    assert [block["toolResult"]["toolUseId"] for block in tool_results] == ["1", "2", "3"]
    assert result.message["content"][0]["text"] == "final answer"
