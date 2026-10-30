"""Tests for the graph vended tool. GraphBuilder is mocked so no model calls are made."""

import contextlib
import importlib
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

import pytest

from strands import Agent
from strands.agent import AgentResult
from strands.agent.state import AgentState
from strands.experimental.tools import stop
from strands.interrupt import Interrupt, _InterruptState
from strands.multiagent.base import NodeResult, Status
from strands.multiagent.graph import GraphResult
from strands.multiagent.spec import Choice, Fixed, Inherit, Open, Preset
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.decorator import DecoratedFunctionTool
from strands.tools.registry import ToolRegistry
from strands.types._events import ToolInterruptEvent, ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolContext
from strands.vended_tools import graph as exported_graph
from strands.vended_tools import make_graph as exported_make_graph
from strands.vended_tools.graph import graph, make_graph
from strands.vended_tools.graph.graph import (
    _DEFAULT_MAX_EDGES,
    _DEFAULT_MAX_NODES,
    _UNAVAILABLE_MESSAGE,
    DEFAULT_GRAPH_DESCRIPTION,
    _build_schema,
    _validate_edges,
)
from strands.vended_tools.handoff_to_user import handoff_to_user
from tests.fixtures.mocked_model_provider import MockedModelProvider

_graph_module = importlib.import_module("strands.vended_tools.graph.graph")

_NODES = [{"name": "a", "instructions": "Do A."}, {"name": "b", "instructions": "Do B."}]
_EDGES = [{"from_node": "a", "to_node": "b"}]


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


async def _events(tool, raw_input, parent=None, tool_use_id="id", **invocation_state):
    parent = parent or _mock_parent()
    state = {"agent": parent, **invocation_state}
    tool_use = {"toolUseId": tool_use_id, "name": tool.tool_name, "input": raw_input}
    context = ToolContext(tool_use=tool_use, agent=parent, invocation_state=state)
    return [event async for event in tool.stream(tool_use, state, _tool_context=context)]


def _result(*, status=Status.COMPLETED, text="Done!"):
    agent_result = AgentResult(
        message={"role": "assistant", "content": [{"text": text}]},
        stop_reason="end_turn",
        state={},
        metrics=EventLoopMetrics(),
    )
    return GraphResult(
        status=status, results={"b": NodeResult(result=agent_result, status=Status.COMPLETED)}, execution_count=2
    )


def _builder(spec):
    child = Mock(name=spec.name)
    child.state = AgentState()
    child.tool_registry = ToolRegistry()
    return child


@contextlib.contextmanager
def _patch(result=None, events=()):
    """Patch GraphBuilder and _default_builder; the built graph streams ``events`` then ``result``."""

    async def stream(task, invocation_state=None, invocation_context=None):
        for event in events:
            yield event
        yield {"type": "multiagent_result", "result": result or _result()}

    with (
        patch.object(_graph_module, "GraphBuilder") as builder_cls,
        patch.object(_graph_module, "_default_builder", return_value=_builder),
    ):
        builder_cls.return_value.build.return_value.stream_async = Mock(side_effect=stream)
        yield builder_cls.return_value


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_nodes": 1},
        {"max_nodes": True},
        {"max_edges": 0},
        {"max_node_executions": 0},
        {"execution_timeout": 0},
        {"node_timeout": -1.5},
        {"node_timeout": True},
        {"tools": Choice([], multiple=True)},
        {"tools": Choice(["a"])},
    ],
)
def test_make_graph_rejects_invalid_config(kwargs):
    with pytest.raises(ValueError):
        make_graph(**kwargs)


def test_make_graph_default_instance_exports_and_spec():
    assert exported_graph is graph and exported_make_graph is make_graph
    assert isinstance(graph, DecoratedFunctionTool)
    assert graph.tool_name == "graph"
    assert make_graph(name="dag").tool_name == "dag"

    tru_spec = graph.tool_spec
    exp_schema = {
        "type": "object",
        "required": ["task", "nodes", "edges"],
        "properties": {
            "task": {
                "type": "string",
                "description": "The objective for the graph; entry-point nodes receive it directly.",
            },
            "nodes": {
                "type": "array",
                "description": "Agent specifications, one per node.",
                "items": {
                    "type": "object",
                    "required": ["name", "instructions"],
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string", "description": "A unique name for this node, referenced by edges."},
                        "instructions": {
                            "type": "string",
                            "description": "A system prompt defining this agent's role.",
                        },
                    },
                },
                "minItems": 2,
                "maxItems": _DEFAULT_MAX_NODES,
            },
            "edges": {
                "type": "array",
                "description": "Directed edges between node names. Use an empty list for fully parallel nodes.",
                "items": {
                    "type": "object",
                    "required": ["from_node", "to_node"],
                    "additionalProperties": False,
                    "properties": {
                        "from_node": {"type": "string", "description": "Name of the upstream node."},
                        "to_node": {"type": "string", "description": "Name of the node that runs after from_node."},
                    },
                },
                "maxItems": _DEFAULT_MAX_EDGES,
            },
        },
    }
    assert tru_spec["inputSchema"]["json"] == exp_schema
    assert tru_spec["description"] == DEFAULT_GRAPH_DESCRIPTION


def test_make_graph_spec_reflects_configuration():
    tools = Choice(["calc"], multiple=True)
    tru_spec = make_graph(max_nodes=3, max_edges=4, tools=tools).tool_spec
    tru_props = tru_spec["inputSchema"]["json"]["properties"]
    assert (tru_props["nodes"]["maxItems"], tru_props["edges"]["maxItems"]) == (3, 4)
    assert tru_props["nodes"]["items"]["properties"]["tools"]["items"]["enum"] == ["calc"]


@pytest.mark.parametrize(
    ("axes", "exp_required", "exp_properties"),
    [
        ({"presets": {}, "instructions": Open()}, ["name", "instructions"], {"name", "instructions"}),
        ({"presets": {"w": Preset()}, "instructions": Open()}, ["name"], {"name", "agent_type", "instructions"}),
        (
            {"presets": {}, "instructions": Fixed("x"), "tools": Inherit(), "model": Fixed("m")},
            ["name"],
            {"name"},
        ),
        (
            {
                "presets": {"w": Preset()},
                "instructions": Choice(["A"]),
                "tools": Choice(["calc"], multiple=True),
                "model": Choice(["fast"]),
            },
            ["name"],
            {"name", "agent_type", "instructions", "tools", "model"},
        ),
    ],
)
def test_build_schema_node_item_reflects_axes(axes, exp_required, exp_properties):
    kwargs = {"default_preset": None, "tools": None, "model": None, **axes}
    tru_item = _build_schema(max_nodes=2, max_edges=1, **kwargs)["properties"]["nodes"]["items"]
    assert tru_item["required"] == exp_required
    assert set(tru_item["properties"]) == exp_properties


@pytest.mark.parametrize(
    ("edges", "match"),
    [
        ("bad", "must be a list"),
        ([_EDGES[0]] * 4, "At most 3"),
        (["x"], "must be a dict"),
        ([{"from_node": "a"}], "must be strings"),
        ([{"from_node": "a", "to_node": "z"}], "'z' is not a declared node"),
        ([{"from_node": "a", "to_node": "a"}], "self-loop"),
        (
            [
                {"from_node": "a", "to_node": "b"},
                {"from_node": "b", "to_node": "c"},
                {"from_node": "c", "to_node": "b"},
            ],
            "cycle: b -> c -> b",
        ),
    ],
)
def test_validate_edges_rejects_invalid_edges(edges, match):
    with pytest.raises(ValueError, match=match):
        _validate_edges(edges, ["a", "b", "c"], max_edges=3)


def test_validate_edges_accepts_dag_with_stripped_names():
    edges = [{"from_node": " a", "to_node": "b "}, {"from_node": "a", "to_node": "c"}]
    assert _validate_edges(edges, ["a", "b", "c"], max_edges=5) == [("a", "b"), ("a", "c")]


@pytest.mark.asyncio
async def test_graph_tool_streams_events_and_returns_result():
    events = [{"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}]
    parent = _mock_parent()
    with _patch(events=events) as graph_builder:
        tru_events = await _events(
            graph,
            {"task": "go", "nodes": _NODES, "edges": _EDGES},
            parent,
            tool_use_id="t1",
            user_key="v",
            request_state={},
        )

    # The parent's request_state is not forwarded to children.
    graph_builder.build.return_value.stream_async.assert_called_once_with(
        "go", invocation_state={"agent": parent, "user_key": "v"}, invocation_context=None
    )
    assert [c.kwargs["node_id"] for c in graph_builder.add_node.call_args_list] == ["a", "b"]
    graph_builder.add_edge.assert_called_once_with("a", "b")
    tru_streamed = [event["tool_stream_event"]["data"] for event in tru_events if isinstance(event, ToolStreamEvent)]
    assert tru_streamed == [*events, "b: Done!"]
    assert isinstance(tru_events[-1], ToolResultEvent)
    assert tru_events[-1].tool_result["content"] == [{"text": "b: Done!"}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("limits", "exp_calls"),
    [
        ({}, [[], [call(900.0)], [call(300.0)]]),
        ({"execution_timeout": None, "node_timeout": None}, [[], [], []]),
        (
            {"max_node_executions": 5, "execution_timeout": 60.0, "node_timeout": 30.0},
            [[call(5)], [call(60.0)], [call(30.0)]],
        ),
    ],
)
async def test_graph_tool_forwards_only_configured_limits(limits, exp_calls):
    with _patch() as graph_builder:
        await _events(make_graph(**limits), {"task": "t", "nodes": _NODES, "edges": []})

    tru_calls = [
        graph_builder.set_max_node_executions.call_args_list,
        graph_builder.set_execution_timeout.call_args_list,
        graph_builder.set_node_timeout.call_args_list,
    ]
    assert tru_calls == exp_calls


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("nodes", "result", "exp_text"),
    [
        (_NODES[:1], None, "Between 2 and 3 nodes required, got 1"),
        (
            [{"name": str(index), "instructions": "x"} for index in range(4)],
            None,
            "Between 2 and 3 nodes required, got 4",
        ),
        ([_NODES[0], _NODES[0]], None, "Duplicate node name 'a' at index 1"),
        (
            _NODES,
            _result(status=Status.FAILED, text="partial"),
            "Graph stopped before completing (status=failed, 2 iterations). Partial output:\nb: partial",
        ),
    ],
)
async def test_graph_tool_returns_error_result(nodes, result, exp_text):
    with _patch(result):
        tru_events = await _events(make_graph(max_nodes=3), {"task": "t", "nodes": nodes, "edges": []})
    assert tru_events[-1].tool_result["status"] == "error"
    assert exp_text in tru_events[-1].tool_result["content"][0]["text"]


@pytest.mark.asyncio
async def test_graph_tool_persists_interrupted_graph_with_stable_id():
    parent = _mock_parent()
    interrupted = _result(status=Status.INTERRUPTED)
    interrupted.interrupts = [Interrupt("approval", "confirm")]
    with (
        _patch(interrupted) as graph_builder,
        patch("strands.multiagent._agent_tool_streamer.take_snapshot") as take_snapshot,
    ):
        take_snapshot.return_value.to_dict.return_value = {"snapshot": True}
        tru_events = await _events(graph, {"task": "t", "nodes": _NODES, "edges": _EDGES}, parent)

    assert tru_events[-1].interrupts == [Interrupt("v1:graph:id:approval", "confirm")]
    graph_builder.set_graph_id.assert_called_once_with("v1:graph:id")
    assert parent._interrupt_state.context["sub_agent_interrupted_turns"] == {"id": {"snapshot": True}}


@pytest.mark.asyncio
async def test_graph_tool_builder_failure_on_fresh_run_returns_error():
    def failing_builder(spec):
        raise ConnectionError("model endpoint unavailable")

    tru_events = await _events(make_graph(builder=failing_builder), {"task": "t", "nodes": _NODES, "edges": _EDGES})

    assert tru_events[-1].tool_result["status"] == "error"
    assert tru_events[-1].tool_result["content"] == [{"text": "Error: ConnectionError - model endpoint unavailable"}]


@pytest.mark.asyncio
async def test_graph_tool_resume_without_stored_turn_returns_unavailable_message():
    parent = _mock_parent()
    parent._interrupt_state = _InterruptState(
        interrupts={"v1:graph:id:approval": Interrupt("v1:graph:id:approval", "confirm", response="yes")},
        activated=True,
    )
    with _patch() as graph_builder:
        graph_builder.build.return_value._interrupt_state = _InterruptState()
        tru_events = await _events(graph, {"task": "t", "nodes": _NODES, "edges": _EDGES}, parent)

    graph_builder.build.return_value.stream_async.assert_not_called()
    assert tru_events[-1].tool_result["content"] == [{"text": f"Error: RuntimeError - {_UNAVAILABLE_MESSAGE}"}]


@pytest.mark.asyncio
async def test_graph_tool_builder_failure_on_resume_raises_the_interrupt_again_and_keeps_the_turn():
    def failing_builder(spec):
        raise ConnectionError("model endpoint unavailable")

    answered = Interrupt("v1:graph:id:approval", "confirm", response="yes")
    awaited = _InterruptState(interrupts={"approval": Interrupt("approval", "confirm")}, activated=True)
    turn = {"scope": "multiAgent", "data": {"state": {"_internal_state": {"interrupt_state": awaited.to_dict()}}}}
    parent = _mock_parent()
    parent._interrupt_state = _InterruptState(
        interrupts={answered.id: answered},
        context={"sub_agent_interrupted_turns": {"id": turn}},
        activated=True,
    )

    tru_events = await _events(
        make_graph(builder=failing_builder), {"task": "t", "nodes": _NODES, "edges": _EDGES}, parent
    )

    assert isinstance(tru_events[-1], ToolInterruptEvent)
    assert tru_events[-1].interrupts == [Interrupt(answered.id, "confirm")]
    assert parent._interrupt_state.context["sub_agent_interrupted_turns"] == {"id": turn}


@pytest.mark.asyncio
async def test_graph_tool_defaults_to_first_preset():
    specs = []

    def builder(spec):
        specs.append(spec)
        return _builder(spec)

    graph_tool = make_graph(builder=builder, presets={"writer": Preset(instructions="Write."), "other": Preset()})
    with _patch():
        await _events(graph_tool, {"task": "t", "nodes": [{"name": "a"}, {"name": "b"}], "edges": []})

    assert [(spec.agent_type, spec.instructions) for spec in specs] == [("writer", "Write."), ("writer", "Write.")]


@pytest.mark.asyncio
async def test_graph_tool_excludes_graph_tools_and_keeps_handoff():
    specs, children = [], []

    def builder(spec):
        specs.append(spec)
        child = _builder(spec)
        child.tool_registry.process_tools([handoff_to_user, graph_tool])
        children.append(child)
        return child

    graph_tool = make_graph(name="nested_graph", builder=builder, instructions=Fixed("Locked."))
    graph_tool.mark_dynamic()
    nodes = [{"name": "a"}, {"name": "b"}]
    with _patch() as graph_builder:
        await _events(graph_tool, {"task": "t", "nodes": nodes, "edges": _EDGES})

    assert [(s.name, s.instructions) for s in specs] == [("a", "Locked."), ("b", "Locked.")]
    assert [c.args[0] for c in graph_builder.add_node.call_args_list] == children
    assert [set(child.tool_registry.registry) for child in children] == [{handoff_to_user.tool_name}] * 2
    assert [child.tool_registry.get_all_tool_specs() for child in children] == [
        [handoff_to_user.tool_spec],
        [handoff_to_user.tool_spec],
    ]


def _tool_use(name, tool_input, tool_use_id, text=None):
    content = [{"text": text}] if text else []
    content.append({"toolUse": {"toolUseId": tool_use_id, "name": name, "input": tool_input}})
    return {"role": "assistant", "content": content}


def _text(text):
    return {"role": "assistant", "content": [{"text": text}]}


def _graph_tool_result(agent):
    blocks = [block for message in agent.messages for block in message["content"]]
    return next(block["toolResult"] for block in blocks if "toolResult" in block)


class _FailingModel(MockedModelProvider):
    async def stream(self, *args, **kwargs):
        raise RuntimeError("model exploded")
        yield


def test_graph_tool_runs_real_graph_and_child_stop_does_not_halt_parent():
    # Parent and children share the inherited model, so responses are consumed in call order.
    model = MockedModelProvider(
        [
            _tool_use("graph", {"task": "go", "nodes": _NODES, "edges": _EDGES}, "p1"),
            _tool_use("stop", {"message": "a done"}, "c1", text="a done"),
            _text("b done"),
            _text("parent final"),
        ]
    )
    agent = Agent(model=model, tools=[graph, stop], callback_handler=None)
    tru_result = agent("start")

    assert tru_result.stop_reason == "end_turn"
    assert str(tru_result).strip() == "parent final"
    assert _graph_tool_result(agent)["content"] == [{"text": "a: a done\nb: b done"}]


def test_graph_tool_handoff_interrupts_and_resumes():
    model = MockedModelProvider(
        [
            _tool_use("graph", {"task": "go", "nodes": _NODES, "edges": _EDGES}, "p1"),
            _tool_use("handoff_to_user", {"message": "Approve?"}, "c1"),
            _text("a done"),
            _text("b done"),
            _text("parent final"),
        ]
    )
    agent = Agent(model=model, tools=[graph, handoff_to_user], callback_handler=None)

    interrupted = agent("start")

    assert interrupted.stop_reason == "interrupt"
    assert interrupted.interrupts[0].reason == "Approve?"
    resumed = agent([{"interruptResponse": {"interruptId": interrupted.interrupts[0].id, "response": "approved"}}])
    assert resumed.stop_reason == "end_turn"
    assert str(resumed).strip() == "parent final"
    assert _graph_tool_result(agent)["content"] == [{"text": "a: a done\nb: b done"}]


def test_graph_tool_parallel_handoffs_interrupt_and_resume():
    # Nodes are rebuilt on each resume, so each node's scripted model must outlive a single build.
    models = {
        name: MockedModelProvider(
            [_tool_use("handoff_to_user", {"message": f"Approve {name}?"}, name), _text(f"{name} done")]
        )
        for name in ("a", "b")
    }

    def builder(spec):
        return Agent(
            model=models[spec.name], tools=[handoff_to_user], system_prompt=spec.instructions, callback_handler=None
        )

    parent_model = MockedModelProvider(
        [_tool_use("graph", {"task": "go", "nodes": _NODES, "edges": []}, "p1"), _text("parent final")]
    )
    agent = Agent(model=parent_model, tools=[make_graph(builder=builder), handoff_to_user], callback_handler=None)

    result = agent("start")
    reasons = []
    while result.stop_reason == "interrupt":
        [interrupt] = result.interrupts
        reasons.append(interrupt.reason)
        result = agent([{"interruptResponse": {"interruptId": interrupt.id, "response": "approved"}}])

    assert set(reasons) == {"Approve a?", "Approve b?"}
    assert str(result).strip() == "parent final"
    [content] = _graph_tool_result(agent)["content"]
    assert set(content["text"].splitlines()) == {"a: a done", "b: b done"}


def test_graph_tool_node_failure_returns_error():
    def builder(spec):
        model = _FailingModel([]) if spec.name == "a" else MockedModelProvider([_text("b done")])
        return Agent(model=model, system_prompt=spec.instructions, callback_handler=None)

    edges = [{"from_node": "b", "to_node": "a"}]
    parent_model = MockedModelProvider(
        [_tool_use("graph", {"task": "go", "nodes": _NODES, "edges": edges}, "p1"), _text("parent final")]
    )
    agent = Agent(model=parent_model, tools=[make_graph(builder=builder)], callback_handler=None)
    agent("start")

    tru_tool_result = _graph_tool_result(agent)
    assert tru_tool_result["status"] == "error"
    assert tru_tool_result["content"] == [
        {"text": "Error: RuntimeError - Graph node(s) a failed: model exploded. Partial output:\nb: b done"}
    ]
