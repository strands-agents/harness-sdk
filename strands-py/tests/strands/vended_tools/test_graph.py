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
from strands.interrupt import Interrupt
from strands.multiagent.base import NodeResult, Status
from strands.multiagent.graph import GraphResult
from strands.multiagent.spec import Choice, Fixed, Inherit, Open, Preset, _append_presets
from strands.telemetry.metrics import EventLoopMetrics
from strands.tools.decorator import DecoratedFunctionTool
from strands.tools.registry import ToolRegistry
from strands.types._events import ToolResultEvent, ToolStreamEvent
from strands.types.tools import ToolContext
from strands.vended_tools import graph as exported_graph
from strands.vended_tools import make_graph as exported_make_graph
from strands.vended_tools.graph import graph, make_graph
from strands.vended_tools.graph.graph import (
    _DEFAULT_MAX_EDGES,
    _DEFAULT_MAX_NODES,
    _DEPTH_STATE_KEY,
    DEFAULT_GRAPH_DESCRIPTION,
    _build_schema,
    _validate_edges,
)
from strands.vended_tools.handoff_to_user import handoff_to_user
from tests.fixtures.mocked_model_provider import MockedModelProvider

_graph_module = importlib.import_module("strands.vended_tools.graph.graph")

_NODES = [{"name": "a", "instructions": "Do A."}, {"name": "b", "instructions": "Do B."}]
_EDGES = [{"from_node": "a", "to_node": "b"}]


def _mock_parent(state: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        tool_registry=ToolRegistry(),
        model=Mock(),
        sandbox=None,
        callback_handler=None,
        trace_attributes=None,
        state=AgentState(state),
    )


def _ctx(parent=None):
    return ToolContext(
        tool_use={"name": "graph", "toolUseId": "id", "input": {}},
        agent=parent or _mock_parent(),
        invocation_state={},
    )


def _result(*, status=Status.COMPLETED, text="Done!", node="b"):
    agent_result = AgentResult(
        message={"role": "assistant", "content": [{"text": text}]},
        stop_reason="end_turn",
        state={},
        metrics=EventLoopMetrics(),
    )
    return GraphResult(
        status=status, results={node: NodeResult(result=agent_result, status=Status.COMPLETED)}, execution_count=2
    )


def _builder(spec):
    child = Mock(name=spec.name)
    child.state = AgentState()
    return child


@contextlib.contextmanager
def _patch(result=None, events=()):
    """Patch GraphBuilder and _default_builder; the built graph streams ``events`` then ``result``."""

    async def stream(task, invocation_state=None):
        for event in events:
            yield event
        yield {"type": "multiagent_result", "result": result or _result()}

    with (
        patch.object(_graph_module, "GraphBuilder") as builder_cls,
        patch.object(_graph_module, "_default_builder", return_value=_builder),
    ):
        builder_cls.return_value.build.return_value.stream_async = Mock(side_effect=stream)
        yield builder_cls.return_value


def test_make_graph_default_instance_and_exports():
    assert exported_graph is graph and exported_make_graph is make_graph
    assert isinstance(graph, DecoratedFunctionTool)
    assert graph.tool_name == "graph"
    assert make_graph(name="dag").tool_name == "dag"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_nodes": 1},
        {"max_nodes": True},
        {"max_edges": 0},
        {"max_depth": 0},
        {"max_node_executions": 0},
        {"execution_timeout": 0},
        {"node_timeout": -1.5},
        {"node_timeout": True},
        {"tools": Choice([], multiple=True)},
        {"tools": Choice(["a"])},
        {"mcp_servers": Choice([], multiple=True)},
        {"mcp_servers": Choice(["a"])},
    ],
)
def test_make_graph_rejects_invalid_config(kwargs):
    with pytest.raises(ValueError):
        make_graph(**kwargs)


def test_make_graph_default_spec():
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
    presets = {"writer": Preset(description="Writes.")}
    tools = Choice(["calc"], multiple=True)
    tru_spec = make_graph(max_nodes=3, max_edges=4, presets=presets, tools=tools).tool_spec
    tru_props = tru_spec["inputSchema"]["json"]["properties"]
    assert (tru_props["nodes"]["maxItems"], tru_props["edges"]["maxItems"]) == (3, 4)
    assert tru_props["nodes"]["items"]["properties"]["tools"]["items"]["enum"] == ["calc"]
    assert tru_spec["description"] == _append_presets(DEFAULT_GRAPH_DESCRIPTION, presets)


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
                "mcp_servers": Choice(["docs"], multiple=True),
                "model": Choice(["fast"]),
            },
            ["name"],
            {"name", "agent_type", "instructions", "tools", "mcp_servers", "model"},
        ),
    ],
)
def test_build_schema_node_item_reflects_axes(axes, exp_required, exp_properties):
    kwargs = {"default_preset": None, "tools": None, "mcp_servers": None, "model": None, **axes}
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


@pytest.mark.parametrize(
    ("edges", "exp_edges"),
    [
        ([{"from_node": " a", "to_node": "b "}, {"from_node": "a", "to_node": "c"}], [("a", "b"), ("a", "c")]),
        ([], []),
    ],
)
def test_validate_edges_accepts_dag_with_stripped_names(edges, exp_edges):
    assert _validate_edges(edges, ["a", "b", "c"], max_edges=5) == exp_edges


@pytest.mark.asyncio
async def test_graph_tool_streams_events_and_returns_result(alist):
    events = [{"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}]
    tool_use = {"toolUseId": "t1", "name": "graph", "input": {"task": "go", "nodes": _NODES, "edges": _EDGES}}
    parent = _mock_parent()
    with _patch(events=events) as graph_builder:
        tru_events = await alist(graph.stream(tool_use, {"agent": parent, "user_key": "v", "request_state": {}}))

    # The parent's request_state is not forwarded to children.
    graph_builder.build.return_value.stream_async.assert_called_once_with(
        "go", invocation_state={"agent": parent, "user_key": "v"}
    )
    assert [c.kwargs["node_id"] for c in graph_builder.add_node.call_args_list] == ["a", "b"]
    graph_builder.add_edge.assert_called_once_with("a", "b")
    # The decorator also streams the final yield before wrapping it as the result.
    tru_streamed = [e["tool_stream_event"]["data"] for e in tru_events if isinstance(e, ToolStreamEvent)]
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
async def test_graph_tool_forwards_only_configured_limits(limits, exp_calls, alist):
    with _patch() as graph_builder:
        await alist(make_graph(**limits)(task="t", nodes=_NODES, edges=[], tool_context=_ctx()))

    tru_calls = [
        graph_builder.set_max_node_executions.call_args_list,
        graph_builder.set_execution_timeout.call_args_list,
        graph_builder.set_node_timeout.call_args_list,
    ]
    assert tru_calls == exp_calls


@pytest.mark.asyncio
@pytest.mark.parametrize("node_count", [1, 3])
async def test_graph_tool_rejects_node_count_out_of_bounds(node_count, alist):
    nodes = [{"name": str(i), "instructions": "x"} for i in range(node_count)]
    with _patch(), pytest.raises(ValueError, match="Between 2 and 2 nodes"):
        await alist(make_graph(max_nodes=2)(task="t", nodes=nodes, edges=[], tool_context=_ctx()))


@pytest.mark.asyncio
async def test_graph_tool_errors_name_the_nodes_parameter(alist):
    nodes = [{"name": "a", "instructions": "x"}, {"name": "a", "instructions": "x"}]
    with _patch(), pytest.raises(ValueError, match="Duplicate node name 'a' at index 1"):
        await alist(graph(task="t", nodes=nodes, edges=[], tool_context=_ctx()))


@pytest.mark.asyncio
async def test_graph_tool_interrupt_raises_actionable_error(alist):
    result = GraphResult(status=Status.INTERRUPTED, interrupts=[Interrupt(id="i1", name="ask_user")])
    with _patch(result), pytest.raises(RuntimeError, match=r"requested user input \(ask_user\)"):
        await alist(graph(task="t", nodes=_NODES, edges=_EDGES, tool_context=_ctx()))


@pytest.mark.asyncio
async def test_graph_tool_failed_status_raises_with_partial_output(alist):
    with _patch(_result(status=Status.FAILED, text="partial")), pytest.raises(RuntimeError) as exc:
        await alist(graph(task="t", nodes=_NODES, edges=_EDGES, tool_context=_ctx()))
    assert "status=failed" in str(exc.value) and "partial" in str(exc.value)


@pytest.mark.asyncio
async def test_graph_tool_missing_result_raises(alist):
    async def no_result(task, invocation_state=None):
        yield {"type": "multiagent_node_start", "node_id": "a", "node_type": "agent"}

    with _patch() as graph_builder, pytest.raises(RuntimeError, match="without producing a result"):
        graph_builder.build.return_value.stream_async = Mock(side_effect=no_result)
        await alist(graph(task="t", nodes=_NODES, edges=_EDGES, tool_context=_ctx()))


@pytest.mark.asyncio
@pytest.mark.parametrize(("stored_depth", "exp_depth"), [(None, 2), (2, 1)])
async def test_graph_tool_builds_children_with_decremented_depth(stored_depth, exp_depth, alist):
    specs, children = [], []

    def builder(spec):
        specs.append(spec)
        child = _builder(spec)
        child.tool_registry = ToolRegistry()
        child.tool_registry.process_tools([handoff_to_user])
        children.append(child)
        return child

    state = {} if stored_depth is None else {_DEPTH_STATE_KEY: stored_depth}
    graph_tool = make_graph(builder=builder, instructions=Fixed("Locked."), max_depth=3)
    nodes = [{"name": "a"}, {"name": "b"}]
    with _patch() as graph_builder:
        await alist(graph_tool(task="t", nodes=nodes, edges=_EDGES, tool_context=_ctx(_mock_parent(state=state))))

    assert [(s.name, s.instructions) for s in specs] == [("a", "Locked."), ("b", "Locked.")]
    assert [c.args[0] for c in graph_builder.add_node.call_args_list] == children
    assert [child.state.get(_DEPTH_STATE_KEY) for child in children] == [exp_depth, exp_depth]
    # A graph cannot pause for user input, so the user-handoff tool is dropped from every child.
    assert [child.tool_registry.registry for child in children] == [{}, {}]


@pytest.mark.asyncio
async def test_graph_tool_exhausted_depth_raises(alist):
    parent = _mock_parent(state={_DEPTH_STATE_KEY: 0})
    with pytest.raises(RuntimeError, match="depth limit reached"):
        await alist(graph(task="t", nodes=_NODES, edges=_EDGES, tool_context=_ctx(parent)))


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


def test_graph_tool_node_failure_names_node_and_keeps_partial_output():
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
    assert "Graph node(s) a failed: model exploded. Partial output:\nb: b done" in tru_tool_result["content"][0]["text"]
