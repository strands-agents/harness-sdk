"""Unit tests for BidiAgent hook events."""

from dataclasses import fields
from unittest.mock import Mock

import pytest

from strands import LocalAgent
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.hooks import (
    BidiAgentStopEvent,
    BidiInterruptionEvent,
    BidiResponseCompleteEvent,
)
from strands.experimental.bidi.models import BidiModel
from strands.hooks import (
    AfterToolsEvent,
    AgentInitializedEvent,
    BeforeToolsEvent,
    HookRegistry,
    MessageAddedEvent,
)
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
def response_complete_event(agent):
    return BidiResponseCompleteEvent(agent=agent, response_id="response-1", stop_reason="complete")


@pytest.fixture
def interruption_event(agent):
    return BidiInterruptionEvent(agent=agent, reason="user_speech")


def test_event_should_reverse_callbacks(agent_stop_event, response_complete_event, interruption_event):
    """Verify which events use reverse callback ordering."""
    assert agent_stop_event.should_reverse_callbacks is True
    assert response_complete_event.should_reverse_callbacks is False
    assert interruption_event.should_reverse_callbacks is False


def test_interruption_event_with_response_id(agent):
    """Verify BidiInterruptionEvent can include response ID."""
    event = BidiInterruptionEvent(agent=agent, reason="error", interrupted_response_id="resp_123")

    tru_event = {field.name: getattr(event, field.name) for field in fields(event)}
    exp_event = {"agent": agent, "reason": "error", "interrupted_response_id": "resp_123"}
    assert tru_event == exp_event


@pytest.mark.parametrize("name", ["agent", "response_id", "stop_reason"])
def test_response_complete_event_cannot_write_properties(response_complete_event, name):
    with pytest.raises(AttributeError, match=f"Property {name} is not writable"):
        setattr(response_complete_event, name, None)


def test_batch_tool_events_accept_bidi_agent():
    """Shared batch hooks carry a BidiAgent without changing their runtime contract."""
    agent = BidiAgent(model=Mock(spec=BidiModel))
    assistant_message = {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": "call-1", "name": "weather", "input": {}}}],
    }
    result_message = {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "call-1", "status": "success", "content": [{"text": "sunny"}]}}],
    }

    before_event = BeforeToolsEvent[LocalAgent](agent=agent, message=assistant_message, invocation_state={})
    after_event = AfterToolsEvent[LocalAgent](agent=agent, message=result_message, invocation_state={})

    assert before_event.agent is agent
    assert after_event.agent is agent


def test_batch_tool_event_writable_properties_remain_restricted():
    """Batch hooks expose only cancel and end_turn as writable behavior controls."""
    agent = BidiAgent(model=Mock(spec=BidiModel))
    message = {"role": "assistant", "content": []}
    before_event = BeforeToolsEvent[LocalAgent](agent=agent, message=message, invocation_state={})
    after_event = AfterToolsEvent[LocalAgent](agent=agent, message=message, invocation_state={})

    before_event.cancel = "cancelled"
    after_event.end_turn = True

    assert before_event.cancel == "cancelled"
    assert after_event.end_turn is True
    for event in (before_event, after_event):
        for name in ("agent", "message", "invocation_state"):
            with pytest.raises(AttributeError, match=f"Property {name} is not writable"):
                setattr(event, name, None)


def test_after_tools_callbacks_remain_reverse_ordered_for_bidi_agent():
    """AfterToolsEvent callbacks retain cleanup ordering with a BidiAgent."""
    agent = BidiAgent(model=Mock(spec=BidiModel))
    registry = HookRegistry()
    callback_order = []
    registry.add_callback(AfterToolsEvent, lambda _event: callback_order.append("first"))
    registry.add_callback(AfterToolsEvent, lambda _event: callback_order.append("second"))

    event = AfterToolsEvent[LocalAgent](agent=agent, message={"role": "user", "content": []}, invocation_state={})
    registry.invoke_callbacks(event)

    assert callback_order == ["second", "first"]
