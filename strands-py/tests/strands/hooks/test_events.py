"""Tests for multi-agent execution lifecycle events."""

from unittest.mock import Mock

import pytest

from strands.hooks import (
    AfterMultiAgentInvocationEvent,
    AfterNodeCallEvent,
    BaseHookEvent,
    BeforeMultiAgentInvocationEvent,
    BeforeNodeCallEvent,
    MultiAgentInitializedEvent,
)


@pytest.fixture
def orchestrator():
    """Mock orchestrator for testing."""
    return Mock()


def test_multi_agent_initialization_event_with_orchestrator_only(orchestrator):
    """Test MultiAgentInitializedEvent creation with orchestrator only."""
    event = MultiAgentInitializedEvent(source=orchestrator)

    assert event.source is orchestrator
    assert event.invocation_state is None
    assert isinstance(event, BaseHookEvent)


def test_multi_agent_initialization_event_with_invocation_state(orchestrator):
    """Test MultiAgentInitializedEvent creation with invocation state."""
    invocation_state = {"key": "value"}
    event = MultiAgentInitializedEvent(source=orchestrator, invocation_state=invocation_state)

    assert event.source is orchestrator
    assert event.invocation_state == invocation_state


def test_after_node_invocation_event_with_required_fields(orchestrator):
    """Test AfterNodeCallEvent creation with required fields."""
    node_id = "node_1"
    event = AfterNodeCallEvent(source=orchestrator, node_id=node_id)

    assert event.source is orchestrator
    assert event.node_id == node_id
    assert event.invocation_state is None
    assert isinstance(event, BaseHookEvent)


def test_after_node_invocation_event_with_invocation_state(orchestrator):
    """Test AfterNodeCallEvent creation with invocation state."""
    node_id = "node_2"
    invocation_state = {"result": "success"}
    event = AfterNodeCallEvent(source=orchestrator, node_id=node_id, invocation_state=invocation_state)

    assert event.source is orchestrator
    assert event.node_id == node_id
    assert event.invocation_state == invocation_state


def test_after_multi_agent_invocation_event_with_orchestrator_only(orchestrator):
    """Test AfterMultiAgentInvocationEvent creation with orchestrator only."""
    event = AfterMultiAgentInvocationEvent(source=orchestrator)

    assert event.source is orchestrator
    assert event.invocation_state is None
    assert isinstance(event, BaseHookEvent)


def test_after_multi_agent_invocation_event_with_invocation_state(orchestrator):
    """Test AfterMultiAgentInvocationEvent creation with invocation state."""
    invocation_state = {"final_state": "completed"}
    event = AfterMultiAgentInvocationEvent(source=orchestrator, invocation_state=invocation_state)

    assert event.source is orchestrator
    assert event.invocation_state == invocation_state


def test_before_node_call_event(orchestrator):
    """Test BeforeNodeCallEvent creation."""
    node_id = "node_1"
    event = BeforeNodeCallEvent(source=orchestrator, node_id=node_id)

    assert event.source is orchestrator
    assert event.node_id == node_id
    assert event.invocation_state is None
    assert isinstance(event, BaseHookEvent)


def test_before_multi_agent_invocation_event(orchestrator):
    """Test BeforeMultiAgentInvocationEvent creation."""
    event = BeforeMultiAgentInvocationEvent(source=orchestrator)

    assert event.source is orchestrator
    assert event.invocation_state is None
    assert isinstance(event, BaseHookEvent)


def test_after_events_should_reverse_callbacks(orchestrator):
    """Test that After events have should_reverse_callbacks property set to True."""
    after_node_event = AfterNodeCallEvent(source=orchestrator, node_id="test")
    after_invocation_event = AfterMultiAgentInvocationEvent(source=orchestrator)

    assert after_node_event.should_reverse_callbacks is True
    assert after_invocation_event.should_reverse_callbacks is True
