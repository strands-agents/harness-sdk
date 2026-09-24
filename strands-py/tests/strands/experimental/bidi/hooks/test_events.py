"""Unit tests for BidiAgent hook events."""

from dataclasses import fields
from unittest.mock import Mock

import pytest

from strands import LocalAgent
from strands.experimental.bidi.agent import BidiAgent
from strands.experimental.bidi.hooks import (
    BidiAgentStopEvent,
    BidiBargeInEvent,
    BidiResponseStopEvent,
)
from strands.experimental.bidi.models import BidiModel
from strands.hooks import AgentInitializedEvent, MessageAddedEvent
from tests.fixtures.mock_hook_provider import MockHookProvider


def test_agent_initialized_event():
    hooks = MockHookProvider([AgentInitializedEvent])
    agent = BidiAgent(model=Mock(spec=BidiModel), hooks=[hooks])

    tru_events = hooks.events_received
    exp_events = [AgentInitializedEvent[LocalAgent](agent=agent)]
    assert tru_events == exp_events


@pytest.mark.asyncio
async def test_message_added_event():
    hooks = MockHookProvider([MessageAddedEvent])
    agent = BidiAgent(model=Mock(spec=BidiModel), hooks=[hooks])
    message = {"role": "user", "content": [{"text": "Hello"}], "tracking_id": "message-1"}

    inferred_events = []

    async def on_message(event: MessageAddedEvent[LocalAgent]):
        inferred_events.append(event)

    agent.add_hook(on_message)
    await agent._append_messages(message)

    tru_events = hooks.events_received
    exp_events = [MessageAddedEvent[LocalAgent](agent=agent, message=message)]
    assert tru_events == exp_events
    assert inferred_events == exp_events


@pytest.fixture
def agent():
    return Mock()


@pytest.fixture
def agent_stop_event(agent):
    return BidiAgentStopEvent(agent=agent)


@pytest.fixture
def response_stop_event(agent):
    return BidiResponseStopEvent(agent=agent, response_id="response-1", stop_reason="end_turn")


@pytest.fixture
def barge_in_event(agent):
    return BidiBargeInEvent(agent=agent, reason="user_speech")


def test_event_should_reverse_callbacks(agent_stop_event, response_stop_event, barge_in_event):
    """Verify which events use reverse callback ordering."""
    assert agent_stop_event.should_reverse_callbacks is True
    assert response_stop_event.should_reverse_callbacks is False
    assert barge_in_event.should_reverse_callbacks is False


def test_barge_in_event_fields(agent):
    event = BidiBargeInEvent(agent=agent, reason="error")

    tru_event = {field.name: getattr(event, field.name) for field in fields(event)}
    exp_event = {"agent": agent, "reason": "error"}
    assert tru_event == exp_event


@pytest.mark.parametrize("name", ["agent", "response_id", "stop_reason"])
def test_response_stop_event_cannot_write_properties(response_stop_event, name):
    with pytest.raises(AttributeError, match=f"Property {name} is not writable"):
        setattr(response_stop_event, name, None)
