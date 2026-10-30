"""Tests for nested-agent tool stream wrapping."""

from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest

from strands.interrupt import Interrupt, InterruptException, _InterruptState
from strands.multiagent._agent_tool_streamer import (
    _INTERRUPTED_TURNS_KEY,
    _AgentToolStreamer,
    _ChildAgentAdapter,
    _ChildMultiAgentAdapter,
)
from strands.multiagent.base import Status
from strands.multiagent.graph import GraphResult
from strands.multiagent.swarm import SwarmResult
from strands.types._snapshot import Snapshot

TOOL_USE = {"toolUseId": "t", "name": "tool", "input": {}}


async def _stream(*events: dict[str, Any]):
    """Yield test events."""
    for event in events:
        yield event


AGENT_ADAPTER = _ChildAgentAdapter(label="Child", agent_name="child")
MULTI_AGENT_ADAPTER = _ChildMultiAgentAdapter(label="Swarm")


@pytest.mark.parametrize("result_type", [GraphResult, SwarmResult])
def test_multiagent_adapter_classifies_graph_and_swarm_interrupts(result_type):
    result = result_type(status=Status.INTERRUPTED, interrupts=[Interrupt("approval", "confirm")])

    assert MULTI_AGENT_ADAPTER.classify(Mock(), result) == [Interrupt("approval", "confirm")]


def test_multiagent_adapter_reports_incomplete_result_with_its_label():
    result = SwarmResult(status=Status.FAILED, execution_count=2)

    assert MULTI_AGENT_ADAPTER.classify(Mock(), result) == (
        f"Swarm stopped before completing (status=failed, 2 iterations). Partial output:\n{result}"
    )


def test_multiagent_adapter_round_trips_orchestrator_state():
    source = Mock(id="swarm")
    source.serialize_state.return_value = {"status": "interrupted"}
    target = Mock(id="swarm", _interrupt_state=_InterruptState(activated=True))
    snapshot = MULTI_AGENT_ADAPTER.take_snapshot(source)

    awaiting_responses = MULTI_AGENT_ADAPTER.restore(target, Snapshot.from_dict(snapshot.to_dict()))

    assert awaiting_responses is True
    target.deserialize_state.assert_called_once_with({"status": "interrupted"})


@pytest.mark.asyncio
async def test_stream_skips_terminal_result_and_retains_it(alist):
    child = Mock()
    result = Mock(stop_reason="completed", interrupts=[])
    tool_streamer = _AgentToolStreamer(
        interrupt_state=None,
        tool_use_id=TOOL_USE["toolUseId"],
        namespace="v1:test",
    )

    tru_events = await alist(
        tool_streamer.stream(AGENT_ADAPTER, child, _stream({"text": "progress"}, {"result": result}))
    )

    assert tru_events == [{"text": "progress"}]
    assert tool_streamer.result is result


@pytest.mark.asyncio
async def test_stream_stores_and_namespaces_child_interrupts(alist):
    child = Mock()
    child.take_snapshot.return_value = Snapshot(scope="agent", schema_version="1.0", data={}, app_data={})
    result = Mock(stop_reason="interrupt", interrupts=[Interrupt("approval", "confirm")])
    tool_streamer = _AgentToolStreamer(
        interrupt_state=_InterruptState(),
        tool_use_id=TOOL_USE["toolUseId"],
        namespace="v1:test",
    )

    tru_events = await alist(tool_streamer.stream(AGENT_ADAPTER, child, _stream({"result": result})))

    assert tru_events == []
    assert tool_streamer.interrupts == [Interrupt("v1:test:t:approval", "confirm")]
    assert set(tool_streamer._interrupt_state.context[_INTERRUPTED_TURNS_KEY]) == {"t"}  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_stream_returns_error_when_child_does_not_produce_a_result(alist):
    child = Mock()
    tool_streamer = _AgentToolStreamer(interrupt_state=None, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test")

    tru_events = await alist(tool_streamer.stream(AGENT_ADAPTER, child, _stream({"text": "progress"})))

    assert tru_events == [
        {"text": "progress"},
    ]
    assert tool_streamer.error == "Child did not produce a result."


@pytest.mark.parametrize(
    "scope,adapter,wrap",
    [
        ("agent", AGENT_ADAPTER, lambda state: {"interrupt_state": state}),
        ("multiAgent", MULTI_AGENT_ADAPTER, lambda state: {"state": {"_internal_state": {"interrupt_state": state}}}),
    ],
)
def test_resume_reraises_unloadable_turns_that_still_await_an_approval(scope, adapter, wrap):
    interrupt = Interrupt("v1:test:t:approval", "confirm", response="approved")
    awaited = _InterruptState(interrupts={"approval": Interrupt("approval", "confirm")}, activated=True)
    parent_state = _InterruptState(
        interrupts={interrupt.id: interrupt},
        context={
            _INTERRUPTED_TURNS_KEY: {
                "t": {
                    "scope": scope,
                    "schema_version": "0.0",
                    "created_at": "2026-01-01T00:00:00+00:00",
                    "data": wrap(awaited.to_dict()),
                    "app_data": {},
                }
            }
        },
        activated=True,
    )
    child = Mock()
    tool_streamer = _AgentToolStreamer(
        interrupt_state=parent_state, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test"
    )

    responses = tool_streamer.resume(adapter, child, "unavailable")

    assert responses is None
    assert tool_streamer.interrupts == [Interrupt(interrupt.id, "confirm")]
    assert parent_state.context[_INTERRUPTED_TURNS_KEY]["t"]["schema_version"] == "0.0"


@pytest.mark.parametrize("turn", [None, "garbage", {"data": "x"}, {"data": {"interrupt_state": {"interrupts": 1}}}])
def test_resume_returns_error_when_saved_turn_is_missing_or_unreadable(turn):
    interrupt = Interrupt("v1:test:t:approval", "confirm", response="approved")
    parent_state = _InterruptState(
        interrupts={interrupt.id: interrupt},
        context={_INTERRUPTED_TURNS_KEY: {} if turn is None else {"t": turn}},
        activated=True,
    )
    child = Mock()
    child._interrupt_state = SimpleNamespace(activated=False)
    tool_streamer = _AgentToolStreamer(
        interrupt_state=parent_state, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test"
    )

    responses = tool_streamer.resume(AGENT_ADAPTER, child, "unavailable")

    assert responses is None
    assert tool_streamer.error == "unavailable"


@pytest.mark.asyncio
async def test_raise_unfinished_raises_from_stream_and_resume(alist):
    child = Mock()
    child.take_snapshot.return_value = Snapshot(scope="agent", schema_version="1.0", data={}, app_data={})
    result = Mock(stop_reason="interrupt", interrupts=[Interrupt("approval", "confirm")])
    parent_state = _InterruptState()
    tool_streamer = _AgentToolStreamer(
        interrupt_state=parent_state, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test", raise_unfinished=True
    )

    with pytest.raises(InterruptException) as exc_info:
        await alist(tool_streamer.stream(AGENT_ADAPTER, child, _stream({"result": result})))
    assert exc_info.value.interrupt == Interrupt("v1:test:t:approval", "confirm")

    parent_state.interrupts = {exc_info.value.interrupt.id: exc_info.value.interrupt}
    parent_state.activated = True
    resumed = _AgentToolStreamer(
        interrupt_state=parent_state, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test", raise_unfinished=True
    )
    child._interrupt_state = SimpleNamespace(activated=False)
    with pytest.raises(RuntimeError, match="^unavailable$"):
        resumed.resume(AGENT_ADAPTER, child, "unavailable")


@pytest.mark.asyncio
async def test_stream_clears_completed_child_turn_and_preserves_siblings(alist):
    parent_state = _InterruptState(context={_INTERRUPTED_TURNS_KEY: {"t": {"snapshot": "child"}, "t2": {}}})
    child = Mock()
    child.cancel_signal.is_set.return_value = False
    result = Mock(stop_reason="end_turn", interrupts=[])
    tool_streamer = _AgentToolStreamer(
        interrupt_state=parent_state, tool_use_id=TOOL_USE["toolUseId"], namespace="v1:test"
    )

    await alist(tool_streamer.stream(AGENT_ADAPTER, child, _stream({"result": result})))

    assert parent_state.context[_INTERRUPTED_TURNS_KEY] == {"t2": {}}
