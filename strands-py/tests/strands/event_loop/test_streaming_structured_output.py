"""Tests for streaming.py with structured output support."""

import unittest.mock

import pytest
from pydantic import BaseModel

import strands.event_loop.streaming
from strands.tools.structured_output.structured_output_tool import StructuredOutputTool
from strands.types._events import TypedEvent


class SampleModel(BaseModel):
    """Sample model for structured output."""

    name: str
    age: int


@pytest.fixture(autouse=True)
def moto_autouse(moto_env, moto_mock_aws):
    _ = moto_env
    _ = moto_mock_aws


@pytest.mark.asyncio
async def test_stream_messages_with_tool_choice(agenerator, alist):
    """Test stream_messages with tool_choice parameter for structured output."""
    mock_model = unittest.mock.MagicMock()
    mock_model.stream.return_value = agenerator(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "test-123", "name": "SampleModel"}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"name": "test", "age": 25}'}}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "tool_use"}},
            {
                "metadata": {
                    "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
                    "metrics": {"latencyMs": 100},
                }
            },
        ]
    )

    # Create a structured output tool and get its spec
    structured_tool = StructuredOutputTool(SampleModel)
    tool_spec = structured_tool.tool_spec
    tool_choice = {"tool": {"name": "SampleModel"}}

    stream = strands.event_loop.streaming.stream_messages(
        mock_model,
        system_prompt_content=[{"text": "test prompt"}],
        messages=[{"role": "user", "content": [{"text": "Generate a test model"}]}],
        tool_specs=[tool_spec],
        system_prompt="test prompt",
        tool_choice=tool_choice,
    )

    tru_events = await alist(stream)

    # Verify the model.stream was called with tool_choice
    mock_model.stream.assert_called_with(
        [{"role": "user", "content": [{"text": "Generate a test model"}]}],
        [tool_spec],
        "test prompt",
        tool_choice=tool_choice,
        system_prompt_content=[{"text": "test prompt"}],
        invocation_state=None,
        model_state=None,
        cancel_signal=None,
        agent_metadata=None,
    )

    # Verify we get the expected events
    assert len(tru_events) > 0

    # Find the stop event
    stop_event = None
    for event in tru_events:
        if isinstance(event, dict) and "stop" in event:
            stop_event = event
            break

    assert stop_event is not None
    assert stop_event["stop"][0] == "tool_use"

    # Ensure that we're getting typed events
    non_typed_events = [event for event in tru_events if not isinstance(event, TypedEvent)]
    assert non_typed_events == []


@pytest.mark.asyncio
async def test_stream_messages_with_forced_structured_output(agenerator, alist):
    """Test stream_messages with forced structured output tool."""
    mock_model = unittest.mock.MagicMock()

    # Simulate a response with tool use
    mock_model.stream.return_value = agenerator(
        [
            {"messageStart": {"role": "assistant"}},
            {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "123", "name": "SampleModel"}}}},
            {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"name": "Alice", "age": 30}'}}}},
            {"contentBlockStop": {}},
            {"messageStop": {"stopReason": "tool_use"}},
            {
                "metadata": {
                    "usage": {"inputTokens": 20, "outputTokens": 10, "totalTokens": 30},
                    "metrics": {"latencyMs": 150},
                }
            },
        ]
    )

    # Create a structured output tool and get its spec
    structured_tool = StructuredOutputTool(SampleModel)
    tool_spec = structured_tool.tool_spec
    tool_choice = {"any": {}}

    stream = strands.event_loop.streaming.stream_messages(
        mock_model,
        system_prompt_content=[{"text": "Extract user information"}],
        messages=[{"role": "user", "content": [{"text": "Alice is 30 years old"}]}],
        tool_specs=[tool_spec],
        system_prompt="Extract user information",
        tool_choice=tool_choice,
    )

    tru_events = await alist(stream)

    # Verify the model.stream was called with the forced tool choice
    mock_model.stream.assert_called_with(
        [{"role": "user", "content": [{"text": "Alice is 30 years old"}]}],
        [tool_spec],
        "Extract user information",
        tool_choice=tool_choice,
        system_prompt_content=[{"text": "Extract user information"}],
        invocation_state=None,
        model_state=None,
        cancel_signal=None,
        agent_metadata=None,
    )

    assert len(tru_events) > 0

    # Find the stop event and verify it contains the extracted data
    stop_event = None
    for event in tru_events:
        if isinstance(event, dict) and "stop" in event:
            stop_event = event
            break

    assert stop_event is not None
    stop_reason, message, usage, metrics = stop_event["stop"]

    assert stop_reason == "tool_use"
    assert message["role"] == "assistant"
    assert len(message["content"]) > 0

    # Check that the tool use contains the expected data
    tool_use_content = None
    for content in message["content"]:
        if "toolUse" in content:
            tool_use_content = content["toolUse"]
            break

    assert tool_use_content is not None
    assert tool_use_content["name"] == "SampleModel"
    assert tool_use_content["input"] == {"name": "Alice", "age": 30}
