"""Tests for the swarm vended tool.

The swarm tool is a thin shim over :class:`~strands.multiagent.Swarm`: it owns
spec validation, agent construction, and result mapping. Tests mock the SDK
Swarm class so no model calls are made.
"""

import importlib
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from strands import Agent
from strands.agent import AgentResult
from strands.agent.state import AgentState
from strands.experimental.tools import stop
from strands.multiagent.base import NodeResult, Status
from strands.multiagent.spec import Choice, Fixed, Inherit, Open, Preset
from strands.multiagent.swarm import SwarmResult
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.registry import ToolRegistry
from strands.types._events import ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolContext
from strands.vended_tools.swarm import make_swarm, swarm
from strands.vended_tools.swarm.swarm import (
    _DEFAULT_MAX_AGENTS,
    _DEPTH_STATE_KEY,
    DEFAULT_SWARM_DESCRIPTION,
    _build_agent_item_schema,
    _build_description,
    _resolve_specs,
)
from tests.fixtures.mocked_model_provider import MockedModelProvider

_swarm_module = importlib.import_module("strands.vended_tools.swarm.swarm")


def _mock_parent(tool_names: list[str] | None = None, state: dict | None = None) -> SimpleNamespace:
    registry = ToolRegistry()
    if tool_names:
        for name in tool_names:
            t = Mock()
            t.tool_name = name
            registry.registry[name] = t
    return SimpleNamespace(
        tool_registry=registry,
        model=Mock(),
        sandbox=None,
        callback_handler=None,
        trace_attributes=None,
        state=AgentState(state),
    )


def _ctx(parent=None):
    if parent is None:
        parent = _mock_parent()
    return ToolContext(tool_use={"name": "swarm", "toolUseId": "id", "input": {}}, agent=parent, invocation_state={})


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
    sr = SwarmResult(status=status, results={node: NodeResult(result=r, status=Status.COMPLETED)}, execution_count=1)
    return sr


def _kwargs():
    return dict(
        max_agents=_DEFAULT_MAX_AGENTS,
        presets={},
        default_preset=None,
        instructions=Open(),
        tools=None,
        mcp_servers=Inherit(),
        model=Inherit(),
    )


def _patch(result=None, events=()):
    """Patch Swarm and _default_builder so no model calls are made.

    The mocked ``Swarm.stream_async`` yields ``events`` then the final result event.
    """
    if result is None:
        result = _result()

    async def _stream(task, invocation_state=None):
        for event in events:
            yield event
        yield {"type": "multiagent_result", "result": result}

    sp = patch.object(_swarm_module, "Swarm")

    def _builder(spec):
        child = Mock(name=spec.name)
        child.state = AgentState()
        child.tool_registry = ToolRegistry()
        return child

    bp = patch.object(_swarm_module, "_default_builder", return_value=_builder)

    class _Ctx:
        def __enter__(self):
            self.cls = sp.__enter__()
            bp.__enter__()
            self.cls.return_value.stream_async = Mock(side_effect=_stream)
            return self.cls

        def __exit__(self, *a):
            bp.__exit__(*a)
            sp.__exit__(*a)

    return _Ctx()


class TestBuildAgentItemSchema:
    def test_visible_and_hidden_axes(self):
        # Open + no presets → instructions required.
        schema = _build_agent_item_schema(
            presets={}, instructions=Open(), tools=None, mcp_servers=Inherit(), model=None
        )
        assert schema["required"] == ["name", "instructions"]
        assert schema["additionalProperties"] is False
        assert schema["properties"]["instructions"]["type"] == "string"

        # Open + presets → instructions not required (preset provides a default).
        with_presets = _build_agent_item_schema(
            presets={"w": Preset(description="W")},
            instructions=Open(),
            tools=None,
            mcp_servers=Inherit(),
            model=None,
        )
        assert with_presets["required"] == ["name"]

        # Fixed/Inherit → hidden.
        hidden = _build_agent_item_schema(
            presets={},
            instructions=Fixed("x"),
            tools=Inherit(),
            mcp_servers=Inherit(),
            model=Fixed("m"),
        )
        assert set(hidden["properties"]) == {"name"}

    def test_choice_axes_and_presets(self):
        presets = {"alpha": Preset(description="First"), "beta": Preset(description="Second")}
        schema = _build_agent_item_schema(
            presets=presets,
            instructions=Choice(["A", "B"]),
            tools=Choice(["calc", "fetch"], multiple=True),
            mcp_servers=Choice(["docs", "github"], multiple=True),
            model=Choice(["fast", "smart"]),
        )
        assert schema["properties"]["instructions"]["enum"] == ["A", "B"]
        assert schema["properties"]["tools"]["items"]["enum"] == ["calc", "fetch"]
        assert schema["properties"]["mcp_servers"]["items"]["enum"] == ["docs", "github"]
        assert schema["properties"]["model"]["enum"] == ["fast", "smart"]
        agent_type = schema["properties"]["agent_type"]
        assert agent_type["enum"] == ["alpha", "beta"]
        assert "- alpha: First" in agent_type["description"]

    def test_presets_without_descriptions(self):
        schema = _build_agent_item_schema(
            presets={"w": Preset()}, instructions=Open(), tools=None, mcp_servers=Inherit(), model=None
        )
        assert schema["properties"]["agent_type"]["description"] == "Role to assign this agent."


class TestBuildDescription:
    def test_with_and_without_presets(self):
        assert _build_description("Base.", {}) == "Base."
        desc = _build_description("Base.", {"w": Preset(description="Writes.")})
        assert "w" in desc and "Writes." in desc


class TestResolveSpecs:
    @pytest.mark.parametrize(
        "agents,match",
        [
            ("bad", "must be a list"),
            ([], "At least 1"),
            ([{"name": "a"}] * 25, "At most 20"),
            (["not a dict"], "must be a dict"),
            ([{}], "non-empty 'name'"),
            ([{"name": "a"}, {"name": "a"}], "Duplicate"),
        ],
    )
    def test_rejects_invalid_input(self, agents, match):
        with pytest.raises(ValueError, match=match):
            _resolve_specs(agents, **_kwargs())

    def test_resolves_instructions_and_names(self):
        specs = _resolve_specs([_spec("a", instructions="Do."), _spec("b")], **_kwargs())
        assert [s.name for s in specs] == ["a", "b"]
        assert specs[0].instructions == "Do."

    def test_presets_and_defaults(self):
        kw = _kwargs()
        kw["presets"] = {"writer": Preset(instructions="Write.")}
        kw["default_preset"] = "writer"
        assert _resolve_specs([_spec("a", agent_type="writer")], **kw)[0].instructions == "Write."
        assert _resolve_specs([_spec("b")], **kw)[0].instructions == "Write."  # default
        with pytest.raises(ValueError, match="Unknown agent_type"):
            _resolve_specs([_spec("c", agent_type="nope")], **kw)

    def test_choice_tools_filtered(self):
        kw = _kwargs()
        kw["tools"] = Choice(["calc", "fetch"], multiple=True)
        assert _resolve_specs([_spec("a", tools=["calc", "unknown"])], **kw)[0].tools == ["calc"]


class TestMakeSwarm:
    def test_default_instance_and_exports(self):
        from strands.tools.decorator import DecoratedFunctionTool
        from strands.vended_tools import make_swarm as ms
        from strands.vended_tools import swarm as s

        assert s is swarm and ms is make_swarm
        assert isinstance(swarm, DecoratedFunctionTool) and swarm.tool_name == "swarm"
        assert make_swarm(name="team").tool_name == "team"

    @pytest.mark.parametrize(
        "kw",
        [
            {"max_agents": 0},
            {"max_agents": True},
            {"max_depth": 0},
            {"max_depth": True},
            {"tools": Choice([], multiple=True)},
            {"tools": Choice(["a"])},  # multiple=False on a list axis
            {"mcp_servers": Choice([], multiple=True)},
            {"mcp_servers": Choice(["a"])},  # multiple=False on a list axis
        ],
    )
    def test_rejects_invalid_limits(self, kw):
        with pytest.raises(ValueError):
            make_swarm(**kw)

    def test_default_spec(self):
        agents = swarm.tool_spec["inputSchema"]["json"]["properties"]["agents"]
        assert agents["minItems"] == 1 and agents["maxItems"] == _DEFAULT_MAX_AGENTS
        assert "first agent receives the task" in agents["description"]
        assert agents["items"] == _build_agent_item_schema(
            presets={}, instructions=Open(), tools=None, mcp_servers=None, model=Inherit()
        )
        assert swarm.tool_spec["description"] == DEFAULT_SWARM_DESCRIPTION

    def test_spec_reflects_configuration(self):
        """The factory wires its axes, presets, and max_agents into the schema and description."""
        axes = dict(
            presets={"writer": Preset(description="Writes.")},
            instructions=Choice(["A"]),
            tools=Choice(["calc"], multiple=True),
            mcp_servers=Choice(["docs", "gh"], multiple=True),
            model=Choice(["fast"]),
        )
        t = make_swarm(max_agents=3, **axes)
        agents = t.tool_spec["inputSchema"]["json"]["properties"]["agents"]
        assert agents["maxItems"] == 3
        assert agents["items"] == _build_agent_item_schema(**axes)
        assert t.tool_spec["description"] == _build_description(DEFAULT_SWARM_DESCRIPTION, axes["presets"])


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
        cls.return_value.stream_async.assert_called_once_with("go", invocation_state={"agent": parent, "user_key": "v"})
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
    async def test_validates_agents_against_max_agents(self):
        with pytest.raises(ValueError, match="At most 2"):
            await _run(
                make_swarm(max_agents=2), task="t", agents=[_spec("a"), _spec("b"), _spec("c")], tool_context=_ctx()
            )

    @pytest.mark.asyncio
    async def test_failed_status_raises(self):
        with _patch(_result(status=Status.FAILED, text="partial")), pytest.raises(RuntimeError) as exc:
            await _run(swarm, task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx())
        assert "status=failed" in str(exc.value) and "partial" in str(exc.value)

    @pytest.mark.asyncio
    async def test_missing_result_raises(self):
        with _patch() as cls:

            async def _no_result(task, invocation_state=None):
                yield {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}

            cls.return_value.stream_async = Mock(side_effect=_no_result)
            with pytest.raises(RuntimeError, match="without producing a result"):
                await _run(swarm, task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx())


class TestEndToEnd:
    def test_child_stop_does_not_halt_parent(self):
        def tool_use(name, tool_input, tool_use_id):
            return {
                "role": "assistant",
                "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}}],
            }

        # Parent and child share the inherited model, so responses are consumed in call order.
        model = MockedModelProvider(
            [
                tool_use("swarm", {"task": "go", "agents": [_spec("a", instructions="Do.")]}, "p1"),
                tool_use("stop", {"message": "child done"}, "c1"),
                {"role": "assistant", "content": [{"text": "parent final"}]},
            ]
        )
        result = Agent(model=model, tools=[swarm, stop], callback_handler=None)("start")
        assert result.stop_reason == "end_turn"
        assert str(result).strip() == "parent final"


class TestChildren:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("stored_depth,expected_depth", [(None, 2), (2, 1)])
    async def test_builds_children(self, stored_depth, expected_depth):
        """Children are built from resolved specs, get decremented depth, and lose handoff_to_agent."""
        specs, children = [], []

        def builder(spec):
            specs.append(spec)
            child = Mock(name=spec.name)
            child.state = AgentState()
            child.tool_registry = ToolRegistry()
            child.tool_registry.registry["handoff_to_agent"] = Mock()
            children.append(child)
            return child

        state = {} if stored_depth is None else {_DEPTH_STATE_KEY: stored_depth}
        custom = make_swarm(builder=builder, instructions=Fixed("Locked."), max_depth=3)
        with _patch() as cls:
            await _run(custom, task="t", agents=[_spec("a"), _spec("b")], tool_context=_ctx(_mock_parent(state=state)))

        assert [(s.name, s.instructions) for s in specs] == [("a", "Locked."), ("b", "Locked.")]
        assert cls.call_args[1]["nodes"] == children
        for child in children:
            assert child.state.get(_DEPTH_STATE_KEY) == expected_depth
            assert "handoff_to_agent" not in child.tool_registry.registry

    @pytest.mark.asyncio
    async def test_exhausted_depth_raises(self):
        parent = _mock_parent(state={_DEPTH_STATE_KEY: 0})
        with pytest.raises(RuntimeError, match="depth limit reached"):
            await _run(swarm, task="t", agents=[_spec("a", instructions="Do.")], tool_context=_ctx(parent))
