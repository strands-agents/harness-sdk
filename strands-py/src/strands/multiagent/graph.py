"""Directed Graph Multi-Agent Pattern Implementation.

This module provides a deterministic graph-based agent orchestration system where
agents or MultiAgentBase instances (like Swarm or Graph) are nodes in a graph,
executed according to edge dependencies, with output from one node passed as input
to connected nodes.

Key Features:
- Agents and MultiAgentBase instances (Swarm, Graph, etc.) as graph nodes
- Deterministic execution based on dependency resolution
- Output propagation along edges
- Support for cyclic graphs (feedback loops)
- Clear dependency management
- Supports nested graphs (Graph as a node in another Graph)
"""

import asyncio
import copy
import inspect
import logging
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeGuard, cast

from opentelemetry import trace as trace_api

from .._async import run_async
from ..agent import Agent
from ..agent.base import AgentBase
from ..agent.state import AgentState
from ..hooks.events import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    MultiAgentInitializedEvent,
)
from ..hooks.registry import HookCallback, HookOrder, HookProvider, HookRegistry
from ..interrupt import Interrupt, _InterruptState
from ..plugins.multiagent_plugin import MultiAgentPlugin
from ..plugins.multiagent_registry import _MultiAgentPluginRegistry
from ..session import SessionManager
from ..telemetry import get_tracer
from ..types._events import (
    MultiAgentHandoffEvent,
    MultiAgentNodeCancelEvent,
    MultiAgentNodeInterruptEvent,
    MultiAgentNodeStartEvent,
    MultiAgentNodeStopEvent,
    MultiAgentNodeStreamEvent,
    MultiAgentResultEvent,
)
from ..types.content import ContentBlock, Messages
from ..types.event_loop import Metrics, Usage
from ..types.multiagent import MultiAgentInput
from ..types.session import decode_bytes_values, encode_bytes_values
from ..types.traces import AttributeValue
from .base import (
    MultiAgentBase,
    MultiAgentResult,
    NodeResult,
    Status,
    _accumulate_cache_usage,
    _parse_metrics,
    _parse_usage,
)

logger = logging.getLogger(__name__)

_DEFAULT_GRAPH_ID = "default_graph"


class EdgeConditionWithContext(Protocol):
    """Protocol for edge conditions that receive invocation_state.

    This allows conditions to make routing decisions based on runtime context
    passed during graph invocation, such as feature flags, user roles, or
    environment-specific configuration.

    Designed with **kwargs for future extensibility without breaking changes.

    Not @runtime_checkable because the expected use case is a function or lambda,
    and isinstance() checks cannot structurally distinguish callable signatures.
    Dispatch uses _is_context_condition() with inspect.signature() instead.
    """

    def __call__(self, state: "GraphState", *, invocation_state: dict[str, Any], **kwargs: Any) -> bool:
        """Evaluate whether the edge should be traversed."""
        ...


LegacyEdgeCondition = Callable[["GraphState"], bool]
EdgeCondition = LegacyEdgeCondition | EdgeConditionWithContext


def _is_context_condition(condition: EdgeCondition) -> TypeGuard[EdgeConditionWithContext]:
    """Check if a condition function accepts invocation_state parameter.

    Uses inspect.signature() for reliable detection, returning a TypeGuard
    so mypy can narrow the type at call sites.

    Detection keys on the parameter *name* only — any parameter named
    ``invocation_state`` (positional or keyword) triggers the new calling
    convention. The parameter must be passable as a keyword argument since
    ``should_traverse`` always passes it by name.
    """
    try:
        sig = inspect.signature(condition)
        return "invocation_state" in sig.parameters
    except (ValueError, TypeError):
        return False


@dataclass
class GraphState:
    """Graph execution state.

    Attributes:
        status: Current execution status of the graph.
        completed_nodes: Set of nodes that have completed execution.
        failed_nodes: Set of nodes that failed during execution.
        interrupted_nodes: Set of nodes that user interrupted during execution.
        execution_order: List of nodes in the order they were executed.
        task: The original input prompt/query provided to the graph execution.
              This represents the actual work to be performed by the graph as a whole.
              Entry point nodes receive this task as their input if they have no dependencies.
        start_time: Timestamp when the current invocation started.
            Resets on each invocation, even when resuming from interrupt.
        execution_time: Execution time of current invocation in milliseconds.
            Excludes time spent waiting for interrupt responses.
    """

    # Task (with default empty string)
    task: MultiAgentInput = ""

    # Execution state
    status: Status = Status.PENDING
    completed_nodes: set["GraphNode"] = field(default_factory=set)
    failed_nodes: set["GraphNode"] = field(default_factory=set)
    interrupted_nodes: set["GraphNode"] = field(default_factory=set)
    execution_order: list["GraphNode"] = field(default_factory=list)
    start_time: float = field(default_factory=time.time)

    # Results
    results: dict[str, NodeResult] = field(default_factory=dict)

    # Accumulated metrics
    accumulated_usage: Usage = field(default_factory=lambda: Usage(inputTokens=0, outputTokens=0, totalTokens=0))
    accumulated_metrics: Metrics = field(default_factory=lambda: Metrics(latencyMs=0))
    execution_count: int = 0
    execution_time: int = 0

    # Graph structure info
    total_nodes: int = 0
    edges: list[tuple["GraphNode", "GraphNode"]] = field(default_factory=list)
    entry_points: list["GraphNode"] = field(default_factory=list)

    def should_continue(
        self,
        max_node_executions: int | None,
        execution_timeout: float | None,
    ) -> tuple[bool, str]:
        """Check if the graph should continue execution.

        Returns: (should_continue, reason)
        """
        # Check node execution limit (only if set)
        if max_node_executions is not None and len(self.execution_order) >= max_node_executions:
            return False, f"Max node executions reached: {max_node_executions}"

        # Check timeout (only if set)
        if execution_timeout is not None:
            elapsed = self.execution_time / 1000 + time.time() - self.start_time
            if elapsed > execution_timeout:
                return False, f"Execution timed out: {execution_timeout}s"

        return True, "Continuing"


@dataclass
class GraphResult(MultiAgentResult):
    """Result from graph execution - extends MultiAgentResult with graph-specific details."""

    total_nodes: int = 0
    completed_nodes: int = 0
    failed_nodes: int = 0
    interrupted_nodes: int = 0
    execution_order: list["GraphNode"] = field(default_factory=list)
    edges: list[tuple["GraphNode", "GraphNode"]] = field(default_factory=list)
    entry_points: list["GraphNode"] = field(default_factory=list)


@dataclass
class GraphEdge:
    """Represents an edge in the graph with an optional condition."""

    from_node: "GraphNode"
    to_node: "GraphNode"
    condition: EdgeCondition | None = None
    _is_context_condition_cached: bool | None = field(default=None, init=False, repr=False, compare=False)

    def __hash__(self) -> int:
        """Return hash for GraphEdge based on from_node and to_node."""
        return hash((self.from_node.node_id, self.to_node.node_id))

    def should_traverse(self, state: GraphState, *, invocation_state: dict[str, Any]) -> bool:
        """Check if this edge should be traversed based on condition.

        Args:
            state: The current graph execution state.
            invocation_state: Runtime context passed during graph invocation.
                New-style conditions (EdgeConditionWithContext) receive this parameter.
                Legacy conditions (Callable[[GraphState], bool]) are called with state only.
        """
        condition = self.condition
        if condition is None:
            return True
        if self._check_is_context_condition(condition):
            return condition(state, invocation_state=invocation_state)
        legacy_condition = cast(LegacyEdgeCondition, condition)
        return legacy_condition(state)

    def _check_is_context_condition(self, condition: EdgeCondition) -> TypeGuard[EdgeConditionWithContext]:
        """Check and cache whether this edge's condition accepts invocation_state."""
        if self._is_context_condition_cached is None:
            self._is_context_condition_cached = _is_context_condition(condition)
        return self._is_context_condition_cached


@dataclass
class GraphNode:
    """Represents a node in the graph."""

    node_id: str
    executor: AgentBase | MultiAgentBase
    dependencies: set["GraphNode"] = field(default_factory=set)
    execution_status: Status = Status.PENDING
    result: NodeResult | None = None
    execution_time: int = 0
    _initial_messages: Messages = field(default_factory=list, init=False)
    _initial_state: AgentState = field(default_factory=AgentState, init=False)
    _initial_model_state: dict[str, Any] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        """Capture initial executor state after initialization."""
        # Deep copy the initial messages and state to preserve them
        if hasattr(self.executor, "messages"):
            self._initial_messages = copy.deepcopy(self.executor.messages)

        if hasattr(self.executor, "state") and isinstance(self.executor.state, AgentState):
            self._initial_state = AgentState(self.executor.state.get())

        if hasattr(self.executor, "_model_state"):
            self._initial_model_state = copy.deepcopy(self.executor._model_state)

    def reset_executor_state(self) -> None:
        """Reset GraphNode executor state to initial state when graph was created.

        This is useful when nodes are executed multiple times and need to start
        fresh on each execution, providing stateless behavior.
        """
        if hasattr(self.executor, "messages"):
            self.executor.messages = copy.deepcopy(self._initial_messages)

        if hasattr(self.executor, "state") and isinstance(self.executor.state, AgentState):
            self.executor.state = AgentState(self._initial_state.get())

        if hasattr(self.executor, "_model_state"):
            self.executor._model_state = copy.deepcopy(self._initial_model_state)

        # Reset execution status
        self.execution_status = Status.PENDING
        self.result = None

    def __hash__(self) -> int:
        """Return hash for GraphNode based on node_id."""
        return hash(self.node_id)

    def __eq__(self, other: Any) -> bool:
        """Return equality for GraphNode based on node_id."""
        if not isinstance(other, GraphNode):
            return False
        return self.node_id == other.node_id


def _validate_node_executor(
    executor: AgentBase | MultiAgentBase, existing_nodes: dict[str, GraphNode] | None = None
) -> None:
    """Validate a node executor for graph compatibility.

    Args:
        executor: The executor to validate
        existing_nodes: Optional dict of existing nodes to check for duplicates
    """
    # Check for duplicate node instances
    if existing_nodes:
        seen_instances = {id(node.executor) for node in existing_nodes.values()}
        if id(executor) in seen_instances:
            raise ValueError("Duplicate node instance detected. Each node must have a unique object instance.")

    # Validate Agent-specific constraints
    if isinstance(executor, Agent):
        # Check for session persistence
        if executor._session_manager is not None:
            raise ValueError("Session persistence is not supported for Graph agents yet.")


class GraphBuilder:
    """Builder pattern for constructing graphs."""

    def __init__(self) -> None:
        """Initialize GraphBuilder with empty collections."""
        self.nodes: dict[str, GraphNode] = {}
        self.edges: set[GraphEdge] = set()
        self.entry_points: set[GraphNode] = set()

        # Configuration options
        self._max_node_executions: int | None = None
        self._execution_timeout: float | None = None
        self._node_timeout: float | None = None
        self._reset_on_revisit: bool = False
        self._id: str = _DEFAULT_GRAPH_ID
        self._session_manager: SessionManager | None = None
        self._hooks: list[HookProvider] | None = None
        self._plugins: list[MultiAgentPlugin] | None = None

    def add_node(self, executor: AgentBase | MultiAgentBase, node_id: str | None = None) -> GraphNode:
        """Add an AgentBase or MultiAgentBase instance as a node to the graph."""
        _validate_node_executor(executor, self.nodes)

        # Auto-generate node_id if not provided
        if node_id is None:
            node_id = getattr(executor, "id", None) or getattr(executor, "name", None) or f"node_{len(self.nodes)}"

        if node_id in self.nodes:
            raise ValueError(f"Node '{node_id}' already exists")

        node = GraphNode(node_id=node_id, executor=executor)
        self.nodes[node_id] = node
        return node

    def add_edge(
        self,
        from_node: str | GraphNode,
        to_node: str | GraphNode,
        condition: EdgeCondition | None = None,
    ) -> GraphEdge:
        """Add an edge between two nodes with optional condition function.

        The condition can be either:
        - A legacy callable: Callable[[GraphState], bool] - receives only graph state
        - A new-style callable: EdgeConditionWithContext - receives graph state and invocation_state
        """

        def resolve_node(node: str | GraphNode, node_type: str) -> GraphNode:
            if isinstance(node, str):
                if node not in self.nodes:
                    raise ValueError(f"{node_type} node '{node}' not found")
                return self.nodes[node]
            else:
                if node not in self.nodes.values():
                    raise ValueError(f"{node_type} node object has not been added to the graph, use graph.add_node")
                return node

        from_node_obj = resolve_node(from_node, "Source")
        to_node_obj = resolve_node(to_node, "Target")

        # Add edge and update dependencies
        edge = GraphEdge(from_node=from_node_obj, to_node=to_node_obj, condition=condition)
        self.edges.add(edge)
        to_node_obj.dependencies.add(from_node_obj)
        return edge

    def set_entry_point(self, node_id: str) -> "GraphBuilder":
        """Set a node as an entry point for graph execution."""
        if node_id not in self.nodes:
            raise ValueError(f"Node '{node_id}' not found")
        self.entry_points.add(self.nodes[node_id])
        return self

    def reset_on_revisit(self, enabled: bool = True) -> "GraphBuilder":
        """Control whether nodes reset their state when revisited.

        When enabled, nodes will reset their messages and state to initial values
        each time they are revisited (re-executed). This is useful for stateless
        behavior where nodes should start fresh on each revisit.

        Args:
            enabled: Whether to reset node state when revisited (default: True)
        """
        self._reset_on_revisit = enabled
        return self

    def set_max_node_executions(self, max_executions: int) -> "GraphBuilder":
        """Set maximum number of node executions allowed.

        Args:
            max_executions: Maximum total node executions (None for no limit)
        """
        self._max_node_executions = max_executions
        return self

    def set_execution_timeout(self, timeout: float) -> "GraphBuilder":
        """Set total execution timeout.

        Args:
            timeout: Total execution timeout in seconds (None for no limit)
        """
        self._execution_timeout = timeout
        return self

    def set_node_timeout(self, timeout: float) -> "GraphBuilder":
        """Set individual node execution timeout.

        Args:
            timeout: Individual node timeout in seconds (None for no limit)
        """
        self._node_timeout = timeout
        return self

    def set_graph_id(self, graph_id: str) -> "GraphBuilder":
        """Set graph id.

        Args:
            graph_id: Unique graph id
        """
        self._id = graph_id
        return self

    def set_session_manager(self, session_manager: SessionManager) -> "GraphBuilder":
        """Set session manager for the graph.

        Args:
            session_manager: SessionManager instance
        """
        self._session_manager = session_manager
        return self

    def set_hook_providers(self, hooks: list[HookProvider]) -> "GraphBuilder":
        """Set hook providers for the graph.

        Args:
            hooks: Customer hooks user passes in
        """
        self._hooks = hooks
        return self

    def set_plugins(self, plugins: list[MultiAgentPlugin]) -> "GraphBuilder":
        """Set plugins for the graph.

        Args:
            plugins: List of multi-agent plugins for extending graph behavior
        """
        self._plugins = plugins
        return self

    def build(self) -> "Graph":
        """Build and validate the graph with configured settings."""
        if not self.nodes:
            raise ValueError("Graph must contain at least one node")

        # Auto-detect entry points if none specified
        if not self.entry_points:
            self.entry_points = {node for node_id, node in self.nodes.items() if not node.dependencies}
            logger.debug(
                "entry_points=<%s> | auto-detected entrypoints", ", ".join(node.node_id for node in self.entry_points)
            )
            if not self.entry_points:
                raise ValueError("No entry points found - all nodes have dependencies")

        # Validate entry points and check for cycles
        self._validate_graph()

        return Graph(
            nodes=self.nodes.copy(),
            edges=self.edges.copy(),
            entry_points=self.entry_points.copy(),
            max_node_executions=self._max_node_executions,
            execution_timeout=self._execution_timeout,
            node_timeout=self._node_timeout,
            reset_on_revisit=self._reset_on_revisit,
            session_manager=self._session_manager,
            hooks=self._hooks,
            id=self._id,
            plugins=self._plugins,
        )

    def _validate_graph(self) -> None:
        """Validate graph structure."""
        # Validate entry points exist
        entry_point_ids = {node.node_id for node in self.entry_points}
        invalid_entries = entry_point_ids - set(self.nodes.keys())
        if invalid_entries:
            raise ValueError(f"Entry points not found in nodes: {invalid_entries}")

        # Warn about potential infinite loops if no execution limits are set
        if self._max_node_executions is None and self._execution_timeout is None:
            logger.warning("Graph without execution limits may run indefinitely if cycles exist")


class Graph(MultiAgentBase):
    """Directed Graph multi-agent orchestration with configurable revisit behavior."""

    def __init__(
        self,
        nodes: dict[str, GraphNode],
        edges: set[GraphEdge],
        entry_points: set[GraphNode],
        max_node_executions: int | None = None,
        execution_timeout: float | None = None,
        node_timeout: float | None = None,
        reset_on_revisit: bool = False,
        session_manager: SessionManager | None = None,
        hooks: list[HookProvider] | None = None,
        id: str = _DEFAULT_GRAPH_ID,
        trace_attributes: Mapping[str, AttributeValue] | None = None,
        plugins: list[MultiAgentPlugin] | None = None,
    ) -> None:
        """Initialize Graph with execution limits and reset behavior.

        Args:
            nodes: Dictionary of node_id to GraphNode
            edges: Set of GraphEdge objects
            entry_points: Set of GraphNode objects that are entry points
            max_node_executions: Maximum total node executions (default: None - no limit)
            execution_timeout: Total execution timeout in seconds (default: None - no limit)
            node_timeout: Individual node timeout in seconds (default: None - no limit)
            reset_on_revisit: Whether to reset node state when revisited (default: False)
            session_manager: Session manager for persisting graph state and execution history (default: None)
            hooks: List of hook providers for monitoring and extending graph execution behavior (default: None)
            id: Unique graph id (default: None)
            trace_attributes: Custom trace attributes to apply to the agent's trace span (default: None)
            plugins: List of multi-agent plugins for extending graph behavior (default: None)
        """
        super().__init__()

        # Validate nodes for duplicate instances
        self._validate_graph(nodes)

        self.nodes = nodes
        self.edges = edges
        self.entry_points = entry_points
        self.max_node_executions = max_node_executions
        self.execution_timeout = execution_timeout
        self.node_timeout = node_timeout
        self.reset_on_revisit = reset_on_revisit
        self.state = GraphState()
        self._interrupt_state = _InterruptState()
        self.tracer = get_tracer()
        self.trace_attributes: dict[str, AttributeValue] = self._parse_trace_attributes(trace_attributes)
        self.session_manager = session_manager
        self.hooks = HookRegistry()
        if self.session_manager:
            self.hooks.add_hook(self.session_manager)
        if hooks:
            for hook in hooks:
                self.hooks.add_hook(hook)

        self._plugin_registry = _MultiAgentPluginRegistry(self)
        if plugins:
            for plugin in plugins:
                self._plugin_registry.add_and_init(plugin)

        self._resume_next_nodes: list[GraphNode] = []
        self._resume_from_session = False
        self._current_invocation_state: dict[str, Any] = {}
        self.id = id

        run_async(lambda: self.hooks.invoke_callbacks_async(MultiAgentInitializedEvent(self)))

    def add_hook(
        self, callback: HookCallback, event_type: type | list[type] | None = None, *, order: float = HookOrder.DEFAULT
    ) -> None:
        """Register a hook callback with the graph.

        Args:
            callback: The callback function to invoke when events of this type occur.
            event_type: The class type(s) of events this callback should handle.
                Can be a single type, a list of types, or None to infer from
                the callback's first parameter type hint.
            order: Execution priority. Lower values execute first.
        """
        self.hooks.add_callback(event_type, callback, order=order)

    def __call__(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> GraphResult:
        """Invoke the graph synchronously.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Keyword arguments allowing backward compatible future changes.
        """
        if invocation_state is None:
            invocation_state = {}

        return run_async(lambda: self.invoke_async(task, invocation_state))

    async def invoke_async(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> GraphResult:
        """Invoke the graph asynchronously.

        This method uses stream_async internally and consumes all events until completion,
        following the same pattern as the Agent class.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Keyword arguments allowing backward compatible future changes.
        """
        events = self.stream_async(task, invocation_state, **kwargs)
        final_event = None
        async for event in events:
            final_event = event

        if final_event is None or "result" not in final_event:
            raise ValueError("Graph streaming completed without producing a result event")

        return cast(GraphResult, final_event["result"])

    async def stream_async(
        self, task: MultiAgentInput, invocation_state: dict[str, Any] | None = None, **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream events during graph execution.

        Args:
            task: The task to execute
            invocation_state: Additional state/context passed to underlying agents.
                Defaults to None to avoid mutable default argument issues.
            **kwargs: Keyword arguments allowing backward compatible future changes.

        Yields:
            Dictionary events during graph execution, such as:
            - multi_agent_node_start: When a node begins execution
            - multi_agent_node_stream: Forwarded agent/multi-agent events with node context
            - multi_agent_node_stop: When a node stops execution
            - result: Final graph result
        """
        if invocation_state is None:
            invocation_state = {}

        self._current_invocation_state = invocation_state

        await self.hooks.invoke_callbacks_async(BeforeMultiAgentInvocationEvent(self, invocation_state))
        self._interrupt_state.resume(task)

        logger.debug("task=<%s> | starting graph execution", task)

        # Initialize state
        start_time = time.time()
        if not self._resume_from_session and not self._interrupt_state.activated:
            # Initialize state
            self.state = GraphState(
                status=Status.EXECUTING,
                task=task,
                total_nodes=len(self.nodes),
                edges=[(edge.from_node, edge.to_node) for edge in self.edges],
                entry_points=list(self.entry_points),
                start_time=start_time,
            )
        else:
            self.state.status = Status.EXECUTING
            self.state.start_time = start_time

        span = self.tracer.start_multiagent_span(task, "graph", custom_trace_attributes=self.trace_attributes)
        with trace_api.use_span(span, end_on_exit=True):
            interrupts = []

            self._invocation_start_time = start_time

            try:
                logger.debug(
                    "max_node_executions=<%s>, execution_timeout=<%s>s, node_timeout=<%s>s | graph execution config",
                    self.max_node_executions or "None",
                    self.execution_timeout or "None",
                    self.node_timeout or "None",
                )

                async for event in self._execute_graph(invocation_state):
                    if isinstance(event, MultiAgentNodeInterruptEvent):
                        interrupts.extend(event.interrupts)

                    yield event.as_dict()

                # Set final status based on execution results
                if self.state.failed_nodes:
                    self.state.status = Status.FAILED
                elif self.state.status == Status.EXECUTING:
                    self.state.status = Status.COMPLETED

                logger.debug("status=<%s> | graph execution completed", self.state.status)

                # Yield final result (consistent with Agent's AgentResultEvent format)
                result = self._build_result(interrupts)

                # Use the same event format as Agent for consistency
                yield MultiAgentResultEvent(result=result).as_dict()

            except Exception:
                logger.exception("graph execution failed")
                self.state.status = Status.FAILED
                raise
            finally:
                self.state.execution_time = self._commit_active_interval(self.state.execution_time)
                await self.hooks.invoke_callbacks_async(AfterMultiAgentInvocationEvent(self))
                self._resume_from_session = False
                self._resume_next_nodes.clear()

    def _validate_graph(self, nodes: dict[str, GraphNode]) -> None:
        """Validate graph nodes for duplicate instances."""
        # Check for duplicate node instances
        seen_instances = set()
        for node in nodes.values():
            if id(node.executor) in seen_instances:
                raise ValueError("Duplicate node instance detected. Each node must have a unique object instance.")
            seen_instances.add(id(node.executor))

            # Validate Agent-specific constraints for each node
            _validate_node_executor(node.executor)

    def _activate_interrupt(
        self, node: GraphNode, interrupts: list[Interrupt], from_hook: bool = False
    ) -> MultiAgentNodeInterruptEvent:
        """Activate the interrupt state.

        Args:
            node: The interrupted node.
            interrupts: The interrupts raised by the user.
            from_hook: Whether the interrupt originated from a hook (e.g., BeforeNodeCallEvent).

        Returns:
            MultiAgentNodeInterruptEvent
        """
        logger.debug("node=<%s>, from_hook=<%s> | node interrupted", node.node_id, from_hook)

        node.execution_status = Status.INTERRUPTED

        self.state.status = Status.INTERRUPTED
        self.state.interrupted_nodes.add(node)

        self._interrupt_state.interrupts.update({interrupt.id: interrupt for interrupt in interrupts})
        self._interrupt_state.activate()

        self._interrupt_state.context[node.node_id] = {
            "from_hook": from_hook,
            "interrupt_ids": [interrupt.id for interrupt in interrupts],
        }

        if isinstance(node.executor, Agent):
            self._interrupt_state.context[node.node_id].update(
                {
                    "interrupt_state": node.executor._interrupt_state.to_dict(),
                    "state": node.executor.state.get(),
                    "messages": node.executor.messages,
                    "model_state": node.executor._model_state,
                }
            )

        return MultiAgentNodeInterruptEvent(node.node_id, interrupts)

    async def _execute_graph(self, invocation_state: dict[str, Any]) -> AsyncIterator[Any]:
        """Execute graph and yield TypedEvent objects."""
        if self._interrupt_state.activated:
            ready_nodes = [self.nodes[node_id] for node_id in self._interrupt_state.context["completed_nodes"]]
            ready_nodes.extend(self.state.interrupted_nodes)

            self.state.interrupted_nodes.clear()

        elif self._resume_from_session:
            ready_nodes = self._resume_next_nodes

        else:
            ready_nodes = list(self.entry_points)

        while ready_nodes:
            # Check execution limits before continuing
            should_continue, reason = self.state.should_continue(
                max_node_executions=self.max_node_executions,
                execution_timeout=self.execution_timeout,
            )
            if not should_continue:
                self.state.status = Status.FAILED
                logger.debug("reason=<%s> | stopping execution", reason)
                return  # Let the top-level exception handler deal with it

            current_batch = ready_nodes.copy()
            ready_nodes.clear()

            # Execute current batch
            async for event in self._execute_nodes_parallel(current_batch, invocation_state):
                yield event

            if self.state.status == Status.INTERRUPTED:
                self._interrupt_state.context["completed_nodes"] = [
                    node.node_id for node in current_batch if node.execution_status == Status.COMPLETED
                ]
                return

            self._interrupt_state.deactivate()

            # Find newly ready nodes after batch execution
            # We add all nodes in current batch as completed batch,
            # because a failure would throw exception and code would not make it here
            newly_ready = self._find_newly_ready_nodes(current_batch)

            # Emit handoff event for batch transition if there are nodes to transition to
            if newly_ready:
                handoff_event = MultiAgentHandoffEvent(
                    from_node_ids=[node.node_id for node in current_batch],
                    to_node_ids=[node.node_id for node in newly_ready],
                )
                yield handoff_event
                logger.debug(
                    "from_node_ids=<%s>, to_node_ids=<%s> | batch transition",
                    [node.node_id for node in current_batch],
                    [node.node_id for node in newly_ready],
                )

            ready_nodes.extend(newly_ready)

    async def _execute_nodes_parallel(
        self, nodes: list["GraphNode"], invocation_state: dict[str, Any]
    ) -> AsyncIterator[Any]:
        """Execute multiple nodes in parallel and merge their event streams in real-time.

        Uses a shared queue where each node's stream runs independently and pushes events
        as they occur, enabling true real-time event propagation without round-robin delays.
        """
        if self._interrupt_state.activated:
            nodes = [node for node in nodes if node.execution_status == Status.INTERRUPTED]

        event_queue: asyncio.Queue[Any | None | Exception] = asyncio.Queue()

        # Start all node streams as independent tasks
        tasks = [asyncio.create_task(self._stream_node_to_queue(node, event_queue, invocation_state)) for node in nodes]

        try:
            # Consume events from the queue as they arrive
            # Continue until all tasks are done
            while any(not task.done() for task in tasks):
                try:
                    # Use timeout to avoid race condition: if all tasks complete between
                    # checking task.done() and calling queue.get(), we'd hang forever.
                    # The 0.1s timeout allows us to periodically re-check task completion
                    # while still being responsive to incoming events.
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.1)
                except asyncio.TimeoutError:
                    # No event available, continue checking tasks
                    continue

                # Check if it's an exception - fail fast
                if isinstance(event, Exception):
                    # Cancel all other tasks immediately
                    for task in tasks:
                        if not task.done():
                            task.cancel()
                    raise event

                if event is not None:
                    yield event

            # Process any remaining events in the queue after all tasks complete
            while not event_queue.empty():
                event = await event_queue.get()
                if isinstance(event, Exception):
                    raise event
                if event is not None:
                    yield event
        finally:
            # Cancel any remaining tasks
            remaining_tasks = [task for task in tasks if not task.done()]
            if remaining_tasks:
                logger.warning(
                    "remaining_task_count=<%d> | cancelling remaining tasks in finally block",
                    len(remaining_tasks),
                )
                for task in remaining_tasks:
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _stream_node_to_queue(
        self,
        node: GraphNode,
        event_queue: asyncio.Queue[Any | None | Exception],
        invocation_state: dict[str, Any],
    ) -> None:
        """Stream events from a node to the shared queue with optional timeout."""
        try:
            # Apply timeout to the entire streaming process if configured
            if self.node_timeout is not None:

                async def stream_node() -> None:
                    async for event in self._execute_node(node, invocation_state):
                        await event_queue.put(event)

                try:
                    await asyncio.wait_for(stream_node(), timeout=self.node_timeout)
                except asyncio.TimeoutError:
                    # Handle timeout and send exception through queue
                    timeout_exc = await self._handle_node_timeout(node, event_queue)
                    await event_queue.put(timeout_exc)
            else:
                # No timeout - stream normally
                async for event in self._execute_node(node, invocation_state):
                    await event_queue.put(event)
        except Exception as e:
            # Send exception through queue for fail-fast behavior
            await event_queue.put(e)
        finally:
            await event_queue.put(None)

    async def _handle_node_timeout(self, node: GraphNode, event_queue: asyncio.Queue[Any | None]) -> Exception:
        """Handle a node timeout by creating a failed result and emitting events.

        Returns:
            The timeout exception to be re-raised for fail-fast behavior
        """
        assert self.node_timeout is not None
        timeout_exception = Exception(f"Node '{node.node_id}' execution timed out after {self.node_timeout}s")

        node_result = NodeResult(
            result=timeout_exception,
            execution_time=round(self.node_timeout * 1000),
            status=Status.FAILED,
            accumulated_usage=Usage(inputTokens=0, outputTokens=0, totalTokens=0),
            accumulated_metrics=Metrics(latencyMs=round(self.node_timeout * 1000)),
            execution_count=1,
        )

        node.execution_status = Status.FAILED
        node.result = node_result
        node.execution_time = node_result.execution_time
        self.state.failed_nodes.add(node)
        self.state.results[node.node_id] = node_result

        complete_event = MultiAgentNodeStopEvent(
            node_id=node.node_id,
            node_result=node_result,
        )
        await event_queue.put(complete_event)

        return timeout_exception

    def _find_newly_ready_nodes(self, completed_batch: list["GraphNode"]) -> list["GraphNode"]:
        """Find nodes that became ready after the last execution.

        Only evaluates destination nodes of outbound edges from the completed batch,
        instead of iterating over all nodes in the graph.
        """
        # Collect unique candidate nodes reachable from the completed batch
        candidates = {edge.to_node for edge in self.edges if edge.from_node in completed_batch}

        newly_ready = []
        for node in candidates:
            if self._is_node_ready_with_conditions(node, completed_batch):
                newly_ready.append(node)
        return newly_ready

    def _is_node_ready_with_conditions(self, node: GraphNode, completed_batch: list["GraphNode"]) -> bool:
        """Check if a node is ready considering conditional edges."""
        # Get incoming edges to this node
        incoming_edges = [edge for edge in self.edges if edge.to_node == node]

        # Check if at least one incoming edge condition is satisfied
        for edge in incoming_edges:
            if edge.from_node in completed_batch:
                if edge.should_traverse(self.state, invocation_state=self._current_invocation_state):
                    logger.debug(
                        "from=<%s>, to=<%s> | edge ready via satisfied condition", edge.from_node.node_id, node.node_id
                    )
                    return True
                else:
                    logger.debug(
                        "from=<%s>, to=<%s> | edge condition not satisfied", edge.from_node.node_id, node.node_id
                    )
        return False

    async def _execute_node(self, node: GraphNode, invocation_state: dict[str, Any]) -> AsyncIterator[Any]:
        """Execute a single node and yield TypedEvent objects."""
        # Reset the node's state if reset_on_revisit is enabled, and it's being revisited
        if self.reset_on_revisit and node in self.state.completed_nodes:
            logger.debug("node_id=<%s> | resetting node state for revisit", node.node_id)
            node.reset_executor_state()
            self.state.completed_nodes.remove(node)

        node.execution_status = Status.EXECUTING
        logger.debug("node_id=<%s> | executing node", node.node_id)

        # Emit node start event
        node_type = "multiagent" if isinstance(node.executor, MultiAgentBase) else "agent"
        start_event = MultiAgentNodeStartEvent(node_id=node.node_id, node_type=node_type)
        yield start_event

        before_event, interrupts = await self.hooks.invoke_callbacks_async(
            BeforeNodeCallEvent(self, node.node_id, invocation_state)
        )

        start_time = time.time()
        try:
            if interrupts:
                yield self._activate_interrupt(node, interrupts, from_hook=True)
                return

            if before_event.cancel_node:
                cancel_message = (
                    before_event.cancel_node if isinstance(before_event.cancel_node, str) else "node cancelled by user"
                )
                logger.debug("reason=<%s> | cancelling execution", cancel_message)
                yield MultiAgentNodeCancelEvent(node.node_id, cancel_message)
                raise RuntimeError(cancel_message)

            # Build node input from satisfied dependencies
            node_input = self._build_node_input(node)

            # Execute and stream events (timeout handled at task level)
            if isinstance(node.executor, MultiAgentBase):
                # For nested multi-agent systems, stream their events and collect result
                multi_agent_result = None
                async for event in node.executor.stream_async(node_input, invocation_state):
                    # Forward nested multi-agent events with node context
                    wrapped_event = MultiAgentNodeStreamEvent(node.node_id, event)
                    yield wrapped_event
                    # Capture the final result event
                    if "result" in event:
                        multi_agent_result = event["result"]

                # Use the captured result from streaming (no double execution)
                if multi_agent_result is None:
                    raise ValueError(f"Node '{node.node_id}' did not produce a result event")

                node_result = NodeResult(
                    result=multi_agent_result,
                    execution_time=multi_agent_result.execution_time,
                    status=multi_agent_result.status,
                    accumulated_usage=multi_agent_result.accumulated_usage,
                    accumulated_metrics=multi_agent_result.accumulated_metrics,
                    execution_count=multi_agent_result.execution_count,
                    interrupts=multi_agent_result.interrupts,
                )

            elif isinstance(node.executor, AgentBase):
                # For AgentBase implementations (Agent, A2AAgent, etc.), stream events and collect result
                agent_response = None
                async for event in node.executor.stream_async(node_input, invocation_state=invocation_state):
                    # Forward agent events with node context
                    wrapped_event = MultiAgentNodeStreamEvent(node.node_id, event)
                    yield wrapped_event
                    # Capture the final result event
                    if "result" in event:
                        agent_response = event["result"]

                # Use the captured result from streaming (no double execution)
                if agent_response is None:
                    raise ValueError(f"Node '{node.node_id}' did not produce a result event")

                # Extract metrics with defaults
                response_metrics = getattr(agent_response, "metrics", None)
                usage = getattr(
                    response_metrics, "accumulated_usage", Usage(inputTokens=0, outputTokens=0, totalTokens=0)
                )
                metrics = getattr(response_metrics, "accumulated_metrics", Metrics(latencyMs=0))

                # Handle stop_reason and interrupts (use getattr for AgentBase compatibility)
                stop_reason = getattr(agent_response, "stop_reason", "end_turn")
                interrupts = getattr(agent_response, "interrupts", None) or []

                node_result = NodeResult(
                    result=agent_response,
                    execution_time=round((time.time() - start_time) * 1000),
                    status=Status.INTERRUPTED if stop_reason == "interrupt" else Status.COMPLETED,
                    accumulated_usage=usage,
                    accumulated_metrics=metrics,
                    execution_count=1,
                    interrupts=interrupts,
                )
            else:
                raise ValueError(f"Node '{node.node_id}' of type '{type(node.executor)}' is not supported")

            node.result = node_result
            node.execution_time = node_result.execution_time

            if node_result.status == Status.INTERRUPTED:
                yield self._activate_interrupt(node, node_result.interrupts)
                return

            if node_result.status == Status.FAILED:
                node.execution_status = Status.FAILED
                self.state.failed_nodes.add(node)
            else:
                node.execution_status = Status.COMPLETED
                self.state.completed_nodes.add(node)
            self.state.results[node.node_id] = node_result
            self.state.execution_order.append(node)

            # Accumulate metrics
            self._accumulate_metrics(node_result)

            # Emit node stop event with full NodeResult
            complete_event = MultiAgentNodeStopEvent(
                node_id=node.node_id,
                node_result=node_result,
            )
            yield complete_event

            logger.debug(
                "node_id=<%s>, execution_time=<%dms> | node completed successfully",
                node.node_id,
                node.execution_time,
            )

        except Exception as e:
            # All failures (programming errors and execution failures) stop graph execution
            # This matches the old fail-fast behavior
            logger.error("node_id=<%s>, error=<%s> | node failed", node.node_id, e)
            execution_time = round((time.time() - start_time) * 1000)

            # Create a NodeResult for the failed node
            node_result = NodeResult(
                result=e,
                execution_time=execution_time,
                status=Status.FAILED,
                accumulated_usage=Usage(inputTokens=0, outputTokens=0, totalTokens=0),
                accumulated_metrics=Metrics(latencyMs=execution_time),
                execution_count=1,
            )

            node.execution_status = Status.FAILED
            node.result = node_result
            node.execution_time = execution_time
            self.state.failed_nodes.add(node)
            self.state.results[node.node_id] = node_result

            # Emit stop event even for failures
            complete_event = MultiAgentNodeStopEvent(
                node_id=node.node_id,
                node_result=node_result,
            )
            yield complete_event

            # Re-raise to stop graph execution (fail-fast behavior)
            raise

        finally:
            if node.execution_status != Status.INTERRUPTED:
                await self.hooks.invoke_callbacks_async(AfterNodeCallEvent(self, node.node_id, invocation_state))

    def _accumulate_metrics(self, node_result: NodeResult) -> None:
        """Accumulate metrics from a node result."""
        self.state.accumulated_usage["inputTokens"] += node_result.accumulated_usage.get("inputTokens", 0)
        self.state.accumulated_usage["outputTokens"] += node_result.accumulated_usage.get("outputTokens", 0)
        self.state.accumulated_usage["totalTokens"] += node_result.accumulated_usage.get("totalTokens", 0)
        _accumulate_cache_usage(self.state.accumulated_usage, node_result.accumulated_usage)
        self.state.accumulated_metrics["latencyMs"] += node_result.accumulated_metrics.get("latencyMs", 0)
        self.state.execution_count += node_result.execution_count

    def _build_node_input(self, node: GraphNode) -> list[ContentBlock]:
        """Build input text for a node based on dependency outputs.

        If resuming from an interrupt, return user responses.

        Example formatted output:
        ```
        Original Task: Analyze the quarterly sales data and create a summary report

        Inputs from previous nodes:

        From data_processor:
          - Agent: Sales data processed successfully. Found 1,247 transactions totaling $89,432.
          - Agent: Key trends: 15% increase in Q3, top product category is Electronics.

        From validator:
          - Agent: Data validation complete. All records verified, no anomalies detected.
        ```
        """
        if self._interrupt_state.activated:
            context = self._interrupt_state.context
            if node.node_id in context:
                node_context = context[node.node_id]

                # Only route responses if the interrupt originated from the node's execution
                if not node_context["from_hook"]:
                    # Filter responses to only those for this node's interrupts
                    node_responses = [
                        response
                        for response in context["responses"]
                        if response["interruptResponse"]["interruptId"] in node_context["interrupt_ids"]
                    ]

                    # Restore Agent-specific state for interrupt resumption
                    # Only Agent (not generic AgentBase) supports interrupt state restoration
                    if isinstance(node.executor, Agent):
                        node.executor.messages = node_context["messages"]
                        node.executor.state = AgentState(node_context["state"])
                        node.executor._interrupt_state = _InterruptState.from_dict(node_context["interrupt_state"])
                        node.executor._model_state = node_context.get("model_state", {})

                    return node_responses

        # Get satisfied dependencies
        dependency_results = {}
        for edge in self.edges:
            if (
                edge.to_node == node
                and edge.from_node in self.state.completed_nodes
                and edge.from_node.node_id in self.state.results
            ):
                if edge.should_traverse(self.state, invocation_state=self._current_invocation_state):
                    dependency_results[edge.from_node.node_id] = self.state.results[edge.from_node.node_id]

        if not dependency_results:
            # No dependencies - return task as ContentBlocks
            if isinstance(self.state.task, str):
                return [ContentBlock(text=self.state.task)]
            else:
                return cast(list[ContentBlock], self.state.task)

        # Combine task with dependency outputs
        node_input = []

        # Add original task
        if isinstance(self.state.task, str):
            node_input.append(ContentBlock(text=f"Original Task: {self.state.task}"))
        else:
            # Add task content blocks with a prefix
            node_input.append(ContentBlock(text="Original Task:"))
            node_input.extend(cast(list[ContentBlock], self.state.task))

        # Add dependency outputs
        node_input.append(ContentBlock(text="\nInputs from previous nodes:"))

        for dep_id, node_result in dependency_results.items():
            node_input.append(ContentBlock(text=f"\nFrom {dep_id}:"))
            # Get all agent results from this node (flattened if nested)
            agent_results = node_result.get_agent_results()
            for result in agent_results:
                agent_name = getattr(result, "agent_name", "Agent")
                result_text = str(result)
                node_input.append(ContentBlock(text=f"  - {agent_name}: {result_text}"))

        return node_input

    def _build_result(self, interrupts: list[Interrupt]) -> GraphResult:
        """Build graph result from current state.

        Args:
            interrupts: List of interrupts collected during execution.

        Returns:
            GraphResult with current state.
        """
        return GraphResult(
            status=self.state.status,
            results=self.state.results,
            accumulated_usage=self.state.accumulated_usage,
            accumulated_metrics=self.state.accumulated_metrics,
            execution_count=self.state.execution_count,
            execution_time=self._execution_time_with_active_interval(self.state.execution_time),
            total_nodes=self.state.total_nodes,
            completed_nodes=len(self.state.completed_nodes),
            failed_nodes=len(self.state.failed_nodes),
            interrupted_nodes=len(self.state.interrupted_nodes),
            execution_order=self.state.execution_order,
            edges=self.state.edges,
            entry_points=self.state.entry_points,
            interrupts=interrupts,
        )

    def serialize_state(self) -> dict[str, Any]:
        """Serialize the current graph state to a dictionary."""
        compute_nodes = self._compute_ready_nodes_for_resume()
        next_nodes = [n.node_id for n in compute_nodes] if compute_nodes else []
        return {
            "type": "graph",
            "id": self.id,
            "status": self.state.status.value,
            "completed_nodes": [n.node_id for n in self.state.completed_nodes],
            "failed_nodes": [n.node_id for n in self.state.failed_nodes],
            "interrupted_nodes": [n.node_id for n in self.state.interrupted_nodes],
            "node_results": {k: v.to_dict() for k, v in (self.state.results or {}).items()},
            "next_nodes_to_execute": next_nodes,
            "current_task": encode_bytes_values(self.state.task),
            "execution_order": [n.node_id for n in self.state.execution_order],
            "accumulated_usage": self.state.accumulated_usage,
            "accumulated_metrics": self.state.accumulated_metrics,
            "execution_count": self.state.execution_count,
            "execution_time": self._execution_time_with_active_interval(self.state.execution_time),
            "_internal_state": {
                "interrupt_state": self._interrupt_state.to_dict(),
            },
        }

    def deserialize_state(self, payload: dict[str, Any]) -> None:
        """Restore graph state from a session dict and prepare for execution.

        This method handles two scenarios:
        1. If the graph execution ended (no next_nodes_to_execute, eg: Completed, or Failed with dead end nodes),
        resets all nodes and graph state to allow re-execution from the beginning.
        2. If the graph execution was interrupted mid-execution (has next_nodes_to_execute),
           restores the persisted state and prepares to resume execution from the next ready nodes.

        Args:
            payload: Dictionary containing persisted state data including status,
                    completed nodes, results, and next nodes to execute.
        """
        if "_internal_state" in payload:
            internal_state = payload["_internal_state"]
            self._interrupt_state = _InterruptState.from_dict(internal_state["interrupt_state"])

        if not payload.get("next_nodes_to_execute"):
            # Reset all nodes
            for node in self.nodes.values():
                node.reset_executor_state()
            # Reset graph state
            self.state = GraphState()
            self._resume_from_session = False
            return
        else:
            self._from_dict(payload)
            self._resume_from_session = True

    def _compute_ready_nodes_for_resume(self) -> list[GraphNode]:
        if self.state.status == Status.PENDING:
            return []
        ready_nodes: list[GraphNode] = []
        completed_nodes = set(self.state.completed_nodes)
        pending_sources = self._compute_pending_sources(completed_nodes)
        for node in self.nodes.values():
            if node in completed_nodes:
                continue
            incoming = [edge for edge in self.edges if edge.to_node is node]
            if not incoming:
                ready_nodes.append(node)
            elif self._is_node_ready_for_resume(node, incoming, completed_nodes, pending_sources):
                ready_nodes.append(node)

        return ready_nodes

    def _is_edge_traversable(self, edge: GraphEdge) -> bool:
        """Return whether an edge should be followed under the in-memory invocation state.

        Short-circuits unconditional edges to skip the signature inspection and cache lookup
        that ``should_traverse`` performs for context-aware conditions.
        """
        return edge.condition is None or edge.should_traverse(
            self.state, invocation_state=self._current_invocation_state
        )

    def _compute_pending_sources(self, completed_nodes: set[GraphNode]) -> set[GraphNode]:
        """Compute the set of not-yet-completed nodes that will run when execution resumes.

        This is the discriminator between a *live pending parent* and a genuinely *bypassed dead
        branch*, so a fan-in node stays not-ready while any parent that will still produce a result
        is outstanding. It has two seeds:

        - In-flight nodes (``execution_status == EXECUTING``): serialize runs from the per-node
          ``AfterNodeCallEvent`` while sibling nodes in the same parallel batch are still executing.
          Their partial progress is not persisted, so they re-run on resume. This is the
          authoritative in-flight signal, and it catches siblings with no completed ancestor (e.g.
          two concurrent entry points feeding one join) that forward reachability alone would miss.
        - Completed nodes: their traversable outgoing edges lead to nodes that will be scheduled
          next on resume.

        From those seeds the walk follows *traversable* outgoing edges (unconditional, or whose
        condition is True under the in-memory ``_current_invocation_state``) and collects every
        reached not-yet-completed node. A bypassed dead branch is never reached because the only
        edge into it has a condition that evaluates to False, so the traversal never crosses it.

        The traversal is transitive so a deep pending chain (e.g. ``root -> mid -> right -> join``
        with ``mid`` still executing) marks every node below the frontier as pending, not just the
        immediate children. A ``visited`` set makes it terminate on cyclic graphs.

        Args:
            completed_nodes: Nodes that have already completed execution.

        Returns:
            The set of not-yet-completed nodes that will execute on resume — in-flight nodes plus
            everything reachable from the completed or in-flight frontier via traversable edges.
        """
        executing_nodes = {node for node in self.nodes.values() if node.execution_status == Status.EXECUTING}
        pending: set[GraphNode] = set(executing_nodes)
        visited = completed_nodes | executing_nodes
        frontier = list(visited)
        while frontier:
            source = frontier.pop()
            for edge in self.edges:
                if edge.from_node is not source:
                    continue
                target = edge.to_node
                # A visited target is already decided; skip before evaluating the (user-supplied)
                # condition so it is not re-invoked for edges into the completed/in-flight region.
                if target in visited or not self._is_edge_traversable(edge):
                    continue
                visited.add(target)
                pending.add(target)
                frontier.append(target)
        return pending

    def _is_node_ready_for_resume(
        self,
        node: GraphNode,
        incoming: list[GraphEdge],
        completed_nodes: set[GraphNode],
        pending_sources: set[GraphNode],
    ) -> bool:
        """Check if a node is ready for resume, accounting for conditional edges.

        A node is ready if all TRAVERSABLE incoming edges from *live* sources have their
        source completed. Edges whose condition evaluates to False are excluded (paths
        intentionally not taken). Edges whose source is a *bypassed dead branch* — never
        scheduled and outside the resume frontier — are also excluded, as they will never fire.

        A source is *live* if it is touched (completed, interrupted, or failed) or *pending*
        (in ``pending_sources``: a not-yet-completed node that will still run on resume — see
        ``_compute_pending_sources``). Keeping edges from pending sources in the AND-join is what
        distinguishes an in-flight parallel sibling from a bypassed dead branch: a fan-in node
        whose sibling parent is still executing at serialize time stays not-ready, so resume runs
        the fan-in exactly once with all inputs present rather than off its already-completed
        parent alone.

        Note: this method is called at serialize time (before persisting) using the
        invocation_state that is in memory at that moment. The resulting node IDs are
        stored as ``next_nodes_to_execute`` and loaded directly on resume — so the
        initial resume batch reflects serialize-time state. Subsequent routing decisions
        (after those initial nodes complete) re-evaluate conditions with whatever
        invocation_state the caller passes on the resume invocation.

        Uses AND-join semantics for edges from live sources (all must have completed
        sources), preserving the original behavior for parallel fan-in patterns.

        Args:
            node: The candidate node to evaluate.
            incoming: The node's incoming edges.
            completed_nodes: Nodes that have already completed execution.
            pending_sources: Not-yet-completed nodes that will still run on resume (see
                ``_compute_pending_sources``).
        """
        traversable_edges = [edge for edge in incoming if self._is_edge_traversable(edge)]

        if not traversable_edges:
            return False

        # Keep edges from live sources — touched nodes (completed, interrupted, failed) plus
        # pending nodes that will run on resume. Edges from bypassed dead branches (untouched
        # and unreachable from any completed node) are dropped, since they will never fire.
        live_sources = completed_nodes | self.state.interrupted_nodes | self.state.failed_nodes | pending_sources
        relevant_edges = [edge for edge in traversable_edges if edge.from_node in live_sources]

        # If no relevant edges remain (all sources are bypassed), the node
        # is not ready — it has no valid path from executed nodes.
        if not relevant_edges:
            return False

        return all(edge.from_node in completed_nodes for edge in relevant_edges)

    def _from_dict(self, payload: dict[str, Any]) -> None:
        self.state.status = Status(payload["status"])
        # Hydrate completed nodes & results
        raw_results = payload.get("node_results") or {}
        results: dict[str, NodeResult] = {}
        for node_id, entry in raw_results.items():
            if node_id not in self.nodes:
                continue
            try:
                results[node_id] = NodeResult.from_dict(entry)
            except Exception:
                logger.exception("Failed to hydrate NodeResult for node_id=%s; skipping.", node_id)
                raise
        self.state.results = results

        self.state.failed_nodes = set(
            self.nodes[node_id] for node_id in (payload.get("failed_nodes") or []) if node_id in self.nodes
        )
        for node in self.state.failed_nodes:
            node.execution_status = Status.FAILED

        self.state.interrupted_nodes = set(
            self.nodes[node_id] for node_id in (payload.get("interrupted_nodes") or []) if node_id in self.nodes
        )
        for node in self.state.interrupted_nodes:
            node.execution_status = Status.INTERRUPTED

        self.state.completed_nodes = set(
            self.nodes[node_id] for node_id in (payload.get("completed_nodes") or []) if node_id in self.nodes
        )
        for node in self.state.completed_nodes:
            node.execution_status = Status.COMPLETED

        # Execution order (only nodes that still exist)
        order_node_ids = payload.get("execution_order") or []
        self.state.execution_order = [self.nodes[node_id] for node_id in order_node_ids if node_id in self.nodes]

        # Task
        self.state.task = decode_bytes_values(payload.get("current_task", self.state.task))

        # Cumulative accounting: restore so the timeout budget (should_continue) and the reported
        # totals stay correct across a resume, rather than resetting to zero.
        self.state.accumulated_usage = _parse_usage(payload.get("accumulated_usage") or {})
        self.state.accumulated_metrics = _parse_metrics(payload.get("accumulated_metrics") or {})
        self.state.execution_count = int(payload.get("execution_count") or 0)
        self.state.execution_time = int(payload.get("execution_time") or 0)

        # next nodes to execute
        next_nodes = [self.nodes[nid] for nid in (payload.get("next_nodes_to_execute") or []) if nid in self.nodes]
        self._resume_next_nodes = next_nodes
