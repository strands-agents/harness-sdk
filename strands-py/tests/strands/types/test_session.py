import json
import unittest.mock
from uuid import uuid4

import pytest

from strands import Agent
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from strands.agent.state import AgentState
from strands.experimental.bidi import BidiAgent
from strands.interrupt import _InterruptState
from strands.types.session import (
    Session,
    SessionAgent,
    SessionMessage,
    SessionType,
    decode_bytes_values,
    encode_bytes_values,
)


def test_session_json_serializable():
    session = Session(session_id=str(uuid4()), session_type=SessionType.AGENT)
    # json dumps will fail if its not json serializable
    session_json_string = json.dumps(session.to_dict())
    loaded_session = Session.from_dict(json.loads(session_json_string))
    assert loaded_session is not None


def test_agent_json_serializable():
    agent = SessionAgent(
        agent_id=str(uuid4()), state={"foo": "bar"}, conversation_manager_state=NullConversationManager().get_state()
    )
    # json dumps will fail if its not json serializable
    agent_json_string = json.dumps(agent.to_dict())
    loaded_agent = SessionAgent.from_dict(json.loads(agent_json_string))
    assert loaded_agent is not None


def test_message_json_serializable():
    message = SessionMessage(message={"role": "user", "content": [{"text": "Hello!"}]}, message_id=0)
    # json dumps will fail if its not json serializable
    message_json_string = json.dumps(message.to_dict())
    loaded_message = SessionMessage.from_dict(json.loads(message_json_string))
    assert loaded_message is not None


def test_bytes_encoding_decoding():
    # Test simple bytes
    test_bytes = b"Hello, world!"
    encoded = encode_bytes_values(test_bytes)
    assert isinstance(encoded, dict)
    assert encoded["__bytes_encoded__"] is True
    decoded = decode_bytes_values(encoded)
    assert decoded == test_bytes

    # Test nested structure with bytes
    test_data = {
        "text": "Hello",
        "binary": b"Binary data",
        "nested": {"more_binary": b"More binary data", "list_with_binary": [b"Item 1", "Text item", b"Item 3"]},
    }

    encoded = encode_bytes_values(test_data)
    # Verify it's JSON serializable
    json_str = json.dumps(encoded)
    # Deserialize and decode
    decoded = decode_bytes_values(json.loads(json_str))

    # Verify the decoded data matches the original
    assert decoded["text"] == test_data["text"]
    assert decoded["binary"] == test_data["binary"]
    assert decoded["nested"]["more_binary"] == test_data["nested"]["more_binary"]
    assert decoded["nested"]["list_with_binary"][0] == test_data["nested"]["list_with_binary"][0]
    assert decoded["nested"]["list_with_binary"][1] == test_data["nested"]["list_with_binary"][1]
    assert decoded["nested"]["list_with_binary"][2] == test_data["nested"]["list_with_binary"][2]


def test_session_message_with_bytes():
    # Create a message with bytes content
    message = {
        "role": "user",
        "content": [{"text": "Here is some binary data"}, {"binary_data": b"This is binary data"}],
    }

    # Create a SessionMessage
    session_message = SessionMessage.from_message(message, 0)

    # Verify it's JSON serializable
    message_json_string = json.dumps(session_message.to_dict())

    # Load it back
    loaded_message = SessionMessage.from_dict(json.loads(message_json_string))

    # Convert back to original message and verify
    original_message = loaded_message.to_message()

    assert original_message["role"] == message["role"]
    assert original_message["content"][0]["text"] == message["content"][0]["text"]
    assert original_message["content"][1]["binary_data"] == message["content"][1]["binary_data"]


def test_session_message_preserves_durable_id():
    message = {"role": "user", "content": [{"text": "Hello!"}], "tracking_id": "durable-abc"}

    session_message = SessionMessage.from_message(message, 0)
    loaded_message = SessionMessage.from_dict(json.loads(json.dumps(session_message.to_dict())))

    assert loaded_message.to_message()["tracking_id"] == "durable-abc"


def test_session_message_without_durable_id():
    # Legacy messages persisted before durable ids have no id, and none is backfilled.
    message = {"role": "user", "content": [{"text": "Hello!"}]}

    session_message = SessionMessage.from_message(message, 0)
    loaded_message = SessionMessage.from_dict(json.loads(json.dumps(session_message.to_dict())))

    assert "tracking_id" not in loaded_message.to_message()


def test_session_message_redaction_preserves_durable_id():
    message = {"role": "user", "content": [{"text": "secret"}], "tracking_id": "durable-xyz"}

    session_message = SessionMessage.from_message(message, 0)
    # Redaction mutates content in place, leaving the top-level id on the same dict.
    session_message.redact_message = {"role": "user", "content": [{"text": "REDACTED"}], "tracking_id": "durable-xyz"}
    loaded_message = SessionMessage.from_dict(json.loads(json.dumps(session_message.to_dict())))

    redacted = loaded_message.to_message()
    assert redacted["tracking_id"] == "durable-xyz"
    assert redacted["content"] == [{"text": "REDACTED"}]


def test_session_agent_from_agent():
    agent = unittest.mock.Mock(spec=Agent)
    agent.agent_id = "a1"
    agent.conversation_manager = unittest.mock.Mock(get_state=lambda: {"test": "conversation"})
    agent.state = AgentState({"test": "state"})
    agent._interrupt_state = _InterruptState(interrupts={}, context={}, activated=False)
    agent._model_state = {}

    tru_session_agent = SessionAgent.from_agent(agent)
    exp_session_agent = SessionAgent(
        agent_id="a1",
        conversation_manager_state={"test": "conversation"},
        state={"test": "state"},
        _internal_state={
            "interrupt_state": {"interrupts": {}, "context": {}, "activated": False},
            "model_state": {},
        },
        created_at=unittest.mock.ANY,
        updated_at=unittest.mock.ANY,
    )
    assert tru_session_agent == exp_session_agent


def test_session_agent_initialize_internal_state():
    agent = unittest.mock.Mock(spec=Agent)
    session_agent = SessionAgent(
        agent_id="a1",
        conversation_manager_state={},
        state={},
        _internal_state={
            "interrupt_state": {"interrupts": {}, "context": {"test": "init"}, "activated": False},
            "model_state": {"response_id": "resp_abc"},
        },
    )

    session_agent.initialize_internal_state(agent)

    tru_interrupt_state = agent._interrupt_state
    exp_interrupt_state = _InterruptState(interrupts={}, context={"test": "init"}, activated=False)
    assert tru_interrupt_state == exp_interrupt_state

    tru_model_state = agent._model_state
    exp_model_state = {"response_id": "resp_abc"}
    assert tru_model_state == exp_model_state


@pytest.mark.parametrize("has_interrupt_state", [False, True])
def test_session_agent_from_agent_with_bidi(has_interrupt_state):
    agent = unittest.mock.Mock(spec=BidiAgent)
    agent.agent_id = "bidi"
    agent.state = AgentState({"data": {"count": 2}})
    if has_interrupt_state:
        agent._interrupt_state = _InterruptState(context={"resume": "tool"})

    session_agent = SessionAgent.from_agent(agent)
    tru_session_agent = SessionAgent.from_dict(json.loads(json.dumps(session_agent.to_dict())))
    exp_session_agent = SessionAgent(
        agent_id="bidi",
        state={"data": {"count": 2}},
        conversation_manager_state={},
        _internal_state={},
        created_at=unittest.mock.ANY,
        updated_at=unittest.mock.ANY,
    )
    assert tru_session_agent == exp_session_agent


@pytest.mark.parametrize("has_interrupt_state", [False, True])
def test_session_agent_initialize_internal_state_skips_bidi(has_interrupt_state):
    agent = unittest.mock.Mock(spec=BidiAgent)
    original_interrupt_state = _InterruptState(context={"existing": "bidi"})
    if has_interrupt_state:
        agent._interrupt_state = original_interrupt_state
    saved_interrupt_state = _InterruptState(context={"resume": "tool"})
    session_agent = SessionAgent(
        agent_id="bidi",
        state={},
        conversation_manager_state={},
        _internal_state={
            "interrupt_state": saved_interrupt_state.to_dict(),
            "model_state": {"response_id": "agent-only"},
        },
    )

    session_agent.initialize_internal_state(agent)

    assert hasattr(agent, "_interrupt_state") == has_interrupt_state
    if has_interrupt_state:
        assert agent._interrupt_state is original_interrupt_state
    assert not hasattr(agent, "_model_state")


@pytest.mark.parametrize("agent_type", [Agent, BidiAgent])
def test_session_agent_requires_agent_id(agent_type):
    agent = unittest.mock.Mock(spec=agent_type, agent_id=None)
    with pytest.raises(ValueError, match="agent_id needs to be defined"):
        SessionAgent.from_agent(agent)


def test_session_agent_with_bytes():
    # Agent state can hold binary content (e.g. inline PDF bytes from a multimodal prompt), which
    # crashes json.dumps() unless to_dict() encodes it. Regression test for #1864.
    session_agent = SessionAgent(
        agent_id="a1",
        conversation_manager_state={},
        state={"document": {"format": "pdf", "source": {"bytes": b"This is binary data"}}},
    )

    # json dumps will fail if it's not json serializable
    agent_json_string = json.dumps(session_agent.to_dict())

    # Load it back and verify the full state round-trips, bytes included
    loaded_agent = SessionAgent.from_dict(json.loads(agent_json_string))
    assert loaded_agent.state == session_agent.state
