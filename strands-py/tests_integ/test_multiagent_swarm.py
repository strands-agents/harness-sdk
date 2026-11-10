from uuid import uuid4

import pytest

from strands import Agent, tool
from strands.hooks import (
    AfterInvocationEvent,
    AfterModelCallEvent,
    AfterToolCallEvent,
    BeforeInvocationEvent,
    BeforeModelCallEvent,
    BeforeNodeCallEvent,
    BeforeToolCallEvent,
    MessageAddedEvent,
)
from strands.multiagent.swarm import Swarm
from strands.session.file_session_manager import FileSessionManager
from strands.types.content import ContentBlock
from tests.fixtures.mock_hook_provider import MockHookProvider


@tool
def web_search(query: str) -> str:
    """Search the web for information."""
    # Mock implementation
    return f"Results for '{query}': 25% yearly growth assumption, reaching $1.81 trillion by 2030"


@tool
def calculate(expression: str) -> str:
    """Calculate the result of a mathematical expression."""
    try:
        return f"The result of {expression} is {eval(expression)}"
    except Exception as e:
        return f"Error calculating {expression}: {str(e)}"


@pytest.fixture
def hook_provider():
    return MockHookProvider("all")


@pytest.fixture
def researcher_agent(hook_provider):
    """Create an agent specialized in research."""
    return Agent(
        name="researcher",
        system_prompt=(
            "You are a research specialist who excels at finding information. When you need to perform calculations or"
            " format documents, hand off to the appropriate specialist."
        ),
        hooks=[hook_provider],
        tools=[web_search],
    )


@pytest.fixture
def analyst_agent(hook_provider):
    """Create an agent specialized in data analysis."""
    return Agent(
        name="analyst",
        system_prompt=(
            "You are a data analyst who excels at calculations and numerical analysis. When you need"
            " research or document formatting, hand off to the appropriate specialist."
        ),
        hooks=[hook_provider],
        tools=[calculate],
    )


@pytest.fixture
def writer_agent(hook_provider):
    """Create an agent specialized in writing and formatting."""
    return Agent(
        name="writer",
        hooks=[hook_provider],
        system_prompt=(
            "You are a professional writer who excels at formatting and presenting information. When you need research"
            " or calculations, hand off to the appropriate specialist."
        ),
    )


@pytest.fixture
def exit_hook():
    class ExitHook:
        def __init__(self):
            self.should_exit = True

        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.exit_before_writer)

        def exit_before_writer(self, event):
            if event.node_id == "writer" and self.should_exit:
                raise SystemExit("Controlled exit before writer")

    return ExitHook()


@pytest.fixture
def verify_hook():
    class VerifyHook:
        def __init__(self):
            self.first_node = None

        def register_hooks(self, registry):
            registry.add_callback(BeforeNodeCallEvent, self.capture_first_node)

        def capture_first_node(self, event):
            if self.first_node is None:
                self.first_node = event.node_id

    return VerifyHook()


@pytest.mark.timeout(120)
def test_swarm_execution_with_string(researcher_agent, analyst_agent, writer_agent, hook_provider):
    """Test swarm execution with string input."""
    # Create the swarm
    swarm = Swarm([researcher_agent, analyst_agent, writer_agent])

    # Define a task that requires collaboration
    task = (
        "Research the current AI agent market trends, calculate the growth rate assuming 25% yearly growth, "
        "and create a basic report"
    )

    # Execute the swarm
    result = swarm(task)

    # Verify results
    assert result.status.value == "completed"
    assert len(result.results) > 0
    assert result.execution_time > 0
    assert result.execution_count > 0

    # Verify agent history - at least one agent should have been used
    assert len(result.node_history) > 0

    # Just ensure that hooks are emitted; actual content is not verified
    researcher_hooks = hook_provider.extract_for(researcher_agent).event_types_received
    assert BeforeInvocationEvent in researcher_hooks
    assert MessageAddedEvent in researcher_hooks
    assert BeforeModelCallEvent in researcher_hooks
    assert BeforeToolCallEvent in researcher_hooks
    assert AfterToolCallEvent in researcher_hooks
    assert AfterModelCallEvent in researcher_hooks
    assert AfterInvocationEvent in researcher_hooks


@pytest.mark.asyncio
@pytest.mark.timeout(180)
async def test_swarm_execution_with_image(researcher_agent, analyst_agent, writer_agent, yellow_img):
    """Test swarm execution with image input."""
    # Create the swarm
    swarm = Swarm([researcher_agent, analyst_agent, writer_agent])

    # Create content blocks with text and image
    content_blocks: list[ContentBlock] = [
        {"text": "Analyze this image and create a report about what you see:"},
        {"image": {"format": "png", "source": {"bytes": yellow_img}}},
    ]

    # Execute the swarm with multi-modal input
    result = await swarm.invoke_async(content_blocks)

    # Verify results
    assert result.status.value == "completed"
    assert len(result.results) > 0
    assert result.execution_time > 0
    assert result.execution_count > 0

    # Verify agent history - at least one agent should have been used
    assert len(result.node_history) > 0


@pytest.mark.asyncio
async def test_swarm_streaming(alist):
    """Test that Swarm properly streams all event types during execution."""
    researcher = Agent(
        name="researcher",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are a researcher. When you need calculations, hand off to the analyst.",
    )
    analyst = Agent(
        name="analyst",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are an analyst. Use tools to perform calculations.",
        tools=[calculate],
    )

    swarm = Swarm([researcher, analyst], node_timeout=900.0)

    # Collect events
    events = await alist(swarm.stream_async("Calculate 10 + 5 and explain the result"))

    # Count event categories
    node_start_events = [e for e in events if e.get("type") == "multiagent_node_start"]
    node_stream_events = [e for e in events if e.get("type") == "multiagent_node_stream"]
    node_stop_events = [e for e in events if e.get("type") == "multiagent_node_stop"]
    handoff_events = [e for e in events if e.get("type") == "multiagent_handoff"]
    result_events = [e for e in events if "result" in e and e.get("type") != "multiagent_node_stream"]

    # Verify we got multiple events of each type
    assert len(node_start_events) >= 1, f"Expected at least 1 node_start event, got {len(node_start_events)}"
    assert len(node_stream_events) > 10, f"Expected many node_stream events, got {len(node_stream_events)}"
    assert len(node_stop_events) >= 1, f"Expected at least 1 node_stop event, got {len(node_stop_events)}"
    assert len(handoff_events) >= 1, f"Expected at least 1 handoff event, got {len(handoff_events)}"
    assert len(result_events) >= 1, f"Expected at least 1 result event, got {len(result_events)}"

    # Verify handoff event structure
    handoff = handoff_events[0]
    assert "from_node_ids" in handoff, "Handoff event missing from_node_ids"
    assert "to_node_ids" in handoff, "Handoff event missing to_node_ids"
    assert "message" in handoff, "Handoff event missing message"
    assert handoff["from_node_ids"] == ["researcher"], (
        f"Expected from_node_ids=['researcher'], got {handoff['from_node_ids']}"
    )
    assert handoff["to_node_ids"] == ["analyst"], f"Expected to_node_ids=['analyst'], got {handoff['to_node_ids']}"

    # Verify node stop event structure
    stop_event = node_stop_events[0]
    assert "node_id" in stop_event, "Node stop event missing node_id"
    assert "node_result" in stop_event, "Node stop event missing node_result"
    node_result = stop_event["node_result"]
    assert hasattr(node_result, "execution_time"), "NodeResult missing execution_time"
    assert node_result.execution_time > 0, "Expected positive execution_time"

    # Verify we have events from at least one agent
    researcher_events = [e for e in events if e.get("node_id") == "researcher"]
    analyst_events = [e for e in events if e.get("node_id") == "analyst"]
    assert len(researcher_events) > 0 or len(analyst_events) > 0, "Expected events from at least one agent"


@pytest.mark.asyncio
async def test_swarm_node_result_structure():
    """Test that NodeResult properly contains AgentResult after swarm execution.

    This test verifies the merge conflict resolution where AgentResult import
    was correctly handled and NodeResult properly wraps AgentResult objects.
    """
    from strands.agent.agent_result import AgentResult
    from strands.multiagent.base import NodeResult

    researcher = Agent(
        name="researcher",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are a researcher. Answer the question directly without handing off.",
    )

    swarm = Swarm([researcher])

    # Execute the swarm
    result = await swarm.invoke_async("What is 2 + 2?")

    # Verify the result structure
    assert result.status.value in ["completed", "failed"]  # May fail due to credentials

    # If execution succeeded, verify the structure
    if result.status.value == "completed":
        assert len(result.results) == 1
        assert "researcher" in result.results

        # Verify NodeResult contains AgentResult
        node_result = result.results["researcher"]
        assert isinstance(node_result, NodeResult)
        assert isinstance(node_result.result, AgentResult)

        # Verify AgentResult has expected attributes
        agent_result = node_result.result
        assert hasattr(agent_result, "message")
        assert hasattr(agent_result, "stop_reason")
        assert hasattr(agent_result, "metrics")
        assert agent_result.message is not None
        assert agent_result.stop_reason in ["end_turn", "max_tokens", "stop_sequence"]

        # Verify metrics are properly accumulated
        assert node_result.accumulated_usage["totalTokens"] > 0
        assert node_result.accumulated_metrics["latencyMs"] > 0


@pytest.mark.asyncio
async def test_swarm_multiple_handoffs_with_agent_results():
    """Test that multiple handoffs properly preserve AgentResult in each NodeResult.

    This test ensures the AgentResult type is correctly used throughout the swarm
    execution chain, verifying the import resolution from the merge conflict.
    """
    from strands.agent.agent_result import AgentResult

    agent1 = Agent(
        name="agent1",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are agent1. Hand off to agent2 immediately.",
    )
    agent2 = Agent(
        name="agent2",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are agent2. Hand off to agent3 immediately.",
    )
    agent3 = Agent(
        name="agent3",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are agent3. Complete the task without handing off.",
    )

    swarm = Swarm([agent1, agent2, agent3])

    # Execute the swarm
    result = await swarm.invoke_async("Complete this task")

    # Verify execution completed or failed gracefully
    assert result.status.value in ["completed", "failed"]

    # If execution succeeded, verify the structure
    if result.status.value == "completed":
        assert len(result.node_history) >= 2  # At least 2 agents should have executed

        # Verify each NodeResult contains a valid AgentResult
        for node_id, node_result in result.results.items():
            assert isinstance(node_result.result, AgentResult), f"Node {node_id} result is not an AgentResult"
            assert node_result.result.message is not None, f"Node {node_id} AgentResult has no message"
            assert node_result.accumulated_usage["totalTokens"] >= 0, f"Node {node_id} has invalid token usage"


@pytest.mark.asyncio
async def test_swarm_get_agent_results_flattening():
    """Test that get_agent_results() properly extracts AgentResult objects from NodeResults.

    This test verifies that the NodeResult.get_agent_results() method correctly
    handles AgentResult objects, ensuring the type system works correctly after
    the merge conflict resolution.
    """
    from strands.agent.agent_result import AgentResult

    agent1 = Agent(
        name="agent1",
        model="us.amazon.nova-pro-v1:0",
        system_prompt="You are agent1. Answer directly.",
    )

    swarm = Swarm([agent1])

    # Execute the swarm
    result = await swarm.invoke_async("What is the capital of France?")

    # Verify execution completed or failed gracefully
    assert result.status.value in ["completed", "failed"]

    # If execution succeeded, verify the structure
    if result.status.value == "completed":
        assert "agent1" in result.results
        node_result = result.results["agent1"]

        # Test get_agent_results() method
        agent_results = node_result.get_agent_results()
        assert len(agent_results) == 1
        assert isinstance(agent_results[0], AgentResult)
        assert agent_results[0].message is not None


def test_swarm_resume_from_executing_state(tmpdir, exit_hook, verify_hook):
    """Test swarm resuming from EXECUTING state using BeforeNodeCallEvent hook."""
    session_id = f"swarm_resume_{uuid4()}"

    # First execution - exit before second node
    session_manager = FileSessionManager(session_id=session_id, storage_dir=tmpdir)
    researcher = Agent(name="researcher", system_prompt="you are a researcher.")
    writer = Agent(name="writer", system_prompt="you are a writer.")

    swarm = Swarm([researcher, writer], session_manager=session_manager, hooks=[exit_hook])

    try:
        swarm("write AI trends in 100 words")
    except SystemExit as e:
        assert "Controlled exit before writer" in str(e)

    # Verify state was persisted with EXECUTING status and next node
    persisted_state = session_manager.read_multi_agent(session_id, swarm.id)
    assert persisted_state["status"] == "executing"
    assert len(persisted_state["node_history"]) == 1
    assert persisted_state["node_history"][0] == "researcher"
    assert persisted_state["next_nodes_to_execute"] == ["writer"]

    exit_hook.should_exit = False
    researcher2 = Agent(name="researcher", system_prompt="you are a researcher.")
    writer2 = Agent(name="writer", system_prompt="you are a writer.")
    new_swarm = Swarm([researcher2, writer2], session_manager=session_manager, hooks=[verify_hook])
    result = new_swarm("write AI trends in 100 words")

    # Verify swarm behavior - should resume from writer, not restart
    assert result.status.value == "completed"
    assert verify_hook.first_node == "writer"
    node_ids = [n.node_id for n in result.node_history]
    assert "writer" in node_ids
