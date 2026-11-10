"""Tests for MessageMetadata and get_message_metadata."""

from strands.types.content import Message, MessageMetadata, get_message_metadata


def test_message_without_metadata():
    msg: Message = {"role": "assistant", "content": [{"text": "hello"}]}
    assert get_message_metadata(msg) == {}


def test_message_with_metadata():
    meta: MessageMetadata = {
        "usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15},
        "metrics": {"latencyMs": 100},
    }
    msg: Message = {"role": "assistant", "content": [{"text": "hello"}], "metadata": meta}
    assert get_message_metadata(msg) == meta
    assert get_message_metadata(msg)["usage"]["inputTokens"] == 10


def test_message_with_custom_metadata():
    meta: MessageMetadata = {
        "custom": {"source": "summarization", "original_turns": [5, 6, 7]},
    }
    msg: Message = {"role": "assistant", "content": [{"text": "summary"}], "metadata": meta}
    result = get_message_metadata(msg)
    assert result["custom"]["source"] == "summarization"


def test_metadata_does_not_affect_role_and_content():
    msg: Message = {
        "role": "assistant",
        "content": [{"text": "hello"}],
        "metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2}},
    }
    assert msg["role"] == "assistant"
    assert msg["content"] == [{"text": "hello"}]
