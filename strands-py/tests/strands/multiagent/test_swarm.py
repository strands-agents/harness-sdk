import asyncio
import shutil
import tempfile
import time
from unittest.mock import ANY, MagicMock, Mock, patch

import pytest

from strands.agent import Agent, AgentResult
from strands.agent.state import AgentState
from strands.hooks import AfterMultiAgentInvocationEvent, AfterNodeCallEvent, BeforeNodeCallEvent
from strands.hooks.registry import HookRegistry
from strands.interrupt import Interrupt, _InterruptState
from strands.multiagent.base import NodeResult, Status
from strands.multiagent.swarm import SharedContext, Swarm, SwarmNode, SwarmResult, SwarmState, _InflightTurn
from strands.session.file_session_manager import FileSessionManager
from strands.session.session_manager import SessionManager
from strands.types._events import MultiAgentNodeStartEvent
from strands.types.content import ContentBlock


def create_mock_agent(name, response_text="Default response", metrics=None, agent_id=None, should_fail=False):
    """Create a mock Agent with specified properties."""
    agent = Mock(spec=Agent)
    agent.name = name
    agent.id = agent_id or f"{name}_id"
    agent.messages = []
    agent.state = AgentState()  # Add state attribute
    agent._interrupt_state = _InterruptState()  # Add interrupt state
    agent._model_state = {}  # Add model state
    agent.tool_registry = Mock()
    agent.tool_registry.registry = {}
    agent.tool_registry.process_tools = Mock()
    agent._call_count = 0
    agent._should_fail = should_fail
    agent._session_manager = None
    agent.hooks = HookRegistry()

    if metrics is None:
        metrics = Mock(
            accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30},
            accumulated_metrics={"latencyMs": 100.0},
        )

    def create_mock_result():
        agent._call_count += 1

        # Simulate failure if requested
        if agent._should_fail:
            raise Exception("Simulated agent failure")

        return AgentResult(
            message={"role": "assistant", "content": [{"text": response_text}]},
            stop_reason="end_turn",
            state={},
            metrics=metrics,
        )

    agent.return_value = create_mock_result()
    agent.__call__ = Mock(side_effect=create_mock_result)

    async def mock_invoke_async(*args, **kwargs):
        return create_mock_result()

    async def mock_stream_async(*args, **kwargs):
        # Simple mock stream that yields a start event and then the result
        yield {"agent_start": True, "node": name}
        yield {"agent_thinking": True, "thought": f"Processing with {name}"}
        yield {"result": create_mock_result()}

    agent.invoke_async = MagicMock(side_effect=mock_invoke_async)
    agent.stream_async = Mock(side_effect=mock_stream_async)

    return agent


@pytest.fixture
def mock_agents():
    """Create a set of mock agents for testing."""
    return {
        "coordinator": create_mock_agent("coordinator", "Coordinating task"),
        "specialist": create_mock_agent("specialist", "Specialized response"),
        "reviewer": create_mock_agent("reviewer", "Review complete"),
    }


@pytest.fixture
def mock_swarm(mock_agents):
    """Create a swarm for testing."""
    agents = list(mock_agents.values())
    swarm = Swarm(
        agents,
        max_handoffs=5,
        max_iterations=5,
        execution_timeout=30.0,
        node_timeout=10.0,
    )

    return swarm


@pytest.fixture
def mock_strands_tracer():
    with patch("strands.multiagent.swarm.get_tracer") as mock_get_tracer:
        mock_tracer_instance = MagicMock()
        mock_span = MagicMock()
        mock_tracer_instance.start_multiagent_span.return_value = mock_span
        mock_get_tracer.return_value = mock_tracer_instance
        yield mock_tracer_instance


@pytest.fixture
def mock_use_span():
    with patch("strands.multiagent.swarm.trace_api.use_span") as mock_use_span:
        yield mock_use_span


def test_swarm_structure_and_nodes(mock_swarm, mock_agents):
    """Test swarm structure and SwarmNode properties."""
    # Test swarm structure
    assert len(mock_swarm.nodes) == 3
    assert "coordinator" in mock_swarm.nodes
    assert "specialist" in mock_swarm.nodes
    assert "reviewer" in mock_swarm.nodes

    # Test SwarmNode properties
    coordinator_node = mock_swarm.nodes["coordinator"]
    assert coordinator_node.node_id == "coordinator"
    assert coordinator_node.executor == mock_agents["coordinator"]
    assert str(coordinator_node) == "coordinator"
    assert repr(coordinator_node) == "SwarmNode(node_id='coordinator')"

    # Test SwarmNode equality and hashing
    other_coordinator = SwarmNode("coordinator", mock_agents["coordinator"])
    assert coordinator_node == other_coordinator
    assert hash(coordinator_node) == hash(other_coordinator)
    assert coordinator_node != mock_swarm.nodes["specialist"]
    # Test SwarmNode inequality with different types
    assert coordinator_node != "not_a_swarm_node"
    assert coordinator_node != 42


def test_shared_context(mock_swarm):
    """Test SharedContext functionality and validation."""
    coordinator_node = mock_swarm.nodes["coordinator"]
    specialist_node = mock_swarm.nodes["specialist"]

    # Test SharedContext with multiple nodes (covers new node path)
    shared_context = SharedContext()
    shared_context.add_context(coordinator_node, "task_status", "in_progress")
    assert shared_context.context["coordinator"]["task_status"] == "in_progress"

    # Add context for a different node (this will create new node entry)
    shared_context.add_context(specialist_node, "analysis", "complete")
    assert shared_context.context["specialist"]["analysis"] == "complete"
    assert len(shared_context.context) == 2  # Two nodes now have context

    # Test SharedContext validation
    with pytest.raises(ValueError, match="Key cannot be None"):
        shared_context.add_context(coordinator_node, None, "value")

    with pytest.raises(ValueError, match="Key must be a string"):
        shared_context.add_context(coordinator_node, 123, "value")

    with pytest.raises(ValueError, match="Key cannot be empty"):
        shared_context.add_context(coordinator_node, "", "value")

    with pytest.raises(ValueError, match="Value is not JSON serializable"):
        shared_context.add_context(coordinator_node, "key", lambda x: x)


def test_swarm_state_should_continue(mock_swarm):
    """Test SwarmState should_continue method with various scenarios."""
    coordinator_node = mock_swarm.nodes["coordinator"]
    specialist_node = mock_swarm.nodes["specialist"]
    state = SwarmState(current_node=coordinator_node, task="test task")

    # Test normal continuation
    should_continue, reason = state.should_continue(
        max_handoffs=10,
        max_iterations=10,
        execution_timeout=60.0,
        repetitive_handoff_detection_window=0,
        repetitive_handoff_min_unique_agents=0,
    )
    assert should_continue is True
    assert reason == "Continuing"

    # Test max handoffs limit
    state.node_history = [coordinator_node] * 5
    should_continue, reason = state.should_continue(
        max_handoffs=3,
        max_iterations=10,
        execution_timeout=60.0,
        repetitive_handoff_detection_window=0,
        repetitive_handoff_min_unique_agents=0,
    )
    assert should_continue is False
    assert "Max handoffs reached" in reason

    # Test max iterations limit
    should_continue, reason = state.should_continue(
        max_handoffs=10,
        max_iterations=3,
        execution_timeout=60.0,
        repetitive_handoff_detection_window=0,
        repetitive_handoff_min_unique_agents=0,
    )
    assert should_continue is False
    assert "Max iterations reached" in reason

    # Test timeout
    state.start_time = time.time() - 100  # Set start time to 100 seconds ago
    should_continue, reason = state.should_continue(
        max_handoffs=10,
        max_iterations=10,
        execution_timeout=50.0,  # 50 second timeout
        repetitive_handoff_detection_window=0,
        repetitive_handoff_min_unique_agents=0,
    )
    assert should_continue is False
    assert "Execution timed out" in reason

    # Test repetitive handoff detection
    state.node_history = [coordinator_node, specialist_node, coordinator_node, specialist_node]
    state.start_time = time.time()  # Reset start time
    should_continue, reason = state.should_continue(
        max_handoffs=10,
        max_iterations=10,
        execution_timeout=60.0,
        repetitive_handoff_detection_window=4,
        repetitive_handoff_min_unique_agents=3,
    )
    assert should_continue is False
    assert "Repetitive handoff" in reason


@pytest.mark.asyncio
async def test_swarm_execution_async(mock_strands_tracer, mock_use_span, mock_swarm, mock_agents):
    """Test asynchronous swarm execution."""
    # Execute swarm
    task = [ContentBlock(text="Analyze this task"), ContentBlock(text="Additional context")]
    result = await mock_swarm.invoke_async(task)

    # Verify execution results
    assert result.status == Status.COMPLETED
    assert result.execution_count == 1
    assert len(result.results) == 1

    # Verify agent was called (via stream_async)
    assert mock_agents["coordinator"].stream_async.call_count >= 1

    # Verify metrics aggregation
    assert result.accumulated_usage["totalTokens"] >= 0
    assert result.accumulated_metrics["latencyMs"] >= 0

    # Verify result type
    assert isinstance(result, SwarmResult)
    assert hasattr(result, "node_history")
    assert len(result.node_history) == 1

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


def test_swarm_synchronous_execution(mock_strands_tracer, mock_use_span, mock_agents):
    """Test synchronous swarm execution using __call__ method."""
    agents = list(mock_agents.values())
    swarm = Swarm(
        nodes=agents,
        max_handoffs=3,
        max_iterations=3,
        execution_timeout=15.0,
        node_timeout=5.0,
    )

    # Test synchronous execution
    result = swarm("Test synchronous swarm execution")

    # Verify execution results
    assert result.status == Status.COMPLETED
    assert result.execution_count == 1
    assert len(result.results) == 1
    assert result.execution_time >= 0

    # Verify agent was called (via stream_async)
    assert mock_agents["coordinator"].stream_async.call_count >= 1

    # Verify return type is SwarmResult
    assert isinstance(result, SwarmResult)
    assert hasattr(result, "node_history")

    # Test swarm configuration
    assert swarm.max_handoffs == 3
    assert swarm.max_iterations == 3
    assert swarm.execution_timeout == 15.0
    assert swarm.node_timeout == 5.0

    # Test tool injection
    for node in swarm.nodes.values():
        node.executor.tool_registry.process_tools.assert_called()

    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


def test_swarm_builder_validation(mock_agents):
    """Test swarm builder validation and error handling."""
    # Test agent name assignment
    unnamed_agent = create_mock_agent(None)
    unnamed_agent.name = None
    agents_with_unnamed = [unnamed_agent, mock_agents["coordinator"]]

    swarm_with_unnamed = Swarm(nodes=agents_with_unnamed)
    assert "node_0" in swarm_with_unnamed.nodes
    assert "coordinator" in swarm_with_unnamed.nodes

    # Test duplicate node names
    duplicate_agent = create_mock_agent("coordinator")
    with pytest.raises(ValueError, match="Node ID 'coordinator' is not unique"):
        Swarm(nodes=[mock_agents["coordinator"], duplicate_agent])

    # Test duplicate agent instances
    same_agent = mock_agents["coordinator"]
    with pytest.raises(ValueError, match="Duplicate node instance detected"):
        Swarm(nodes=[same_agent, same_agent])

    # Test tool name conflicts - handoff tool
    conflicting_agent = create_mock_agent("conflicting")
    conflicting_agent.tool_registry.registry = {"handoff_to_agent": Mock()}

    with pytest.raises(ValueError, match="already has tools with names that conflict"):
        Swarm(nodes=[conflicting_agent])


def test_swarm_handoff_functionality():
    """Test swarm handoff functionality."""

    # Create an agent that will hand off to another agent
    def create_handoff_agent(name, target_agent_name, response_text="Handing off"):
        """Create a mock agent that performs handoffs."""
        agent = create_mock_agent(name, response_text)
        agent._handoff_done = False  # Track if handoff has been performed

        def create_handoff_result():
            agent._call_count += 1
            # Perform handoff on first execution call (not setup calls)
            if (
                not agent._handoff_done
                and hasattr(agent, "_swarm_ref")
                and agent._swarm_ref
                and hasattr(agent._swarm_ref.state, "completion_status")
            ):
                target_node = agent._swarm_ref.nodes.get(target_agent_name)
                if target_node:
                    agent._swarm_ref._handle_handoff(
                        target_node, f"Handing off to {target_agent_name}", {"handoff_context": "test_data"}
                    )
                    agent._handoff_done = True

            return AgentResult(
                message={"role": "assistant", "content": [{"text": response_text}]},
                stop_reason="end_turn",
                state={},
                metrics=Mock(
                    accumulated_usage={"inputTokens": 5, "outputTokens": 10, "totalTokens": 15},
                    accumulated_metrics={"latencyMs": 50.0},
                ),
            )

        agent.return_value = create_handoff_result()
        agent.__call__ = Mock(side_effect=create_handoff_result)

        async def mock_invoke_async(*args, **kwargs):
            return create_handoff_result()

        async def mock_stream_async(*args, **kwargs):
            yield {"agent_start": True}
            result = create_handoff_result()
            yield {"result": result}

        agent.invoke_async = MagicMock(side_effect=mock_invoke_async)
        agent.stream_async = Mock(side_effect=mock_stream_async)
        return agent

    # Create agents - first one hands off, second one completes by not handing off
    handoff_agent = create_handoff_agent("handoff_agent", "completion_agent")
    completion_agent = create_mock_agent("completion_agent", "Task completed")

    # Create a swarm with reasonable limits
    handoff_swarm = Swarm(nodes=[handoff_agent, completion_agent], max_handoffs=10, max_iterations=10)
    handoff_agent._swarm_ref = handoff_swarm
    completion_agent._swarm_ref = handoff_swarm

    # Execute swarm - this should hand off from first agent to second agent
    result = handoff_swarm("Test handoff during execution")

    # Verify the handoff occurred
    assert result.status == Status.COMPLETED
    assert result.execution_count == 2  # Both agents should have executed
    assert len(result.node_history) == 2

    # Verify the handoff agent executed first
    assert result.node_history[0].node_id == "handoff_agent"

    # Verify the completion agent executed after handoff
    assert result.node_history[1].node_id == "completion_agent"

    # Verify both agents were called (via stream_async)
    assert handoff_agent.stream_async.call_count >= 1
    assert completion_agent.stream_async.call_count >= 1

    # Test handoff when task is already completed
    completed_swarm = Swarm(nodes=[handoff_agent, completion_agent])
    completed_swarm.state.completion_status = Status.COMPLETED
    completed_swarm._handle_handoff(completed_swarm.nodes["completion_agent"], "test message", {"key": "value"})
    # Should not change current node when already completed


def test_swarm_tool_creation_and_execution():
    """Test swarm tool creation and execution with error handling."""
    error_agent = create_mock_agent("error_agent")
    error_swarm = Swarm(nodes=[error_agent])

    # Test tool execution with errors
    handoff_tool = error_swarm._create_handoff_tool()
    error_result = handoff_tool("nonexistent_agent", "test message")
    assert error_result["status"] == "error"
    assert "not found" in error_result["content"][0]["text"]


def test_swarm_failure_handling(mock_strands_tracer, mock_use_span):
    """Test swarm execution with agent failures."""
    # Test execution with agent failures
    failing_agent = create_mock_agent("failing_agent")
    failing_agent._should_fail = True  # Set failure flag after creation
    failing_swarm = Swarm(nodes=[failing_agent], node_timeout=1.0)

    # The swarm catches exceptions internally and sets status to FAILED
    result = failing_swarm("Test failure handling")
    assert result.status == Status.FAILED
    mock_strands_tracer.start_multiagent_span.assert_called()
    mock_use_span.assert_called_once()


def test_swarm_metrics_handling():
    """Test swarm metrics handling with missing metrics."""
    no_metrics_agent = create_mock_agent("no_metrics", metrics=None)
    no_metrics_swarm = Swarm(nodes=[no_metrics_agent])

    result = no_metrics_swarm("Test no metrics")
    assert result.status == Status.COMPLETED


def test_accumulate_metrics_sums_cache_token_counters():
    """Cache token counters are summed across nodes, not dropped (#797).

    Each node's usage is a disjoint Bedrock-style payload where
    totalTokens = inputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens,
    so the aggregated totals must reconcile once the cache counters are accumulated too.
    """
    swarm = Swarm(nodes=[create_mock_agent("agent1"), create_mock_agent("agent2")])
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
        ),
    ]

    for node_result in node_results:
        swarm._accumulate_metrics(node_result)

    tru_usage = swarm.state.accumulated_usage
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
    swarm = Swarm(nodes=[create_mock_agent("agent1"), create_mock_agent("agent2")])
    result_text = AgentResult(
        message={"role": "assistant", "content": [{"text": "ok"}]}, stop_reason="end_turn", state={}, metrics={}
    )

    swarm._accumulate_metrics(
        NodeResult(result=result_text, accumulated_usage={"inputTokens": 10, "outputTokens": 20, "totalTokens": 30})
    )

    tru_usage = swarm.state.accumulated_usage
    exp_usage = {"inputTokens": 10, "outputTokens": 20, "totalTokens": 30}
    assert tru_usage == exp_usage


def test_swarm_auto_completion_without_handoff():
    """Test swarm auto-completion when no handoff occurs."""
    # Create a simple agent that doesn't hand off
    no_handoff_agent = create_mock_agent("no_handoff_agent", "Task completed without handoff")

    # Create a swarm with just this agent
    auto_complete_swarm = Swarm(nodes=[no_handoff_agent])

    # Execute swarm - this should complete automatically since there's no handoff
    result = auto_complete_swarm("Test auto-completion without handoff")

    # Verify the swarm completed successfully
    assert result.status == Status.COMPLETED
    assert result.execution_count == 1
    assert len(result.node_history) == 1
    assert result.node_history[0].node_id == "no_handoff_agent"

    # Verify the agent was called (via stream_async)
    assert no_handoff_agent.stream_async.call_count >= 1


def test_swarm_configurable_entry_point():
    """Test swarm with configurable entry point."""
    # Create multiple agents
    agent1 = create_mock_agent("agent1", "Agent 1 response")
    agent2 = create_mock_agent("agent2", "Agent 2 response")
    agent3 = create_mock_agent("agent3", "Agent 3 response")

    # Create swarm with agent2 as entry point
    swarm = Swarm([agent1, agent2, agent3], entry_point=agent2)

    # Verify entry point is set correctly
    assert swarm.entry_point is agent2

    # Execute swarm
    result = swarm("Test task")

    # Verify agent2 was the first to execute
    assert result.status == Status.COMPLETED
    assert len(result.node_history) == 1
    assert result.node_history[0].node_id == "agent2"


def test_swarm_invalid_entry_point():
    """Test swarm with invalid entry point raises error."""
    agent1 = create_mock_agent("agent1", "Agent 1 response")
    agent2 = create_mock_agent("agent2", "Agent 2 response")
    agent3 = create_mock_agent("agent3", "Agent 3 response")  # Not in swarm

    # Try to create swarm with agent not in the swarm
    with pytest.raises(ValueError, match="Entry point agent not found in swarm nodes"):
        Swarm([agent1, agent2], entry_point=agent3)


def test_swarm_default_entry_point():
    """Test swarm uses first agent as default entry point."""
    agent1 = create_mock_agent("agent1", "Agent 1 response")
    agent2 = create_mock_agent("agent2", "Agent 2 response")

    # Create swarm without specifying entry point
    swarm = Swarm([agent1, agent2])

    # Verify no explicit entry point is set
    assert swarm.entry_point is None

    # Execute swarm
    result = swarm("Test task")

    # Verify first agent was used as entry point
    assert result.status == Status.COMPLETED
    assert len(result.node_history) == 1
    assert result.node_history[0].node_id == "agent1"


def test_swarm_duplicate_agent_names():
    """Test swarm rejects agents with duplicate names."""
    agent1 = create_mock_agent("duplicate_name", "Agent 1 response")
    agent2 = create_mock_agent("duplicate_name", "Agent 2 response")

    # Try to create swarm with duplicate names
    with pytest.raises(ValueError, match="Node ID 'duplicate_name' is not unique"):
        Swarm([agent1, agent2])


def test_swarm_entry_point_same_name_different_object():
    """Test entry point validation with same name but different object."""
    agent1 = create_mock_agent("agent1", "Agent 1 response")
    agent2 = create_mock_agent("agent2", "Agent 2 response")

    # Create a different agent with same name as agent1
    different_agent_same_name = create_mock_agent("agent1", "Different agent response")

    # Try to use the different agent as entry point
    with pytest.raises(ValueError, match="Entry point agent not found in swarm nodes"):
        Swarm([agent1, agent2], entry_point=different_agent_same_name)


def test_swarm_validate_unsupported_features():
    """Test Swarm validation for session persistence and callbacks."""
    # Test with normal agent (should work)
    normal_agent = create_mock_agent("normal_agent")
    normal_agent._session_manager = None
    normal_agent.hooks = HookRegistry()

    swarm = Swarm([normal_agent])
    assert len(swarm.nodes) == 1

    # Test with session manager (should fail)
    mock_session_manager = Mock(spec=SessionManager)
    agent_with_session = create_mock_agent("agent_with_session")
    agent_with_session._session_manager = mock_session_manager
    agent_with_session.hooks = HookRegistry()

    with pytest.raises(ValueError, match="Session persistence is not supported for Swarm agents yet"):
        Swarm([agent_with_session])


@pytest.mark.asyncio
async def test_swarm_kwargs_passing(mock_strands_tracer, mock_use_span):
    """Test that kwargs are passed through to underlying agents."""
    kwargs_agent = create_mock_agent("kwargs_agent", "Response with kwargs")

    swarm = Swarm(nodes=[kwargs_agent])

    test_kwargs = {"custom_param": "test_value", "another_param": 42}
    result = await swarm.invoke_async("Test kwargs passing", test_kwargs)

    # Verify stream_async was called (kwargs are passed through)
    assert kwargs_agent.stream_async.call_count >= 1
    assert result.status == Status.COMPLETED


def test_swarm_kwargs_passing_sync(mock_strands_tracer, mock_use_span):
    """Test that kwargs are passed through to underlying agents in sync execution."""
    kwargs_agent = create_mock_agent("kwargs_agent", "Response with kwargs")

    swarm = Swarm(nodes=[kwargs_agent])

    test_kwargs = {"custom_param": "test_value", "another_param": 42}
    result = swarm("Test kwargs passing sync", test_kwargs)

    # Verify stream_async was called (kwargs are passed through)
    assert kwargs_agent.stream_async.call_count >= 1
    assert result.status == Status.COMPLETED


@pytest.mark.asyncio
async def test_swarm_streaming_events(mock_strands_tracer, mock_use_span, alist):
    """Test that swarm streaming emits proper events during execution."""

    # Create agents with custom streaming behavior
    coordinator = create_mock_agent("coordinator", "Coordinating task")
    specialist = create_mock_agent("specialist", "Specialized response")

    # Track events and execution order
    execution_events = []

    async def coordinator_stream(*args, **kwargs):
        execution_events.append("coordinator_start")
        yield {"agent_start": True, "node": "coordinator"}
        yield {"agent_thinking": True, "thought": "Analyzing task"}
        await asyncio.sleep(0.01)  # Small delay
        execution_events.append("coordinator_end")
        yield {"result": coordinator.return_value}

    async def specialist_stream(*args, **kwargs):
        execution_events.append("specialist_start")
        yield {"agent_start": True, "node": "specialist"}
        yield {"agent_thinking": True, "thought": "Applying expertise"}
        await asyncio.sleep(0.01)  # Small delay
        execution_events.append("specialist_end")
        yield {"result": specialist.return_value}

    coordinator.stream_async = Mock(side_effect=coordinator_stream)
    specialist.stream_async = Mock(side_effect=specialist_stream)

    # Create swarm with handoff logic
    swarm = Swarm(nodes=[coordinator, specialist], max_handoffs=2, max_iterations=3, execution_timeout=30.0)

    # Add handoff tool to coordinator to trigger specialist
    def handoff_to_specialist():
        """Hand off to specialist for detailed analysis."""
        return specialist

    coordinator.tool_registry.registry = {"handoff_to_specialist": handoff_to_specialist}

    # Collect all streaming events
    events = await alist(swarm.stream_async("Test swarm streaming"))

    # Verify event structure
    assert len(events) > 0

    # Should have node start/stop events
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    node_stop_events = [e for e in events if e.get("type") == "multiagent_node_stop"]
    node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
    result_events = [e for e in events if "result" in e and e.get("type") != "multiagent_node_stream"]

    # Should have at least one node execution
    assert len(node_start_events) >= 1
    assert len(node_stop_events) >= 1

    # Should have forwarded agent events
    assert len(node_stream_events) >= 2  # At least some events per agent

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

    # Verify final result
    final_result = result_events[0]["result"]
    assert final_result.status == Status.COMPLETED


@pytest.mark.asyncio
async def test_swarm_streaming_with_handoffs(mock_strands_tracer, mock_use_span, alist):
    """Test swarm streaming with agent handoffs."""

    # Create agents
    coordinator = create_mock_agent("coordinator", "Coordinating")
    specialist = create_mock_agent("specialist", "Specialized work")
    reviewer = create_mock_agent("reviewer", "Review complete")

    # Track handoff sequence
    handoff_sequence = []

    async def coordinator_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "coordinator"}
        yield {"agent_thinking": True, "thought": "Need specialist help"}
        handoff_sequence.append("coordinator_to_specialist")
        yield {"result": coordinator.return_value}

    async def specialist_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "specialist"}
        yield {"agent_thinking": True, "thought": "Doing specialized work"}
        handoff_sequence.append("specialist_to_reviewer")
        yield {"result": specialist.return_value}

    async def reviewer_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "reviewer"}
        yield {"agent_thinking": True, "thought": "Reviewing work"}
        handoff_sequence.append("reviewer_complete")
        yield {"result": reviewer.return_value}

    coordinator.stream_async = Mock(side_effect=coordinator_stream)
    specialist.stream_async = Mock(side_effect=specialist_stream)
    reviewer.stream_async = Mock(side_effect=reviewer_stream)

    # Set up handoff tools
    def handoff_to_specialist():
        return specialist

    def handoff_to_reviewer():
        return reviewer

    coordinator.tool_registry.registry = {"handoff_to_specialist": handoff_to_specialist}
    specialist.tool_registry.registry = {"handoff_to_reviewer": handoff_to_reviewer}
    reviewer.tool_registry.registry = {}

    # Create swarm
    swarm = Swarm(nodes=[coordinator, specialist, reviewer], max_handoffs=5, max_iterations=5, execution_timeout=30.0)

    # Collect streaming events
    events = await alist(swarm.stream_async("Test handoff streaming"))

    # Should have multiple node executions due to handoffs
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    handoff_events = [e for e in events if e.get("type") == "multiagent_handoff"]

    # Should have executed at least one agent (handoffs are complex to mock)
    assert len(node_start_events) >= 1

    # Verify handoff events have proper structure if any occurred
    for event in handoff_events:
        assert "from_node_ids" in event
        assert "to_node_ids" in event
        assert isinstance(event["from_node_ids"], list)
        assert isinstance(event["to_node_ids"], list)


@pytest.mark.asyncio
async def test_swarm_streaming_with_failures(mock_strands_tracer, mock_use_span):
    """Test swarm streaming behavior when agents fail."""

    # Create a failing agent (don't fail during creation, fail during execution)
    failing_agent = create_mock_agent("failing_agent", "Should fail")
    success_agent = create_mock_agent("success_agent", "Success")

    async def failing_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "failing_agent"}
        yield {"agent_thinking": True, "thought": "About to fail"}
        await asyncio.sleep(0.01)
        raise Exception("Simulated streaming failure")

    async def success_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "success_agent"}
        yield {"agent_thinking": True, "thought": "Working successfully"}
        yield {"result": success_agent.return_value}

    failing_agent.stream_async = Mock(side_effect=failing_stream)
    success_agent.stream_async = Mock(side_effect=success_stream)

    # Create swarm starting with failing agent
    swarm = Swarm(nodes=[failing_agent, success_agent], max_handoffs=2, max_iterations=3, execution_timeout=30.0)

    # Collect events until failure
    events = []
    # Note: We expect an exception but swarm might handle it gracefully
    # So we don't use pytest.raises here - we check for either success or failure
    try:
        async for event in swarm.stream_async("Test streaming with failure"):
            events.append(event)
    except Exception:
        pass  # Expected - failure during streaming

    # Should get some events before failure (if failure occurred)
    if len(events) > 0:
        # Should have node start events
        node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
        assert len(node_start_events) >= 1

        # Should have some forwarded events before failure
        node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
        assert len(node_stream_events) >= 1


@pytest.mark.asyncio
async def test_swarm_streaming_timeout_behavior(mock_strands_tracer, mock_use_span):
    """Test swarm streaming with execution timeout."""

    # Create a slow agent
    slow_agent = create_mock_agent("slow_agent", "Slow response")

    async def slow_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "slow_agent"}
        yield {"agent_thinking": True, "thought": "Taking my time"}
        await asyncio.sleep(0.2)  # Longer than timeout
        yield {"result": slow_agent.return_value}

    slow_agent.stream_async = Mock(side_effect=slow_stream)

    # Create swarm with short timeout
    swarm = Swarm(
        nodes=[slow_agent],
        max_handoffs=1,
        max_iterations=1,
        execution_timeout=0.1,  # Very short timeout
    )

    # Should timeout during streaming or complete
    # Note: Timeout behavior is timing-dependent, so we accept both outcomes
    events = []
    try:
        async for event in swarm.stream_async("Test timeout streaming"):
            events.append(event)
    except Exception:
        pass  # Timeout is acceptable

    # Should get at least some events regardless of timeout
    assert len(events) >= 1


@pytest.mark.asyncio
async def test_swarm_streaming_backward_compatibility(mock_strands_tracer, mock_use_span, alist):
    """Test that swarm streaming maintains backward compatibility."""
    # Create simple agent
    agent = create_mock_agent("test_agent", "Test response")

    # Create swarm
    swarm = Swarm(nodes=[agent])

    # Test that invoke_async still works
    result = await swarm.invoke_async("Test backward compatibility")
    assert result.status == Status.COMPLETED

    # Test that streaming also works and produces same result
    events = await alist(swarm.stream_async("Test backward compatibility"))

    # Should have final result event
    result_events = [e for e in events if "result" in e and e.get("type") != "multiagent_node_stream"]
    assert len(result_events) == 1

    streaming_result = result_events[0]["result"]
    assert streaming_result.status == Status.COMPLETED

    # Results should be equivalent
    assert result.status == streaming_result.status


@pytest.mark.asyncio
async def test_swarm_single_invocation_no_double_execution(mock_strands_tracer, mock_use_span):
    """Test that swarm nodes are only invoked once (no double execution from streaming)."""
    # Create agent with invocation counter
    agent = create_mock_agent("test_agent", "Test response")

    # Track invocation count
    invocation_count = {"count": 0}

    async def counted_stream(*args, **kwargs):
        invocation_count["count"] += 1
        yield {"agent_start": True, "node": "test_agent"}
        yield {"agent_thinking": True, "thought": "Processing"}
        yield {"result": agent.return_value}

    agent.stream_async = Mock(side_effect=counted_stream)

    # Create swarm
    swarm = Swarm(nodes=[agent])

    # Execute the swarm
    result = await swarm.invoke_async("Test single invocation")

    # Verify successful execution
    assert result.status == Status.COMPLETED

    # CRITICAL: Agent should be invoked exactly once
    assert invocation_count["count"] == 1, f"Agent invoked {invocation_count['count']} times, expected 1"

    # Verify stream_async was called but invoke_async was NOT called
    assert agent.stream_async.call_count == 1
    # invoke_async should not be called at all since we're using streaming
    agent.invoke_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_handoff_single_invocation_per_node(mock_strands_tracer, mock_use_span):
    """Test that each node in a swarm handoff chain is invoked exactly once."""
    # Create agents with invocation counters
    invocation_counts = {"coordinator": 0, "specialist": 0}

    coordinator = create_mock_agent("coordinator", "Coordinating")
    specialist = create_mock_agent("specialist", "Specialized work")

    async def coordinator_stream(*args, **kwargs):
        invocation_counts["coordinator"] += 1
        yield {"agent_start": True, "node": "coordinator"}
        yield {"agent_thinking": True, "thought": "Need specialist"}
        yield {"result": coordinator.return_value}

    async def specialist_stream(*args, **kwargs):
        invocation_counts["specialist"] += 1
        yield {"agent_start": True, "node": "specialist"}
        yield {"agent_thinking": True, "thought": "Doing specialized work"}
        yield {"result": specialist.return_value}

    coordinator.stream_async = Mock(side_effect=coordinator_stream)
    specialist.stream_async = Mock(side_effect=specialist_stream)

    # Set up handoff tool
    def handoff_to_specialist():
        return specialist

    coordinator.tool_registry.registry = {"handoff_to_specialist": handoff_to_specialist}
    specialist.tool_registry.registry = {}

    # Create swarm
    swarm = Swarm(nodes=[coordinator, specialist], max_handoffs=2, max_iterations=3)

    # Execute the swarm
    result = await swarm.invoke_async("Test handoff single invocation")

    # Verify successful execution
    assert result.status == Status.COMPLETED

    # CRITICAL: Each agent should be invoked exactly once
    # Note: Actual invocation depends on whether handoff occurs, but no double execution
    assert invocation_counts["coordinator"] == 1, f"Coordinator invoked {invocation_counts['coordinator']} times"
    # Specialist may or may not be invoked depending on handoff logic, but if invoked, only once
    assert invocation_counts["specialist"] <= 1, f"Specialist invoked {invocation_counts['specialist']} times"

    # Verify stream_async was called but invoke_async was NOT called
    assert coordinator.stream_async.call_count == 1
    coordinator.invoke_async.assert_not_called()
    if invocation_counts["specialist"] > 0:
        specialist.invoke_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_timeout_with_streaming(mock_strands_tracer, mock_use_span):
    """Test that swarm node timeout works correctly with streaming."""
    # Create a slow agent
    slow_agent = create_mock_agent("slow_agent", "Slow response")

    async def slow_stream(*args, **kwargs):
        yield {"agent_start": True, "node": "slow_agent"}
        await asyncio.sleep(0.3)  # Longer than timeout
        yield {"result": slow_agent.return_value}

    slow_agent.stream_async = Mock(side_effect=slow_stream)

    # Create swarm with short node timeout
    swarm = Swarm(
        nodes=[slow_agent],
        max_handoffs=1,
        max_iterations=1,
        node_timeout=0.1,  # Short timeout
    )

    # Execute - should complete with FAILED status due to timeout
    result = await swarm.invoke_async("Test timeout")

    # Verify the swarm failed due to timeout
    assert result.status == Status.FAILED

    # Verify the agent started streaming
    assert slow_agent.stream_async.call_count == 1


@pytest.mark.asyncio
async def test_swarm_node_timeout_with_mocked_streaming():
    """Test that swarm node timeout properly cancels a streaming generator that freezes."""
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

    # Create swarm with short node timeout
    swarm = Swarm(
        nodes=[slow_agent],
        max_handoffs=1,
        max_iterations=1,
        node_timeout=0.5,  # 500ms timeout
    )

    # Execute - should complete with FAILED status due to timeout
    result = await swarm.invoke_async("Test freezing generator")
    assert result.status == Status.FAILED


@pytest.mark.asyncio
async def test_swarm_timeout_cleanup_on_exception():
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

    # Create swarm with timeout
    swarm = Swarm(
        nodes=[agent],
        max_handoffs=1,
        max_iterations=1,
        node_timeout=30.0,
    )

    # Execute - swarm catches exceptions and continues, marking node as failed
    result = await swarm.invoke_async("Test exception handling")
    # Verify the node failed
    assert "test_agent" in result.results
    assert result.results["test_agent"].status == Status.FAILED
    assert result.status == Status.FAILED


@pytest.mark.asyncio
async def test_swarm_invoke_async_no_result_event(mock_strands_tracer, mock_use_span):
    """Test that invoke_async raises ValueError when stream produces no result event."""
    # Create a mock swarm that produces events but no final result
    agent = create_mock_agent("test_agent", "Test response")
    swarm = Swarm(nodes=[agent])

    # Mock stream_async to yield events but no result event
    async def no_result_stream(*args, **kwargs):
        """Simulate a stream that yields events but no result."""
        yield {"agent_start": True, "node": "test_agent"}
        yield {"agent_thinking": True, "thought": "Processing"}
        # Intentionally don't yield a result event

    swarm.stream_async = Mock(side_effect=no_result_stream)

    # Execute - should raise ValueError
    with pytest.raises(ValueError, match="Swarm streaming completed without producing a result event"):
        await swarm.invoke_async("Test no result event")


@pytest.mark.asyncio
async def test_swarm_stream_async_exception_in_execute_swarm(mock_strands_tracer, mock_use_span):
    """Test that stream_async logs exception when _execute_swarm raises an error."""
    # Create an agent
    agent = create_mock_agent("test_agent", "Test response")

    # Create swarm
    swarm = Swarm(nodes=[agent])

    # Mock _execute_swarm to raise an exception after yielding an event
    async def failing_execute_swarm(*args, **kwargs):
        """Simulate _execute_swarm raising an exception."""
        # Yield a valid event first

        yield MultiAgentNodeStartEvent(node_id="test_agent", node_type="agent")
        # Then raise an exception
        raise RuntimeError("Simulated failure in _execute_swarm")

    swarm._execute_swarm = Mock(side_effect=failing_execute_swarm)

    # Execute - should raise the exception and log it
    with pytest.raises(RuntimeError, match="Simulated failure in _execute_swarm"):
        async for _ in swarm.stream_async("Test exception logging"):
            pass

    # Verify the swarm status is FAILED
    assert swarm.state.completion_status == Status.FAILED


@pytest.mark.asyncio
async def test_swarm_persistence(mock_strands_tracer, mock_use_span):
    """Test swarm persistence functionality with multimodal input containing binary bytes."""
    import base64
    import json

    # Create mock session manager
    session_manager = Mock(spec=FileSessionManager)
    session_manager.read_multi_agent.return_value = None

    # Create simple swarm with session manager
    agent = create_mock_agent("test_agent")
    swarm = Swarm([agent], session_manager=session_manager)

    # Test get_state_from_orchestrator
    state = swarm.serialize_state()
    assert state["type"] == "swarm"
    assert state["id"] == "default_swarm"
    assert state["_internal_state"] == {
        "interrupt_state": {"activated": False, "context": {}, "interrupts": {}},
    }
    assert "status" in state
    assert "node_history" in state
    assert "node_results" in state
    assert "context" in state

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

    # Simulate swarm having executed with a multimodal task
    swarm.state.task = multimodal_task

    # serialize_state must not raise TypeError for bytes
    serialized = swarm.serialize_state()
    assert json.dumps(serialized)  # must be JSON-serializable

    # The bytes should be encoded in the serialized form
    encoded_bytes = serialized["current_task"][1]["document"]["source"]["bytes"]
    assert encoded_bytes == {"__bytes_encoded__": True, "data": base64.b64encode(pdf_bytes).decode()}

    # deserialize_state must restore bytes back to original
    serialized["next_nodes_to_execute"] = ["test_agent"]
    serialized["status"] = "executing"
    swarm.deserialize_state(serialized)
    restored_bytes = swarm.state.task[1]["document"]["source"]["bytes"]
    assert restored_bytes == pdf_bytes

    # Test apply_state_from_dict with plain string persisted state (backward compat)
    persisted_state = {
        "status": "executing",
        "node_history": [],
        "node_results": {},
        "current_task": "persisted task",
        "next_nodes_to_execute": ["test_agent"],
        "context": {"shared_context": {"test_agent": {"key": "value"}}, "handoff_message": "test handoff"},
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

    swarm.deserialize_state(persisted_state)
    assert swarm.state.task == "persisted task"
    assert swarm.state.handoff_message == "test handoff"
    assert swarm.shared_context.context["test_agent"]["key"] == "value"
    assert swarm._interrupt_state == _InterruptState(
        activated=False,
        context={"a": 1},
        interrupts={"i1": Interrupt(id="i1", name="test_name", reason="test_reason")},
    )

    # Execute swarm to test persistence integration
    result = await swarm.invoke_async("Test persistence")

    # Verify execution completed
    assert result.status == Status.COMPLETED
    assert len(result.results) == 1
    assert "test_agent" in result.results

    # Test state serialization after execution
    final_state = swarm.serialize_state()
    assert final_state["status"] == "completed"
    assert len(final_state["node_history"]) == 1
    assert "test_agent" in final_state["node_results"]


def test_swarm_serialize_deserialize_serialize_preserves_state():
    """serialize -> deserialize -> serialize is value-preserving on the resume path.

    Guarantees that a resumed swarm re-serializes the same shared_context and cumulative
    accounting (execution_time / accumulated_usage / accumulated_metrics) it was restored with,
    and that the restored SwarmState and Swarm share the same shared_context object.
    """
    agent = create_mock_agent("first")
    swarm = Swarm([agent])

    payload = {
        "type": "swarm",
        "id": "default_swarm",
        "status": "executing",
        "node_history": [],
        "node_results": {},
        "next_nodes_to_execute": ["first"],
        "current_task": "resume me",
        "accumulated_usage": {"inputTokens": 11, "outputTokens": 22, "totalTokens": 33},
        "accumulated_metrics": {"latencyMs": 44},
        "execution_time": 555,
        "context": {
            "shared_context": {"first": {"fact": "persist-me"}},
            "handoff_node": None,
            "handoff_message": None,
        },
        "_internal_state": {"interrupt_state": {"activated": False, "context": {}, "interrupts": {}}},
    }

    swarm.deserialize_state(payload)

    # The swarm-owned and state-owned shared contexts must be the same restored object.
    assert swarm.shared_context.context == {"first": {"fact": "persist-me"}}
    assert swarm.state.shared_context.context == {"first": {"fact": "persist-me"}}
    assert swarm.state.shared_context is swarm.shared_context

    # Cumulative accounting is restored, not reset to zero.
    assert swarm.state.accumulated_usage == {"inputTokens": 11, "outputTokens": 22, "totalTokens": 33}
    assert swarm.state.accumulated_metrics == {"latencyMs": 44}
    assert swarm.state.execution_time == 555

    serialize1 = swarm.serialize_state()
    swarm.deserialize_state(serialize1)
    serialize2 = swarm.serialize_state()

    assert serialize2["context"]["shared_context"] == serialize1["context"]["shared_context"]
    assert serialize2["context"]["shared_context"] == {"first": {"fact": "persist-me"}}
    assert serialize2["accumulated_usage"] == serialize1["accumulated_usage"]
    assert serialize2["accumulated_metrics"] == serialize1["accumulated_metrics"]
    assert serialize2["execution_time"] == serialize1["execution_time"]


def test_swarm_checkpoint_persists_in_flight_execution_time():
    """A mid-run per-node checkpoint persists elapsed time so a resumed swarm keeps its timeout budget.

    Guards the crash-restart path: the AfterNodeCall session sync serializes before the invocation's
    finally commits the interval, so serialize_state must fold the in-flight interval into
    execution_time rather than persisting the stale pre-invocation value (which would reset the budget).
    """
    clock = {"now": 3000.6}

    swarm = Swarm([create_mock_agent("first")])

    with patch("strands.multiagent.swarm.time.time", lambda: clock["now"]):
        # Marker set at invocation start; a checkpoint taken 600ms in must reflect that interval.
        swarm._invocation_start_time = 3000.0
        swarm.state.completion_status = Status.EXECUTING
        swarm.state.current_node = swarm.nodes["first"]
        checkpoint = swarm.serialize_state()

    assert checkpoint["execution_time"] == 600


@pytest.mark.asyncio
async def test_swarm_tracing_setup_failure_does_not_leak_timer(mock_strands_tracer, mock_use_span):
    """A tracing setup failure must not leave the invocation timer running.

    The timer starts inside the span context so its clearing finally is guaranteed to run. If span
    setup raises before then, no interval is started, and a later serialize_state must not accrue
    wall time against an abandoned invocation.
    """
    clock = {"now": 2000.0}
    mock_strands_tracer.start_multiagent_span.side_effect = RuntimeError("span setup failed")

    swarm = Swarm([create_mock_agent("first")])

    with patch("strands.multiagent.swarm.time.time", lambda: clock["now"]):
        with pytest.raises(RuntimeError, match="span setup failed"):
            await swarm.invoke_async("go")
        clock["now"] = 2000.5  # 500ms later
        checkpoint = swarm.serialize_state()

    assert swarm._invocation_start_time is None
    assert checkpoint["execution_time"] == 0


@pytest.mark.asyncio
async def test_swarm_handle_handoff():
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")

    swarm = Swarm([first_agent, second_agent])

    async def handoff_stream(*args, **kwargs):
        yield {"agent_start": True}

        swarm._handle_handoff(swarm.nodes["second"], "test message", {})

        assert swarm.state.current_node.node_id == "first"
        assert swarm.state.handoff_node.node_id == "second"

        yield {"result": first_agent.return_value}

    first_agent.stream_async = Mock(side_effect=handoff_stream)

    result = await swarm.invoke_async("test")
    assert result.status == Status.COMPLETED

    tru_node_order = [node.node_id for node in result.node_history]
    exp_node_order = ["first", "second"]
    assert tru_node_order == exp_node_order


def resume_payload(
    *,
    status="executing",
    frontier=("first",),
    node_history=(),
    handoff_node=None,
    handoff_message=None,
    shared_context=None,
    interrupt_state=None,
    task="test",
):
    """Build a persisted swarm payload for the resume tests."""
    return {
        "status": status,
        "node_history": list(node_history),
        "node_results": {},
        "current_task": task,
        "next_nodes_to_execute": list(frontier),
        "context": {
            "shared_context": shared_context or {},
            "handoff_node": handoff_node,
            "handoff_message": handoff_message,
        },
        "_internal_state": {
            "interrupt_state": interrupt_state or {"activated": False, "context": {}, "interrupts": {}},
        },
    }


def build_interrupt_result(interrupt_id):
    """Build an agent result that pauses its node on an interrupt."""
    interrupt_result = AgentResult(
        message={"role": "assistant", "content": [{"text": "pausing"}]},
        stop_reason="interrupt",
        state={},
        metrics=Mock(accumulated_usage={"totalTokens": 1}, accumulated_metrics={"latencyMs": 1}),
    )
    interrupt_result.interrupts = [Interrupt(id=interrupt_id, name="test", reason="mid-turn")]
    return interrupt_result


def interrupt_context_for(node_id):
    """Build an active interrupt state whose context covers only the given node."""
    return {
        "activated": True,
        "context": {
            node_id: {
                "activated": True,
                "interrupt_state": {"activated": False, "context": {}, "interrupts": {}},
                "state": {},
                "messages": [],
            }
        },
        "interrupts": {},
    }


@pytest.mark.asyncio
async def test_swarm_resume_after_completion_starts_clean_run(mock_strands_tracer, mock_use_span):
    """A completed swarm restored into a fresh process starts a clean run instead of crashing.

    A reset must leave nothing of the finished run behind for the next one.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])
    swarm.shared_context.add_context(swarm.nodes["first"], "stale_key", "stale_value")

    result = await swarm.invoke_async("test")
    assert result.status == Status.COMPLETED

    completed_snapshot = swarm.serialize_state()
    assert completed_snapshot["status"] == "completed"
    assert completed_snapshot["next_nodes_to_execute"] == []

    first_agent2 = create_mock_agent("first")
    second_agent2 = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent2, second_agent2])
    resumed_swarm.shared_context.add_context(resumed_swarm.nodes["first"], "stale_key", "stale_value")
    resumed_swarm.deserialize_state(completed_snapshot)

    assert resumed_swarm._resume_from_session is False
    assert resumed_swarm.state.completion_status == Status.PENDING
    assert resumed_swarm.shared_context.context == {}

    resumed_result = await resumed_swarm.invoke_async("fresh task")
    assert resumed_result.status == Status.COMPLETED

    tru_node_order = [node.node_id for node in resumed_result.node_history]
    exp_node_order = ["first"]
    assert tru_node_order == exp_node_order
    assert "stale_value" not in first_agent2.stream_async.call_args[0][0][0]["text"]


@pytest.mark.asyncio
async def test_swarm_resume_cancelled_handoff_reruns_source_not_target(mock_strands_tracer, mock_use_span):
    """Cancellation after a handoff request keeps the frontier on the uncompleted source, not the target.

    asyncio.CancelledError bypasses the node's `except Exception` while the finally still checkpoints, so the
    cancel path rolls the requested handoff back to keep the frontier on the node that never finished.
    """
    first = create_mock_agent("first")
    second = create_mock_agent("second")
    swarm = Swarm([first, second])

    async def cancel_stream(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {"secret_for_second": "value"})
        raise asyncio.CancelledError("cancelled mid-turn")

    first.stream_async = Mock(side_effect=cancel_stream)

    snapshots = []
    swarm.hooks.add_callback(AfterNodeCallEvent, lambda event: snapshots.append(swarm.serialize_state()))

    with pytest.raises(asyncio.CancelledError):
        await swarm.invoke_async("test")

    assert len(snapshots) == 1
    cancelled_snapshot = snapshots[0]
    assert cancelled_snapshot["next_nodes_to_execute"] == ["first"]
    assert cancelled_snapshot["context"]["handoff_node"] is None
    assert cancelled_snapshot["context"]["handoff_message"] is None
    assert cancelled_snapshot["context"]["shared_context"] == {}

    first2 = create_mock_agent("first")
    second2 = create_mock_agent("second")
    resumed_swarm = Swarm([first2, second2])
    resumed_swarm.deserialize_state(cancelled_snapshot)
    assert resumed_swarm.state.current_node.node_id == "first"


@pytest.mark.asyncio
async def test_swarm_resume_closed_stream_after_handoff_reruns_source(mock_strands_tracer, mock_use_span):
    """Closing the public stream after a node requests a handoff rolls back the uncommitted handoff.

    Consumer aclose() injects GeneratorExit at the stream_async yield, whose finally checkpoints before the
    inner execution generator tears down, so that finally owns the rollback for this teardown path.
    """
    first = create_mock_agent("first")
    second = create_mock_agent("second")
    swarm = Swarm([first, second])

    async def handoff_then_yield(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {"secret_for_second": "value"})
        yield {"agent_thinking": True}
        yield {"result": first.return_value}

    first.stream_async = Mock(side_effect=handoff_then_yield)

    snapshots = []
    swarm.hooks.add_callback(AfterMultiAgentInvocationEvent, lambda event: snapshots.append(swarm.serialize_state()))

    # Consume past the handoff request so the pending handoff exists when the stream is closed mid-node.
    stream = swarm.stream_async("test")
    events_seen = 0
    async for _event in stream:
        events_seen += 1
        if events_seen >= 3:
            break
    assert swarm.state.handoff_node is not None and swarm.state.handoff_node.node_id == "second"
    await stream.aclose()

    final_snapshot = snapshots[-1]
    tru_frontier = final_snapshot["next_nodes_to_execute"]
    exp_frontier = ["first"]
    assert tru_frontier == exp_frontier
    assert final_snapshot["context"]["handoff_node"] is None


@pytest.mark.asyncio
async def test_swarm_crash_restart_handoff_via_file_session_on_disk(mock_strands_tracer, mock_use_span):
    """End-to-end crash-restart of a handoff through a real FileSessionManager writing to disk.

    Only the on-disk path runs deserialize from the rebuilt Swarm's constructor, so it covers checkpoint
    timing that an in-memory round trip cannot.
    """
    with tempfile.TemporaryDirectory() as live_dir, tempfile.TemporaryDirectory() as crash_dir:
        session_manager = FileSessionManager(session_id="crash-restart", storage_dir=live_dir)
        first_agent = create_mock_agent("first")
        second_agent = create_mock_agent("second")
        swarm = Swarm([first_agent, second_agent], session_manager=session_manager)

        async def handoff_stream(*args, **kwargs):
            yield {"agent_start": True}
            swarm._handle_handoff(swarm.nodes["second"], "test message", {})
            yield {"result": first_agent.return_value}

        first_agent.stream_async = Mock(side_effect=handoff_stream)

        # Copy the on-disk session mid-run: the durable state a crash would leave behind.
        captured = {"done": False}

        def capture_crash(event):
            if not captured["done"]:
                shutil.rmtree(crash_dir, ignore_errors=True)
                shutil.copytree(live_dir, crash_dir)
                captured["done"] = True

        swarm.hooks.add_callback(AfterNodeCallEvent, capture_crash, order=1000)
        await swarm.invoke_async("test")

        # Fresh process: rebuild Swarm + manager over the crash snapshot. deserialize_state runs in the
        # constructor via MultiAgentInitializedEvent.
        resumed_manager = FileSessionManager(session_id="crash-restart", storage_dir=crash_dir)
        first_agent2 = create_mock_agent("first")
        second_agent2 = create_mock_agent("second")
        resumed_swarm = Swarm([first_agent2, second_agent2], session_manager=resumed_manager)

        resumed_result = await resumed_swarm.invoke_async("test")

        assert resumed_result.status == Status.COMPLETED
        second_agent2.stream_async.assert_called_once()
        first_agent2.stream_async.assert_not_called()


@pytest.mark.parametrize("teardown", ["cancel", "close"])
@pytest.mark.asyncio
async def test_swarm_crash_restart_uncommitted_interrupt_resume_reruns_source_on_disk(
    teardown, mock_strands_tracer, mock_use_span
):
    """A node interrupted after handing off resumes before its handoff target, even if that resumed turn dies.

    An interrupted source inherits its own committed handoff, so its resumed turn starts with that target
    already pending. Persisting the target as the frontier would skip the source's unfinished work and strand
    the restored interrupt context, which is keyed to the source.
    """
    with tempfile.TemporaryDirectory() as live_dir, tempfile.TemporaryDirectory() as crash_dir:
        session_manager = FileSessionManager(session_id="uncommitted-resume", storage_dir=live_dir)
        first_agent = create_mock_agent("first")
        second_agent = create_mock_agent("second")
        swarm = Swarm([first_agent, second_agent], session_manager=session_manager)

        # The agent's own interrupt state activates, as it does for an interrupt raised inside the agent.
        async def handoff_then_interrupt(*args, **kwargs):
            yield {"agent_start": True}
            swarm._handle_handoff(swarm.nodes["second"], "message for second", {})
            first_agent._interrupt_state.activate()
            yield {"result": build_interrupt_result("interrupt-first")}

        first_agent.stream_async = Mock(side_effect=handoff_then_interrupt)

        interrupted_result = await swarm.invoke_async("test")
        assert interrupted_result.status == Status.INTERRUPTED

        responses = [
            {
                "interruptResponse": {
                    "interruptId": interrupted_result.interrupts[0].id,
                    "response": "test_response",
                },
            },
        ]

        async def never_finishes(*args, **kwargs):
            yield {"agent_start": True}
            await asyncio.sleep(0)
            yield {"result": build_interrupt_result("interrupt-first-again")}

        first_agent.stream_async = Mock(side_effect=never_finishes)

        stream = swarm.stream_async(responses)
        async for _event in stream:
            break
        if teardown == "close":
            await stream.aclose()
        else:
            # Throw into the generator rather than cancelling a task: real cancellation re-raises inside the
            # teardown hooks, so no checkpoint is written and the restore below would prove nothing.
            with pytest.raises(asyncio.CancelledError):
                await stream.athrow(asyncio.CancelledError())

        shutil.rmtree(crash_dir, ignore_errors=True)
        shutil.copytree(live_dir, crash_dir)

        resumed_manager = FileSessionManager(session_id="uncommitted-resume", storage_dir=crash_dir)
        first_agent2 = create_mock_agent("first")
        second_agent2 = create_mock_agent("second")
        resumed_swarm = Swarm([first_agent2, second_agent2], session_manager=resumed_manager)

        resumed_result = await resumed_swarm.invoke_async(responses)

        assert resumed_result.status == Status.COMPLETED
        tru_node_order = [node.node_id for node in resumed_result.node_history]
        exp_node_order = ["first", "second"]
        assert tru_node_order == exp_node_order
        assert "message for second" in second_agent2.stream_async.call_args[0][0][0]["text"]


@pytest.mark.asyncio
async def test_swarm_checkpoint_before_any_node_ran_keeps_restored_frontier(mock_strands_tracer, mock_use_span):
    """A restored swarm that checkpoints before running a node keeps its frontier on the node that owes work.

    A restored mid-handoff state carries the target while the frontier node still owes its turn, so promoting
    the target would drop that node's work on every restart cycle.
    """
    payload = resume_payload(frontier=["first"], handoff_node="second", handoff_message="message for second")

    resumed_swarm = Swarm([create_mock_agent("first"), create_mock_agent("second")])
    resumed_swarm.deserialize_state(payload)

    tru_frontier = resumed_swarm.serialize_state()["next_nodes_to_execute"]
    exp_frontier = ["first"]
    assert tru_frontier == exp_frontier

    reused_swarm = Swarm([create_mock_agent("first"), create_mock_agent("second")])
    await reused_swarm.invoke_async("earlier run")
    reused_swarm.deserialize_state(payload)

    assert reused_swarm.serialize_state()["next_nodes_to_execute"] == ["first"]


@pytest.mark.asyncio
async def test_swarm_interrupt_resume_cancelled_before_node_keeps_source_frontier(mock_strands_tracer, mock_use_span):
    """An interrupt-resume cancelled before its node starts keeps the frontier on the node that owes work.

    In-memory resume reuses the instance that ran the interrupting turn, so its committed outcome must not
    carry into the resuming invocation and promote a handoff that invocation merely inherited.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_then_interrupt(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {})
        first_agent._interrupt_state.activate()
        yield {"result": build_interrupt_result("interrupt-first")}

    first_agent.stream_async = Mock(side_effect=handoff_then_interrupt)

    interrupted_result = await swarm.invoke_async("test")
    assert interrupted_result.status == Status.INTERRUPTED

    async def block_before_node(event):
        await asyncio.sleep(1)

    swarm.hooks.add_callback(BeforeNodeCallEvent, block_before_node)
    responses = [
        {"interruptResponse": {"interruptId": interrupted_result.interrupts[0].id, "response": "test_response"}},
    ]

    stream = swarm.stream_async(responses)
    pending_first_event = asyncio.ensure_future(stream.asend(None))
    # Yield until the blocking hook has parked the generator inside its first turn, then cancel it there.
    await asyncio.sleep(0.01)
    pending_first_event.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending_first_event

    tru_frontier = swarm.serialize_state()["next_nodes_to_execute"]
    exp_frontier = ["first"]
    assert tru_frontier == exp_frontier


@pytest.mark.asyncio
async def test_swarm_resume_missing_frontier_node_resets_to_fresh_run(mock_strands_tracer, mock_use_span):
    """A resume frontier naming a node this swarm no longer defines restarts the task from the initial node.

    The persisted history, results, and pending handoff describe a topology that no longer exists, so resuming
    a surviving node would hand it another node's work.
    """
    payload = resume_payload(
        frontier=["removed_node"],
        node_history=["removed_node"],
        handoff_node="second",
        handoff_message="message for second",
        shared_context={"removed_node": {"removed_only": "leftover"}},
        task="saved task",
    )

    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm._resume_from_session is False
    assert resumed_swarm.state.completion_status == Status.PENDING
    assert resumed_swarm.state.handoff_node is None
    assert resumed_swarm.state.handoff_message is None
    assert resumed_swarm.shared_context.context == {}

    result = await resumed_swarm.invoke_async("fresh task")

    assert result.status == Status.COMPLETED
    tru_node_order = [node.node_id for node in result.node_history]
    exp_node_order = ["first"]
    assert tru_node_order == exp_node_order
    second_agent.stream_async.assert_not_called()
    node_input_text = first_agent.stream_async.call_args[0][0][0]["text"]
    assert "fresh task" in node_input_text
    assert "saved task" not in node_input_text
    assert "message for second" not in node_input_text
    assert "removed_only" not in node_input_text


@pytest.mark.asyncio
async def test_swarm_resume_pending_revisit_node_runs(mock_strands_tracer, mock_use_span):
    """A pending handoff to a node that already ran earlier resumes that node rather than restarting.

    In an A->B->A cycle the frontier node appears earlier in node_history, yet is still pending.
    """
    payload = resume_payload(
        frontier=["second"],
        node_history=["first", "second", "first"],
        handoff_message="back to second",
    )

    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm._resume_from_session is True
    assert resumed_swarm.serialize_state()["next_nodes_to_execute"] == ["second"]

    result = await resumed_swarm.invoke_async("test")

    assert result.status == Status.COMPLETED
    second_agent.stream_async.assert_called_once()
    first_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_resume_sanitizes_removed_nodes_from_restored_state(mock_strands_tracer, mock_use_span):
    """Restoring a resumable frontier keeps surviving nodes' state and drops every trace of removed ones.

    A handoff message is written for its target and shared context is keyed by node id, so both are rendered
    into a later node's prompt; entries belonging to a node this swarm no longer defines would leak there.
    """
    payload = resume_payload(
        frontier=["second"],
        node_history=["first"],
        handoff_node="removed_node",
        handoff_message="to removed",
        shared_context={
            "first": {"surviving_key": "surviving_value"},
            "removed_node": {"removed_key": "removed_value"},
        },
    )

    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm._resume_from_session is True
    assert resumed_swarm.state.current_node.node_id == "second"
    assert resumed_swarm.state.handoff_node is None
    assert resumed_swarm.state.handoff_message is None

    tru_context = resumed_swarm.shared_context.context
    exp_context = {"first": {"surviving_key": "surviving_value"}}
    assert tru_context == exp_context

    result = await resumed_swarm.invoke_async("test")

    assert result.status == Status.COMPLETED
    node_input_text = second_agent.stream_async.call_args[0][0][0]["text"]
    assert "surviving_value" in node_input_text
    assert "to removed" not in node_input_text
    assert "removed_value" not in node_input_text


@pytest.mark.parametrize("frontier", [[], ["removed_node"]])
@pytest.mark.asyncio
async def test_swarm_resume_reset_clears_active_interrupt_state(frontier, mock_strands_tracer, mock_use_span):
    """A reset drops an interrupt state whose context no longer matches the nodes that will run.

    Both _execute_node and reset_executor_state index interrupt context by node id, so a restored interrupt
    keyed to a node the restarted run does not execute would raise KeyError into a silent FAILED run.
    """
    payload = resume_payload(
        status="interrupted",
        frontier=frontier,
        node_history=["first"],
        interrupt_state=interrupt_context_for("removed_node"),
    )

    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm._interrupt_state.activated is False

    result = await resumed_swarm.invoke_async("test")
    assert result.status == Status.COMPLETED
    first_agent.stream_async.assert_called()


@pytest.mark.asyncio
async def test_swarm_handoff_then_interrupt_preserves_committed_handoff(mock_strands_tracer, mock_use_span):
    """A node that requests a handoff and then interrupts keeps that committed handoff through teardown.

    An interrupt pauses rather than fails the turn, so it commits.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_then_interrupt(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {"finding": "value"})
        yield {"result": build_interrupt_result("interrupt-first")}

    first_agent.stream_async = Mock(side_effect=handoff_then_interrupt)

    result = await swarm.invoke_async("test")
    assert result.status == Status.INTERRUPTED

    assert swarm.state.handoff_node is not None
    assert swarm.state.handoff_node.node_id == "second"
    assert swarm.state.handoff_message == "message for second"
    assert swarm.shared_context.context.get("first") == {"finding": "value"}


@pytest.mark.asyncio
async def test_swarm_resume_after_failed_handoff_does_not_mask_failure(mock_strands_tracer, mock_use_span):
    """A node that requests a handoff and then fails serializes an empty frontier, so resume resets.

    A failed run persists no resume frontier, so restoring it cannot resume as a success.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_then_fail(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "test message", {})
        raise RuntimeError("node blew up after requesting handoff")

    first_agent.stream_async = Mock(side_effect=handoff_then_fail)

    after_node_snapshots = []
    swarm.hooks.add_callback(
        AfterNodeCallEvent, lambda event: after_node_snapshots.append(swarm.serialize_state()), order=1000
    )

    result = await swarm.invoke_async("test")
    assert result.status == Status.FAILED

    # The after-node checkpoint fires before teardown, so the failing turn rolls back its own handoff.
    tru_after_node_context = after_node_snapshots[0]["context"]
    exp_after_node_context = {"shared_context": {}, "handoff_node": None, "handoff_message": None}
    assert tru_after_node_context == exp_after_node_context

    failed_snapshot = swarm.serialize_state()
    assert failed_snapshot["status"] == "failed"
    assert failed_snapshot["next_nodes_to_execute"] == []
    assert failed_snapshot["context"]["handoff_node"] is None

    first_agent2 = create_mock_agent("first")
    second_agent2 = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent2, second_agent2])
    resumed_swarm.deserialize_state(failed_snapshot)

    assert resumed_swarm._resume_from_session is False
    assert resumed_swarm.state.completion_status == Status.PENDING


@pytest.mark.asyncio
async def test_swarm_teardown_between_nodes_keeps_the_handoff_target_as_frontier(mock_strands_tracer, mock_use_span):
    """A teardown after a handoff is applied but before the target starts keeps that target as the frontier.

    The finished turn stops speaking for the frontier once its handoff is applied: the target now owes a turn
    of its own, and no turn is in flight until it starts, so the checkpoint must still name the target.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_to_second(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {})
        yield {"result": first_agent.return_value}

    first_agent.stream_async = Mock(side_effect=handoff_to_second)

    # Tear down where the swarm has advanced to 'second' but has not begun its turn.
    def exit_before_second(event):
        if event.node_id == "second":
            raise SystemExit("controlled exit before second")

    swarm.hooks.add_callback(BeforeNodeCallEvent, exit_before_second)

    with pytest.raises(SystemExit):
        await swarm.invoke_async("test")

    snapshot = swarm.serialize_state()
    assert snapshot["status"] == "executing"
    assert snapshot["node_history"] == ["first"]
    tru_frontier = snapshot["next_nodes_to_execute"]
    exp_frontier = ["second"]
    assert tru_frontier == exp_frontier

    resumed_first = create_mock_agent("first")
    resumed_second = create_mock_agent("second")
    resumed_swarm = Swarm([resumed_first, resumed_second])
    resumed_swarm.deserialize_state(snapshot)
    result = await resumed_swarm.invoke_async("test")

    assert result.status == Status.COMPLETED
    resumed_second.stream_async.assert_called_once()
    resumed_first.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_repeated_crash_at_completed_turn_is_a_fixed_point(mock_strands_tracer, mock_use_span):
    """Crashing repeatedly at the same completed turn records that turn once, not once per crash.

    A committed turn with no handoff owes nothing, so its checkpoint must be a fixed point: node_history
    feeds should_continue's limits, the repetitive-handoff window, and each node's prompt, so an entry added
    per crash would eventually stop the swarm from running anything.
    """
    snapshot = None
    for _generation in range(3):
        agent = create_mock_agent("solo")
        swarm = Swarm([agent], max_iterations=2)
        if snapshot is not None:
            swarm.deserialize_state(snapshot)

        stream = swarm.stream_async("test")
        async for event in stream:
            if event.get("type") == "multiagent_node_stop":
                break
        await stream.aclose()

        snapshot = swarm.serialize_state()
        assert snapshot["node_history"] == ["solo"]
        # The turn is done and owes no handoff, so nothing is left to resume.
        assert snapshot["next_nodes_to_execute"] == []

    final_agent = create_mock_agent("solo")
    final_swarm = Swarm([final_agent], max_iterations=2)
    final_swarm.deserialize_state(snapshot)
    result = await final_swarm.invoke_async("test")

    assert result.status == Status.COMPLETED
    assert result.execution_count == 1


@pytest.mark.asyncio
async def test_swarm_stream_closed_at_self_handoff_completion_keeps_one_pending_turn(
    mock_strands_tracer, mock_use_span
):
    """A node that self-hands-off and completes leaves exactly one pending turn, not two.

    The frontier already carries the self-handoff target, so persisting the handoff beside it would make the
    restored swarm run that node once for the frontier and again for the handoff.
    """
    first_agent = create_mock_agent("first")
    swarm = Swarm([first_agent, create_mock_agent("second")])

    async def self_handoff_then_succeed(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["first"], "loop again", {})
        yield {"result": first_agent.return_value}

    first_agent.stream_async = Mock(side_effect=self_handoff_then_succeed)

    stream = swarm.stream_async("test")
    async for event in stream:
        if event.get("type") == "multiagent_node_stop":
            break
    await stream.aclose()

    snapshot = swarm.serialize_state()
    assert snapshot["next_nodes_to_execute"] == ["first"]
    assert snapshot["context"]["handoff_node"] is None

    resumed_agent = create_mock_agent("first")
    resumed_swarm = Swarm([resumed_agent, create_mock_agent("second")])
    resumed_swarm.deserialize_state(snapshot)
    await resumed_swarm.invoke_async("test")

    resumed_agent.stream_async.assert_called_once()


def test_swarm_serialize_omits_handoff_the_resume_frontier_carries():
    """A handoff the resume frontier already carries is not persisted.

    A persisted handoff always means its target still owes a turn, so the writer settles that where the
    turn's outcome is known instead of leaving restore to infer it from a frontier/target equality.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])
    swarm.state = SwarmState(
        current_node=swarm.nodes["first"],
        task="test",
        completion_status=Status.EXECUTING,
        shared_context=swarm.shared_context,
    )
    swarm.state.handoff_node = swarm.nodes["second"]
    swarm.state.handoff_message = "message for second"
    swarm._turn = _InflightTurn(None, None, {}, outcome="committed")

    snapshot = swarm.serialize_state()

    assert snapshot["next_nodes_to_execute"] == ["second"]
    assert snapshot["context"]["handoff_node"] is None
    # The frontier node is the intended recipient, so its message still travels with it.
    assert snapshot["context"]["handoff_message"] == "message for second"


@pytest.mark.asyncio
async def test_swarm_resume_honors_a_persisted_handoff_the_frontier_does_not_carry(mock_strands_tracer, mock_use_span):
    """A persisted handoff whose target is also the frontier is honored as still pending.

    Restore takes the payload literally, so a checkpoint written without the omit-what-the-frontier-carries
    rule replays a turn rather than skipping one.
    """
    payload = resume_payload(
        frontier=["first"],
        node_history=["first"],
        handoff_node="first",
        handoff_message="again",
    )

    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm.state.handoff_node is not None
    assert resumed_swarm.state.handoff_node.node_id == "first"

    result = await resumed_swarm.invoke_async("test")

    tru_node_order = [node.node_id for node in result.node_history]
    exp_node_order = ["first", "first", "first"]
    assert tru_node_order == exp_node_order
    second_agent.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_resume_pending_self_handoff_survives_second_restart(mock_strands_tracer, mock_use_span):
    """A pending self-handoff survives restore at any depth, not just the generation that recorded it.

    The second restart's checkpoint is EXECUTING rather than INTERRUPTED, so status cannot distinguish a
    frontier that carries its handoff from a self-handoff that is still owed.
    """
    first_agent = create_mock_agent("first")
    swarm = Swarm([first_agent, create_mock_agent("second")])

    async def self_handoff_then_interrupt(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["first"], "loop again", {})
        first_agent._interrupt_state.activate()
        yield {"result": build_interrupt_result("interrupt-first")}

    first_agent.stream_async = Mock(side_effect=self_handoff_then_interrupt)

    interrupted_result = await swarm.invoke_async("test")
    assert interrupted_result.status == Status.INTERRUPTED
    first_snapshot = swarm.serialize_state()
    responses = [
        {"interruptResponse": {"interruptId": interrupted_result.interrupts[0].id, "response": "test_response"}},
    ]

    # Second generation: resume the self-handoff, then die before the resumed turn commits.
    resumed_agent = create_mock_agent("first")
    resumed_swarm = Swarm([resumed_agent, create_mock_agent("second")])
    resumed_swarm.deserialize_state(first_snapshot)

    async def dies_mid_turn(*args, **kwargs):
        yield {"agent_start": True}
        await asyncio.sleep(0.05)
        yield {"result": build_interrupt_result("interrupt-first-again")}

    resumed_agent.stream_async = Mock(side_effect=dies_mid_turn)
    stream = resumed_swarm.stream_async(responses)
    async for _event in stream:
        break
    await stream.aclose()
    second_snapshot = resumed_swarm.serialize_state()

    # Third generation: the self-handoff must still be owed, so 'first' runs its own turn and the handoff.
    final_agent = create_mock_agent("first")
    final_swarm = Swarm([final_agent, create_mock_agent("second")])
    final_swarm.deserialize_state(second_snapshot)
    final_result = await final_swarm.invoke_async(responses)

    tru_node_order = [node.node_id for node in final_result.node_history]
    exp_node_order = ["first", "first"]
    assert tru_node_order == exp_node_order


@pytest.mark.asyncio
async def test_swarm_stream_closed_at_node_stop_event_keeps_committed_turn(mock_strands_tracer, mock_use_span):
    """A stream closed on a node's terminal event checkpoints that node as done, handoff included.

    The node's result, metrics, and shared-context writes are already recorded when its stop event is
    forwarded, so a teardown arriving at that yield has nothing left to roll back.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_then_succeed(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {"finding": "value"})
        yield {"result": first_agent.return_value}

    first_agent.stream_async = Mock(side_effect=handoff_then_succeed)

    stream = swarm.stream_async("test")
    async for event in stream:
        if event.get("type") == "multiagent_node_stop":
            break
    await stream.aclose()

    snapshot = swarm.serialize_state()
    assert snapshot["next_nodes_to_execute"] == ["second"]
    assert snapshot["node_history"] == ["first"]
    assert snapshot["context"]["handoff_message"] == "message for second"
    assert snapshot["context"]["shared_context"].get("first") == {"finding": "value"}

    # The restored swarm runs the handoff target with the message the crashed turn had already written.
    resumed_first = create_mock_agent("first")
    resumed_second = create_mock_agent("second")
    resumed_swarm = Swarm([resumed_first, resumed_second])
    resumed_swarm.deserialize_state(snapshot)
    await resumed_swarm.invoke_async("test")

    resumed_first.stream_async.assert_not_called()
    assert "message for second" in resumed_second.stream_async.call_args[0][0][0]["text"]


@pytest.mark.asyncio
async def test_swarm_stream_closed_at_interrupt_stop_event_replays_source(mock_strands_tracer, mock_use_span):
    """A stream closed on an interrupting node's terminal event replays that node rather than losing it.

    The turn commits only once the interrupt is recorded, so a teardown before that leaves the node owing
    its turn instead of skipping it with an interrupt that was never persisted.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")
    swarm = Swarm([first_agent, second_agent])

    async def handoff_then_interrupt(*args, **kwargs):
        yield {"agent_start": True}
        swarm._handle_handoff(swarm.nodes["second"], "message for second", {})
        first_agent._interrupt_state.activate()
        yield {"result": build_interrupt_result("interrupt-first")}

    first_agent.stream_async = Mock(side_effect=handoff_then_interrupt)

    stream = swarm.stream_async("test")
    async for event in stream:
        if event.get("type") == "multiagent_node_stop":
            break
    await stream.aclose()

    snapshot = swarm.serialize_state()
    assert snapshot["next_nodes_to_execute"] == ["first"]
    assert snapshot["_internal_state"]["interrupt_state"]["activated"] is False

    resumed_agent = create_mock_agent("first")
    resumed_second = create_mock_agent("second")
    resumed_swarm = Swarm([resumed_agent, resumed_second])
    resumed_swarm.deserialize_state(snapshot)
    await resumed_swarm.invoke_async("test")

    resumed_agent.stream_async.assert_called_once()
    resumed_second.stream_async.assert_not_called()


@pytest.mark.asyncio
async def test_swarm_resume_interrupted_self_handoff_preserved(mock_strands_tracer, mock_use_span):
    """An interrupted node with a pending self-handoff keeps that handoff on restore.

    An INTERRUPTED checkpoint's frontier is the current node, so a self-handoff equals that frontier by
    coincidence rather than because the frontier already satisfies it.
    """
    first_agent = create_mock_agent("first")
    second_agent = create_mock_agent("second")

    payload = {
        "status": "interrupted",
        "node_history": ["first"],
        "node_results": {},
        "current_task": "test",
        "next_nodes_to_execute": ["first"],
        "context": {"shared_context": {}, "handoff_node": "first", "handoff_message": "loop back"},
        "_internal_state": {"interrupt_state": {"activated": False, "context": {}, "interrupts": {}}},
    }

    resumed_swarm = Swarm([first_agent, second_agent])
    resumed_swarm.deserialize_state(payload)

    assert resumed_swarm._resume_from_session is True
    assert resumed_swarm.state.current_node.node_id == "first"
    assert resumed_swarm.state.handoff_node is not None
    assert resumed_swarm.state.handoff_node.node_id == "first"


@pytest.mark.parametrize(
    ("skip_node", "skip_message"),
    [(True, "node skipped by user"), ("custom skip message", "custom skip message")],
)
@pytest.mark.asyncio
async def test_swarm_skip_node(skip_node, skip_message, alist):
    def skip_callback(event):
        event.skip_node = skip_node
        return event

    agent = create_mock_agent("test_agent", "Should not execute")
    swarm = Swarm([agent])
    swarm.hooks.add_callback(BeforeNodeCallEvent, skip_callback)

    stream = swarm.stream_async("test task")

    tru_events = await alist(stream)
    exp_events = [
        {
            "message": skip_message,
            "node_id": "test_agent",
            "type": "multiagent_node_skip",
        },
        {
            "result": ANY,
            "type": "multiagent_result",
        },
    ]
    assert tru_events == exp_events

    tru_status = swarm.state.completion_status
    exp_status = Status.FAILED
    assert tru_status == exp_status


@pytest.mark.parametrize(
    ("cancel_node", "cancel_message"),
    [(True, "node skipped by user"), ("custom cancel message", "custom cancel message")],
)
@pytest.mark.asyncio
async def test_swarm_cancel_node_backward_compat(cancel_node, cancel_message, alist):
    """cancel_node works as a backward-compatible alias for skip_node and produces multiagent_node_skip."""

    def cancel_callback(event):
        event.cancel_node = cancel_node
        return event

    agent = create_mock_agent("test_agent", "Should not execute")
    swarm = Swarm([agent])
    swarm.hooks.add_callback(BeforeNodeCallEvent, cancel_callback)

    tru_events = await alist(swarm.stream_async("test task"))

    exp_events = [
        {
            "message": cancel_message,
            "node_id": "test_agent",
            "type": "multiagent_node_skip",
        },
        {
            "result": ANY,
            "type": "multiagent_result",
        },
    ]
    assert tru_events == exp_events

    tru_status = swarm.state.completion_status
    exp_status = Status.FAILED
    assert tru_status == exp_status


def test_swarm_interrupt_on_before_node_call_event(interrupt_hook):
    agent = create_mock_agent("test_agent", "Task completed")
    swarm = Swarm([agent], hooks=[interrupt_hook])

    multiagent_result = swarm("Test task")

    first_execution_time = multiagent_result.execution_time

    tru_status = multiagent_result.status
    exp_status = Status.INTERRUPTED
    assert tru_status == exp_status

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
    multiagent_result = swarm(responses)

    tru_status = multiagent_result.status
    exp_status = Status.COMPLETED
    assert tru_status == exp_status

    assert len(multiagent_result.results) == 1
    agent_result = multiagent_result.results["test_agent"]

    tru_message = agent_result.result.message["content"][0]["text"]
    exp_message = "Task completed"
    assert tru_message == exp_message

    tru_after_count = interrupt_hook.after_count
    exp_after_count = 1
    assert tru_after_count == exp_after_count

    assert multiagent_result.execution_time >= first_execution_time


def test_swarm_interrupt_on_agent(agenerator):
    exp_interrupts = [
        Interrupt(
            id="test_id",
            name="test_name",
            reason="test_reason",
        ),
    ]

    agent = create_mock_agent("test_agent", "Task completed")

    swarm = Swarm([agent])

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
    multiagent_result = swarm("Test task")

    tru_status = multiagent_result.status
    exp_status = Status.INTERRUPTED
    assert tru_status == exp_status

    tru_interrupts = multiagent_result.interrupts
    assert tru_interrupts == exp_interrupts

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
    swarm._interrupt_state.context["test_agent"]["activated"] = True

    interrupt = multiagent_result.interrupts[0]
    responses = [
        {
            "interruptResponse": {
                "interruptId": interrupt.id,
                "response": "test_response",
            },
        },
    ]
    multiagent_result = swarm(responses)

    tru_status = multiagent_result.status
    exp_status = Status.COMPLETED
    assert tru_status == exp_status

    agent.stream_async.assert_called_once_with(responses, invocation_state={})
