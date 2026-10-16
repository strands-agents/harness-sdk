"""Graph tool for running a directed acyclic graph of sub-agents at runtime.

Provides :func:`make_graph` (a factory that lets the developer pin safety
limits and authority modes) and :data:`graph` (a default instance). The tool is
a thin shim over :class:`~strands.multiagent.graph.Graph`: it resolves each node
spec through the authority-mode system, builds agents via an :data:`AgentBuilder`,
runs the graph, and maps the result.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from typing_extensions import Required, TypedDict

from ...multiagent.base import Status
from ...multiagent.graph import GraphBuilder, GraphResult
from ...multiagent.spec import (
    AgentBuilder,
    Choice,
    Fixed,
    Inherit,
    Open,
    Preset,
    _append_presets,
    _default_builder,
    _resolve_specs,
    _to_schema_properties,
)
from ...tools.decorator import tool
from ...types.tools import ToolContext
from ..handoff_to_user import handoff_to_user

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

_DEFAULT_MAX_DEPTH = 2
"""Upper bound on the number of nested graph levels."""

_DEFAULT_EXECUTION_TIMEOUT = 900.0
"""Total timeout in seconds for one graph invocation."""

_DEFAULT_NODE_TIMEOUT = 300.0
"""Timeout in seconds for one node execution."""

# A graph cannot pause for user input, so children do not get the user-handoff tool.
_EXCLUDED_TOOLS = frozenset({handoff_to_user.tool_name})

_DEPTH_STATE_KEY = "strands.graph_depth"
"""Agent-state key used to propagate remaining nesting depth to children."""


def make_graph(
    *,
    name: str = "graph",
    description: str = DEFAULT_GRAPH_DESCRIPTION,
    builder: AgentBuilder | None = None,
    presets: Mapping[str, Preset] | None = None,
    default_preset: str | None = None,
    instructions: Open | Choice | Fixed | None = None,
    tools: Choice | Fixed | Inherit | None = None,
    mcp_servers: Choice | Fixed | Inherit | None = None,
    model: Inherit | Choice | Fixed | None = None,
    max_nodes: int = _DEFAULT_MAX_NODES,
    max_edges: int = _DEFAULT_MAX_EDGES,
    max_depth: int = _DEFAULT_MAX_DEPTH,
    max_node_executions: int | None = None,
    execution_timeout: float | None = _DEFAULT_EXECUTION_TIMEOUT,
    node_timeout: float | None = _DEFAULT_NODE_TIMEOUT,
) -> DecoratedFunctionTool:
    """Create a graph tool with developer-controlled safety limits and authority modes.

    Each node spec from the model is resolved through the authority-mode system
    (see :mod:`~strands.multiagent.spec`), then built via ``builder``. A running graph
    cannot be cancelled from the parent agent.

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
        mcp_servers: Authority mode for the MCP servers axis.
        model: Authority mode for the model axis.
        max_nodes: Upper bound on nodes per invocation.
        max_edges: Upper bound on edges per invocation.
        max_depth: Maximum nesting depth for recursive graph calls (>= 1).
        max_node_executions: Maximum total node executions across the graph. ``None`` for no limit.
        execution_timeout: Total timeout in seconds. ``None`` for no limit.
        node_timeout: Per-node timeout in seconds. ``None`` for no limit.

    Returns:
        A decorated tool that builds and runs a :class:`~strands.multiagent.graph.Graph`.

    Raises:
        ValueError: If a count limit is not a positive integer, a timeout is not a positive number,
            *max_nodes* < 2, or a ``Choice`` axis violates its constraints (empty options,
            ``multiple=False`` for tools or MCP servers).
    """
    _validate_limits(
        max_nodes=max_nodes,
        max_edges=max_edges,
        max_depth=max_depth,
        max_node_executions=max_node_executions,
        execution_timeout=execution_timeout,
        node_timeout=node_timeout,
    )

    presets = dict(presets or {})
    instructions = instructions if instructions is not None else Open()
    model = model if model is not None else Inherit()

    if default_preset is None and presets:
        default_preset = next(iter(presets))

    tool_description = _append_presets(description, presets)

    input_schema = _build_schema(
        presets=presets,
        default_preset=default_preset,
        instructions=instructions,
        tools=tools,
        mcp_servers=mcp_servers,
        model=model,
        max_nodes=max_nodes,
        max_edges=max_edges,
    )

    @tool(name=name, description=tool_description, inputSchema={"json": input_schema}, context="tool_context")
    async def graph_tool(
        task: str,
        nodes: list[Mapping[str, Any]],
        edges: list[EdgeSpec],
        tool_context: ToolContext,
    ) -> AsyncGenerator[Any, None]:
        """Builds a directed acyclic graph of agents and runs it to solve a task.

        Args:
            task: The objective passed to entry-point nodes.
            nodes: Agent specification dicts (see :func:`make_graph`).
            edges: Edge dicts with ``from_node`` and ``to_node`` keys.
            tool_context: Injected by the framework. Not user-facing.
        """
        parent = tool_context.agent

        stored = parent.state.get(_DEPTH_STATE_KEY) if parent else None
        depth = max_depth if stored is None else stored
        if depth <= 0:
            raise RuntimeError("Graph nesting depth limit reached; complete this task without spawning another graph.")

        build = builder or _default_builder(parent)

        specs = _resolve_specs(
            nodes,
            presets=presets,
            default_preset=default_preset,
            instructions=instructions,
            tools=tools,
            mcp_servers=mcp_servers,
            model=model,
            label="node",
        )
        if not 2 <= len(specs) <= max_nodes:
            raise ValueError(f"Between 2 and {max_nodes} nodes required, got {len(specs)}")
        validated_edges = _validate_edges(edges, [spec.name for spec in specs if spec.name], max_edges=max_edges)

        graph_builder = GraphBuilder()
        for spec in specs:
            child = build(spec)
            child.state.set(_DEPTH_STATE_KEY, depth - 1)
            for tool_name in _EXCLUDED_TOOLS:
                child.tool_registry.registry.pop(tool_name, None)
            graph_builder.add_node(child, node_id=spec.name)
        for from_node, to_node in validated_edges:
            graph_builder.add_edge(from_node, to_node)

        if max_node_executions is not None:
            graph_builder.set_max_node_executions(max_node_executions)
        if execution_timeout is not None:
            graph_builder.set_execution_timeout(execution_timeout)
        if node_timeout is not None:
            graph_builder.set_node_timeout(node_timeout)

        sdk_graph = graph_builder.build()

        logger.info("task=<%s>, nodes=<%d>, edges=<%d> | starting graph", task[:120], len(specs), len(validated_edges))
        result: GraphResult | None = None
        # Copy so child cycles can't mutate the parent's state; drop request_state so a child's stop can't halt it.
        child_state = {k: v for k, v in tool_context.invocation_state.items() if k != "request_state"}
        try:
            async for event in sdk_graph.stream_async(task, invocation_state=child_state):
                # Hold back the final result event: the decorator treats the last yield as the tool result.
                if event.get("type") == "multiagent_result":
                    result = event["result"]
                else:
                    yield event
        except Exception as error:
            failed = sorted(node.node_id for node in sdk_graph.state.failed_nodes)
            finished = {node_id: res for node_id, res in sdk_graph.state.results.items() if node_id not in failed}
            raise RuntimeError(
                f"Graph node(s) {', '.join(failed) or 'unknown'} failed: {error}. "
                f"Partial output:\n{GraphResult(results=finished)}"
            ) from error

        if result is None:
            raise RuntimeError("Graph stream ended without producing a result")
        if result.interrupts:
            names = sorted({interrupt.name for interrupt in result.interrupts})
            raise RuntimeError(
                f"A node requested user input ({', '.join(names)}), but a graph cannot pause; "
                "complete the task without that input or ask the user yourself."
            )
        if result.status != Status.COMPLETED:
            raise RuntimeError(
                f"Graph stopped before completing (status={result.status.value}, "
                f"{result.execution_count} node executions). Partial output:\n{result}"
            )

        yield str(result)

    return graph_tool


# ---- Internals ----


def _validate_limits(
    *,
    max_nodes: int,
    max_edges: int,
    max_depth: int,
    max_node_executions: int | None,
    execution_timeout: float | None,
    node_timeout: float | None,
) -> None:
    """Validate the developer-supplied graph limits; ``None`` means no limit where allowed.

    Raises:
        ValueError: If a count limit is not a positive integer, a timeout is not a positive number,
            or *max_nodes* < 2.
    """
    limits = {"max_nodes": max_nodes, "max_edges": max_edges, "max_depth": max_depth}
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
    mcp_servers: Choice | Fixed | Inherit | None,
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
        mcp_servers=mcp_servers,
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
