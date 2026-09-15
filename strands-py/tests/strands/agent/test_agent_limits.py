"""Tests for per-invocation budget caps via the ``limits`` kwarg."""

from collections.abc import Sequence

import pytest

from strands import Agent, tool
from strands.hooks import AfterInvocationEvent, BeforeInvocationEvent
from strands.types.event_loop import Usage
from tests.fixtures.mocked_model_provider import MockedModelProvider

TOOL_USE_RESPONSE_1 = {
    "role": "assistant",
    "content": [{"toolUse": {"toolUseId": "tool-1", "name": "loop", "input": {}}}],
}
TOOL_USE_RESPONSE_2 = {
    "role": "assistant",
    "content": [{"toolUse": {"toolUseId": "tool-2", "name": "loop", "input": {}}}],
}


@tool
def loop() -> str:
    """A passthrough tool used to drive multi-turn loops in tests."""
    return "ok"


def _usage(input_tokens: int, output_tokens: int) -> Usage:
    return Usage(
        inputTokens=input_tokens,
        outputTokens=output_tokens,
        totalTokens=input_tokens + output_tokens,
    )


def _agent(responses: Sequence[dict], usages: Sequence[Usage] | None = None) -> Agent:
    return Agent(
        model=MockedModelProvider(list(responses), list(usages) if usages is not None else None),
        tools=[loop],
    )


@pytest.mark.asyncio
async def test_limit_turns_bails_after_cycle_completes():
    """With turns=1, the first tool round trip runs but the second model call is skipped."""
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 5), _usage(20, 5)],
    )

    result = await agent.invoke_async("go", limits={"turns": 1})

    assert result.stop_reason == "limit_turns"
    # Tools from cycle 1 ran; cycle 2 was skipped, so only one model call's usage is recorded.
    assert result.metrics.latest_agent_invocation is not None
    assert len(result.metrics.latest_agent_invocation.cycles) == 1
    assert result.metrics.latest_agent_invocation.usage["outputTokens"] == 5
    # lastMessage should be the user toolResult (tools were processed before the cap fired).
    assert result.message["role"] == "user"
    assert any("toolResult" in block for block in result.message["content"])


@pytest.mark.asyncio
async def test_generous_limits_does_not_trip():
    final_response = {"role": "assistant", "content": [{"text": "done"}]}
    agent = Agent(model=MockedModelProvider([final_response], [_usage(5, 5)]))

    result = await agent.invoke_async("go", limits={"turns": 5, "output_tokens": 1000, "total_tokens": 1000})

    assert result.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_limit_output_tokens_trips_when_cumulative_meets_cap():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 60), _usage(10, 60)],
    )

    result = await agent.invoke_async("go", limits={"output_tokens": 100})

    assert result.stop_reason == "limit_output_tokens"
    assert result.metrics.latest_agent_invocation is not None
    assert len(result.metrics.latest_agent_invocation.cycles) == 2


@pytest.mark.asyncio
async def test_limit_output_tokens_uses_at_least_semantics():
    """Stops when count exactly equals the cap (>= semantics)."""
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 100), _usage(10, 100)],
    )

    result = await agent.invoke_async("go", limits={"output_tokens": 100})

    assert result.stop_reason == "limit_output_tokens"
    assert len(result.metrics.latest_agent_invocation.cycles) == 1


@pytest.mark.asyncio
async def test_limit_total_tokens_trips_when_cumulative_meets_cap():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(200, 100), _usage(200, 100)],
    )

    result = await agent.invoke_async("go", limits={"total_tokens": 500})

    assert result.stop_reason == "limit_total_tokens"
    assert len(result.metrics.latest_agent_invocation.cycles) == 2


@pytest.mark.asyncio
async def test_end_turn_wins_when_model_finishes_on_the_same_cycle_a_cap_would_trip():
    final = {"role": "assistant", "content": [{"text": "final answer"}]}
    agent = Agent(model=MockedModelProvider([final], [_usage(300, 300)]))

    result = await agent.invoke_async("go", limits={"total_tokens": 500})

    assert result.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_simultaneous_trip_priority_turns_wins():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(100, 100), _usage(100, 100)],
    )

    result = await agent.invoke_async("go", limits={"turns": 1, "total_tokens": 1, "output_tokens": 1})

    assert result.stop_reason == "limit_turns"


@pytest.mark.asyncio
async def test_simultaneous_trip_priority_total_over_output():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(100, 100), _usage(100, 100)],
    )

    result = await agent.invoke_async("go", limits={"total_tokens": 1, "output_tokens": 1})

    assert result.stop_reason == "limit_total_tokens"


@pytest.mark.asyncio
async def test_falls_back_to_output_tokens_when_no_higher_priority_cap_set():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(100, 100), _usage(100, 100)],
    )

    result = await agent.invoke_async("go", limits={"output_tokens": 1})

    assert result.stop_reason == "limit_output_tokens"


@pytest.mark.asyncio
async def test_limits_are_per_invocation_not_lifetime():
    """A reused agent gets a fresh budget on each invoke; the cap doesn't leak across calls."""
    final = {"role": "assistant", "content": [{"text": "done"}]}
    agent = Agent(model=MockedModelProvider([final, final], [_usage(10, 50), _usage(10, 50)]))

    r1 = await agent.invoke_async("go", limits={"output_tokens": 75})
    assert r1.stop_reason == "end_turn"
    assert len(r1.metrics.latest_agent_invocation.cycles) == 1

    r2 = await agent.invoke_async("go again", limits={"output_tokens": 75})
    assert r2.stop_reason == "end_turn"
    assert len(r2.metrics.latest_agent_invocation.cycles) == 1


@pytest.mark.parametrize(
    "limits",
    [
        {"turns": -1},
        {"turns": 0},
        {"output_tokens": 0},
        {"total_tokens": -5},
        {"turns": True},  # bool subclasses int; should still be rejected
    ],
)
@pytest.mark.asyncio
async def test_invalid_limits_raise_type_error(limits):
    final = {"role": "assistant", "content": [{"text": "never reached"}]}
    agent = Agent(model=MockedModelProvider([final]))

    with pytest.raises(TypeError):
        await agent.invoke_async("go", limits=limits)


@pytest.mark.parametrize(
    "limits",
    [
        {"max_turns": 3},
        {"turn": 3},
        {"turns": 3, "max_tokens": 100},
    ],
)
@pytest.mark.asyncio
async def test_unrecognized_limits_keys_raise_type_error(limits):
    """An unrecognized cap name is rejected instead of silently applying no limit (#4354)."""
    final = {"role": "assistant", "content": [{"text": "never reached"}]}
    agent = Agent(model=MockedModelProvider([final]))

    with pytest.raises(TypeError, match="not recognized"):
        await agent.invoke_async("go", limits=limits)


@pytest.mark.asyncio
async def test_limits_propagate_through_stream_async():
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 5), _usage(10, 5)],
    )

    result = None
    async for event in agent.stream_async("go", limits={"turns": 1}):
        if "result" in event:
            result = event["result"]

    assert result is not None
    assert result.stop_reason == "limit_turns"


def test_limits_propagate_through_call():
    """The sync ``__call__`` path also accepts and applies ``limits``."""
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 5), _usage(10, 5)],
    )

    result = agent("go", limits={"turns": 1})

    assert result.stop_reason == "limit_turns"


@pytest.mark.asyncio
async def test_empty_limits_dict_is_no_op():
    """``limits={}`` carries no caps and behaves identically to ``limits=None``."""
    final = {"role": "assistant", "content": [{"text": "done"}]}
    agent = Agent(model=MockedModelProvider([final], [_usage(5, 5)]))

    result = await agent.invoke_async("go", limits={})

    assert result.stop_reason == "end_turn"


@pytest.mark.asyncio
async def test_invocation_hooks_fire_when_limit_trips():
    """``BeforeInvocationEvent`` / ``AfterInvocationEvent`` fire even on a graceful cap-trip."""
    agent = _agent(
        [TOOL_USE_RESPONSE_1, TOOL_USE_RESPONSE_2],
        usages=[_usage(10, 5), _usage(10, 5)],
    )

    seen: list[str] = []
    agent.add_hook(lambda event: seen.append("before"), BeforeInvocationEvent)
    agent.add_hook(lambda event: seen.append("after"), AfterInvocationEvent)

    result = await agent.invoke_async("go", limits={"turns": 1})

    assert result.stop_reason == "limit_turns"
    assert seen == ["before", "after"]
