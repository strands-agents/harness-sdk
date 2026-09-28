"""Tests for agent model state with server-side conversation management."""

import unittest.mock

import pytest

from strands.agent.agent import Agent
from strands.agent.conversation_manager import NullConversationManager, SlidingWindowConversationManager


@pytest.fixture
def mock_model():
    """Create a mock model that writes response_id to model_state."""
    model = unittest.mock.MagicMock()
    model.config = {"model_id": "test-model"}
    model.get_config.return_value = {"model_id": "test-model"}

    call_count = 0

    async def mock_stream(messages, tool_specs=None, system_prompt=None, **kwargs):
        nonlocal call_count
        call_count += 1
        resp_id = "resp_abc123" if call_count == 1 else "resp_def456"

        model_state = kwargs.get("model_state")
        if model_state is not None:
            model_state["response_id"] = resp_id

        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": "Hello"}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {
            "metadata": {
                "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                "metrics": {"latencyMs": 100},
            }
        }

    model.stream = unittest.mock.MagicMock(side_effect=mock_stream)
    model.stateful = True
    return model


def test_agent_model_state(mock_model):
    """Verify model_state is populated, messages are cleared, and model_state is passed on subsequent calls."""
    agent = Agent(model=mock_model, callback_handler=None)
    assert isinstance(agent.conversation_manager, NullConversationManager)

    agent("Turn 1")
    assert agent._model_state.get("response_id") == "resp_abc123"
    assert len(agent.messages) == 0

    agent("Turn 2")
    assert agent._model_state.get("response_id") == "resp_def456"
    assert len(agent.messages) == 0

    second_call_kwargs = mock_model.stream.call_args_list[1][1]
    assert second_call_kwargs.get("model_state") is agent._model_state


def test_agent_model_state_raises_with_conversation_manager():
    """Passing a conversation_manager with a stateful model raises ValueError."""
    model = unittest.mock.MagicMock()
    model.stateful = True

    with pytest.raises(ValueError, match="conversation_manager cannot be used with a stateful model"):
        Agent(model=model, conversation_manager=SlidingWindowConversationManager())
