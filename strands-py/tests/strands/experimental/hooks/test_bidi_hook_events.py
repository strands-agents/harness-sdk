"""Unit tests for BidiAgent hook events."""

from dataclasses import fields
from unittest.mock import Mock

import pytest

from strands.experimental.hooks import (
    BidiAfterInvocationEvent,
    BidiAgentInitializedEvent,
    BidiBeforeInvocationEvent,
    BidiInterruptionEvent,
    BidiMessageAddedEvent,
)


@pytest.fixture
def agent():
    return Mock()


@pytest.fixture
def message():
    return {"role": "user", "content": [{"text": "Hello"}]}


@pytest.fixture
def initialized_event(agent):
    return BidiAgentInitializedEvent(agent=agent)


@pytest.fixture
def before_invocation_event(agent):
    return BidiBeforeInvocationEvent(agent=agent)


@pytest.fixture
def after_invocation_event(agent):
    return BidiAfterInvocationEvent(agent=agent)


@pytest.fixture
def message_added_event(agent, message):
    return BidiMessageAddedEvent(agent=agent, message=message)


@pytest.fixture
def interruption_event(agent):
    return BidiInterruptionEvent(agent=agent, reason="user_speech")


def test_event_should_reverse_callbacks(
    initialized_event,
    before_invocation_event,
    after_invocation_event,
    message_added_event,
    interruption_event,
):
    """Verify which events use reverse callback ordering."""
    # note that we ignore E712 (explicit booleans) for consistency/readability purposes

    assert initialized_event.should_reverse_callbacks == False  # noqa: E712
    assert message_added_event.should_reverse_callbacks == False  # noqa: E712
    assert interruption_event.should_reverse_callbacks == False  # noqa: E712

    assert before_invocation_event.should_reverse_callbacks == False  # noqa: E712
    assert after_invocation_event.should_reverse_callbacks == True  # noqa: E712


def test_interruption_event_with_response_id(agent):
    """Verify BidiInterruptionEvent can include response ID."""
    event = BidiInterruptionEvent(agent=agent, reason="error", interrupted_response_id="resp_123")

    tru_event = {field.name: getattr(event, field.name) for field in fields(event)}
    exp_event = {"agent": agent, "reason": "error", "interrupted_response_id": "resp_123"}
    assert tru_event == exp_event


def test_message_added_event_cannot_write_properties(message_added_event):
    """Verify BidiMessageAddedEvent properties are read-only."""
    with pytest.raises(AttributeError, match="Property agent is not writable"):
        message_added_event.agent = Mock()
    with pytest.raises(AttributeError, match="Property message is not writable"):
        message_added_event.message = {}
