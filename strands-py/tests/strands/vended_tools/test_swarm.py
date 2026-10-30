"""Tests for the swarm vended tool.

The swarm tool is a thin shim over :class:`~strands.multiagent.Swarm`: it owns
spec validation, agent construction, and result mapping. Tests mock the SDK
Swarm class so no model calls are made.
"""

import importlib
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from strands import Agent
from strands.agent import AgentResult
from strands.agent.invocation_context import _create_invocation_context
from strands.agent.state import AgentState
from strands.experimental.tools import stop
from strands.interrupt import Interrupt, _InterruptState
from strands.multiagent.base import NodeResult, Status
from strands.multiagent.spec import Fixed, Open, Preset
from strands.multiagent.swarm import SwarmResult
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.registry import ToolRegistry
from strands.types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolContext
from strands.vended_tools.handoff_to_user import handoff_to_user
from strands.vended_tools.swarm import make_swarm, swarm
from strands.vended_tools.swarm.swarm import (
    _DEFAULT_MAX_AGENTS,
    DEFAULT_SWARM_DESCRIPTION,
    _build_schema,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider

_swarm_module = importlib.import_module("strands.vended_tools.swarm.swarm")


def _mock_parent() -> SimpleNamespace:
    return SimpleNamespace(
        tool_registry=ToolRegistry(),
        model=Mock(),
        sandbox=None,
        callback_handler=None,
        trace_attributes=None,
        state=AgentState(),
        _interrupt_state=_InterruptState(),
    )


def _ctx():
    return ToolContext(
        tool_use={"name": "swarm", "toolUseId": "id", "input": {}}, agent=_mock_parent(), invocation_state={}
    )


async def _run(swarm_tool, **kwargs):
    """Drain the tool's async generator; return (streamed events, final result)."""
    yielded = [event async for event in swarm_tool(**kwargs)]
    return yielded[:-1], yielded[-1]


def _spec(name, **kw):
    return {"name": name, **kw}


def _result(*, status=Status.COMPLETED, text="Done!", node="writer"):
    r = AgentResult(
        message={"role": "assistant", "content": [{"text": text}]},
        stop_reason="end_turn",
        state={},
        metrics=EventLoopMetrics(),
    )
    return SwarmResult(status=status, results={node: NodeResult(result=r, status=Status.COMPLETED)}, execution_count=1)


@contextmanager
def _patch(result=None, events=()):
    """Patch Swarm and _default_builder so no model calls are made.

    The mocked ``Swarm.stream_async`` yields ``events`` then the final result event.
    """
    if result is None:
        result = _result()

    async def _stream(task, invocation_state=None, invocation_context=None):
        for event in events:
            yield event
        yield {"type": "multiagent_result", "result": result}

    def _builder(spec):
        child = Mock(name=spec.name)
        child.state = AgentState()
        child.tool_registry = ToolRegistry()
        return child

    with (
        patch.object(_swarm_module, "Swarm") as cls,
        patch.object(_swarm_module, "_default_builder", return_value=_builder),
    ):
        cls.return_value.stream_async = Mock(side_effect=_stream)
        yield cls


@pytest.mark.parametrize(
    "presets,instructions,exp_required",
    [
        ({}, Open(), ["name", "instructions"]),
        ({"w": Preset()}, Open(), ["name"]),
        ({}, Fixed("x"), ["name"]),
    ],
)
def test_build_schema_requires_instructions_only_without_fallback(presets, instructions, exp_required):
    schema = _build_schema(
        presets=presets,
        default_preset=None,
        instructions=instructions,
        tools=None,
        model=None,
        max_agents=1,
    )
    assert schema["properties"]["agents"]["items"]["required"] == exp_required


class TestMakeSwarm:
    def test_default_instance(self):
        from strands.tools.decorator import DecoratedFunctionTool
        from strands.vended_tools import make_swarm as ms
        from strands.vended_tools import swarm as s

        assert s is swarm and ms is make_swarm
        assert isinstance(swarm, DecoratedFunctionTool) and swarm.tool_name == "swarm"
        assert swarm.tool_spec["description"] == DEFAULT_SWARM_DESCRIPTION
        assert swarm.tool_spec["inputSchema"]["json"]["properties"]["agents"]["maxItems"] == _DEFAULT_MAX_AGENTS
        assert make_swarm(name="team").tool_name == "team"

    @pytest.mark.parametrize("max_agents", [0, True])
    def test_rejects_invalid_max_agents(self, max_agents):
        with pytest.raises(ValueError, match="max_agents"):
            make_swarm(max_agents=max_agents)

    def test_spec_reflects_configuration(self):
        """The factory wires presets and max_agents into the schema, defaulting to the first preset."""
        presets = {"writer": Preset(description="Writes."), "editor": Preset()}
        t = make_swarm(max_agents=3, presets=presets)
        agents = t.tool_spec["inputSchema"]["json"]["properties"]["agents"]
        assert agents["maxItems"] == 3
        assert "Omit to use the default ('writer')." in agents["items"]["properties"]["agent_type"]["description"]
        assert t.tool_spec["description"] == DEFAULT_SWARM_DESCRIPTION


class TestSwarmToolExecution:
    @pytest.mark.asyncio
    async def test_streams_events_and_returns_result(self):
        """Through the decorator: swarm events surface as ToolStreamEvents, final text as the tool result."""
        events = [{"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}]
        tool_use = {
            "toolUseId": "t1",
            "name": "swarm",
            "input": {"task": "go", "agents": [_spec("a", instructions="Do.")]},
        }
        parent = _mock_parent()
        invocation_state = {"agent": parent, "user_key": "v", "request_state": {}}
        with _patch(events=events) as cls:
            out = [e async for e in swarm.stream(tool_use, invocation_state)]
        # The parent's request_state is not forwarded to children.
        cls.return_value.stream_async.assert_called_once_with(
            "go", invocation_state={"agent": parent, "user_key": "v"}, invocation_context=None
        )
        # The decorator also streams the final yield before wrapping it as the result.
        streamed = [e["tool_stream_event"]["data"] for e in out if isinstance(e, ToolStreamEvent)]
        assert streamed == [*events, "writer: Done!"]
        assert isinstance(out[-1], ToolResultEvent)
        assert out[-1].tool_result["status"] == "success"
        assert out[-1].tool_result["content"] == [{"text": "writer: Done!"}]

    @pytest.mark.asyncio
    async def test_forwards_limits(self):
        limits = dict(
            max_handoffs=5,
            max_iterations=10,
            execution_timeout=60.0,
            node_timeout=30.0,
            repetitive_handoff_detection_window=4,
            repetitive_handoff_min_unique_agents=2,
        )
        with _patch() as cls:
            await _run(make_swarm(**limits), task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx())
        assert {k: cls.call_args[1][k] for k in limits} == limits

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "agents,kw,match",
        [
            ([], {}, "Between 1 and 2"),
            ([_spec("a"), _spec("b"), _spec("c")], {}, "Between 1 and 2"),
            ([_spec("a", instructions="Do.")], {"entry_point": "z"}, "entry_point 'z'"),
        ],
    )
    async def test_rejects_invalid_agents(self, agents, kw, match):
        with pytest.raises(ValueError, match=match):
            await _run(make_swarm(max_agents=2), task="t", agents=agents, tool_context=_ctx(), **kw)

    @pytest.mark.asyncio
    async def test_failed_status_raises(self):
        with _patch(_result(status=Status.FAILED, text="partial")), pytest.raises(RuntimeError) as exc:
            await _run(swarm, task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx())
        assert "status=failed" in str(exc.value) and "partial" in str(exc.value)

    @pytest.mark.asyncio
    async def test_runs_the_swarm_in_the_request_of_the_tool_call(self):
        invocation_context = _create_invocation_context()
        tool_context = ToolContext(
            tool_use={"name": "swarm", "toolUseId": "id", "input": {}},
            agent=_mock_parent(),
            invocation_state={},
            invocation_context=invocation_context,
        )
        with _patch() as cls:
            await _run(swarm, task="go", agents=[_spec("a", instructions="Do.")], tool_context=tool_context)

        assert cls.return_value.stream_async.call_args.kwargs["invocation_context"] is invocation_context

    @pytest.mark.asyncio
    async def test_missing_result_raises(self):
        with _patch() as cls:

            async def _no_result(task, invocation_state=None, invocation_context=None):
                yield {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}

            cls.return_value.stream_async = Mock(side_effect=_no_result)
            with pytest.raises(RuntimeError, match="did not produce a result"):
                await _run(swarm, task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx())

    @pytest.mark.asyncio
    async def test_persists_interrupted_swarm_with_stable_id(self):
        parent = _mock_parent()
        interrupted = _result(status=Status.INTERRUPTED)
        interrupted.interrupts = [Interrupt("approval", "confirm")]
        with _patch(interrupted) as cls:
            tool_use = {
                "toolUseId": "id",
                "name": "swarm",
                "input": {"task": "t", "agents": [_spec("a", instructions="Do.")]},
            }
            events = [event async for event in swarm.stream(tool_use, {"agent": parent})]

        assert isinstance(events[-1], ToolInterruptEvent)
        assert events[-1].interrupts == [Interrupt("v1:swarm:id:approval", "confirm")]
        assert cls.call_args.kwargs["id"] == "v1:swarm:id"
        assert "id" in parent._interrupt_state.context["sub_agent_interrupted_turns"]

    @pytest.mark.asyncio
    async def test_builder_failure_on_resume_raises_the_interrupt_again_and_keeps_the_turn(self):
        def _failing_builder(spec):
            raise ConnectionError("model endpoint unavailable")

        answered = Interrupt("v1:swarm:id:approval", "confirm", response="yes")
        awaited = _InterruptState(interrupts={"approval": Interrupt("approval", "confirm")}, activated=True)
        turn = {"scope": "multiAgent", "data": {"state": {"_internal_state": {"interrupt_state": awaited.to_dict()}}}}
        parent = _mock_parent()
        parent._interrupt_state = _InterruptState(
            interrupts={answered.id: answered},
            context={"sub_agent_interrupted_turns": {"id": turn}},
            activated=True,
        )
        tool_use = {
            "toolUseId": "id",
            "name": "swarm",
            "input": {"task": "t", "agents": [_spec("a", instructions="Do.")]},
        }

        events = [event async for event in make_swarm(builder=_failing_builder).stream(tool_use, {"agent": parent})]

        assert events[-1] == ToolInterruptEvent(tool_use, [Interrupt(answered.id, "confirm")])
        assert parent._interrupt_state.context["sub_agent_interrupted_turns"] == {"id": turn}


def _tool_use(name, tool_input, tool_use_id):
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}}],
    }


class TestEndToEnd:
    def test_child_stop_does_not_halt_parent(self):
        # Parent and child share the inherited model, so responses are consumed in call order.
        model = MockedModelProvider(
            [
                _tool_use("swarm", {"task": "go", "agents": [_spec("a", instructions="Do.")]}, "p1"),
                _tool_use("stop", {"message": "child done"}, "c1"),
                {"role": "assistant", "content": [{"text": "parent final"}]},
            ]
        )
        result = Agent(model=model, tools=[swarm, stop], callback_handler=None)("start")
        assert result.stop_reason == "end_turn"
        assert str(result).strip() == "parent final"

    def test_child_interrupts_round_trip_through_parent_one_per_resume(self):
        handoffs = [_tool_use("handoff_to_user", {"message": question}, f"c{n}") for n, question in enumerate("AB")]
        model = MockedModelProvider(
            [
                _tool_use("swarm", {"task": "go", "agents": [_spec("a", instructions="Do.")]}, "p1"),
                {"role": "assistant", "content": [block for handoff in handoffs for block in handoff["content"]]},
                {"role": "assistant", "content": [{"text": "child done"}]},
                {"role": "assistant", "content": [{"text": "parent final"}]},
            ]
        )
        agent = Agent(model=model, tools=[swarm, handoff_to_user], callback_handler=None)

        result = agent("start")
        reasons = []
        while result.stop_reason == "interrupt":
            [interrupt] = result.interrupts
            reasons.append(interrupt.reason)
            result = agent([{"interruptResponse": {"interruptId": interrupt.id, "response": "yes"}}])

        assert reasons == ["A", "B"]
        assert str(result).strip() == "parent final"


class TestChildren:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("entry_point", [None, "b"])
    async def test_builds_children(self, entry_point):
        """Children get resolved specs, lose handoff_to_agent and every swarm tool, and honor entry_point."""
        specs, children = [], []

        def builder(spec):
            specs.append(spec)
            child = Mock(name=spec.name)
            child.state = AgentState()
            child.tool_registry = ToolRegistry()
            child.tool_registry.registry["handoff_to_agent"] = Mock()
            child.tool_registry.registry["team"] = custom
            child.tool_registry.registry["swarm"] = make_swarm()
            child.tool_registry.registry["keep"] = Mock()
            child.tool_registry.dynamic_tools["team"] = custom
            children.append(child)
            return child

        custom = make_swarm(name="team", builder=builder, instructions=Fixed("Locked."))
        with _patch() as cls:
            await _run(
                custom,
                task="t",
                agents=[_spec("a"), _spec("b")],
                tool_context=_ctx(),
                entry_point=entry_point,
            )

        assert [(s.name, s.instructions) for s in specs] == [("a", "Locked."), ("b", "Locked.")]
        assert cls.call_args[1]["nodes"] == children
        assert cls.call_args[1].get("entry_point") is (children[1] if entry_point else None)
        for child in children:
            assert list(child.tool_registry.registry) == ["keep"]
            assert not child.tool_registry.dynamic_tools
