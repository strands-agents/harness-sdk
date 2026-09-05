import asyncio
import time
from unittest.mock import ANY, AsyncMock, MagicMock, Mock, call, patch

import pytest

from strands.agent import Agent, AgentBase, AgentResult
from strands.agent.state import AgentState
from strands.hooks import AfterNodeCallEvent, AgentInitializedEvent, BeforeNodeCallEvent
from strands.hooks.registry import HookProvider, HookRegistry
from strands.interrupt import Interrupt, _InterruptState
from strands.multiagent.base import MultiAgentBase, MultiAgentResult, NodeResult
from strands.multiagent.graph import Graph, GraphBuilder, GraphEdge, GraphNode, GraphResult, GraphState, Status
from strands.session.file_session_manager import FileSessionManager
from strands.session.session_manager import SessionManager
from strands.types._events import MultiAgentNodeCancelEvent


def _make_graph(
    nodes: dict,
    edges=None,
    state=None,
    invocation_state=None,
    interrupt_state=None,
) -> Graph:
    """Create a minimally-valid Graph instance for unit tests without invoking __init__."""
    graph = Graph.__new__(Graph)
    graph.nodes = nodes
    graph.edges = edges if edges is not None else set()
    graph.state = state or GraphState()
    graph._current_invocation_state = invocation_state or {}
    graph._interrupt_state = interrupt_state or _InterruptState()
    graph._resume_from_session = False
    graph._resume_next_nodes = []
    graph.max_concurrency = None
    graph.id = "test_graph"
    return graph


def create_mock_agent(name, response_text="Default response", metrics=None, agent_id=None):
    """Create a mock Agent with specified properties."""
    agent = Mock(spec=Agent)
    agent.name = name
    agent.id = agent_id or f"{name}_id"
    agent._session_manager = None
    agent.hooks = HookRegistry()
    agent.state = AgentState()
    agent.messages = []
    agent._interrupt_state = _InterruptState()
    agent._model_state = {}

    if metrics is None:
        metrics = Mock(
            accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
            accumulated_metrics={"latencyMs": 100.0},
        )

    mock_result = AgentResult(
        message={"role": "assistant", "content": [{"text": response_text}]},
        stop_reason="end_turn",
        state={},
        metrics=metrics,
    )

    agent.return_value = mock_result
    agent.__call__ = Mock(return_value=mock_result)

    async def mock_invoke_async(*args, **kwargs):
        return mock_result

    async def mock_stream_async(*args, **kwargs):
        # Simple mock stream that yields a start event and then the result
        yield {"agent_start": True}
        yield {"result": mock_result}

    agent.invoke_async = MagicMock(side_effect=mock_invoke_async)
    agent.stream_async = Mock(side_effect=mock_stream_async)

    return agent


def create_mock_multi_agent(name, response_text="Multi-agent response"):
    """Create a mock MultiAgentBase with specified properties."""
    multi_agent = Mock(spec=MultiAgentBase)
    multi_agent.name = name
    multi_agent.id = f"{name}_id"

    mock_node_result = NodeResult(
        result=AgentResult(
            message={"role": "assistant", "content": [{"text": response_text}]},
            stop_reason="end_turn",
            state={},
            metrics={},
        )
    )
    mock_result = MultiAgentResult(
        results={"inner_node": mock_node_result},
        accumulated_usage={"inputTokens": 15, "outputTokens": 25, "totalTokens": 40},
        accumulated_metrics={"latencyMs": 150.0},
        execution_count=1,
        execution_time=150,
    )

    async def mock_multi_stream_async(*args, **kwargs):
        # Simple mock stream that yields a start event and then the result
        yield {"multi_agent_start": True}
        yield {"result": mock_result}

    multi_agent.invoke_async = AsyncMock(return_value=mock_result)
    multi_agent.stream_async = Mock(side_effect=mock_multi_stream_async)
    multi_agent.execute = Mock(return_value=mock_result)
    return multi_agent


@pytest.fixture
def mock_agents():
    """Create a set of diverse mock agents for testing."""
    return {
        "start_agent": create_mock_agent("start_agent", "Start response"),
        "multi_agent": create_mock_multi_agent("multi_agent", "Multi response"),
        "conditional_agent": create_mock_agent(
            "conditional_agent",
            "Conditional response",
            Mock(
                accumulated_usage={"inputTokens": 5, "outputTokens": 15, "totalTokens": 20},
                accumulated_metrics={"latencyMs": 75.0},
            ),
        ),
        "final_agent": create_mock_agent(
            "final_agent",
            "Final response",
            Mock(
                accumulated_usage={"inputTokens": 8, "outputTokens": 12, "totalTokens": 20},
                accumulated_metrics={"latencyMs": 50.0},
            ),
        ),
        "no_metrics_agent": create_mock_agent("no_metrics_agent", "No metrics response", metrics=None),
        "partial_metrics_agent": create_mock_agent(
            "partial_metrics_agent", "Partial metrics response", Mock(accumulated_usage={}, accumulated_metrics={})
        ),
        "blocked_agent": create_mock_agent("blocked_agent", "Should not execute"),
    }


@pytest.fixture
def string_content_agent():
    """Create an agent with string content (not list) for coverage testing."""
    agent = create_mock_agent("string_content_agent", "String content")
    agent.return_value.message = {"role": "assistant", "content": "string_content"}
    return agent


@pytest.fixture
def mock_strands_tracer():
    with patch("strands.multiagent.graph.get_tracer") as mock_get_tracer:
        mock_tracer_instance = MagicMock()
        mock_span = MagicMock()
        mock_tracer_instance.start_multiagent_span.return_value = mock_span
        mock_get_tracer.return_value = mock_tracer_instance
        yield mock_tracer_instance


@pytest.fixture
def mock_use_span():
    with patch("strands.multiagent.graph.trace_api.use_span") as mock_use_span:
        yield mock_use_span


@pytest.fixture
def mock_graph(mock_agents, string_content_agent):
    """Create a graph for testing various scenarios."""

    def condition_check_completion(state: GraphState) -> bool:
        return any(node.node_id == "start_agent" for node in state.completed_nodes)

    def always_false_condition(state: GraphState) -> bool:
        return False

    builder = GraphBuilder()

    # Add nodes
    builder.add_node(mock_agents["start_agent"], "start_agent")
    builder.add_node(mock_agents["multi_agent"], "multi_node")
    builder.add_node(mock_agents["conditional_agent"], "conditional_agent")
    final_agent_graph_node = builder.add_node(mock_agents["final_agent"], "final_node")
    builder.add_node(mock_agents["no_metrics_agent"], "no_metrics_node")
    builder.add_node(mock_agents["partial_metrics_agent"], "partial_metrics_node")
    builder.add_node(string_content_agent, "string_content_node")
    builder.add_node(mock_agents["blocked_agent"], "blocked_node")

    # Add edges
    builder.add_edge("start_agent", "multi_node")
    builder.add_edge("start_agent", "conditional_agent", condition=condition_check_completion)
    builder.add_edge("multi_node", "final_node")
    builder.add_edge("conditional_agent", final_agent_graph_node)
    builder.add_edge("start_agent", "no_metrics_node")
    builder.add_edge("start_agent", "partial_metrics_node")
    builder.add_edge("start_agent", "string_content_node")
    builder.add_edge("start_agent", "blocked_node", condition=always_false_condition)

    builder.set_entry_point("start_agent")
    return builder.build()


@pytest.mark.asyncio
async def test_graph_execution(mock_strands_tracer, mock_use_span, mock_graph, mock_agents, string_content_agent):
    """Test comprehensive graph execution with diverse nodes and conditional edges."""

    # Test graph structure
    assert len(mock_graph.nodes) == 8
    assert len(mock_graph.edges) == 8
    assert len(mock_graph.entry_points) == 1
    assert any(node.node_id == "start_agent" for node in mock_graph.entry_points)

    # Test node properties
    start_node = mock_graph.nodes["start_agent"]
    assert start_node.node_id == "start_agent"
    assert start_node.executor == mock_agents["start_agent"]
    assert start_node.execution_status == Status.PENDING
    assert len(start_node.dependencies) == 0

    # Test conditional edge evaluation
    conditional_edge = next(
        edge
        for edge in mock_graph.edges
        if edge.from_node.node_id == "start_agent" and edge.to_node.node_id == "conditional_agent"
    )
    assert conditional_edge.condition is not None
    assert not conditional_edge.should_traverse(GraphState(), invocation_state={})

    # Create a mock GraphNode for testing
    start_node = mock_graph.nodes["start_agent"]
    assert conditional_edge.should_traverse(GraphState(completed_nodes={start_node}), invocation_state={})

    result = await mock_graph.invoke_async("Test comprehensive execution")

    # Verify execution results
    assert result.status == Status.COMPLETED
    assert result.total_nodes == 8
    assert result.completed_nodes == 7  # All except blocked_node
    assert result.failed_nodes == 0
    assert len(result.execution_order) == 7
    assert result.execution_order[0].node_id == "start_agent"

    # Verify agent calls (now using stream_async internally)
    assert mock_agents["start_agent"].stream_async.call_count == 1
    assert mock_agents["multi_agent"].stream_async.call_count == 1
    assert mock_agents["conditional_agent"].stream_async.call_count == 1
    assert mock_agents["final_agent"].stream_async.call_count == 1
    assert mock_agents["no_metrics_agent"].stream_async.call_count == 1
    assert mock_agents["partial_metrics_agent"].stream_async.call_count == 1
    assert string_content_agent.stream_async.call_count == 1
    assert mock_agents["blocked_agent"].stream_async.call_count == 0

    # Verify metrics aggregation
    assert result.accumulated_usage["totalTokens"] > 0
    assert result.accumulated_metrics["latencyMs"] > 0
    assert result.execution_count >= 7

    # Verify node results
    assert len(result.results) == 7
    assert "blocked_node" not in result.results

    # Test result content extraction
    start_result = result.results["start_agent"]
    assert start_result.status == Status.COMPLETED
    agent_results = start_result.get_agent_results()
    assert len(agent_results) == 1
    assert "Start response" in str(agent_results[0].message)

    # Verify final graph state
    assert mock_graph.state.status == Status.COMPLETED
    assert len(mock_graph.state.completed_nodes) == 7
    assert len(mock_graph.state.failed_nodes) == 0

    # Test GraphResult properties
    assert isinstance(result, GraphResult)
    assert isinstance(result, MultiAgentResult)
    assert len(result.edges) == 8
    assert len(result.entry_points) == 1
    assert result.entry_points[0].node_id == "start_agent"

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_graph_unsupported_node_type(mock_strands_tracer, mock_use_span):
    """Test unsupported executor type error handling."""

    class UnsupportedExecutor:
        pass

    builder = GraphBuilder()
    builder.add_node(UnsupportedExecutor(), "unsupported_node")
    graph = builder.build()

    # Execute the graph - should raise ValueError due to unsupported node type
    with pytest.raises(ValueError, match="Node 'unsupported_node' of type .* is not supported"):
        await graph.invoke_async("test task")

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_graph_execution_with_failures(mock_strands_tracer, mock_use_span):
    """Test graph execution error handling and failure propagation."""
    failing_agent = Mock(spec=Agent)
    failing_agent.name = "failing_agent"
    failing_agent.id = "fail_node"
    failing_agent.__call__ = Mock(side_effect=Exception("Simulated failure"))

    # Add required attributes for validation
    failing_agent._session_manager = None
    failing_agent.hooks = HookRegistry()

    async def mock_invoke_failure(*args, **kwargs):
        raise Exception("Simulated failure")

    async def mock_stream_failure(*args, **kwargs):
        # Simple mock stream that fails
        yield {"agent_start": True}
        raise Exception("Simulated failure")

    failing_agent.invoke_async = mock_invoke_failure
    failing_agent.stream_async = Mock(side_effect=mock_stream_failure)

    success_agent = create_mock_agent("success_agent", "Success")

    builder = GraphBuilder()
    builder.add_node(failing_agent, "fail_node")
    builder.add_node(success_agent, "success_node")
    builder.add_edge("fail_node", "success_node")
    builder.set_entry_point("fail_node")

    graph = builder.build()

    # Execute the graph - should raise exception (fail-fast behavior)
    with pytest.raises(Exception, match="Simulated failure"):
        await graph.invoke_async("Test error handling")

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_graph_edge_cases(mock_strands_tracer, mock_use_span):
    """Test specific edge cases for coverage."""
    # Test entry node execution without dependencies
    entry_agent = create_mock_agent("entry_agent", "Entry response")

    builder = GraphBuilder()
    builder.add_node(entry_agent, "entry_only")
    graph = builder.build()

    result = await graph.invoke_async([{"text": "Original task"}])

    # Verify entry node was called with original task (via stream_async)
    assert entry_agent.stream_async.call_count == 1
    assert result.status == Status.COMPLETED
    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_cyclic_graph_execution(mock_strands_tracer, mock_use_span):
    """Test execution of a graph with cycles and proper exit conditions."""
    # Create mock agents with state tracking
    agent_a = create_mock_agent("agent_a", "Agent A response")
    agent_b = create_mock_agent("agent_b", "Agent B response")
    agent_c = create_mock_agent("agent_c", "Agent C response")

    # Add state to agents to track execution
    agent_a.state = AgentState()
    agent_b.state = AgentState()
    agent_c.state = AgentState()

    # Create a spy to track reset calls
    reset_spy = MagicMock()

    # Create conditions for controlled cycling
    def a_to_b_condition(state: GraphState) -> bool:
        # A can trigger B if B hasn't been executed yet
        b_count = sum(1 for node in state.execution_order if node.node_id == "b")
        return b_count == 0

    def b_to_c_condition(state: GraphState) -> bool:
        # B can always trigger C (unconditional)
        return True

    def c_to_a_condition(state: GraphState) -> bool:
        # C can trigger A only if A has been executed less than 2 times
        a_count = sum(1 for node in state.execution_order if node.node_id == "a")
        return a_count < 2

    # Create a graph with conditional cycle: A -> B -> C -> A (with conditions)
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    builder.add_edge("a", "b", condition=a_to_b_condition)  # A -> B only if B not executed
    builder.add_edge("b", "c", condition=b_to_c_condition)  # B -> C always
    builder.add_edge("c", "a", condition=c_to_a_condition)  # C -> A only if A executed < 2 times
    builder.set_entry_point("a")
    builder.reset_on_revisit(True)  # Enable state reset on revisit
    builder.set_max_node_executions(10)  # Safety limit
    builder.set_execution_timeout(30.0)  # Safety timeout

    # Patch the reset_executor_state method to track calls
    original_reset = GraphNode.reset_executor_state

    def spy_reset(self):
        reset_spy(self.node_id)
        original_reset(self)

    with patch.object(GraphNode, "reset_executor_state", spy_reset):
        graph = builder.build()

        # Execute the graph with controlled cycling
        result = await graph.invoke_async("Test cyclic graph execution")

        # Verify that the graph executed successfully
        assert result.status == Status.COMPLETED

        # Expected execution order: a -> b -> c -> a (4 total executions)
        # A executes twice (initial + after c), B executes once, C executes once
        assert len(result.execution_order) == 4

        # Verify execution order
        execution_ids = [node.node_id for node in result.execution_order]
        assert execution_ids == ["a", "b", "c", "a"]

        # Verify that each agent was called the expected number of times (via stream_async)
        assert agent_a.stream_async.call_count == 2  # A executes twice
        assert agent_b.stream_async.call_count == 1  # B executes once
        assert agent_c.stream_async.call_count == 1  # C executes once

        # Verify that node state was reset for the revisited node (A)
        assert reset_spy.call_args_list == [call("a")]  # Only A should be reset (when revisited)

        # Verify all nodes were completed (final state)
        assert result.completed_nodes == 3


def test_graph_builder_validation():
    """Test GraphBuilder validation and error handling."""
    # Test empty graph validation
    builder = GraphBuilder()
    with pytest.raises(ValueError, match="Graph must contain at least one node"):
        builder.build()

    # Test duplicate node IDs
    agent1 = create_mock_agent("agent1")
    agent2 = create_mock_agent("agent2")
    builder.add_node(agent1, "duplicate_id")
    with pytest.raises(ValueError, match="Node 'duplicate_id' already exists"):
        builder.add_node(agent2, "duplicate_id")

    # Test duplicate node instances in GraphBuilder.add_node
    builder = GraphBuilder()
    same_agent = create_mock_agent("same_agent")
    builder.add_node(same_agent, "node1")
    with pytest.raises(ValueError, match="Duplicate node instance detected"):
        builder.add_node(same_agent, "node2")  # Same agent instance, different node_id

    # Test duplicate node instances in Graph.__init__
    duplicate_agent = create_mock_agent("duplicate_agent")
    node1 = GraphNode("node1", duplicate_agent)
    node2 = GraphNode("node2", duplicate_agent)  # Same agent instance
    nodes = {"node1": node1, "node2": node2}
    with pytest.raises(ValueError, match="Duplicate node instance detected"):
        Graph(
            nodes=nodes,
            edges=set(),
            entry_points=set(),
        )

    # Test edge validation with non-existent nodes
    builder = GraphBuilder()
    builder.add_node(agent1, "node1")
    with pytest.raises(ValueError, match="Target node 'nonexistent' not found"):
        builder.add_edge("node1", "nonexistent")
    with pytest.raises(ValueError, match="Source node 'nonexistent' not found"):
        builder.add_edge("nonexistent", "node1")

    # Test edge validation with node object not added to graph
    builder = GraphBuilder()
    builder.add_node(agent1, "node1")
    orphan_node = GraphNode("orphan", agent2)
    with pytest.raises(ValueError, match="Source node object has not been added to the graph"):
        builder.add_edge(orphan_node, "node1")
    with pytest.raises(ValueError, match="Target node object has not been added to the graph"):
        builder.add_edge("node1", orphan_node)

    # Test invalid entry point
    with pytest.raises(ValueError, match="Node 'invalid_entry' not found"):
        builder.set_entry_point("invalid_entry")

    # Test multiple invalid entry points in build validation
    builder = GraphBuilder()
    builder.add_node(agent1, "valid_node")
    # Create mock GraphNode objects for invalid entry points
    invalid_node1 = GraphNode("invalid1", agent1)
    invalid_node2 = GraphNode("invalid2", agent2)
    builder.entry_points.add(invalid_node1)
    builder.entry_points.add(invalid_node2)
    with pytest.raises(ValueError, match="Entry points not found in nodes"):
        builder.build()

    # Test cycle detection (should be forbidden by default)
    builder = GraphBuilder()
    builder.add_node(agent1, "a")
    builder.add_node(agent2, "b")
    builder.add_node(create_mock_agent("agent3"), "c")
    builder.add_edge("a", "b")
    builder.add_edge("b", "c")
    builder.add_edge("c", "a")  # Creates cycle
    builder.set_entry_point("a")

    # Should succeed - cycles are now allowed by default
    graph = builder.build()
    assert any(node.node_id == "a" for node in graph.entry_points)

    # Test auto-detection of entry points
    builder = GraphBuilder()
    builder.add_node(agent1, "entry")
    builder.add_node(agent2, "dependent")
    builder.add_edge("entry", "dependent")

    graph = builder.build()
    assert any(node.node_id == "entry" for node in graph.entry_points)

    # Test no entry points scenario
    builder = GraphBuilder()
    builder.add_node(agent1, "a")
    builder.add_node(agent2, "b")
    builder.add_edge("a", "b")
    builder.add_edge("b", "a")

    with pytest.raises(ValueError, match="No entry points found - all nodes have dependencies"):
        builder.build()

    # Test custom execution limits and reset_on_revisit
    builder = GraphBuilder()
    builder.add_node(agent1, "test_node")
    graph = (
        builder.set_max_node_executions(10)
        .set_execution_timeout(300.0)
        .set_node_timeout(60.0)
        .reset_on_revisit()
        .build()
    )
    assert graph.max_node_executions == 10
    assert graph.max_concurrency is None
    assert graph.execution_timeout == 300.0
    assert graph.node_timeout == 60.0
    assert graph.reset_on_revisit is True

    # Test default execution limits and reset_on_revisit (None and False)
    builder = GraphBuilder()
    builder.add_node(agent1, "test_node")
    graph = builder.build()
    assert graph.max_node_executions is None
    assert graph.max_concurrency is None
    assert graph.execution_timeout is None
    assert graph.node_timeout is None
    assert graph.reset_on_revisit is False


@pytest.mark.parametrize("invalid_max_concurrency", [0, -1, 1.5, True])
def test_graph_max_concurrency_validation(invalid_max_concurrency):
    """Test max concurrency validation on the builder and graph constructor."""
    exp_message = rf"max_concurrency=<{invalid_max_concurrency!r}> \| must be a positive integer"

    with pytest.raises(ValueError, match=exp_message):
        GraphBuilder().set_max_concurrency(invalid_max_concurrency)

    with pytest.raises(ValueError, match=exp_message):
        Graph(nodes={}, edges=set(), entry_points=set(), max_concurrency=invalid_max_concurrency)


def test_graph_builder_max_concurrency_none_clears_limit():
    """Test that None restores unlimited concurrency on the builder."""
    builder = GraphBuilder().set_max_concurrency(1).set_max_concurrency(None)
    builder.add_node(create_mock_agent("agent"), "agent")

    tru_max_concurrency = builder.build().max_concurrency
    exp_max_concurrency = None

    assert tru_max_concurrency is exp_max_concurrency


@pytest.mark.asyncio
async def test_graph_execution_limits(mock_strands_tracer, mock_use_span):
    """Test graph execution limits (max_node_executions and execution_timeout)."""
    # Test with a simple linear graph first to verify limits work
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")
    agent_c = create_mock_agent("agent_c", "Response C")

    # Create a linear graph: a -> b -> c
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    builder.add_edge("a", "b")
    builder.add_edge("b", "c")
    builder.set_entry_point("a")

    # Test with no limits (backward compatibility) - should complete normally
    graph = builder.build()  # No limits specified
    result = await graph.invoke_async("Test execution")
    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 3  # All 3 nodes should execute

    # Test with limit that allows completion
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    builder.add_edge("a", "b")
    builder.add_edge("b", "c")
    builder.set_entry_point("a")
    graph = builder.set_max_node_executions(5).set_execution_timeout(900.0).set_node_timeout(300.0).build()
    result = await graph.invoke_async("Test execution")
    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 3  # All 3 nodes should execute

    # Test with limit that prevents full completion
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    builder.add_edge("a", "b")
    builder.add_edge("b", "c")
    builder.set_entry_point("a")
    graph = builder.set_max_node_executions(2).set_execution_timeout(900.0).set_node_timeout(300.0).build()
    result = await graph.invoke_async("Test execution limit")
    assert result.status == Status.FAILED  # Should fail due to limit
    assert len(result.execution_order) == 2  # Should stop at 2 executions


@pytest.mark.asyncio
async def test_graph_execution_limits_with_cyclic_graph(mock_strands_tracer, mock_use_span):
    timeout_agent_a = create_mock_agent("timeout_agent_a", "Response A")
    timeout_agent_b = create_mock_agent("timeout_agent_b", "Response B")

    # Create a cyclic graph that would run indefinitely
    builder = GraphBuilder()
    builder.add_node(timeout_agent_a, "a")
    builder.add_node(timeout_agent_b, "b")
    builder.add_edge("a", "b")
    builder.add_edge("b", "a")  # Creates cycle
    builder.set_entry_point("a")

    # Enable reset_on_revisit so the cycle can continue
    graph = builder.reset_on_revisit(True).set_execution_timeout(5.0).set_max_node_executions(100).build()

    # Execute the cyclic graph - should hit one of the limits
    result = await graph.invoke_async("Test execution limits")

    # Should fail due to hitting a limit (either timeout or max executions)
    assert result.status == Status.FAILED
    # Should have executed many nodes (hitting the limit)
    assert len(result.execution_order) >= 50  # Should execute many times before hitting limit

    # Test timeout logic directly (without execution)
    test_state = GraphState()
    test_state.start_time = time.time() - 10  # Set start time to 10 seconds ago
    should_continue, reason = test_state.should_continue(max_node_executions=100, execution_timeout=5.0)
    assert should_continue is False
    assert "Execution timed out" in reason

    # Test max executions logic directly (without execution)
    test_state2 = GraphState()
    test_state2.execution_order = [None] * 101  # Simulate 101 executions
    should_continue2, reason2 = test_state2.should_continue(max_node_executions=100, execution_timeout=5.0)
    assert should_continue2 is False
    assert "Max node executions reached" in reason2

    # builder = GraphBuilder()
    # builder.add_node(slow_agent, "slow")
    # graph = (builder.set_max_node_executions(1000)  # High limit to avoid hitting this
    #          .set_execution_timeout(0.05)  # Very short execution timeout
    #          .set_node_timeout(300.0)
    #          .build())

    # result = await graph.invoke_async("Test timeout")
    # assert result.status == Status.FAILED  # Should fail due to timeout

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called()


@pytest.mark.asyncio
async def test_graph_node_timeout(mock_strands_tracer, mock_use_span):
    """Test individual node timeout functionality."""

    # Create a mock agent that takes longer than the node timeout
    timeout_agent = create_mock_agent("timeout_agent", "Should timeout")

    async def timeout_invoke(*args, **kwargs):
        await asyncio.sleep(0.2)  # Longer than node timeout
        return timeout_agent.return_value

    async def timeout_stream(*args, **kwargs):
        yield {"agent_start": True}
        await asyncio.sleep(0.2)  # Longer than node timeout
        yield {"result": timeout_agent.return_value}

    timeout_agent.invoke_async = AsyncMock(side_effect=timeout_invoke)
    timeout_agent.stream_async = Mock(side_effect=timeout_stream)

    builder = GraphBuilder()
    builder.add_node(timeout_agent, "timeout_node")

    # Test with no timeout (backward compatibility) - should complete normally
    graph = builder.build()  # No timeout specified
    result = await graph.invoke_async("Test no timeout")
    assert result.status == Status.COMPLETED
    assert result.completed_nodes == 1

    # Test with very short node timeout - should raise timeout exception (fail-fast behavior)
    builder = GraphBuilder()
    builder.add_node(timeout_agent, "timeout_node")
    graph = builder.set_max_node_executions(50).set_execution_timeout(900.0).set_node_timeout(0.1).build()

    # Execute the graph - should raise timeout exception (fail-fast behavior)
    with pytest.raises(Exception, match="execution timed out"):
        await graph.invoke_async("Test node timeout")

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called()


@pytest.mark.asyncio
async def test_backward_compatibility_no_limits():
    """Test that graphs with no limits specified work exactly as before."""
    # Create simple agents
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")

    # Create a simple linear graph
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")

    # Build without specifying any limits - should work exactly as before
    graph = builder.build()

    # Verify the limits are None (no limits)
    assert graph.max_node_executions is None
    assert graph.execution_timeout is None
    assert graph.node_timeout is None

    # Execute the graph - should complete normally
    result = await graph.invoke_async("Test backward compatibility")
    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 2  # Both nodes should execute


@pytest.mark.asyncio
async def test_node_reset_executor_state():
    """Test that GraphNode.reset_executor_state properly resets node state."""
    # Create a mock agent with state
    agent = create_mock_agent("test_agent", "Test response")
    agent.state = AgentState()
    agent.state.set("test_key", "test_value")
    agent.messages = [{"role": "system", "content": "Initial system message"}]

    # Create a GraphNode with this agent
    node = GraphNode("test_node", agent)

    # Verify initial state is captured during initialization
    assert len(node._initial_messages) == 1
    assert node._initial_messages[0]["role"] == "system"
    assert node._initial_messages[0]["content"] == "Initial system message"

    # Modify agent state and messages after initialization
    agent.state.set("new_key", "new_value")
    agent.messages.append({"role": "user", "content": "New message"})

    # Also modify execution status and result
    node.execution_status = Status.COMPLETED
    node.result = NodeResult(
        result="test result",
        execution_time=100,
        status=Status.COMPLETED,
        accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
        accumulated_metrics={"latencyMs": 100},
        execution_count=1,
    )

    # Verify state was modified
    assert len(agent.messages) == 2
    assert agent.state.get("new_key") == "new_value"
    assert node.execution_status == Status.COMPLETED
    assert node.result is not None

    # Reset the executor state
    node.reset_executor_state()

    # Verify messages were reset to initial values
    assert len(agent.messages) == 1
    assert agent.messages[0]["role"] == "system"
    assert agent.messages[0]["content"] == "Initial system message"

    # Verify agent state was reset
    # The test_key should be gone since it wasn't in the initial state
    assert agent.state.get("new_key") is None

    # Verify execution status is reset
    assert node.execution_status == Status.PENDING
    assert node.result is None

    # Test with MultiAgentBase executor
    multi_agent = create_mock_multi_agent("multi_agent")
    multi_agent_node = GraphNode("multi_node", multi_agent)

    # Since MultiAgentBase doesn't have messages or state attributes,
    # reset_executor_state should not fail
    multi_agent_node.execution_status = Status.COMPLETED
    multi_agent_node.result = NodeResult(
        result="test result",
        execution_time=100,
        status=Status.COMPLETED,
        accumulated_usage={},
        accumulated_metrics={},
        execution_count=1,
    )

    # Reset should work without errors
    multi_agent_node.reset_executor_state()

    # Verify execution status is reset
    assert multi_agent_node.execution_status == Status.PENDING
    assert multi_agent_node.result is None


def test_accumulate_metrics_sums_cache_token_counters():
    """Cache token counters are summed across nodes, not dropped (#797).

    Each node's usage is a disjoint Bedrock-style payload where
    totalTokens = inputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens,
    so the aggregated totals must reconcile once the cache counters are accumulated too.
    """
    graph = _make_graph(nodes={})
    result_text = AgentResult(
        message={"role": "assistant", "content": [{"text": "ok"}]}, stop_reason="end_turn", state={}, metrics={}
    )
    node_results = [
        NodeResult(
            result=result_text,
            accumulated_usage={
                "inputTokens": 10,
                "outputTokens": 20,
                "totalTokens": 38,
                "cacheReadInputTokens": 5,
                "cacheWriteInputTokens": 3,
            },
            execution_count=1,
        ),
        NodeResult(
            result=result_text,
            accumulated_usage={
                "inputTokens": 15,
                "outputTokens": 25,
                "totalTokens": 51,
                "cacheReadInputTokens": 7,
                "cacheWriteInputTokens": 4,
            },
            execution_count=1,
        ),
    ]

    for node_result in node_results:
        graph._accumulate_metrics(node_result)

    tru_usage = graph.state.accumulated_usage
    exp_usage = {
        "inputTokens": 25,
        "outputTokens": 45,
        "totalTokens": 89,
        "cacheReadInputTokens": 12,
        "cacheWriteInputTokens": 7,
    }
    assert tru_usage == exp_usage
    assert (
        tru_usage["inputTokens"]
        + tru_usage["outputTokens"]
        + tru_usage["cacheReadInputTokens"]
        + tru_usage["cacheWriteInputTokens"]
        == tru_usage["totalTokens"]
    )


def test_accumulate_metrics_without_cache_counters_omits_them():
    """Nodes without cache counters must not materialize cache keys as 0 (#797)."""
    graph = _make_graph(nodes={})
    result_text = AgentResult(
        message={"role": "assistant", "content": [{"text": "ok"}]}, stop_reason="end_turn", state={}, metrics={}
    )

    graph._accumulate_metrics(
        NodeResult(
            result=result_text,
            accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
            execution_count=1,
        )
    )

    tru_usage = graph.state.accumulated_usage
    exp_usage = {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}
    assert tru_usage == exp_usage


def test_graph_dataclasses_and_enums():
    """Test dataclass initialization, properties, and enum behavior."""
    # Test Status enum
    assert Status.PENDING.value == "pending"
    assert Status.EXECUTING.value == "executing"
    assert Status.COMPLETED.value == "completed"
    assert Status.FAILED.value == "failed"

    # Test GraphState initialization and defaults
    state = GraphState()
    assert state.status == Status.PENDING
    assert len(state.completed_nodes) == 0
    assert len(state.failed_nodes) == 0
    assert state.task == ""
    assert state.accumulated_usage == {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0}
    assert state.execution_count == 0
    assert state.start_time > 0  # Should be set by default factory

    # Test GraphState with custom values
    state = GraphState(status=Status.EXECUTING, task="custom task", total_nodes=5, execution_count=3)
    assert state.status == Status.EXECUTING
    assert state.task == "custom task"
    assert state.total_nodes == 5
    assert state.execution_count == 3

    # Test GraphEdge with and without condition
    mock_agent_a = create_mock_agent("agent_a")
    mock_agent_b = create_mock_agent("agent_b")
    node_a = GraphNode("a", mock_agent_a)
    node_b = GraphNode("b", mock_agent_b)

    edge_simple = GraphEdge(node_a, node_b)
    assert edge_simple.from_node == node_a
    assert edge_simple.to_node == node_b
    assert edge_simple.condition is None
    assert edge_simple.should_traverse(GraphState(), invocation_state={})

    def test_condition(state):
        return len(state.completed_nodes) > 0

    edge_conditional = GraphEdge(node_a, node_b, condition=test_condition)
    assert edge_conditional.condition is not None
    assert not edge_conditional.should_traverse(GraphState(), invocation_state={})

    # Create a mock GraphNode for testing
    mock_completed_node = GraphNode("some_node", create_mock_agent("some_agent"))
    assert edge_conditional.should_traverse(GraphState(completed_nodes={mock_completed_node}), invocation_state={})

    # Test GraphEdge hashing
    node_x = GraphNode("x", mock_agent_a)
    node_y = GraphNode("y", mock_agent_b)
    edge1 = GraphEdge(node_x, node_y)
    edge2 = GraphEdge(node_x, node_y)
    edge3 = GraphEdge(node_y, node_x)
    assert hash(edge1) == hash(edge2)
    assert hash(edge1) != hash(edge3)

    # Test GraphNode initialization
    mock_agent = create_mock_agent("test_agent")
    node = GraphNode("test_node", mock_agent)
    assert node.node_id == "test_node"
    assert node.executor == mock_agent
    assert node.execution_status == Status.PENDING
    assert len(node.dependencies) == 0


def test_graph_synchronous_execution(mock_strands_tracer, mock_use_span, mock_agents):
    """Test synchronous graph execution using execute method."""
    builder = GraphBuilder()
    builder.add_node(mock_agents["start_agent"], "start_agent")
    builder.add_node(mock_agents["final_agent"], "final_agent")
    builder.add_edge("start_agent", "final_agent")
    builder.set_entry_point("start_agent")

    graph = builder.build()

    # Test synchronous execution
    result = graph("Test synchronous execution")

    # Verify execution results
    assert result.status == Status.COMPLETED
    assert result.total_nodes == 2
    assert result.completed_nodes == 2
    assert result.failed_nodes == 0
    assert len(result.execution_order) == 2
    assert result.execution_order[0].node_id == "start_agent"
    assert result.execution_order[1].node_id == "final_agent"

    # Verify agent calls (via stream_async)
    assert mock_agents["start_agent"].stream_async.call_count == 1
    assert mock_agents["final_agent"].stream_async.call_count == 1

    # Verify return type is GraphResult
    assert isinstance(result, GraphResult)
    assert isinstance(result, MultiAgentResult)

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


def test_graph_validate_unsupported_features():
    """Test Graph validation for session persistence and callbacks."""
    # Test with normal agent (should work)
    normal_agent = create_mock_agent("normal_agent")
    normal_agent._session_manager = None
    normal_agent.hooks = HookRegistry()

    builder = GraphBuilder()
    builder.add_node(normal_agent)
    graph = builder.build()
    assert len(graph.nodes) == 1

    # Test with session manager (should fail in GraphBuilder.add_node)
    mock_session_manager = Mock(spec=SessionManager)
    agent_with_session = create_mock_agent("agent_with_session")
    agent_with_session._session_manager = mock_session_manager
    agent_with_session.hooks = HookRegistry()

    builder = GraphBuilder()
    with pytest.raises(ValueError, match="Session persistence is not supported for Graph agents yet"):
        builder.add_node(agent_with_session)

    # Test with callbacks (should fail in GraphBuilder.add_node)
    class TestHookProvider(HookProvider):
        def register_hooks(self, registry, **kwargs):
            registry.add_callback(AgentInitializedEvent, lambda e: None)

    # Test validation in Graph constructor (when nodes are passed directly)
    # Test with session manager in Graph constructor
    node_with_session = GraphNode("node_with_session", agent_with_session)
    with pytest.raises(ValueError, match="Session persistence is not supported for Graph agents yet"):
        Graph(
            nodes={"node_with_session": node_with_session},
            edges=set(),
            entry_points=set(),
        )


@pytest.mark.asyncio
async def test_controlled_cyclic_execution():
    """Test cyclic graph execution with controlled cycle count to verify state reset."""

    # Create a stateful agent that tracks its own execution count
    class StatefulAgent(Agent):
        def __init__(self, name):
            super().__init__()
            self.name = name
            self.state = AgentState()
            self.state.set("execution_count", 0)
            self.messages = []
            self._session_manager = None
            self.hooks = HookRegistry()

        async def invoke_async(self, input_data, invocation_state=None):
            # Increment execution count in state
            count = self.state.get("execution_count") or 0
            self.state.set("execution_count", count + 1)

            return AgentResult(
                message={"role": "assistant", "content": [{"text": f"{self.name} response (execution {count + 1})"}]},
                stop_reason="end_turn",
                state={},
                metrics=Mock(
                    accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
                    accumulated_metrics={"latencyMs": 100.0},
                ),
            )

        async def stream_async(self, input_data, **kwargs):
            # Stream implementation that yields events and final result
            yield {"agent_start": True}
            result = await self.invoke_async(input_data)
            yield {"result": result}

    # Create agents
    agent_a = StatefulAgent("agent_a")
    agent_b = StatefulAgent("agent_b")

    # Create a graph with a simple cycle: A -> B -> A
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    builder.add_edge("b", "a")  # Creates cycle
    builder.set_entry_point("a")
    builder.reset_on_revisit()  # Enable state reset on revisit

    # Build with limited max_node_executions to prevent infinite loop
    graph = builder.set_max_node_executions(3).build()

    # Execute the graph
    result = await graph.invoke_async("Test controlled cyclic execution")

    # With a 2-node cycle and limit of 3, we should see either completion or failure
    # The exact behavior depends on how the cycle detection works
    if result.status == Status.COMPLETED:
        # If it completed, verify it executed some nodes
        assert len(result.execution_order) >= 2
        assert result.execution_order[0].node_id == "a"
    elif result.status == Status.FAILED:
        # If it failed due to limits, verify it hit the limit
        assert len(result.execution_order) == 3  # Should stop at exactly 3 executions
        assert result.execution_order[0].node_id == "a"
    else:
        # Should be either completed or failed
        raise AssertionError(f"Unexpected status: {result.status}")

    # Most importantly, verify that state was reset properly between executions
    # The state.execution_count should be set for both agents after execution
    assert agent_a.state.get("execution_count") >= 1  # Node A executed at least once
    assert agent_b.state.get("execution_count") >= 1  # Node B executed at least once


def test_reset_on_revisit_backward_compatibility():
    """Test that reset_on_revisit provides backward compatibility by default."""
    agent1 = create_mock_agent("agent1")
    agent2 = create_mock_agent("agent2")

    # Test default behavior - reset_on_revisit is False by default
    builder = GraphBuilder()
    builder.add_node(agent1, "a")
    builder.add_node(agent2, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")

    graph = builder.build()
    assert graph.reset_on_revisit is False

    # Test reset_on_revisit with True
    builder = GraphBuilder()
    builder.add_node(agent1, "a")
    builder.add_node(agent2, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")
    builder.reset_on_revisit(True)

    graph = builder.build()
    assert graph.reset_on_revisit is True

    # Test reset_on_revisit with False explicitly
    builder = GraphBuilder()
    builder.add_node(agent1, "a")
    builder.add_node(agent2, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")
    builder.reset_on_revisit(False)

    graph = builder.build()
    assert graph.reset_on_revisit is False


def test_reset_on_revisit_method_chaining():
    """Test that reset_on_revisit method returns GraphBuilder for chaining."""
    agent1 = create_mock_agent("agent1")

    builder = GraphBuilder()
    result = builder.reset_on_revisit()

    # Verify method chaining works
    assert result is builder
    assert builder._reset_on_revisit is True

    # Test full method chaining
    builder.add_node(agent1, "test_node")
    builder.set_max_node_executions(10)
    graph = builder.build()

    assert graph.reset_on_revisit is True
    assert graph.max_node_executions == 10


@pytest.mark.asyncio
async def test_linear_graph_behavior():
    """Test that linear graph behavior works correctly."""
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")

    # Create linear graph
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")

    graph = builder.build()
    assert graph.reset_on_revisit is False

    # Execute should work normally
    result = await graph.invoke_async("Test linear execution")
    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 2
    assert result.execution_order[0].node_id == "a"
    assert result.execution_order[1].node_id == "b"

    # Verify agents were called once each (no state reset, via stream_async)
    assert agent_a.stream_async.call_count == 1
    assert agent_b.stream_async.call_count == 1


@pytest.mark.asyncio
async def test_state_reset_only_with_cycles_enabled():
    """Test that state reset only happens when cycles are enabled."""
    # Create a mock agent that tracks state modifications
    agent = create_mock_agent("test_agent", "Test response")
    agent.state = AgentState()
    agent.messages = [{"role": "system", "content": "Initial message"}]

    # Create GraphNode
    node = GraphNode("test_node", agent)

    state = GraphState()
    state.completed_nodes.add(node)

    # Create graph with cycles disabled (default)
    builder = GraphBuilder()
    builder.add_node(agent, "test_node")
    graph = builder.build()

    # Mock the _execute_node method to test conditional reset logic
    with patch.object(node, "reset_executor_state") as mock_reset:
        # Simulate the conditional logic from _execute_node
        if graph.reset_on_revisit and node in state.completed_nodes:
            node.reset_executor_state()
            state.completed_nodes.remove(node)

        # With reset_on_revisit disabled, reset should not be called
        mock_reset.assert_not_called()

    # Now test with reset_on_revisit enabled
    builder = GraphBuilder()
    builder.add_node(agent, "test_node")
    builder.reset_on_revisit()
    graph = builder.build()

    with patch.object(node, "reset_executor_state") as mock_reset:
        # Simulate the conditional logic from _execute_node
        if graph.reset_on_revisit and node in state.completed_nodes:
            node.reset_executor_state()
            state.completed_nodes.remove(node)

        # With reset_on_revisit enabled, reset should be called
        mock_reset.assert_called_once()


@pytest.mark.asyncio
async def test_self_loop_functionality(mock_strands_tracer, mock_use_span):
    """Test comprehensive self-loop functionality including conditions and reset behavior."""
    # Test basic self-loop with execution counting
    self_loop_agent = create_mock_agent("self_loop_agent", "Self loop response")
    self_loop_agent.invoke_async = Mock(side_effect=self_loop_agent.invoke_async)

    def loop_condition(state: GraphState) -> bool:
        return len(state.execution_order) < 3

    builder = GraphBuilder()
    builder.add_node(self_loop_agent, "self_loop")
    builder.add_edge("self_loop", "self_loop", condition=loop_condition)
    builder.set_entry_point("self_loop")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(10)
    builder.set_execution_timeout(30.0)

    graph = builder.build()
    result = await graph.invoke_async("Test self loop")

    # Verify basic self-loop functionality (via stream_async)
    assert result.status == Status.COMPLETED
    assert self_loop_agent.stream_async.call_count == 3
    assert len(result.execution_order) == 3
    assert all(node.node_id == "self_loop" for node in result.execution_order)


@pytest.mark.asyncio
async def test_self_loop_functionality_without_reset(mock_strands_tracer, mock_use_span):
    loop_agent_no_reset = create_mock_agent("loop_agent", "Loop without reset")

    can_only_be_called_twice: Mock = Mock(side_effect=lambda state: can_only_be_called_twice.call_count <= 2)

    builder = GraphBuilder()
    builder.add_node(loop_agent_no_reset, "loop_node")
    builder.add_edge("loop_node", "loop_node", condition=can_only_be_called_twice)
    builder.set_entry_point("loop_node")
    builder.reset_on_revisit(False)  # Disable state reset
    builder.set_max_node_executions(10)

    graph = builder.build()
    result = await graph.invoke_async("Test self loop without reset")

    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 2

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called()


@pytest.mark.asyncio
async def test_complex_self_loop(mock_strands_tracer, mock_use_span):
    """Test complex self-loop scenarios including multi-node graphs and multiple self-loops."""
    start_agent = create_mock_agent("start_agent", "Start")
    loop_agent = create_mock_agent("loop_agent", "Loop")
    end_agent = create_mock_agent("end_agent", "End")

    def loop_condition(state: GraphState) -> bool:
        loop_count = sum(1 for node in state.execution_order if node.node_id == "loop_node")
        return loop_count < 2

    def end_condition(state: GraphState) -> bool:
        loop_count = sum(1 for node in state.execution_order if node.node_id == "loop_node")
        return loop_count >= 2

    builder = GraphBuilder()
    builder.add_node(start_agent, "start_node")
    builder.add_node(loop_agent, "loop_node")
    builder.add_node(end_agent, "end_node")
    builder.add_edge("start_node", "loop_node")
    builder.add_edge("loop_node", "loop_node", condition=loop_condition)
    builder.add_edge("loop_node", "end_node", condition=end_condition)
    builder.set_entry_point("start_node")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(10)

    graph = builder.build()
    result = await graph.invoke_async("Test complex graph with self loops")

    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 4  # start -> loop -> loop -> end
    assert [node.node_id for node in result.execution_order] == ["start_node", "loop_node", "loop_node", "end_node"]
    assert start_agent.stream_async.call_count == 1
    assert loop_agent.stream_async.call_count == 2
    assert end_agent.stream_async.call_count == 1


@pytest.mark.asyncio
async def test_multiple_nodes_with_self_loops(mock_strands_tracer, mock_use_span):
    agent_a = create_mock_agent("agent_a", "Agent A")
    agent_b = create_mock_agent("agent_b", "Agent B")

    def condition_a(state: GraphState) -> bool:
        return sum(1 for node in state.execution_order if node.node_id == "a") < 2

    def condition_b(state: GraphState) -> bool:
        return sum(1 for node in state.execution_order if node.node_id == "b") < 2

    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "a", condition=condition_a)
    builder.add_edge("b", "b", condition=condition_b)
    builder.add_edge("a", "b")
    builder.set_entry_point("a")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(15)

    graph = builder.build()
    result = await graph.invoke_async("Test multiple self loops")

    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 4  # a -> a -> b -> b
    assert agent_a.stream_async.call_count == 2
    assert agent_b.stream_async.call_count == 2

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called()


@pytest.mark.asyncio
async def test_self_loop_state_reset():
    """Test self-loop edge cases including state reset, failure handling, and infinite loop prevention."""
    agent = create_mock_agent("stateful_agent", "Stateful response")
    agent.state = AgentState()

    def loop_condition(state: GraphState) -> bool:
        return len(state.execution_order) < 3

    builder = GraphBuilder()
    node = builder.add_node(agent, "stateful_node")
    builder.add_edge("stateful_node", "stateful_node", condition=loop_condition)
    builder.set_entry_point("stateful_node")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(10)

    node.reset_executor_state = Mock(wraps=node.reset_executor_state)

    graph = builder.build()
    result = await graph.invoke_async("Test state reset")

    assert result.status == Status.COMPLETED
    assert len(result.execution_order) == 3
    assert node.reset_executor_state.call_count >= 2  # Reset called for revisits


@pytest.mark.asyncio
async def test_infinite_loop_prevention():
    infinite_agent = create_mock_agent("infinite_agent", "Infinite loop")

    def always_true_condition(state: GraphState) -> bool:
        return True

    builder = GraphBuilder()
    builder.add_node(infinite_agent, "infinite_node")
    builder.add_edge("infinite_node", "infinite_node", condition=always_true_condition)
    builder.set_entry_point("infinite_node")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(5)

    graph = builder.build()
    result = await graph.invoke_async("Test infinite loop prevention")

    assert result.status == Status.FAILED
    assert len(result.execution_order) == 5


@pytest.mark.asyncio
async def test_infinite_loop_prevention_self_loops():
    multi_agent = create_mock_multi_agent("multi_agent", "Multi-agent response")
    loop_count = 0

    def multi_loop_condition(state: GraphState) -> bool:
        nonlocal loop_count
        loop_count += 1
        return loop_count <= 2

    builder = GraphBuilder()
    builder.add_node(multi_agent, "multi_node")
    builder.add_edge("multi_node", "multi_node", condition=multi_loop_condition)
    builder.set_entry_point("multi_node")
    builder.reset_on_revisit(True)
    builder.set_max_node_executions(10)

    graph = builder.build()
    result = await graph.invoke_async("Test multi-agent self loop")

    assert result.status == Status.COMPLETED
    assert len(result.execution_order) >= 2
    assert multi_agent.stream_async.call_count >= 2


@pytest.mark.asyncio
async def test_graph_kwargs_passing_agent(mock_strands_tracer, mock_use_span):
    """Test that kwargs are passed through to underlying Agent nodes."""
    kwargs_agent = create_mock_agent("kwargs_agent", "Response with kwargs")
    kwargs_agent.invoke_async = Mock(side_effect=kwargs_agent.invoke_async)

    builder = GraphBuilder()
    builder.add_node(kwargs_agent, "kwargs_node")
    graph = builder.build()

    test_invocation_state = {"custom_param": "test_value", "another_param": 42}
    result = await graph.invoke_async("Test kwargs passing", test_invocation_state)

    # Verify stream_async was called (kwargs are passed through)
    assert kwargs_agent.stream_async.call_count == 1
    assert result.status == Status.COMPLETED


@pytest.mark.asyncio
async def test_graph_kwargs_passing_multiagent(mock_strands_tracer, mock_use_span):
    """Test that kwargs are passed through to underlying MultiAgentBase nodes."""
    kwargs_multiagent = create_mock_multi_agent("kwargs_multiagent", "MultiAgent response with kwargs")
    kwargs_multiagent.invoke_async = Mock(side_effect=kwargs_multiagent.invoke_async)

    builder = GraphBuilder()
    builder.add_node(kwargs_multiagent, "multiagent_node")
    graph = builder.build()

    test_invocation_state = {"custom_param": "test_value", "another_param": 42}
    result = await graph.invoke_async("Test kwargs passing to multiagent", test_invocation_state)

    # Verify stream_async was called (kwargs are passed through)
    assert kwargs_multiagent.stream_async.call_count == 1
    assert result.status == Status.COMPLETED


def test_graph_kwargs_passing_sync(mock_strands_tracer, mock_use_span):
    """Test that kwargs are passed through to underlying nodes in sync execution."""
    kwargs_agent = create_mock_agent("kwargs_agent", "Response with kwargs")
    kwargs_agent.invoke_async = Mock(side_effect=kwargs_agent.invoke_async)

    builder = GraphBuilder()
    builder.add_node(kwargs_agent, "kwargs_node")
    graph = builder.build()

    test_invocation_state = {"custom_param": "test_value", "another_param": 42}
    result = graph("Test kwargs passing sync", test_invocation_state)

    # Verify stream_async was called (kwargs are passed through)
    assert kwargs_agent.stream_async.call_count == 1
    assert result.status == Status.COMPLETED


@pytest.mark.asyncio
async def test_graph_streaming_events(mock_strands_tracer, mock_use_span, alist):
    """Test that graph streaming emits proper events during execution."""
    # Create agents with custom streaming behavior
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")

    # Track events from agent streams
    agent_a_events = [
        {"agent_thinking": True, "thought": "Processing task A"},
        {"agent_progress": True, "step": "analyzing"},
        {"result": agent_a.return_value},
    ]

    agent_b_events = [
        {"agent_thinking": True, "thought": "Processing task B"},
        {"agent_progress": True, "step": "computing"},
        {"result": agent_b.return_value},
    ]

    async def stream_a(*args, **kwargs):
        for event in agent_a_events:
            yield event

    async def stream_b(*args, **kwargs):
        for event in agent_b_events:
            yield event

    agent_a.stream_async = Mock(side_effect=stream_a)
    agent_b.stream_async = Mock(side_effect=stream_b)

    # Build graph: A -> B
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")
    graph = builder.build()

    # Collect all streaming events
    events = await alist(graph.stream_async("Test streaming"))

    # Verify event structure and order
    assert len(events) > 0

    # Should have node start/stop events and forwarded agent events
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    node_stop_events = [e for e in events if e.get("type") == "multiagent_node_stop"]
    node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
    result_events = [e for e in events if "result" in e and e.get("type") != "multiagent_node_stream"]

    # Should have start/stop events for both nodes
    assert len(node_start_events) == 2
    assert len(node_stop_events) == 2

    # Should have forwarded agent events
    assert len(node_stream_events) >= 4  # At least 2 events per agent

    # Should have final result
    assert len(result_events) == 1

    # Verify node start events have correct structure
    for event in node_start_events:
        assert "node_id" in event
        assert "node_type" in event
        assert event["node_type"] == "agent"

    # Verify node stop events have node_result with execution time
    for event in node_stop_events:
        assert "node_id" in event
        assert "node_result" in event
        node_result = event["node_result"]
        assert hasattr(node_result, "execution_time")
        assert isinstance(node_result.execution_time, int)

    # Verify forwarded events maintain node context
    for event in node_stream_events:
        assert "node_id" in event
        assert event["node_id"] in ["a", "b"]

    # Verify final result
    final_result = result_events[0]["result"]
    assert final_result.status == Status.COMPLETED


@pytest.mark.asyncio
async def test_graph_streaming_parallel_events(mock_strands_tracer, mock_use_span, alist):
    """Test that parallel graph execution properly streams events from concurrent nodes."""
    # Create agents that execute in parallel
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")
    agent_c = create_mock_agent("agent_c", "Response C")

    # Track timing and events
    execution_order = []

    async def stream_with_timing(node_id, delay=0.05):
        execution_order.append(f"{node_id}_start")
        yield {"node_start": True, "node": node_id}
        await asyncio.sleep(delay)
        yield {"node_progress": True, "node": node_id}
        execution_order.append(f"{node_id}_end")
        yield {"result": create_mock_agent(node_id, f"Response {node_id}").return_value}

    agent_a.stream_async = Mock(side_effect=lambda *args, **kwargs: stream_with_timing("A", 0.05))
    agent_b.stream_async = Mock(side_effect=lambda *args, **kwargs: stream_with_timing("B", 0.05))
    agent_c.stream_async = Mock(side_effect=lambda *args, **kwargs: stream_with_timing("C", 0.05))

    # Build graph with parallel nodes
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    # All are entry points (parallel execution)
    builder.set_entry_point("a")
    builder.set_entry_point("b")
    builder.set_entry_point("c")
    graph = builder.build()

    # Collect streaming events
    start_time = time.time()
    events = await alist(graph.stream_async("Test parallel streaming"))
    total_time = time.time() - start_time

    # Verify parallel execution timing
    assert total_time < 0.2, f"Expected parallel execution, took {total_time}s"

    # Verify we get events from all nodes
    node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
    nodes_with_events = set(e["node_id"] for e in node_stream_events)
    assert nodes_with_events == {"a", "b", "c"}

    # Verify start events for all nodes
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    start_node_ids = set(e["node_id"] for e in node_start_events)
    assert start_node_ids == {"a", "b", "c"}


@pytest.mark.parametrize(
    ("max_concurrency", "exp_max_active_nodes"),
    [(1, 1), (2, 2), (3, 3), (4, 3), (None, 3)],
)
@pytest.mark.asyncio
async def test_graph_max_concurrency_limits_parallel_nodes(
    max_concurrency, exp_max_active_nodes, mock_strands_tracer, mock_use_span
):
    """Test that graph execution does not exceed the configured concurrency limit."""
    active_nodes = 0
    max_active_nodes = 0

    async def tracked_stream(*args, **kwargs):
        nonlocal active_nodes, max_active_nodes
        active_nodes += 1
        max_active_nodes = max(max_active_nodes, active_nodes)
        try:
            await asyncio.sleep(0.01)
            yield {"result": create_mock_agent("result").return_value}
        finally:
            active_nodes -= 1

    builder = GraphBuilder()
    for node_id in ("a", "b", "c"):
        agent = create_mock_agent(f"agent_{node_id}")
        agent.stream_async = Mock(side_effect=tracked_stream)
        builder.add_node(agent, node_id)
        builder.set_entry_point(node_id)

    graph = builder.set_max_concurrency(max_concurrency).build()
    tru_result = await graph.invoke_async("Test bounded parallel execution")

    assert graph.max_concurrency == max_concurrency
    assert max_active_nodes == exp_max_active_nodes
    assert tru_result.status == Status.COMPLETED


@pytest.mark.parametrize("invalid_max_concurrency", [0, -1, 1.5, True])
@pytest.mark.asyncio
async def test_graph_max_concurrency_validation_after_assignment(
    invalid_max_concurrency, mock_strands_tracer, mock_use_span
):
    """Test that invalid public attribute assignments fail before scheduling nodes."""
    builder = GraphBuilder()
    builder.add_node(create_mock_agent("agent"), "agent")
    graph = builder.build()
    graph.max_concurrency = invalid_max_concurrency
    exp_message = rf"max_concurrency=<{invalid_max_concurrency!r}> \| must be a positive integer"

    with pytest.raises(ValueError, match=exp_message):
        await graph.invoke_async("Test invalid reassignment")


@pytest.mark.asyncio
async def test_graph_max_concurrency_releases_slot_after_failure(mock_strands_tracer, mock_use_span):
    """Test that a failed node releases its slot for a later node."""
    failing_agent = create_mock_agent("failing")

    async def failing_stream(*args, **kwargs):
        yield {"agent_start": True}
        raise RuntimeError("expected failure")

    failing_agent.stream_async = Mock(side_effect=failing_stream)
    succeeding_agent = create_mock_agent("succeeding")
    builder = GraphBuilder()
    builder.add_node(failing_agent, "failing")
    builder.add_node(succeeding_agent, "succeeding")
    graph = builder.build()
    semaphore = asyncio.Semaphore(1)
    event_queue = asyncio.Queue()

    await graph._stream_node_to_queue(graph.nodes["failing"], event_queue, {}, semaphore)
    assert semaphore.locked() is False

    await asyncio.wait_for(
        graph._stream_node_to_queue(graph.nodes["succeeding"], event_queue, {}, semaphore),
        timeout=1,
    )
    assert semaphore.locked() is False
    assert graph.nodes["succeeding"].execution_status == Status.COMPLETED


@pytest.mark.asyncio
async def test_graph_max_concurrency_releases_slot_after_cancellation(mock_strands_tracer, mock_use_span):
    """Test that cancelling a node waiting in its stream releases its slot."""
    stream_started = asyncio.Event()
    never_finish = asyncio.Event()
    blocked_agent = create_mock_agent("blocked")

    async def blocked_stream(*args, **kwargs):
        stream_started.set()
        await never_finish.wait()
        yield {"result": blocked_agent.return_value}

    blocked_agent.stream_async = Mock(side_effect=blocked_stream)
    succeeding_agent = create_mock_agent("succeeding")
    builder = GraphBuilder()
    builder.add_node(blocked_agent, "blocked")
    builder.add_node(succeeding_agent, "succeeding")
    graph = builder.build()
    semaphore = asyncio.Semaphore(1)
    event_queue = asyncio.Queue()

    blocked_task = asyncio.create_task(graph._stream_node_to_queue(graph.nodes["blocked"], event_queue, {}, semaphore))
    await stream_started.wait()
    blocked_task.cancel()
    await asyncio.gather(blocked_task, return_exceptions=True)
    assert semaphore.locked() is False

    await asyncio.wait_for(
        graph._stream_node_to_queue(graph.nodes["succeeding"], event_queue, {}, semaphore),
        timeout=1,
    )
    assert semaphore.locked() is False
    assert graph.nodes["succeeding"].execution_status == Status.COMPLETED


@pytest.mark.asyncio
async def test_graph_node_timeout_excludes_concurrency_queue_time(mock_strands_tracer, mock_use_span):
    """Test that queued nodes receive their full node timeout after acquiring a slot."""
    builder = GraphBuilder()
    builder.add_node(create_mock_agent("queued"), "queued")
    graph = builder.set_node_timeout(0.05).build()
    semaphore = asyncio.Semaphore(0)
    event_queue = asyncio.Queue()

    task = asyncio.create_task(graph._stream_node_to_queue(graph.nodes["queued"], event_queue, {}, semaphore))
    await asyncio.sleep(0.1)

    # Waiting for a concurrency slot must not start the per-node timeout.
    assert not task.done()
    tru_queued_status = graph.nodes["queued"].execution_status
    exp_queued_status = Status.EXECUTING
    assert tru_queued_status == exp_queued_status

    semaphore.release()
    await asyncio.wait_for(task, timeout=1)

    assert graph.nodes["queued"].execution_status == Status.COMPLETED


@pytest.mark.parametrize(
    ("max_concurrency", "exp_status", "exp_tail_status"),
    [(None, Status.COMPLETED, Status.COMPLETED), (1, Status.FAILED, Status.PENDING)],
)
@pytest.mark.asyncio
async def test_graph_max_concurrency_interacts_with_execution_timeout(
    max_concurrency, exp_status, exp_tail_status, mock_strands_tracer, mock_use_span
):
    """Test that serialized batches can exceed the graph-level execution timeout."""

    async def delayed_stream(*args, **kwargs):
        await asyncio.sleep(0.04)
        yield {"result": create_mock_agent("result").return_value}

    builder = GraphBuilder()
    for node_id in ("a", "b", "c", "d"):
        agent = create_mock_agent(node_id)
        agent.stream_async = Mock(side_effect=delayed_stream)
        builder.add_node(agent, node_id)
        builder.set_entry_point(node_id)
    builder.add_node(create_mock_agent("tail"), "tail")
    for node_id in ("a", "b", "c", "d"):
        builder.add_edge(node_id, "tail")

    graph = builder.set_max_concurrency(max_concurrency).set_execution_timeout(0.1).build()
    tru_result = await graph.invoke_async("Test execution timeout interaction")

    assert tru_result.status == exp_status
    assert graph.nodes["tail"].execution_status == exp_tail_status


@pytest.mark.asyncio
async def test_graph_streaming_with_failures(mock_strands_tracer, mock_use_span):
    """Test graph streaming behavior when nodes fail."""
    # Create a failing agent
    failing_agent = Mock(spec=Agent)
    failing_agent.name = "failing_agent"
    failing_agent.id = "fail_node"
    failing_agent._session_manager = None
    failing_agent.hooks = HookRegistry()

    async def failing_stream(*args, **kwargs):
        yield {"agent_start": True}
        yield {"agent_thinking": True, "thought": "About to fail"}
        await asyncio.sleep(0.01)
        raise Exception("Simulated streaming failure")

    async def failing_invoke(*args, **kwargs):
        raise Exception("Simulated failure")

    failing_agent.stream_async = Mock(side_effect=failing_stream)
    failing_agent.invoke_async = failing_invoke

    # Create successful agent
    success_agent = create_mock_agent("success_agent", "Success")

    # Build graph
    builder = GraphBuilder()
    builder.add_node(failing_agent, "fail")
    builder.add_node(success_agent, "success")
    builder.set_entry_point("fail")
    builder.set_entry_point("success")
    graph = builder.build()

    # Collect events - graph should raise exception (fail-fast behavior)
    events = []
    with pytest.raises(Exception, match="Simulated streaming failure"):
        async for event in graph.stream_async("Test streaming with failure"):
            events.append(event)

    # Should get some events before failure
    assert len(events) > 0

    # Should have node start events
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    assert len(node_start_events) >= 1

    # Should have some forwarded events before failure
    node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
    assert len(node_stream_events) >= 1


@pytest.mark.asyncio
async def test_graph_single_node_optimization(mock_strands_tracer, mock_use_span):
    """Test that single node execution uses direct path (optimization)."""
    agent = create_mock_agent("single_agent", "Single response")

    builder = GraphBuilder()
    builder.add_node(agent, "single")
    graph = builder.build()

    result = await graph.invoke_async("Test single node")

    assert result.status == Status.COMPLETED
    assert result.completed_nodes == 1
    assert agent.stream_async.call_count == 1


@pytest.mark.asyncio
async def test_graph_parallel_with_failures(mock_strands_tracer, mock_use_span):
    """Test parallel execution with some nodes failing."""
    # Create a failing agent
    failing_agent = Mock(spec=Agent)
    failing_agent.name = "failing_agent"
    failing_agent.id = "fail_node"
    failing_agent._session_manager = None
    failing_agent.hooks = HookRegistry()

    async def mock_invoke_failure(*args, **kwargs):
        await asyncio.sleep(0.05)  # Small delay
        raise Exception("Simulated failure")

    async def mock_stream_failure_parallel(*args, **kwargs):
        # Simple mock stream that fails
        yield {"agent_start": True}
        await asyncio.sleep(0.05)  # Small delay
        raise Exception("Simulated failure")

    failing_agent.invoke_async = mock_invoke_failure
    failing_agent.stream_async = Mock(side_effect=mock_stream_failure_parallel)

    # Create successful agents that take longer than the failing agent
    success_agent_a = create_mock_agent("success_a", "Success A")
    success_agent_b = create_mock_agent("success_b", "Success B")

    # Override their stream methods to take longer
    async def slow_stream_a(*args, **kwargs):
        yield {"agent_start": True, "node": "success_a"}
        await asyncio.sleep(0.1)  # Longer than failing agent
        yield {"result": success_agent_a.return_value}

    async def slow_stream_b(*args, **kwargs):
        yield {"agent_start": True, "node": "success_b"}
        await asyncio.sleep(0.1)  # Longer than failing agent
        yield {"result": success_agent_b.return_value}

    success_agent_a.stream_async = Mock(side_effect=slow_stream_a)
    success_agent_b.stream_async = Mock(side_effect=slow_stream_b)

    # Build graph with parallel execution where one fails
    builder = GraphBuilder()
    builder.add_node(failing_agent, "fail")
    builder.add_node(success_agent_a, "success_a")
    builder.add_node(success_agent_b, "success_b")

    # All are entry points (parallel)
    builder.set_entry_point("fail")
    builder.set_entry_point("success_a")
    builder.set_entry_point("success_b")

    graph = builder.build()

    # Execute should raise exception (fail-fast behavior)
    with pytest.raises(Exception, match="Simulated failure"):
        await graph.invoke_async("Test parallel with failure")


@pytest.mark.asyncio
async def test_graph_single_invocation_no_double_execution(mock_strands_tracer, mock_use_span):
    """Test that nodes are only invoked once (no double execution from streaming)."""
    # Create agents with invocation counters
    agent_a = create_mock_agent("agent_a", "Response A")
    agent_b = create_mock_agent("agent_b", "Response B")

    # Track invocation counts
    invocation_counts = {"agent_a": 0, "agent_b": 0}

    async def counted_stream_a(*args, **kwargs):
        invocation_counts["agent_a"] += 1
        yield {"agent_start": True}
        yield {"agent_thinking": True, "thought": "Processing A"}
        yield {"result": agent_a.return_value}

    async def counted_stream_b(*args, **kwargs):
        invocation_counts["agent_b"] += 1
        yield {"agent_start": True}
        yield {"agent_thinking": True, "thought": "Processing B"}
        yield {"result": agent_b.return_value}

    agent_a.stream_async = Mock(side_effect=counted_stream_a)
    agent_b.stream_async = Mock(side_effect=counted_stream_b)

    # Build graph: A -> B
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_edge("a", "b")
    builder.set_entry_point("a")
    graph = builder.build()

    # Execute the graph
    result = await graph.invoke_async("Test single invocation")

    # Verify successful execution
    assert result.status == Status.COMPLETED

    # CRITICAL: Each agent should be invoked exactly once
    assert invocation_counts["agent_a"] == 1, f"Agent A invoked {invocation_counts['agent_a']} times, expected 1"
    assert invocation_counts["agent_b"] == 1, f"Agent B invoked {invocation_counts['agent_b']} times, expected 1"

    # Verify stream_async was called but invoke_async was NOT called
    assert agent_a.stream_async.call_count == 1
    assert agent_b.stream_async.call_count == 1
    # invoke_async should not be called at all since we're using streaming
    agent_a.invoke_async.assert_not_called()
    agent_b.invoke_async.assert_not_called()


@pytest.mark.asyncio
async def test_graph_parallel_single_invocation(mock_strands_tracer, mock_use_span):
    """Test that parallel nodes are only invoked once each."""
    # Create parallel agents with invocation counters
    invocation_counts = {"a": 0, "b": 0, "c": 0}

    async def create_counted_agent(name):
        agent = create_mock_agent(name, f"Response {name}")

        async def counted_stream(*args, **kwargs):
            invocation_counts[name] += 1
            yield {"agent_start": True, "node": name}
            await asyncio.sleep(0.01)  # Small delay
            yield {"result": agent.return_value}

        agent.stream_async = Mock(side_effect=counted_stream)
        return agent

    agent_a = await create_counted_agent("a")
    agent_b = await create_counted_agent("b")
    agent_c = await create_counted_agent("c")

    # Build graph with parallel nodes
    builder = GraphBuilder()
    builder.add_node(agent_a, "a")
    builder.add_node(agent_b, "b")
    builder.add_node(agent_c, "c")
    builder.set_entry_point("a")
    builder.set_entry_point("b")
    builder.set_entry_point("c")
    graph = builder.build()

    # Execute the graph
    result = await graph.invoke_async("Test parallel single invocation")

    # Verify successful execution
    assert result.status == Status.COMPLETED

    # CRITICAL: Each agent should be invoked exactly once
    assert invocation_counts["a"] == 1, f"Agent A invoked {invocation_counts['a']} times, expected 1"
    assert invocation_counts["b"] == 1, f"Agent B invoked {invocation_counts['b']} times, expected 1"
    assert invocation_counts["c"] == 1, f"Agent C invoked {invocation_counts['c']} times, expected 1"

    # Verify stream_async was called but invoke_async was NOT called
    assert agent_a.stream_async.call_count == 1
    assert agent_b.stream_async.call_count == 1
    assert agent_c.stream_async.call_count == 1
    agent_a.invoke_async.assert_not_called()
    agent_b.invoke_async.assert_not_called()
    agent_c.invoke_async.assert_not_called()


@pytest.mark.asyncio
async def test_graph_node_timeout_with_mocked_streaming():
    """Test that node timeout properly cancels a streaming generator that freezes."""
    # Create an agent that will timeout during streaming
    slow_agent = Agent(
        name="slow_agent",
        model="us.amazon.nova-lite-v1:0",
        system_prompt="You are a slow agent. Take your time responding.",
    )

    # Override stream_async to simulate a freezing generator
    original_stream = slow_agent.stream_async

    async def freezing_stream(*args, **kwargs):
        """Simulate a generator that yields some events then freezes."""
        # Yield a few events normally
        count = 0
        async for event in original_stream(*args, **kwargs):
            yield event
            count += 1
            if count >= 3:
                # Simulate freezing - sleep longer than timeout
                await asyncio.sleep(10.0)
                break

    slow_agent.stream_async = freezing_stream

    # Create graph with short node timeout
    builder = GraphBuilder()
    builder.add_node(slow_agent, "slow_node")
    builder.set_node_timeout(0.5)  # 500ms timeout
    graph = builder.build()

    # Execute - should timeout and raise exception (fail-fast behavior)
    with pytest.raises(Exception, match="execution timed out"):
        await graph.invoke_async("Test freezing generator")


@pytest.mark.asyncio
async def test_graph_timeout_cleanup_on_exception():
    """Test that timeout properly cleans up tasks even when exceptions occur."""
    # Create an agent
    agent = Agent(
        name="test_agent",
        model="us.amazon.nova-lite-v1:0",
        system_prompt="You are a test agent.",
    )

    # Override stream_async to raise an exception after some events
    original_stream = agent.stream_async

    async def exception_stream(*args, **kwargs):
        """Simulate a generator that raises an exception."""
        count = 0
        async for event in original_stream(*args, **kwargs):
            yield event
            count += 1
            if count >= 2:
                raise ValueError("Simulated error during streaming")

    agent.stream_async = exception_stream

    # Create graph with timeout
    builder = GraphBuilder()
    builder.add_node(agent, "test_node")
    builder.set_node_timeout(30.0)
    graph = builder.build()

    # Execute - the exception propagates through _stream_with_timeout
    with pytest.raises(ValueError, match="Simulated error during streaming"):
        await graph.invoke_async("Test exception handling")

    # Verify execution_time is set even on failure (via finally block)
    assert graph.state.execution_time > 0, "execution_time should be set even when exception occurs"


@pytest.mark.asyncio
async def test_graph_agent_no_result_event(mock_strands_tracer, mock_use_span):
    """Test that graph raises error when agent stream doesn't produce result event."""
    # Create an agent that streams events but never yields a result
    no_result_agent = create_mock_agent("no_result_agent", "Should fail")

    async def stream_without_result(*args, **kwargs):
        """Stream that yields events but no result."""
        yield {"agent_start": True}
        yield {"agent_thinking": True, "thought": "Processing"}
        # Missing: yield {"result": ...}

    no_result_agent.stream_async = Mock(side_effect=stream_without_result)

    builder = GraphBuilder()
    builder.add_node(no_result_agent, "no_result_node")
    graph = builder.build()

    # Execute - should raise ValueError about missing result event
    with pytest.raises(ValueError, match="Node 'no_result_node' did not produce a result event"):
        await graph.invoke_async("Test missing result event")

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_graph_multiagent_no_result_event(mock_strands_tracer, mock_use_span):
    """Test that graph raises error when multi-agent stream doesn't produce result event."""
    # Create a multi-agent that streams events but never yields a result
    no_result_multiagent = create_mock_multi_agent("no_result_multiagent", "Should fail")

    async def stream_without_result(*args, **kwargs):
        """Stream that yields events but no result."""
        yield {"multi_agent_start": True}
        yield {"multi_agent_progress": True, "step": "processing"}
        # Missing: yield {"result": ...}

    no_result_multiagent.stream_async = Mock(side_effect=stream_without_result)

    builder = GraphBuilder()
    builder.add_node(no_result_multiagent, "no_result_multiagent_node")
    graph = builder.build()

    # Execute - should raise ValueError about missing result event
    with pytest.raises(ValueError, match="Node 'no_result_multiagent_node' did not produce a result event"):
        await graph.invoke_async("Test missing result event from multiagent")

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


@pytest.mark.asyncio
async def test_graph_nested_multiagent_failed_status_routed_to_failed_nodes(mock_strands_tracer, mock_use_span):
    """Test that a nested MultiAgentBase reporting FAILED status is routed to failed_nodes."""
    failing_multiagent = create_mock_multi_agent("failing_multiagent", "nested failure")

    failed_inner_result = MultiAgentResult(
        results={"inner_node": NodeResult(result=Exception("inner failure"), status=Status.FAILED)},
        accumulated_usage={"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
        accumulated_metrics={"latencyMs": 0.0},
        execution_count=1,
        execution_time=10,
        status=Status.FAILED,
    )

    async def stream_failed_result(*args, **kwargs):
        yield {"multi_agent_start": True}
        yield {"result": failed_inner_result}

    failing_multiagent.stream_async = Mock(side_effect=stream_failed_result)
    failing_multiagent.invoke_async = AsyncMock(return_value=failed_inner_result)

    builder = GraphBuilder()
    builder.add_node(failing_multiagent, "failing_multiagent_node")
    graph = builder.build()

    result = await graph.invoke_async("Test nested multiagent failure routing")

    assert result.status == Status.FAILED
    assert graph.state.status == Status.FAILED
    failed_node_ids = {node.node_id for node in graph.state.failed_nodes}
    completed_node_ids = {node.node_id for node in graph.state.completed_nodes}
    assert "failing_multiagent_node" in failed_node_ids
    assert "failing_multiagent_node" not in completed_node_ids
    assert graph.nodes["failing_multiagent_node"].execution_status == Status.FAILED


@pytest.mark.asyncio
async def test_graph_persisted(mock_strands_tracer, mock_use_span):
    """Test graph persistence functionality with multimodal input containing binary bytes."""
    import base64
    import json

    # Create mock session manager
    session_manager = Mock(spec=FileSessionManager)
    session_manager.read_multi_agent().return_value = None

    # Create simple graph with session manager
    builder = GraphBuilder()
    agent = create_mock_agent("test_agent")
    builder.add_node(agent, "test_node")
    builder.set_entry_point("test_node")
    builder.set_session_manager(session_manager)

    graph = builder.build()

    # Test get_state_from_orchestrator
    state = graph.serialize_state()
    assert state["type"] == "graph"
    assert state["id"] == "default_graph"
    assert state["_internal_state"] == {
        "interrupt_state": {"activated": False, "context": {}, "interrupts": {}},
    }
    assert "status" in state
    assert "completed_nodes" in state
    assert "node_results" in state

    # Build a multimodal prompt with inline binary PDF bytes (the problematic case)
    pdf_bytes = b"%PDF-1.4 binary content"
    multimodal_task = [
        {"text": "Analyze this PDF"},
        {
            "document": {
                "format": "pdf",
                "name": "document.pdf",
                "source": {
                    "bytes": pdf_bytes,
                },
            }
        },
    ]

    # Simulate graph having executed with a multimodal task
    graph.state.task = multimodal_task

    # serialize_state must not raise TypeError for bytes
    serialized = graph.serialize_state()
    assert json.dumps(serialized)  # must be JSON-serializable

    # The bytes should be encoded in the serialized form
    encoded_bytes = serialized["current_task"][1]["document"]["source"]["bytes"]
    assert encoded_bytes == {"__bytes_encoded__": True, "data": base64.b64encode(pdf_bytes).decode()}

    # deserialize_state must restore bytes back to original
    serialized["next_nodes_to_execute"] = ["test_node"]
    serialized["status"] = "executing"
    graph.deserialize_state(serialized)
    restored_bytes = graph.state.task[1]["document"]["source"]["bytes"]
    assert restored_bytes == pdf_bytes

    # Test apply_state_from_dict with plain string persisted state (backward compat)
    persisted_state = {
        "status": "executing",
        "completed_nodes": [],
        "failed_nodes": [],
        "interrupted_nodes": [],
        "node_results": {},
        "current_task": "persisted task",
        "execution_order": [],
        "next_nodes_to_execute": ["test_node"],
        "_internal_state": {
            "interrupt_state": {
                "activated": False,
                "context": {"a": 1},
                "interrupts": {
                    "i1": {
                        "id": "i1",
                        "name": "test_name",
                        "reason": "test_reason",
                    },
                },
            },
        },
    }

    graph.deserialize_state(persisted_state)
    assert graph.state.task == "persisted task"
    assert graph._interrupt_state == _InterruptState(
        activated=False,
        context={"a": 1},
        interrupts={"i1": Interrupt(id="i1", name="test_name", reason="test_reason")},
    )

    # Execute graph to test persistence integration
    result = await graph.invoke_async("Test persistence")

    # Verify execution completed
    assert result.status == Status.COMPLETED
    assert len(result.results) == 1
    assert "test_node" in result.results

    # Test state serialization after execution
    final_state = graph.serialize_state()
    assert final_state["status"] == "completed"
    assert len(final_state["completed_nodes"]) == 1
    assert "test_node" in final_state["node_results"]


def test_graph_serialize_deserialize_serialize_preserves_cumulative_state():
    """serialize -> deserialize -> serialize is value-preserving on the resume path.

    Guarantees that a resumed graph re-serializes the same cumulative accounting (accumulated_usage /
    accumulated_metrics / execution_count / execution_time) it was restored with, so the timeout
    budget (should_continue) and the totals reported in GraphResult reflect the whole run.
    """
    builder = GraphBuilder()
    builder.add_node(create_mock_agent("test_agent"), "test_node")
    builder.set_entry_point("test_node")
    graph = builder.build()

    payload = {
        "type": "graph",
        "id": "default_graph",
        "status": "executing",
        "completed_nodes": [],
        "failed_nodes": [],
        "interrupted_nodes": [],
        "node_results": {},
        "next_nodes_to_execute": ["test_node"],
        "current_task": "resume me",
        "execution_order": [],
        "accumulated_usage": {"inputTokens": 11, "outputTokens": 22, "totalTokens": 33},
        "accumulated_metrics": {"latencyMs": 44},
        "execution_count": 3,
        "execution_time": 555,
        "_internal_state": {"interrupt_state": {"activated": False, "context": {}, "interrupts": {}}},
    }

    graph.deserialize_state(payload)

    # Cumulative accounting is restored, not reset to zero.
    assert graph.state.accumulated_usage == {"inputTokens": 11, "outputTokens": 22, "totalTokens": 33}
    assert graph.state.accumulated_metrics == {"latencyMs": 44}
    assert graph.state.execution_count == 3
    assert graph.state.execution_time == 555

    serialize1 = graph.serialize_state()
    graph.deserialize_state(serialize1)
    serialize2 = graph.serialize_state()

    assert serialize2["accumulated_usage"] == serialize1["accumulated_usage"]
    assert serialize2["accumulated_metrics"] == serialize1["accumulated_metrics"]
    assert serialize2["execution_count"] == serialize1["execution_count"]
    assert serialize2["execution_time"] == serialize1["execution_time"]


@pytest.mark.asyncio
async def test_graph_execution_time_reflects_active_invocation(mock_strands_tracer, mock_use_span):
    """The final GraphResult includes the current invocation's interval on top of restored prior time.

    execution_time is committed to state once, at finalization. GraphResult is built before that
    commit, so it must fold in the in-flight interval itself — and finalization must not double-count.
    """
    # Monotonic fake clock advanced explicitly; robust to how many times time.time() is called.
    clock = {"now": 1000.0}

    with patch("strands.multiagent.graph.time.time", lambda: clock["now"]):
        builder = GraphBuilder()
        builder.add_node(create_mock_agent("test_agent"), "test_node")
        builder.set_entry_point("test_node")
        graph = builder.build()

        # Resume from a checkpoint that already accrued 555ms in a prior invocation.
        graph.deserialize_state(
            {
                "type": "graph",
                "id": "default_graph",
                "status": "executing",
                "completed_nodes": [],
                "failed_nodes": [],
                "interrupted_nodes": [],
                "node_results": {},
                "next_nodes_to_execute": ["test_node"],
                "current_task": "resume me",
                "execution_order": [],
                "accumulated_usage": {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0},
                "accumulated_metrics": {"latencyMs": 0},
                "execution_count": 0,
                "execution_time": 555,
                "_internal_state": {"interrupt_state": {"activated": False, "context": {}, "interrupts": {}}},
            }
        )

        # The node advances the clock by 1200ms while it "runs".
        async def advancing_stream(*args, **kwargs):
            clock["now"] += 1.2
            yield {"result": graph.nodes["test_node"].executor.return_value}

        graph.nodes["test_node"].executor.stream_async = Mock(side_effect=advancing_stream)

        result = await graph.invoke_async("resume me")

    # 555 restored + 1200 in-flight = 1755ms; committed exactly once.
    tru_result_time = result.execution_time
    exp_result_time = 1755
    assert tru_result_time == exp_result_time
    assert graph.state.execution_time == exp_result_time


@pytest.mark.asyncio
async def test_graph_checkpoint_persists_in_flight_execution_time(mock_strands_tracer, mock_use_span):
    """A mid-run per-node checkpoint persists elapsed time so a resumed run keeps its timeout budget.

    Guards the crash-restart path: the AfterNodeCall session sync serializes before the invocation's
    finally commits the interval, so serialize_state must fold the in-flight interval into
    execution_time rather than persisting the stale pre-invocation value (which would reset the budget).
    """
    clock = {"now": 2000.4}

    builder = GraphBuilder()
    builder.add_node(create_mock_agent("test_agent"), "test_node")
    builder.set_entry_point("test_node")
    graph = builder.build()

    with patch("strands.multiagent.graph.time.time", lambda: clock["now"]):
        # Marker set at invocation start; a checkpoint taken 400ms in must reflect that interval.
        graph._invocation_start_time = 2000.0
        graph.state.status = Status.EXECUTING
        checkpoint = graph.serialize_state()

    assert checkpoint["execution_time"] == 400


@pytest.mark.asyncio
async def test_graph_tracing_setup_failure_does_not_leak_timer(mock_strands_tracer, mock_use_span):
    """A tracing setup failure must not leave the invocation timer running.

    The timer starts inside the span context so its clearing finally is guaranteed to run. If span
    setup raises before then, no interval is started, and a later serialize_state must not accrue
    wall time against an abandoned invocation.
    """
    clock = {"now": 1000.0}
    mock_strands_tracer.start_multiagent_span.side_effect = RuntimeError("span setup failed")

    builder = GraphBuilder()
    builder.add_node(create_mock_agent("test_agent"), "test_node")
    builder.set_entry_point("test_node")
    graph = builder.build()

    with patch("strands.multiagent.graph.time.time", lambda: clock["now"]):
        with pytest.raises(RuntimeError, match="span setup failed"):
            await graph.invoke_async("go")
        clock["now"] = 1000.5  # 500ms later
        checkpoint = graph.serialize_state()

    assert graph._invocation_start_time is None
    assert checkpoint["execution_time"] == 0


@pytest.mark.parametrize(
    ("cancel_node", "cancel_message"),
    [(True, "node cancelled by user"), ("custom cancel message", "custom cancel message")],
)
@pytest.mark.asyncio
async def test_graph_cancel_node(cancel_node, cancel_message):
    def cancel_callback(event):
        event.cancel_node = cancel_node
        return event

    agent = create_mock_agent("test_agent", "Should not execute")
    builder = GraphBuilder()
    builder.add_node(agent, "test_agent")
    builder.set_entry_point("test_agent")
    graph = builder.build()
    graph.hooks.add_callback(BeforeNodeCallEvent, cancel_callback)

    stream = graph.stream_async("test task")

    tru_cancel_event = None
    with pytest.raises(RuntimeError, match=cancel_message):
        async for event in stream:
            if event.get("type") == "multiagent_node_cancel":
                tru_cancel_event = event

    exp_cancel_event = MultiAgentNodeCancelEvent(node_id="test_agent", message=cancel_message)
    assert tru_cancel_event == exp_cancel_event

    tru_status = graph.state.status
    exp_status = Status.FAILED
    assert tru_status == exp_status


def test_graph_interrupt_on_before_node_call_event(interrupt_hook):
    agent = create_mock_agent("test_agent", "Task completed")

    builder = GraphBuilder()
    builder.add_node(agent, "test_agent")
    builder.set_hook_providers([interrupt_hook])
    graph = builder.build()

    multiagent_result = graph("Test task")

    first_execution_time = multiagent_result.execution_time

    tru_result_status = multiagent_result.status
    exp_result_status = Status.INTERRUPTED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.INTERRUPTED
    assert tru_state_status == exp_state_status

    tru_node_ids = [node.node_id for node in graph.state.interrupted_nodes]
    exp_node_ids = ["test_agent"]
    assert tru_node_ids == exp_node_ids

    tru_interrupts = multiagent_result.interrupts
    exp_interrupts = [
        Interrupt(
            id=ANY,
            name="test_name",
            reason="test_reason",
        ),
    ]
    assert tru_interrupts == exp_interrupts

    tru_after_count = interrupt_hook.after_count
    exp_after_count = 0
    assert tru_after_count == exp_after_count

    interrupt = multiagent_result.interrupts[0]
    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "test_response",
            },
        },
    ]
    multiagent_result = graph(responses)

    tru_result_status = multiagent_result.status
    exp_result_status = Status.COMPLETED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.COMPLETED
    assert tru_state_status == exp_state_status

    assert len(multiagent_result.results) == 1
    agent_result = multiagent_result.results["test_agent"]

    tru_message = agent_result.result.message["content"][0]["text"]
    exp_message = "Task completed"
    assert tru_message == exp_message

    tru_after_count = interrupt_hook.after_count
    exp_after_count = 1
    assert tru_after_count == exp_after_count

    assert multiagent_result.execution_time >= first_execution_time


def test_graph_interrupt_on_agent(agenerator):
    exp_interrupts = [
        Interrupt(
            id="test_id",
            name="test_name",
            reason="test_reason",
        )
    ]

    agent = create_mock_agent("test_agent", "Task completed")
    agent.stream_async = Mock()
    agent.stream_async.return_value = agenerator(
        [
            {
                "result": AgentResult(
                    message={},
                    stop_reason="interrupt",
                    state={},
                    metrics=None,
                    interrupts=exp_interrupts,
                ),
            },
        ],
    )

    builder = GraphBuilder()
    builder.add_node(agent, "test_agent")
    graph = builder.build()

    multiagent_result = graph("Test task")

    tru_result_status = multiagent_result.status
    exp_result_status = Status.INTERRUPTED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.INTERRUPTED
    assert tru_state_status == exp_state_status

    tru_node_ids = [node.node_id for node in graph.state.interrupted_nodes]
    exp_node_ids = ["test_agent"]
    assert tru_node_ids == exp_node_ids

    tru_interrupts = multiagent_result.interrupts
    assert tru_interrupts == exp_interrupts

    interrupt = multiagent_result.interrupts[0]

    agent.stream_async = Mock()
    agent.stream_async.return_value = agenerator(
        [
            {
                "result": AgentResult(
                    message={},
                    stop_reason="end_turn",
                    state={},
                    metrics=None,
                ),
            },
        ],
    )
    graph._interrupt_state.context["test_agent"] = {
        "from_hook": False,
        "interrupt_ids": [interrupt.id],
        "interrupt_state": {
            "activated": True,
            "context": {},
            "interrupts": {interrupt.id: interrupt.to_dict()},
        },
        "messages": [],
        "state": {},
        "model_state": {},
    }

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "test_response",
            },
        },
    ]
    multiagent_result = graph(responses)

    tru_result_status = multiagent_result.status
    exp_result_status = Status.COMPLETED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.COMPLETED
    assert tru_state_status == exp_state_status

    assert len(multiagent_result.results) == 1

    agent.stream_async.assert_called_once_with(responses, invocation_state={})


def test_graph_interrupt_on_multiagent(agenerator):
    exp_interrupts = [
        Interrupt(
            id="test_id",
            name="test_name",
            reason="test_reason",
        )
    ]

    multiagent = create_mock_multi_agent("test_multiagent", "Multi-agent completed")
    multiagent.stream_async = Mock()
    multiagent.stream_async.return_value = agenerator(
        [
            {
                "result": MultiAgentResult(
                    results={},
                    status=Status.INTERRUPTED,
                    interrupts=exp_interrupts,
                ),
            },
        ],
    )

    builder = GraphBuilder()
    builder.add_node(multiagent, "test_multiagent")
    graph = builder.build()

    multiagent_result = graph("Test task")

    tru_result_status = multiagent_result.status
    exp_result_status = Status.INTERRUPTED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.INTERRUPTED
    assert tru_state_status == exp_state_status

    tru_node_ids = [node.node_id for node in graph.state.interrupted_nodes]
    exp_node_ids = ["test_multiagent"]
    assert tru_node_ids == exp_node_ids

    tru_interrupts = multiagent_result.interrupts
    assert tru_interrupts == exp_interrupts

    interrupt = multiagent_result.interrupts[0]

    multiagent.stream_async = Mock()
    multiagent.stream_async.return_value = agenerator(
        [
            {
                "result": MultiAgentResult(
                    results={
                        "inner_node": NodeResult(
                            result=AgentResult(
                                message={"role": "assistant", "content": [{"text": "Inner completed"}]},
                                stop_reason="end_turn",
                                state={},
                                metrics={},
                            )
                        )
                    },
                    status=Status.COMPLETED,
                ),
            },
        ],
    )
    graph._interrupt_state.context["test_multiagent"] = {
        "from_hook": False,
        "interrupt_ids": [interrupt.id],
    }

    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "test_response",
            },
        },
    ]
    multiagent_result = graph(responses)

    tru_result_status = multiagent_result.status
    exp_result_status = Status.COMPLETED
    assert tru_result_status == exp_result_status

    tru_state_status = graph.state.status
    exp_state_status = Status.COMPLETED
    assert tru_state_status == exp_state_status

    assert len(multiagent_result.results) == 1

    multiagent.stream_async.assert_called_once_with(responses, {})


@pytest.mark.asyncio
async def test_graph_with_agentbase_implementation(mock_strands_tracer, mock_use_span):
    """Test that Graph accepts any AgentBase implementation (not just Agent)."""

    # Create a minimal AgentBase implementation
    class CustomAgentBase:
        """Custom AgentBase implementation for testing."""

        def __init__(self, name: str, response_text: str):
            self.name = name
            self.id = f"{name}_id"
            self._response_text = response_text

        def __call__(self, prompt=None, **kwargs):
            return AgentResult(
                message={"role": "assistant", "content": [{"text": self._response_text}]},
                stop_reason="end_turn",
                state={},
                metrics=Mock(
                    accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
                    accumulated_metrics={"latencyMs": 100.0},
                ),
            )

        async def invoke_async(self, prompt=None, **kwargs):
            return self(prompt, **kwargs)

        async def stream_async(self, prompt=None, **kwargs):
            yield {"start": True}
            yield {"result": self(prompt, **kwargs)}

    # Verify it satisfies AgentBase protocol
    custom_agent = CustomAgentBase("custom", "Custom response")
    assert isinstance(custom_agent, AgentBase)

    # Create a regular mock agent
    regular_agent = create_mock_agent("regular", "Regular response")

    # Build graph with both
    builder = GraphBuilder()
    builder.add_node(custom_agent, "custom_node")
    builder.add_node(regular_agent, "regular_node")
    builder.add_edge("custom_node", "regular_node")
    builder.set_entry_point("custom_node")
    graph = builder.build()

    result = await graph.invoke_async("Test task")

    assert result.status == Status.COMPLETED
    assert result.completed_nodes == 2
    assert "custom_node" in result.results
    assert "regular_node" in result.results


def test_find_newly_ready_nodes_only_evaluates_outbound_edges():
    """Verify _find_newly_ready_nodes only checks destinations of outbound edges from completed batch.

    Previously, it iterated over ALL nodes, which could cause nodes to fire
    before their actual dependencies completed.

    See: https://github.com/strands-agents/harness-sdk/issues/685
    """
    # Build a graph: A -> B -> C, D -> E (independent chain)
    node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
    node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
    node_c = GraphNode(node_id="C", executor=create_mock_agent("C"))
    node_d = GraphNode(node_id="D", executor=create_mock_agent("D"))
    node_e = GraphNode(node_id="E", executor=create_mock_agent("E"))

    graph = _make_graph(
        nodes={"A": node_a, "B": node_b, "C": node_c, "D": node_d, "E": node_e},
        edges={
            GraphEdge(from_node=node_a, to_node=node_b),
            GraphEdge(from_node=node_b, to_node=node_c),
            GraphEdge(from_node=node_d, to_node=node_e),
        },
    )

    # When A completes, only B should be ready (not E)
    ready = graph._find_newly_ready_nodes([node_a])
    ready_ids = {n.node_id for n in ready}
    assert ready_ids == {"B"}, f"Expected only B, got {ready_ids}"

    # When D completes, only E should be ready (not B or C)
    ready = graph._find_newly_ready_nodes([node_d])
    ready_ids = {n.node_id for n in ready}
    assert ready_ids == {"E"}, f"Expected only E, got {ready_ids}"


# =============================================================================
# Tests for EdgeConditionWithContext (invocation_state in edge conditions)
# =============================================================================


class TestEdgeConditionProtocol:
    """Tests for the EdgeConditionWithContext protocol and dispatch logic."""

    def test_legacy_condition_still_works(self):
        """Verify Callable[[GraphState], bool] conditions work unchanged."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        def legacy_condition(state: GraphState) -> bool:
            return len(state.completed_nodes) > 0

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=legacy_condition)

        assert not edge.should_traverse(GraphState(), invocation_state={})
        assert edge.should_traverse(GraphState(completed_nodes={node_a}), invocation_state={})

    def test_legacy_condition_not_affected_by_invocation_state(self):
        """Legacy conditions should work even when invocation_state is passed."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        def legacy_condition(state: GraphState) -> bool:
            return True

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=legacy_condition)
        assert edge.should_traverse(GraphState(), invocation_state={"key": "value"})

    def test_new_style_condition_receives_invocation_state(self):
        """Verify EdgeConditionWithContext receives invocation_state kwarg."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        received_invocation_state = {}

        def context_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            received_invocation_state.update(invocation_state)
            return invocation_state.get("enable_path", False)

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=context_condition)

        # Without the flag, should not traverse
        assert not edge.should_traverse(GraphState(), invocation_state={"enable_path": False})
        assert received_invocation_state == {"enable_path": False}

        # With the flag, should traverse
        received_invocation_state.clear()
        assert edge.should_traverse(GraphState(), invocation_state={"enable_path": True})
        assert received_invocation_state == {"enable_path": True}

    def test_condition_none_always_traverses(self):
        """Verify edges without conditions always traverse."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=None)
        assert edge.should_traverse(GraphState(), invocation_state={})
        assert edge.should_traverse(GraphState(), invocation_state={"anything": True})

    def test_new_style_condition_with_kwargs_extensibility(self):
        """Verify conditions with **kwargs work for future extensibility."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        def extensible_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return True

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=extensible_condition)
        assert edge.should_traverse(GraphState(), invocation_state={})

    def test_invocation_state_empty_dict_passed_through(self):
        """Verify empty dict is passed through to context conditions."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))

        received = []

        def context_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            received.append(invocation_state)
            return True

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=context_condition)
        assert edge.should_traverse(GraphState(), invocation_state={})
        assert received == [{}]


class TestInvocationStatePropagation:
    """Tests that invocation_state flows correctly through graph execution paths."""

    def test_is_node_ready_with_conditions_passes_invocation_state(self):
        """Verify _is_node_ready_with_conditions passes invocation_state to edge conditions."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_b.dependencies.add(node_a)

        received_state = {}

        def context_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            received_state.update(invocation_state)
            return invocation_state.get("activate", False)

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=context_condition)

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b},
            edges={edge},
            state=GraphState(completed_nodes={node_a}),
            invocation_state={"activate": True},
        )

        assert graph._is_node_ready_with_conditions(node_b, [node_a])
        assert received_state == {"activate": True}

    def test_is_node_ready_with_conditions_invocation_state_false(self):
        """Verify condition returning False blocks node readiness."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_b.dependencies.add(node_a)

        def context_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return invocation_state.get("activate", False)

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=context_condition)

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b},
            edges={edge},
            state=GraphState(completed_nodes={node_a}),
            invocation_state={"activate": False},
        )

        assert not graph._is_node_ready_with_conditions(node_b, [node_a])

    def test_build_node_input_passes_invocation_state(self):
        """Verify _build_node_input uses invocation_state for edge condition evaluation."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_b.dependencies.add(node_a)

        def context_condition(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return invocation_state.get("include_dep", False)

        edge = GraphEdge(from_node=node_a, to_node=node_b, condition=context_condition)

        mock_result = AgentResult(
            message={"role": "assistant", "content": [{"text": "result from A"}]},
            stop_reason="end_turn",
            state={},
            metrics=Mock(
                accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
                accumulated_metrics={"latencyMs": 100.0},
            ),
        )

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b},
            edges={edge},
            state=GraphState(
                task="test task",
                completed_nodes={node_a},
                results={"A": NodeResult(result=mock_result)},
            ),
            invocation_state={"include_dep": False},
        )

        # With condition=False, dependency is excluded -> gets raw task
        node_input = graph._build_node_input(node_b)
        assert any("test task" in str(block) for block in node_input)

        # With condition=True, dependency result is included
        graph._current_invocation_state = {"include_dep": True}
        node_input = graph._build_node_input(node_b)
        input_text = " ".join(str(block) for block in node_input)
        assert "result from A" in input_text


class TestResumeDeadlockFix:
    """Tests for the _compute_ready_nodes_for_resume deadlock fix with conditional edges."""

    def test_resume_skips_false_condition_edges(self):
        """Graph: A->(cond=False)->B, A->(unconditional)->C. C should be ready on resume."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_c = GraphNode(node_id="C", executor=create_mock_agent("C"))
        node_b.dependencies.add(node_a)
        node_c.dependencies.add(node_a)

        def always_false(state: GraphState) -> bool:
            return False

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b, "C": node_c},
            edges={
                GraphEdge(from_node=node_a, to_node=node_b, condition=always_false),
                GraphEdge(from_node=node_a, to_node=node_c),  # unconditional
            },
            state=GraphState(status=Status.INTERRUPTED, completed_nodes={node_a}),
        )

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        # C should be ready (unconditional edge from A), B should not (condition=False)
        assert "C" in ready_ids
        assert "B" not in ready_ids

    def test_resume_diamond_with_conditional_skip(self):
        """Exact scenario from issue comment: A->(cond=True)->B->C, A->(cond=False)->C.

        When condition is False, B is skipped. C has two incoming edges:
        - B->C (unconditional, but B never ran)
        - A->C (condition=False, should be excluded from readiness check)

        Without the fix, C is stuck because all() requires both edges satisfied.
        With the fix, the A->C edge is excluded (condition=False), and since there
        are no other traversable edges with incomplete sources, we need B->C.
        But B never ran, so C can't be ready via B->C either.

        The correct fix scenario: when condition selects the FAST path (True),
        B runs and C should be ready via B->C (excluding A->C which is False).
        """
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_c = GraphNode(node_id="C", executor=create_mock_agent("C"))
        node_b.dependencies.add(node_a)
        node_c.dependencies.add(node_a)
        node_c.dependencies.add(node_b)

        def use_fast_path(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return invocation_state.get("fast", False)

        def skip_direct(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return not invocation_state.get("fast", False)

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b, "C": node_c},
            edges={
                GraphEdge(from_node=node_a, to_node=node_b, condition=use_fast_path),
                GraphEdge(from_node=node_a, to_node=node_c, condition=skip_direct),
                GraphEdge(from_node=node_b, to_node=node_c),
            },
            state=GraphState(status=Status.INTERRUPTED, completed_nodes={node_a, node_b}),
            invocation_state={"fast": True},
        )

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        # C should be ready: A->C edge excluded (condition=False), B->C is unconditional and B completed
        assert "C" in ready_ids

    def test_resume_all_conditions_false_blocks_node(self):
        """If ALL incoming edges have conditions that are False, node should not be ready."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_b.dependencies.add(node_a)

        def always_false(state: GraphState) -> bool:
            return False

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b},
            edges={
                GraphEdge(from_node=node_a, to_node=node_b, condition=always_false),
            },
            state=GraphState(status=Status.INTERRUPTED, completed_nodes={node_a}),
        )

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        assert "B" not in ready_ids

    def test_resume_with_invocation_state_condition(self):
        """Condition uses invocation_state; on resume with same state, correct routing."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_c = GraphNode(node_id="C", executor=create_mock_agent("C"))
        node_b.dependencies.add(node_a)
        node_c.dependencies.add(node_a)

        def check_role(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return invocation_state.get("role") == "admin"

        def check_not_admin(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return invocation_state.get("role") != "admin"

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b, "C": node_c},
            edges={
                GraphEdge(from_node=node_a, to_node=node_b, condition=check_role),
                GraphEdge(from_node=node_a, to_node=node_c, condition=check_not_admin),
            },
            state=GraphState(status=Status.INTERRUPTED, completed_nodes={node_a}),
        )

        # As admin: only B should be ready
        graph._current_invocation_state = {"role": "admin"}
        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        assert ready_ids == {"B"}

        # As non-admin: only C should be ready
        graph._current_invocation_state = {"role": "user"}
        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        assert ready_ids == {"C"}

    def test_resume_mixed_conditional_unconditional_edges(self):
        """Node with both conditional (False) and unconditional edges: ready if unconditional source completed."""
        node_a = GraphNode(node_id="A", executor=create_mock_agent("A"))
        node_b = GraphNode(node_id="B", executor=create_mock_agent("B"))
        node_c = GraphNode(node_id="C", executor=create_mock_agent("C"))
        node_b.dependencies.add(node_a)
        node_c.dependencies.add(node_a)
        node_c.dependencies.add(node_b)

        def always_false(state: GraphState) -> bool:
            return False

        graph = _make_graph(
            nodes={"A": node_a, "B": node_b, "C": node_c},
            edges={
                GraphEdge(from_node=node_a, to_node=node_b),  # unconditional
                GraphEdge(from_node=node_a, to_node=node_c, condition=always_false),  # conditional (False)
                GraphEdge(from_node=node_b, to_node=node_c),  # unconditional
            },
            state=GraphState(status=Status.INTERRUPTED, completed_nodes={node_a, node_b}),
        )

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = {n.node_id for n in ready}
        # C should be ready: A->C is excluded (condition=False), B->C is unconditional and B completed
        assert "C" in ready_ids


class TestConditionSignatureDetection:
    """Tests for the _is_context_condition helper."""

    def test_detects_legacy_condition(self):
        """Legacy condition without invocation_state param."""
        from strands.multiagent.graph import _is_context_condition

        def legacy(state: GraphState) -> bool:
            return True

        assert not _is_context_condition(legacy)

    def test_detects_new_style_condition(self):
        """New-style condition with invocation_state param."""
        from strands.multiagent.graph import _is_context_condition

        def new_style(state: GraphState, *, invocation_state: dict, **kwargs) -> bool:
            return True

        assert _is_context_condition(new_style)

    def test_detects_positional_invocation_state(self):
        """Condition with invocation_state as positional param (also supported)."""
        from strands.multiagent.graph import _is_context_condition

        def positional(state: GraphState, invocation_state: dict) -> bool:
            return True

        assert _is_context_condition(positional)

    def test_lambda_without_invocation_state(self):
        """Lambda conditions (legacy pattern)."""
        from strands.multiagent.graph import _is_context_condition

        cond = lambda state: len(state.completed_nodes) > 0  # noqa: E731
        assert not _is_context_condition(cond)


@pytest.mark.asyncio
async def test_reset_executor_state_preserves_graph_state_for_nested_graph():
    """Verify reset_executor_state does not corrupt MultiAgentBase state.

    When a GraphNode wraps a MultiAgentBase executor (e.g. a nested Graph),
    reset_executor_state() must not overwrite GraphState with AgentState.
    Regression test for #1775.
    """
    inner_agent = create_mock_agent("inner", "inner response")
    inner_builder = GraphBuilder()
    inner_builder.add_node(inner_agent, "inner_node")
    inner_builder.set_entry_point("inner_node")
    inner_graph = inner_builder.build()

    # inner_graph.state is a GraphState, not AgentState
    assert isinstance(inner_graph.state, GraphState)

    node = GraphNode(node_id="nested", executor=inner_graph)

    # Simulate a completed execution
    node.execution_status = Status.COMPLETED
    node.result = NodeResult(result=MagicMock(), status=Status.COMPLETED)

    # Reset should NOT corrupt the nested graph's state
    node.reset_executor_state()

    # After reset, the executor's state must still be GraphState
    assert isinstance(inner_graph.state, GraphState), "reset_executor_state overwrote GraphState with AgentState"
    assert node.execution_status == Status.PENDING
    assert node.result is None


# ---------------------------------------------------------------------------
# Test: _is_node_ready_for_resume excludes edges from bypassed nodes
# ---------------------------------------------------------------------------


class TestResumeBypassedNodes:
    """Verify _is_node_ready_for_resume excludes edges from bypassed (never-executed) nodes.

    When conditional edges create a skip/bypass pattern (A→C bypassing B), node B
    may never execute. Its unconditional outgoing edge B→C should not block C from
    being ready for resume, because B was intentionally bypassed.

    Regression test for strands-agents/sdk-python#3068.
    """

    @pytest.mark.asyncio
    async def test_bypassed_node_does_not_block_resume(self):
        """C should be in next_nodes_to_execute even though B (bypassed) has an unconditional edge to C."""
        agent_a = create_mock_agent("A", "a done")
        agent_b = create_mock_agent("B", "b done")
        agent_c = create_mock_agent("C", "c done")

        builder = GraphBuilder()
        builder.add_node(agent_a, "A")
        builder.add_node(agent_b, "B")
        builder.add_node(agent_c, "C")

        # A→B: enter only when skip_flag is falsy
        def enter_b(state, *, invocation_state, **kwargs):
            return not (invocation_state or {}).get("skip_flag", False)

        # A→C: bypass B when skip_flag is truthy
        def bypass_to_c(state, *, invocation_state, **kwargs):
            return (invocation_state or {}).get("skip_flag", False)

        builder.add_edge("A", "B", condition=enter_b)
        builder.add_edge("A", "C", condition=bypass_to_c)
        builder.add_edge("B", "C")  # unconditional

        graph = builder.build()

        # Simulate: A completed, B bypassed (never executed), C interrupted
        node_a = graph.nodes["A"]
        _node_b = graph.nodes["B"]
        node_c = graph.nodes["C"]

        node_a.execution_status = Status.COMPLETED
        node_c.execution_status = Status.INTERRUPTED

        graph.state.status = Status.INTERRUPTED
        graph.state.completed_nodes = {node_a}
        graph.state.interrupted_nodes = {node_c}
        graph._current_invocation_state = {"skip_flag": True}

        # Compute ready nodes for resume
        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = [n.node_id for n in ready]

        # C should be ready — its bypass edge from A is satisfied
        assert "C" in ready_ids, (
            f"Expected 'C' in next_nodes_to_execute, got {ready_ids}. Edge from bypassed node B should not block C."
        )
        # B should NOT be ready — its enter condition is False
        assert "B" not in ready_ids

    @pytest.mark.asyncio
    async def test_parallel_fan_in_still_waits_for_all(self):
        """AND-join is preserved for parallel fan-in (non-bypassed nodes)."""
        agent_a = create_mock_agent("A", "a done")
        agent_b = create_mock_agent("B", "b done")
        agent_c = create_mock_agent("C", "c done")

        builder = GraphBuilder()
        builder.add_node(agent_a, "A")
        builder.add_node(agent_b, "B")
        builder.add_node(agent_c, "C")

        # Both A and B feed into C (parallel fan-in, unconditional)
        builder.add_edge("A", "C")
        builder.add_edge("B", "C")

        graph = builder.build()

        node_a = graph.nodes["A"]
        node_b = graph.nodes["B"]
        _node_c = graph.nodes["C"]

        # Only A completed, B is still in progress (touched but not done)
        node_a.execution_status = Status.COMPLETED
        node_b.execution_status = Status.INTERRUPTED  # touched but not completed

        graph.state.status = Status.INTERRUPTED
        graph.state.completed_nodes = {node_a}
        graph.state.interrupted_nodes = {node_b}
        graph._current_invocation_state = {}

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = [n.node_id for n in ready]

        # C should NOT be ready — B is touched (interrupted) but not completed
        # AND-join requires all touched sources to be completed
        assert "C" not in ready_ids, "AND-join should still wait for interrupted node B to complete"
        # B is an entry point (no incoming edges), so it is always ready.
        assert "B" in ready_ids

    @pytest.mark.asyncio
    async def test_node_with_only_bypassed_source_is_not_ready(self):
        """A node whose only incoming edge comes from a bypassed source is not ready for resume."""
        agent_a = create_mock_agent("A", "a done")
        agent_b = create_mock_agent("B", "b done")
        agent_c = create_mock_agent("C", "c done")

        builder = GraphBuilder()
        builder.add_node(agent_a, "A")
        builder.add_node(agent_b, "B")
        builder.add_node(agent_c, "C")

        # A→B: skipped when skip_flag is truthy, so B is bypassed
        def enter_b(state, *, invocation_state, **kwargs):
            return not (invocation_state or {}).get("skip_flag", False)

        builder.add_edge("A", "B", condition=enter_b)
        builder.add_edge("B", "C")  # C's only source is the bypassed B

        graph = builder.build()

        # A completed, B bypassed (never touched)
        node_a = graph.nodes["A"]
        node_a.execution_status = Status.COMPLETED

        graph.state.status = Status.INTERRUPTED
        graph.state.completed_nodes = {node_a}
        graph._current_invocation_state = {"skip_flag": True}

        ready = graph._compute_ready_nodes_for_resume()
        ready_ids = [n.node_id for n in ready]

        # C is not ready — its only incoming edge is from the bypassed B
        assert "C" not in ready_ids, "Node with only a bypassed source should not be ready"
        # B is not ready — its enter condition is False
        assert "B" not in ready_ids

    @pytest.mark.asyncio
    async def test_serialize_deserialize_with_bypassed_node(self):
        """Full serialize/deserialize cycle with a bypassed node produces correct resume."""
        agent_a = create_mock_agent("A", "a done")
        agent_b = create_mock_agent("B", "b done")
        agent_c = create_mock_agent("C", "c done")

        builder = GraphBuilder()
        builder.add_node(agent_a, "A")
        builder.add_node(agent_b, "B")
        builder.add_node(agent_c, "C")

        def enter_b(state, *, invocation_state, **kwargs):
            return not (invocation_state or {}).get("skip_flag", False)

        def bypass_to_c(state, *, invocation_state, **kwargs):
            return (invocation_state or {}).get("skip_flag", False)

        builder.add_edge("A", "B", condition=enter_b)
        builder.add_edge("A", "C", condition=bypass_to_c)
        builder.add_edge("B", "C")

        graph = builder.build()

        # Simulate state after: A completed, B bypassed, C interrupted
        node_a = graph.nodes["A"]
        node_c = graph.nodes["C"]
        node_a.execution_status = Status.COMPLETED
        node_c.execution_status = Status.INTERRUPTED

        graph.state.status = Status.INTERRUPTED
        graph.state.completed_nodes = {node_a}
        graph.state.interrupted_nodes = {node_c}
        graph.state.execution_order = [node_a]
        graph.state.results = {}
        graph._current_invocation_state = {"skip_flag": True}

        # Serialize
        payload = graph.serialize_state()

        assert "C" in payload["next_nodes_to_execute"], (
            f"Expected 'C' in serialized next_nodes_to_execute, got {payload['next_nodes_to_execute']}"
        )

        # Deserialize into a fresh graph
        graph2 = builder.build()
        graph2._current_invocation_state = {"skip_flag": True}
        graph2.deserialize_state(payload)

        assert graph2._resume_from_session is True, "Graph should resume from session, not reset"

    @pytest.mark.asyncio
    async def test_resume_executes_bypassed_join_target_end_to_end(self):
        """Resuming after deserialize actually runs C — the node blocked by a bypassed source.

        Guards the full serialize→deserialize→resume path (not just the computed
        next_nodes_to_execute) for strands-agents/sdk-python#3068.
        """
        agent_a = create_mock_agent("A", "a done")
        agent_b = create_mock_agent("B", "b done")
        agent_c = create_mock_agent("C", "c done")

        builder = GraphBuilder()
        builder.add_node(agent_a, "A")
        builder.add_node(agent_b, "B")
        builder.add_node(agent_c, "C")

        def enter_b(state, *, invocation_state, **kwargs):
            return not (invocation_state or {}).get("skip_flag", False)

        def bypass_to_c(state, *, invocation_state, **kwargs):
            return (invocation_state or {}).get("skip_flag", False)

        builder.add_edge("A", "B", condition=enter_b)
        builder.add_edge("A", "C", condition=bypass_to_c)
        builder.add_edge("B", "C")

        graph = builder.build()

        # Simulate state after: A completed, B bypassed, C interrupted
        node_a = graph.nodes["A"]
        node_c = graph.nodes["C"]
        node_a.execution_status = Status.COMPLETED
        node_c.execution_status = Status.INTERRUPTED

        graph.state.status = Status.INTERRUPTED
        graph.state.completed_nodes = {node_a}
        graph.state.interrupted_nodes = {node_c}
        graph.state.execution_order = [node_a]
        graph.state.results = {}
        graph._current_invocation_state = {"skip_flag": True}

        payload = graph.serialize_state()

        # Deserialize into a fresh graph and resume execution
        graph2 = builder.build()
        graph2.deserialize_state(payload)
        result = await graph2.invoke_async("resume", invocation_state={"skip_flag": True})

        # C runs to completion on resume; B (bypassed) never executes
        assert result.status == Status.COMPLETED
        assert "C" in result.results
        graph2.nodes["C"].executor.stream_async.assert_called()
        graph2.nodes["B"].executor.stream_async.assert_not_called()


class TestResumeInFlightSibling:
    """Verify a fan-in node is not marked ready while a parallel sibling is still in-flight.

    In a diamond root → {left, right} → join, serializing after left completes but while right is
    still executing must not mark join ready off left alone. An in-flight sibling is in none of the
    terminal sets (completed/interrupted/failed) at serialize time, and must be distinguished from a
    bypassed dead branch: join stays out of the resume frontier so a restore runs join exactly once,
    with both parents' outputs present, rather than double-running it and seeing incomplete inputs.
    """

    def test_in_flight_sibling_excluded_from_resume_frontier(self):
        """join is excluded and right included when right is still executing at serialize time."""
        builder = GraphBuilder()
        builder.add_node(create_mock_agent("root"), "root")
        builder.add_node(create_mock_agent("left"), "left")
        builder.add_node(create_mock_agent("right"), "right")
        builder.add_node(create_mock_agent("join"), "join")
        builder.add_edge("root", "left")
        builder.add_edge("root", "right")
        builder.add_edge("left", "join")
        builder.add_edge("right", "join")
        graph = builder.build()

        node_root = graph.nodes["root"]
        node_left = graph.nodes["left"]
        node_right = graph.nodes["right"]

        # root and left completed; right still executing (in none of the terminal sets)
        node_root.execution_status = Status.COMPLETED
        node_left.execution_status = Status.COMPLETED
        node_right.execution_status = Status.EXECUTING

        graph.state.status = Status.EXECUTING
        graph.state.completed_nodes = {node_root, node_left}

        payload = graph.serialize_state()

        assert "join" not in payload["next_nodes_to_execute"], (
            f"join must not be ready while sibling right is in-flight, got {payload['next_nodes_to_execute']}"
        )
        assert "right" in payload["next_nodes_to_execute"]

        ready_ids = {node.node_id for node in graph._compute_ready_nodes_for_resume()}
        assert ready_ids == {"right"}

    @pytest.mark.asyncio
    async def test_resume_runs_fan_in_once_with_both_inputs(self):
        """A restore from a mid-flight snapshot runs the fan-in exactly once with both inputs present."""
        release_right = asyncio.Event()

        agent_right = create_mock_agent("right", "right done")

        async def blocking_right_stream(*args, **kwargs):
            # Block right so the snapshot is captured while it is genuinely in-flight.
            yield {"agent_start": True}
            await release_right.wait()
            yield {"result": agent_right.return_value}

        agent_right.stream_async = Mock(side_effect=blocking_right_stream)

        builder = GraphBuilder()
        builder.add_node(create_mock_agent("root", "root done"), "root")
        builder.add_node(create_mock_agent("left", "left done"), "left")
        builder.add_node(agent_right, "right")
        builder.add_node(create_mock_agent("join", "join done"), "join")
        builder.add_edge("root", "left")
        builder.add_edge("root", "right")
        builder.add_edge("left", "join")
        builder.add_edge("right", "join")
        graph = builder.build()

        captured: dict = {}

        def capture_on_left(event):
            # left completes while right is still blocked — snapshot the live-sibling state, then
            # release right so the first graph can finish.
            if event.node_id == "left" and "payload" not in captured:
                captured["payload"] = event.source.serialize_state()
                release_right.set()

        graph.add_hook(capture_on_left, AfterNodeCallEvent)

        await graph.invoke_async("diamond task")

        assert "payload" in captured, "left's AfterNodeCallEvent should fire while right is in-flight"
        assert "join" not in captured["payload"]["next_nodes_to_execute"]

        # Resume into a fresh graph with independent executor mocks, since the call-count and input
        # assertions target the resumed graph's nodes.
        builder2 = GraphBuilder()
        builder2.add_node(create_mock_agent("root", "root done"), "root")
        builder2.add_node(create_mock_agent("left", "left done"), "left")
        builder2.add_node(create_mock_agent("right", "right done"), "right")
        agent_join2 = create_mock_agent("join", "join done")
        builder2.add_node(agent_join2, "join")
        builder2.add_edge("root", "left")
        builder2.add_edge("root", "right")
        builder2.add_edge("left", "join")
        builder2.add_edge("right", "join")
        graph2 = builder2.build()

        graph2.deserialize_state(captured["payload"])
        result = await graph2.invoke_async("diamond task")

        # join runs exactly once — a stale frontier including join would double-run it.
        assert agent_join2.stream_async.call_count == 1
        assert result.status == Status.COMPLETED
        assert "join" in result.results

        # join's single run sees both parents' outputs.
        join_input = agent_join2.stream_async.call_args.args[0]
        join_input_text = " ".join(str(block) for block in join_input)
        assert "From left:" in join_input_text
        assert "From right:" in join_input_text

    def test_in_flight_entry_point_sibling_excluded_from_resume_frontier(self):
        """An in-flight sibling with no completed ancestor still blocks the fan-in.

        Two entry points left and right feed join with no shared root. When left completes while
        right is still executing, right has no completed ancestor, so forward reachability from
        completed nodes alone would miss it. The in-flight node itself is the seed that keeps join
        out of the frontier.
        """
        builder = GraphBuilder()
        builder.add_node(create_mock_agent("left"), "left")
        builder.add_node(create_mock_agent("right"), "right")
        builder.add_node(create_mock_agent("join"), "join")
        builder.set_entry_point("left")
        builder.set_entry_point("right")
        builder.add_edge("left", "join")
        builder.add_edge("right", "join")
        graph = builder.build()

        node_left = graph.nodes["left"]
        node_right = graph.nodes["right"]

        # left completed; right still executing, with no completed ancestor to reach it from
        node_left.execution_status = Status.COMPLETED
        node_right.execution_status = Status.EXECUTING

        graph.state.status = Status.EXECUTING
        graph.state.completed_nodes = {node_left}

        payload = graph.serialize_state()

        assert "join" not in payload["next_nodes_to_execute"], (
            f"join must not be ready while in-flight entry point right is outstanding, "
            f"got {payload['next_nodes_to_execute']}"
        )
        assert "right" in payload["next_nodes_to_execute"]

    @pytest.mark.asyncio
    async def test_resume_runs_fan_in_once_for_in_flight_entry_point_sibling(self):
        """End-to-end restore when the in-flight sibling is an entry point with no completed ancestor.

        Two entry points left and right feed join. left completes while right is still blocked; the
        snapshot is captured mid-flight, then resumed into a fresh graph. join must run exactly once
        with both parents' outputs present.
        """
        right_executing = asyncio.Event()
        release_right = asyncio.Event()

        agent_left = create_mock_agent("left", "left done")
        agent_right = create_mock_agent("right", "right done")

        async def blocking_right_stream(*args, **kwargs):
            # right has entered execution (status EXECUTING) by the time its stream runs; signal
            # that, then block so the snapshot is captured while right is genuinely in-flight.
            yield {"agent_start": True}
            right_executing.set()
            await release_right.wait()
            yield {"result": agent_right.return_value}

        async def left_stream_after_right_executing(*args, **kwargs):
            # Gate left's completion on right being in-flight, so the snapshot is deterministic
            # regardless of the order the parallel entry-point tasks are scheduled.
            yield {"agent_start": True}
            await right_executing.wait()
            yield {"result": agent_left.return_value}

        agent_left.stream_async = Mock(side_effect=left_stream_after_right_executing)
        agent_right.stream_async = Mock(side_effect=blocking_right_stream)

        builder = GraphBuilder()
        builder.add_node(agent_left, "left")
        builder.add_node(agent_right, "right")
        builder.add_node(create_mock_agent("join", "join done"), "join")
        builder.set_entry_point("left")
        builder.set_entry_point("right")
        builder.add_edge("left", "join")
        builder.add_edge("right", "join")
        graph = builder.build()

        captured: dict = {}

        def capture_on_left(event):
            if event.node_id == "left" and "payload" not in captured:
                captured["payload"] = event.source.serialize_state()
                release_right.set()

        graph.add_hook(capture_on_left, AfterNodeCallEvent)

        await graph.invoke_async("two entry points")

        assert "payload" in captured, "left's AfterNodeCallEvent should fire while right is in-flight"
        assert "join" not in captured["payload"]["next_nodes_to_execute"]

        # Resume into a fresh graph with independent executor mocks.
        builder2 = GraphBuilder()
        builder2.add_node(create_mock_agent("left", "left done"), "left")
        builder2.add_node(create_mock_agent("right", "right done"), "right")
        agent_join2 = create_mock_agent("join", "join done")
        builder2.add_node(agent_join2, "join")
        builder2.set_entry_point("left")
        builder2.set_entry_point("right")
        builder2.add_edge("left", "join")
        builder2.add_edge("right", "join")
        graph2 = builder2.build()

        graph2.deserialize_state(captured["payload"])
        result = await graph2.invoke_async("two entry points")

        # join runs exactly once — a stale frontier including join would double-run it.
        assert agent_join2.stream_async.call_count == 1
        assert result.status == Status.COMPLETED
        assert "join" in result.results

        # join's single run sees both parents' outputs.
        join_input = agent_join2.stream_async.call_args.args[0]
        join_input_text = " ".join(str(block) for block in join_input)
        assert "From left:" in join_input_text
        assert "From right:" in join_input_text
