from unittest.mock import Mock

import pytest

from strands import Agent
from strands.hooks import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    MultiAgentInitializedEvent,
)
from strands.multiagent.graph import Graph, GraphBuilder
from strands.multiagent.swarm import Swarm
from tests.fixtures.mock_multiagent_hook_provider import MockMultiAgentHookProvider
from tests.fixtures.mocked_model_provider import MockedModelProvider


@pytest.fixture
def hook_provider():
    return MockMultiAgentHookProvider(
        [
            BeforeMultiAgentInvocationEvent,
            AfterMultiAgentInvocationEvent,
            AfterNodeCallEvent,
            BeforeNodeCallEvent,
            MultiAgentInitializedEvent,
        ]
    )


@pytest.fixture
def mock_model():
    agent_messages = [
        {"role": "assistant", "content": [{"text": "Task completed"}]},
        {"role": "assistant", "content": [{"text": "Task completed by agent 2"}]},
        {"role": "assistant", "content": [{"text": "Additional response"}]},
    ]
    return MockedModelProvider(agent_messages)


@pytest.fixture
def agent1(mock_model):
    return Agent(model=mock_model, system_prompt="You are agent 1.", name="agent1")


@pytest.fixture
def agent2(mock_model):
    return Agent(model=mock_model, system_prompt="You are agent 2.", name="agent2")


@pytest.fixture
def swarm(agent1, agent2, hook_provider):
    swarm = Swarm(nodes=[agent1, agent2], hooks=[hook_provider])
    return swarm


@pytest.fixture
def graph(agent1, agent2, hook_provider):
    builder = GraphBuilder()
    builder.add_node(agent1, "agent1")
    builder.add_node(agent2, "agent2")
    builder.add_edge("agent1", "agent2")
    builder.set_entry_point("agent1")
    graph = Graph(nodes=builder.nodes, edges=builder.edges, entry_points=builder.entry_points, hooks=[hook_provider])
    return graph


def test_swarm_complete_hook_lifecycle(swarm, hook_provider):
    """E2E test verifying complete hook lifecycle for Swarm."""
    result = swarm("test task")

    length, events = hook_provider.get_events()
    assert length == 5
    assert result.status.value == "completed"

    events_list = list(events)

    # Check event types and basic properties, ignoring invocation_state
    assert isinstance(events_list[0], MultiAgentInitializedEvent)
    assert events_list[0].source == swarm

    assert isinstance(events_list[1], BeforeMultiAgentInvocationEvent)
    assert events_list[1].source == swarm

    assert isinstance(events_list[2], BeforeNodeCallEvent)
    assert events_list[2].source == swarm
    assert events_list[2].node_id == "agent1"

    assert isinstance(events_list[3], AfterNodeCallEvent)
    assert events_list[3].source == swarm
    assert events_list[3].node_id == "agent1"

    assert isinstance(events_list[4], AfterMultiAgentInvocationEvent)
    assert events_list[4].source == swarm


def test_graph_complete_hook_lifecycle(graph, hook_provider):
    """E2E test verifying complete hook lifecycle for Graph."""
    result = graph("test task")

    length, events = hook_provider.get_events()
    assert length == 7
    assert result.status.value == "completed"

    events_list = list(events)

    # Check event types and basic properties, ignoring invocation_state
    assert isinstance(events_list[0], MultiAgentInitializedEvent)
    assert events_list[0].source == graph

    assert isinstance(events_list[1], BeforeMultiAgentInvocationEvent)
    assert events_list[1].source == graph

    assert isinstance(events_list[2], BeforeNodeCallEvent)
    assert events_list[2].source == graph
    assert events_list[2].node_id == "agent1"

    assert isinstance(events_list[3], AfterNodeCallEvent)
    assert events_list[3].source == graph
    assert events_list[3].node_id == "agent1"

    assert isinstance(events_list[4], BeforeNodeCallEvent)
    assert events_list[4].source == graph
    assert events_list[4].node_id == "agent2"

    assert isinstance(events_list[5], AfterNodeCallEvent)
    assert events_list[5].source == graph
    assert events_list[5].node_id == "agent2"

    assert isinstance(events_list[6], AfterMultiAgentInvocationEvent)
    assert events_list[6].source == graph


@pytest.mark.parametrize("invocation_state", [{}, {"request_id": "req-1"}])
@pytest.mark.asyncio
async def test_graph_after_hook_precedes_terminal_result(graph, hook_provider, invocation_state):
    """The terminal result includes completed invocation cleanup and its state (#4411)."""
    stream = graph.stream_async("test task", invocation_state=invocation_state)
    try:
        async for event in stream:
            if "result" in event:
                after_event = hook_provider.events_received[-1]
                assert isinstance(after_event, AfterMultiAgentInvocationEvent)
                assert after_event.invocation_state is invocation_state
                assert event["result"].execution_time == graph.state.execution_time
                break
        else:
            pytest.fail("Graph did not yield a terminal result")
    finally:
        await stream.aclose()

    assert hook_provider.event_types_received.count(AfterMultiAgentInvocationEvent) == 1


@pytest.mark.asyncio
async def test_graph_after_hook_receives_state_on_error(graph, hook_provider, monkeypatch, alist):
    """Execution errors still run the after hook with the active state (#4411)."""
    invocation_state = {"request_id": "req-1"}
    error = RuntimeError("graph execution failed")
    monkeypatch.setattr(graph, "_execute_graph", Mock(side_effect=error))

    with pytest.raises(RuntimeError) as raised:
        await alist(graph.stream_async("test task", invocation_state=invocation_state))

    assert raised.value is error
    after_event = hook_provider.events_received[-1]
    assert isinstance(after_event, AfterMultiAgentInvocationEvent)
    assert after_event.invocation_state is invocation_state
    assert hook_provider.event_types_received.count(AfterMultiAgentInvocationEvent) == 1


@pytest.mark.asyncio
async def test_graph_after_hook_receives_state_on_close(graph, hook_provider):
    """Closing a partial stream runs the after hook exactly once with its state (#4411)."""
    invocation_state = {"request_id": "req-1"}
    stream = graph.stream_async("test task", invocation_state=invocation_state)
    try:
        await anext(stream)
    finally:
        await stream.aclose()

    after_event = hook_provider.events_received[-1]
    assert isinstance(after_event, AfterMultiAgentInvocationEvent)
    assert after_event.invocation_state is invocation_state
    assert hook_provider.event_types_received.count(AfterMultiAgentInvocationEvent) == 1


@pytest.mark.asyncio
async def test_graph_after_hook_error_prevents_terminal_result(graph):
    """A failed cleanup must not expose a successful terminal result (#4411)."""
    error = RuntimeError("cleanup failed")
    graph.add_hook(Mock(side_effect=error), AfterMultiAgentInvocationEvent)
    events = []

    with pytest.raises(RuntimeError) as raised:
        async for event in graph.stream_async("test task"):
            events.append(event)

    assert raised.value is error
    assert not any("result" in event for event in events)
