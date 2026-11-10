"""Tests for token limit recovery utility."""

from strands.event_loop._recover_message_on_max_tokens_reached import (
    recover_message_on_max_tokens_reached,
)
from strands.types.content import Message


def test_recover_message_on_max_tokens_reached_with_incomplete_tool_use():
    """Test recovery when incomplete tool use is present in the message."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"text": "I'll help you with that."},
            {"toolUse": {"name": "calculator", "input": {}, "toolUseId": ""}},  # Missing toolUseId
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 2

    # First content block should be preserved
    assert result["content"][0] == {"text": "I'll help you with that."}

    # Second content block should be replaced with error message
    assert "text" in result["content"][1]
    assert "calculator" in result["content"][1]["text"]
    assert "incomplete due to maximum token limits" in result["content"][1]["text"]


def test_recover_message_on_max_tokens_reached_with_missing_tool_name():
    """Test recovery when tool use has no name."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"name": "", "input": {}, "toolUseId": "123"}},  # Missing name
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 1

    # Content should be replaced with error message using <unknown>
    assert "text" in result["content"][0]
    assert "<unknown>" in result["content"][0]["text"]
    assert "incomplete due to maximum token limits" in result["content"][0]["text"]


def test_recover_message_on_max_tokens_reached_with_missing_input():
    """Test recovery when tool use has no input."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"name": "calculator", "toolUseId": "123"}},  # Missing input
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 1

    # Content should be replaced with error message
    assert "text" in result["content"][0]
    assert "calculator" in result["content"][0]["text"]
    assert "incomplete due to maximum token limits" in result["content"][0]["text"]


def test_recover_message_on_max_tokens_reached_with_missing_tool_use_id():
    """Test recovery when tool use has no toolUseId."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"name": "calculator", "input": {"expression": "2+2"}}},  # Missing toolUseId
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 1

    # Content should be replaced with error message
    assert "text" in result["content"][0]
    assert "calculator" in result["content"][0]["text"]
    assert "incomplete due to maximum token limits" in result["content"][0]["text"]


def test_recover_message_on_max_tokens_reached_with_valid_tool_use():
    """Test that even valid tool uses are replaced with error messages."""
    complete_message: Message = {
        "role": "assistant",
        "content": [
            {"text": "I'll help you with that."},
            {"toolUse": {"name": "calculator", "input": {"expression": "2+2"}, "toolUseId": "123"}},  # Valid
        ],
    }

    result = recover_message_on_max_tokens_reached(complete_message)

    # Should replace even valid tool uses with error messages
    assert result["role"] == "assistant"
    assert len(result["content"]) == 2
    assert result["content"][0] == {"text": "I'll help you with that."}

    # Valid tool use should also be replaced with error message
    assert "text" in result["content"][1]
    assert "calculator" in result["content"][1]["text"]
    assert "incomplete due to maximum token limits" in result["content"][1]["text"]


def test_recover_message_on_max_tokens_reached_with_empty_content():
    """Test handling of message with empty content."""
    empty_message: Message = {"role": "assistant", "content": []}

    result = recover_message_on_max_tokens_reached(empty_message)

    # Should return message with empty content preserved
    assert result["role"] == "assistant"
    assert result["content"] == []


def test_recover_message_on_max_tokens_reached_with_none_content():
    """Test handling of message with None content."""
    none_content_message: Message = {"role": "assistant", "content": None}

    result = recover_message_on_max_tokens_reached(none_content_message)

    # Should return message with empty content
    assert result["role"] == "assistant"
    assert result["content"] == []


def test_recover_message_on_max_tokens_reached_with_mixed_content():
    """Test recovery with mix of valid content and incomplete tool use."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"text": "Let me calculate this for you."},
            {"toolUse": {"name": "calculator", "input": {}, "toolUseId": ""}},  # Incomplete
            {"text": "And then I'll explain the result."},
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 3

    # First and third content blocks should be preserved
    assert result["content"][0] == {"text": "Let me calculate this for you."}
    assert result["content"][2] == {"text": "And then I'll explain the result."}

    # Second content block should be replaced with error message
    assert "text" in result["content"][1]
    assert "calculator" in result["content"][1]["text"]
    assert "incomplete due to maximum token limits" in result["content"][1]["text"]


def test_recover_message_on_max_tokens_reached_preserves_non_tool_content():
    """Test that non-tool content is preserved as-is."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"text": "Here's some text."},
            {"image": {"format": "png", "source": {"bytes": "fake_image_data"}}},
            {"toolUse": {"name": "", "input": {}, "toolUseId": "123"}},  # Incomplete
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 3

    # First two content blocks should be preserved exactly
    assert result["content"][0] == {"text": "Here's some text."}
    assert result["content"][1] == {"image": {"format": "png", "source": {"bytes": "fake_image_data"}}}

    # Third content block should be replaced with error message
    assert "text" in result["content"][2]
    assert "<unknown>" in result["content"][2]["text"]
    assert "incomplete due to maximum token limits" in result["content"][2]["text"]


def test_recover_message_on_max_tokens_reached_multiple_incomplete_tools():
    """Test recovery with multiple incomplete tool uses."""
    incomplete_message: Message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"name": "calculator", "input": {}}},  # Missing toolUseId
            {"text": "Some text in between."},
            {"toolUse": {"name": "", "input": {}, "toolUseId": "456"}},  # Missing name
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 3

    # First tool use should be replaced
    assert "text" in result["content"][0]
    assert "calculator" in result["content"][0]["text"]
    assert "incomplete due to maximum token limits" in result["content"][0]["text"]

    # Text content should be preserved
    assert result["content"][1] == {"text": "Some text in between."}

    # Second tool use should be replaced with <unknown>
    assert "text" in result["content"][2]
    assert "<unknown>" in result["content"][2]["text"]
    assert "incomplete due to maximum token limits" in result["content"][2]["text"]


def test_recover_message_on_max_tokens_reached_preserves_metadata():
    """Test that metadata is preserved through recovery."""
    message: Message = {
        "role": "assistant",
        "content": [
            {"toolUse": {"name": "calculator", "input": {}, "toolUseId": "123"}},
        ],
        "metadata": {"usage": {"inputTokens": 42, "outputTokens": 10, "totalTokens": 52}},
    }

    result = recover_message_on_max_tokens_reached(message)

    assert "metadata" in result
    assert result["metadata"]["usage"]["inputTokens"] == 42


def test_recover_message_on_max_tokens_reached_without_metadata():
    """Test that recovery works fine when no metadata is present."""
    message: Message = {
        "role": "assistant",
        "content": [{"text": "some text"}],
    }

    result = recover_message_on_max_tokens_reached(message)

    assert "metadata" not in result


def test_recover_message_on_max_tokens_reached_preserves_user_role():
    """Test that the function preserves the original message role."""
    incomplete_message: Message = {
        "role": "user",
        "content": [
            {"toolUse": {"name": "calculator", "input": {}}},  # Missing toolUseId
        ],
    }

    result = recover_message_on_max_tokens_reached(incomplete_message)

    # Should preserve the original role
    assert result["role"] == "user"
    assert len(result["content"]) == 1
    assert "text" in result["content"][0]
    assert "calculator" in result["content"][0]["text"]


def test_recover_message_on_max_tokens_reached_with_content_without_tool_use():
    """Test handling of content blocks that don't have toolUse key."""
    message: Message = {
        "role": "assistant",
        "content": [
            {"text": "Regular text content."},
            {"someOtherKey": "someValue"},  # Content without toolUse
            {"toolUse": {"name": "calculator"}},  # Incomplete tool use
        ],
    }

    result = recover_message_on_max_tokens_reached(message)

    # Check the corrected message content
    assert result["role"] == "assistant"
    assert len(result["content"]) == 3

    # First two content blocks should be preserved
    assert result["content"][0] == {"text": "Regular text content."}
    assert result["content"][1] == {"someOtherKey": "someValue"}

    # Third content block should be replaced with error message
    assert "text" in result["content"][2]
    assert "calculator" in result["content"][2]["text"]
    assert "incomplete due to maximum token limits" in result["content"][2]["text"]
