"""Graph tool for running a directed acyclic graph of sub-agents at runtime.

Provides :func:`make_graph` (a factory that lets the developer pin safety
limits and authority modes) and :data:`graph` (a default instance). The tool is
a thin shim over :class:`~strands.multiagent.graph.Graph`: it resolves each node
spec through the authority-mode system, builds agents via an :data:`AgentBuilder`,
runs the graph, and maps the result.
"""

from __future__ import annotations

import logging
import weakref
from collections.abc import AsyncGenerator, Mapping, Sequence
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from typing_extensions import Required, TypedDict

from ...multiagent._agent_tool_streamer import _AgentToolStreamer, _ChildMultiAgentAdapter
from ...multiagent.graph import GraphBuilder, GraphResult
from ...multiagent.spec import (
    AgentBuilder,
    Choice,
    Fixed,
    Inherit,
    Open,
    Preset,
    _default_builder,
    _resolve_specs,
    _to_schema_properties,
)
from ...tools.decorator import tool
from ...types.multiagent import MultiAgentInput
from ...types.tools import ToolContext

if TYPE_CHECKING:
    from ...tools.decorator import DecoratedFunctionTool

logger = logging.getLogger(__name__)

DEFAULT_GRAPH_DESCRIPTION = (
    "Run a team of AI agents as a directed acyclic graph to solve a task. "
    "Each node is an agent with its own name, system prompt, and tools (drawn from your own). "
    "Each edge `{from_node, to_node}` makes `to_node` run after `from_node` finishes; "
    "a node receives the task plus the outputs of its finished upstream nodes. "
    "Nodes with no incoming edges are entry points that receive the task directly, and "
    "nodes that become ready together run in parallel. Cycles are not allowed. "
    "Returns each node's final output, prefixed with its name. If the graph does not "
    "complete (a node fails, or a node-execution or time limit is hit), the call fails "
    "with the partial output."
)
"""Description for the default graph tool."""


class EdgeSpec(TypedDict):
    """One directed edge in a graph topology."""

    from_node: Required[str]
    to_node: Required[str]


_DEFAULT_MAX_NODES = 20
"""Upper bound on the number of nodes a single graph invocation may create."""

_DEFAULT_MAX_EDGES = 50
"""Upper bound on the number of edges a single graph invocation may declare."""

_DEFAULT_EXECUTION_TIMEOUT = 900.0
"""Total timeout in seconds for one graph invocation."""

_DEFAULT_NODE_TIMEOUT = 300.0
"""Timeout in seconds for one node execution."""

_GRAPH_ADAPTER = _ChildMultiAgentAdapter(label="Graph")

_UNAVAILABLE_MESSAGE = (
    "Graph did NOT run and the response was NOT applied: its interrupted turn is not available. "
    "Do not report the task as completed; if it is still needed, start the graph again."
)

# Every graph tool created, so children lose all of them regardless of name or instance.
_GRAPH_TOOLS: weakref.WeakSet[DecoratedFunctionTool] = weakref.WeakSet()


def make_graph(
    *,
    name: str = "graph",
    description: str = DEFAULT_GRAPH_DESCRIPTION,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    max_nodes: int = _DEFAULT_MAX_NODES,
    max_edges: int = _DEFAULT_MAX_EDGES,
    max_node_executions: int | None = None,
    execution_timeout: float | None = _DEFAULT_EXECUTION_TIMEOUT,
    node_timeout: float | None = _DEFAULT_NODE_TIMEOUT,
) -> DecoratedFunctionTool:
    """Create a graph tool with developer-controlled safety limits and authority modes.

    Each node spec from the model is resolved through the authority-mode system
    (see :mod:`~strands.multiagent.spec`), then built via ``builder``. A running graph
    cannot be cancelled from the parent agent.

    A child's interrupt is surfaced as an interrupt of this tool and can be resumed after a
    parent-agent snapshot restore.

    Args:
        name: Tool name shown to the model.
        description: Tool description shown to the model.
        builder: Callable that turns an :class:`AgentSpec` into an ``Agent``.
            When ``None`` a default builder is used that creates an ``Agent``
            inheriting the caller's model with the spec's instructions and tools.
        presets: Named roles the model can select via ``agent_type``.
        default_preset: Preset used when the model omits both ``agent_type`` and ``instructions``.
        instructions: Authority mode for the instructions axis.
        tools: Authority mode for the tools axis.
        model: Authority mode for the model axis.
        max_nodes: Upper bound on nodes per invocation.
        max_edges: Upper bound on edges per invocation.
        max_node_executions: Maximum total node executions across the graph. ``None`` for no limit.
        execution_timeout: Total timeout in seconds. ``None`` for no limit.
        node_timeout: Per-node timeout in seconds. ``None`` for no limit.

    Returns:
        A decorated tool that builds and runs a :class:`~strands.multiagent.graph.Graph`.

    Raises:
        ValueError: If a count limit is not a positive integer, a timeout is not a positive number,
            *max_nodes* < 2, or a ``Choice`` axis violates its constraints (empty options,
            ``multiple=False`` for tools).
    """
    _validate_limits(
        max_nodes=max_nodes,
        max_edges=max_edges,
        max_node_executions=max_node_executions,
        execution_timeout=execution_timeout,
        node_timeout=node_timeout,
    )

    presets = dict(presets or {})
    instructions = instructions if instructions is not None else Open()
    model = model if model is not None else Inherit()

    if default_preset is None and presets:
        default_preset = next(iter(presets))

    input_schema = _build_schema(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        model=model,
        max_nodes=max_nodes,
        max_edges=max_edges,
    )

    @tool(name=name, description=description, inputSchema={"json": input_schema}, context="tool_context")
    async def graph_tool(
        task: str,
        nodes: list[Mapping[str, Any]],
        edges: list[EdgeSpec],
        tool_context: ToolContext,
    ) -> AsyncGenerator[dict[str, Any] | str, None]:
        """Builds a directed acyclic graph of agents and runs it to solve a task.

        Args:
            task: The objective passed to entry-point nodes.
            nodes: Agent specification dicts (see :func:`make_graph`).
            edges: Edge dicts with ``from_node`` and ``to_node`` keys.
            tool_context: Injected by the framework. Not user-facing.
        """
        tool_use_id = tool_context.tool_use["toolUseId"]
        tool_streamer = _AgentToolStreamer(
            interrupt_state=getattr(tool_context.agent, "_interrupt_state", None),
            tool_use_id=tool_use_id,
            namespace="v1:graph",
            raise_unfinished=True,
        )
        build = builder or _default_builder(tool_context.agent)
        specs = _resolve_specs(
            nodes,
            presets=presets,
            default_preset=default_preset,
            instructions=instructions,
            tools=tools,
            model=model,
            label="node",
        )
        if not 2 <= len(specs) <= max_nodes:
            raise ValueError(f"Between 2 and {max_nodes} nodes required, got {len(specs)}")
        validated_edges = _validate_edges(edges, [spec.name for spec in specs if spec.name], max_edges=max_edges)

        graph_builder = GraphBuilder()
        try:
            for spec in specs:
                child = build(spec)
                for tool_name, child_tool in list(child.tool_registry.registry.items()):
                    if child_tool in _GRAPH_TOOLS:
                        del child.tool_registry.registry[tool_name]
                        child.tool_registry.dynamic_tools.pop(tool_name, None)
                graph_builder.add_node(child, node_id=spec.name)
        except Exception as error:
            if not tool_streamer.is_resuming():
                raise
            logger.warning("tool_use_id=<%s> | failed to rebuild interrupted graph: %s", tool_use_id, error)
            # Always raises: a missing child leaves the streamer unfinished.
            tool_streamer.resume(_GRAPH_ADAPTER, None, _UNAVAILABLE_MESSAGE)
        for from_node, to_node in validated_edges:
            graph_builder.add_edge(from_node, to_node)

        graph_builder.set_graph_id(f"v1:graph:{quote(tool_use_id, safe='')}")
        if max_node_executions is not None:
            graph_builder.set_max_node_executions(max_node_executions)
        if execution_timeout is not None:
            graph_builder.set_execution_timeout(execution_timeout)
        if node_timeout is not None:
            graph_builder.set_node_timeout(node_timeout)

        sdk_graph = graph_builder.build()
        resumed = tool_streamer.resume(_GRAPH_ADAPTER, sdk_graph, _UNAVAILABLE_MESSAGE)
        graph_input: MultiAgentInput = task if resumed is None else resumed

        logger.info("task=<%s>, nodes=<%d>, edges=<%d> | starting graph", task[:120], len(specs), len(validated_edges))
        # Drop request_state so a child's stop can't halt the parent.
        child_state = {key: value for key, value in tool_context.invocation_state.items() if key != "request_state"}
        source = sdk_graph.stream_async(
            graph_input, invocation_state=child_state, invocation_context=tool_context.invocation_context
        )
        try:
            async for event in tool_streamer.stream(_GRAPH_ADAPTER, sdk_graph, source):
                yield event
        except Exception as error:
            # The streamer's own interrupt or error is already model-facing.
            if tool_streamer.interrupts is not None or tool_streamer.error is not None:
                raise
            failed = sorted(node.node_id for node in sdk_graph.state.failed_nodes)
            results = sdk_graph.state.results
            finished = {node_id: node_result for node_id, node_result in results.items() if node_id not in failed}
            raise RuntimeError(
                f"Graph node(s) {', '.join(failed) or 'unknown'} failed: {error}. "
                f"Partial output:\n{GraphResult(results=finished)}"
            ) from error
        yield str(tool_streamer.result)

    _GRAPH_TOOLS.add(graph_tool)
    return graph_tool


# ---- Internals ----


def _validate_limits(
    *,
    max_nodes: int,
    max_edges: int,
    max_node_executions: int | None,
    execution_timeout: float | None,
    node_timeout: float | None,
) -> None:
    """Validate the developer-supplied graph limits; ``None`` means no limit where allowed.

    Raises:
        ValueError: If a count limit is not a positive integer, a timeout is not a positive number,
            or *max_nodes* < 2.
    """
    limits = {"max_nodes": max_nodes, "max_edges": max_edges}
    if max_node_executions is not None:
        limits["max_node_executions"] = max_node_executions
    # bool subclasses int, so it is rejected explicitly.
    for limit_name, limit in limits.items():
        if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
            raise ValueError(f"{limit_name} must be a positive integer")
    timeouts = (("execution_timeout", execution_timeout), ("node_timeout", node_timeout))
    for limit_name, timeout in timeouts:
        if timeout is not None and (not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or timeout <= 0):
            raise ValueError(f"{limit_name} must be a positive number")
    if max_nodes < 2:
        raise ValueError("max_nodes must be at least 2")


def _validate_edges(
    edges: Sequence[Mapping[str, Any]], node_names: list[str], *, max_edges: int
) -> list[tuple[str, str]]:
    """Validate raw edge dicts from the model against the declared node names.

    Raises:
        ValueError: On bad types, unknown node references, self-loops, or cycles.
    """
    if not isinstance(edges, list):
        raise ValueError(f"edges must be a list, got {type(edges).__name__}")
    if len(edges) > max_edges:
        raise ValueError(f"At most {max_edges} edges allowed, got {len(edges)}")

    known = set(node_names)
    validated: list[tuple[str, str]] = []
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            raise ValueError(f"Edge at index {index} must be a dict, got {type(edge).__name__}")
        from_node, to_node = edge.get("from_node"), edge.get("to_node")
        if not isinstance(from_node, str) or not isinstance(to_node, str):
            raise ValueError(f"Edge at index {index}: from_node and to_node must be strings")
        from_node, to_node = from_node.strip(), to_node.strip()
        for end in (from_node, to_node):
            if end not in known:
                raise ValueError(f"Edge at index {index}: {end!r} is not a declared node")
        if from_node == to_node:
            raise ValueError(f"Edge at index {index}: self-loop on {from_node!r}")
        validated.append((from_node, to_node))

    # Edges are unconditional, so a cycle would re-run until a limit is hit.
    cycle = _find_cycle(node_names, validated)
    if cycle:
        raise ValueError(f"Edges form a cycle: {' -> '.join(cycle)}")

    return validated


def _find_cycle(node_names: list[str], edges: list[tuple[str, str]]) -> list[str] | None:
    """Return one cycle as a closed path of node names, or ``None`` if the graph is acyclic."""
    successors: dict[str, list[str]] = {name: [] for name in node_names}
    for from_node, to_node in edges:
        successors[from_node].append(to_node)

    visiting: list[str] = []
    done: set[str] = set()

    def visit(node: str) -> list[str] | None:
        if node in visiting:
            return visiting[visiting.index(node) :] + [node]
        if node in done:
            return None
        visiting.append(node)
        for nxt in successors[node]:
            found = visit(nxt)
            if found:
                return found
        visiting.pop()
        done.add(node)
        return None

    for name in node_names:
        found = visit(name)
        if found:
            return found
    return None


def _build_schema(
    *,
    presets: Mapping[str, Preset],
    default_preset: str | None,
    instructions: Open | Choice | Fixed,
    tools: Choice | Fixed | Inherit | None,
    model: Inherit | Choice | Fixed | None,
    max_nodes: int,
    max_edges: int,
) -> dict[str, Any]:
    """Derive the tool's input schema from the axis modes; hidden axes produce no node property."""
    # Without a preset to fall back on, an Open prompt must come from the model.
    required = ["name", "instructions"] if isinstance(instructions, Open) and not presets else ["name"]
    axis_properties = _to_schema_properties(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        model=model,
    )
    return {
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
                    "required": required,
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string", "description": "A unique name for this node, referenced by edges."},
                        **axis_properties,
                    },
                },
                "minItems": 2,
                "maxItems": max_nodes,
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
                "maxItems": max_edges,
            },
        },
    }


graph = make_graph()
"""Default graph tool. Children inherit the caller's model."""
