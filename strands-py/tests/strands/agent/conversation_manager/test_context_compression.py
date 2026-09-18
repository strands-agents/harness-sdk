"""Tests for shared context-compression helpers."""

from unittest.mock import Mock

import pytest

from strands.agent.conversation_manager.compression.context_compression import (
    DEFAULT_SUMMARIZATION_PROMPT,
    adjust_split_point_for_tool_pairs,
    find_valid_trim_point,
    generate_summary,
    matches_message_type,
)
from strands.agent.conversation_manager.compression.pin_message import partition_pinned, pin_message
from strands.models.model import Model
from strands.types.content import Message
from strands.types.exceptions import ContextWindowOverflowException


def text_msg(role: str, text: str) -> Message:
    return {"role": role, "content": [{"text": text}]}


def tool_use_msg(tool_use_id: str, name: str = "test") -> Message:
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": tool_use_id, "name": name, "input": {}}}]}


def tool_result_msg(tool_use_id: str, text: str = "result") -> Message:
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": text}]}}],
    }


async def _mock_model_stream(response_text):
    yield {"messageStart": {"role": "assistant"}}
    yield {"contentBlockStart": {"start": {}}}
    yield {"contentBlockDelta": {"delta": {"text": response_text}}}
    yield {"contentBlockStop": {}}
    yield {"messageStop": {"stopReason": "end_turn"}}


async def _mock_model_stream_error(error):
    """Async generator that raises, simulating a model failure during streaming."""
    raise error
    yield  # pragma: no cover - makes this a generator


def mock_model(summary_text="Summary of conversation"):
    model = Mock(spec=Model)
    model.stateful = False
    model.stream = Mock(side_effect=lambda *a, **kw: _mock_model_stream(summary_text))
    return model


def stream_call_args(model):
    """Return the (messages, tool_specs, system_prompt) the summarizer passed to ``model.stream``."""
    args = model.stream.call_args.args
    return args[0], args[1], args[2]


class TestAdjustSplitPointForToolPairs:
    def test_returns_split_point_when_message_is_plain_text(self):
        messages = [text_msg("user", "hello"), text_msg("assistant", "hi"), text_msg("user", "bye")]
        assert adjust_split_point_for_tool_pairs(messages, 0) == 0

    def test_skips_tool_result_messages(self):
        messages = [tool_result_msg("id-1"), text_msg("user", "hello")]
        assert adjust_split_point_for_tool_pairs(messages, 0) == 1

    def test_skips_tool_use_without_following_tool_result(self):
        messages = [tool_use_msg("id-1"), text_msg("assistant", "no result"), text_msg("user", "hello")]
        assert adjust_split_point_for_tool_pairs(messages, 0) == 1

    def test_accepts_tool_use_when_followed_by_tool_result(self):
        messages = [tool_use_msg("id-1"), tool_result_msg("id-1"), text_msg("user", "hello")]
        assert adjust_split_point_for_tool_pairs(messages, 0) == 0

    def test_skips_multiple_consecutive_tool_results(self):
        messages = [tool_result_msg("id-1"), tool_result_msg("id-2"), text_msg("user", "hello")]
        assert adjust_split_point_for_tool_pairs(messages, 0) == 2

    def test_raises_when_no_valid_split_point_exists(self):
        messages = [tool_result_msg("id-1"), tool_result_msg("id-2")]
        with pytest.raises(ContextWindowOverflowException, match="Unable to trim conversation context"):
            adjust_split_point_for_tool_pairs(messages, 0)

    def test_returns_split_point_when_it_equals_messages_length(self):
        messages = [text_msg("user", "hello"), text_msg("assistant", "hi")]
        assert adjust_split_point_for_tool_pairs(messages, 2) == 2

    def test_raises_when_split_point_exceeds_messages_length(self):
        messages = [text_msg("user", "hello")]
        with pytest.raises(ContextWindowOverflowException, match="Split point exceeds message array length"):
            adjust_split_point_for_tool_pairs(messages, 5)


class TestFindValidTrimPoint:
    def test_finds_plain_user_message(self):
        messages = [text_msg("user", "hello"), text_msg("assistant", "hi")]
        assert find_valid_trim_point(messages, 0) == 0

    def test_skips_non_user_messages(self):
        messages = [text_msg("assistant", "hi"), text_msg("user", "hello")]
        assert find_valid_trim_point(messages, 0) == 1

    def test_skips_tool_result_user_messages(self):
        messages = [tool_result_msg("id-1"), text_msg("user", "hello")]
        assert find_valid_trim_point(messages, 0) == 1

    def test_returns_messages_length_when_no_valid_point_found(self):
        messages = [text_msg("assistant", "hi"), tool_result_msg("id-1")]
        assert find_valid_trim_point(messages, 0) == len(messages)

    def test_respects_start_index(self):
        messages = [text_msg("user", "skip"), text_msg("assistant", "hi"), text_msg("user", "find")]
        assert find_valid_trim_point(messages, 1) == 2

    def test_returns_zero_for_empty_messages(self):
        assert find_valid_trim_point([], 0) == 0


class TestMatchesMessageType:
    def test_all_always_matches(self):
        assert matches_message_type(text_msg("user", "hello"), "all") is True
        assert matches_message_type(tool_use_msg("id-1"), "all") is True
        assert matches_message_type(tool_result_msg("id-1"), "all") is True

    def test_tools_matches_tool_messages(self):
        assert matches_message_type(tool_use_msg("id-1"), "tools") is True
        assert matches_message_type(tool_result_msg("id-1"), "tools") is True

    def test_tools_does_not_match_plain_text(self):
        assert matches_message_type(text_msg("user", "hello"), "tools") is False
        assert matches_message_type(text_msg("assistant", "hi"), "tools") is False

    def test_messages_matches_plain_text(self):
        assert matches_message_type(text_msg("user", "hello"), "messages") is True
        assert matches_message_type(text_msg("assistant", "hi"), "messages") is True

    def test_messages_does_not_match_tool_messages(self):
        assert matches_message_type(tool_use_msg("id-1"), "messages") is False
        assert matches_message_type(tool_result_msg("id-1"), "messages") is False


class TestPartitionPinned:
    def test_separates_pinned_and_unpinned_messages(self):
        messages = [text_msg("user", "a"), text_msg("assistant", "b"), text_msg("user", "c")]
        pin_message(messages, 1)

        pinned, unpinned = partition_pinned(messages, 0, 3)
        assert len(pinned) == 1
        assert len(unpinned) == 2

    def test_respects_range_end(self):
        messages = [text_msg("user", "a"), text_msg("assistant", "b"), text_msg("user", "c")]
        pin_message(messages, 0)
        pin_message(messages, 2)

        pinned, unpinned = partition_pinned(messages, 0, 2)
        assert len(pinned) == 1
        assert len(unpinned) == 1


@pytest.mark.asyncio
class TestGenerateSummary:
    async def test_returns_a_user_role_message(self):
        model = mock_model("Summary of conversation")
        messages = [text_msg("user", "hello"), text_msg("assistant", "hi")]

        result = await generate_summary(messages, model)

        assert result["role"] == "user"

    async def test_passes_the_default_system_prompt(self):
        model = mock_model("Summary")
        await generate_summary([text_msg("user", "hello")], model)

        _, _, system_prompt = stream_call_args(model)
        assert system_prompt == DEFAULT_SUMMARIZATION_PROMPT

    async def test_passes_a_custom_system_prompt(self):
        model = mock_model("Summary")
        await generate_summary([text_msg("user", "hello")], model, "Custom prompt")

        _, _, system_prompt = stream_call_args(model)
        assert system_prompt == "Custom prompt"

    async def test_appends_summarization_request_message(self):
        model = mock_model("Summary")
        original = [text_msg("user", "hello"), text_msg("assistant", "hi")]
        await generate_summary(original, model)

        passed_messages, tool_specs, _ = stream_call_args(model)
        assert len(passed_messages) == 3
        assert "summarize" in passed_messages[2]["content"][0]["text"].lower()
        assert tool_specs is None

    async def test_does_not_mutate_original_messages(self):
        model = mock_model("Summary")
        original = [text_msg("user", "hello"), text_msg("assistant", "hi")]
        await generate_summary(original, model)
        assert len(original) == 2

    async def test_propagates_model_errors(self):
        model = Mock(spec=Model)
        model.stateful = False
        model.stream = Mock(side_effect=lambda *a, **kw: _mock_model_stream_error(RuntimeError("model failed")))

        with pytest.raises(RuntimeError, match="model failed"):
            await generate_summary([text_msg("user", "hello")], model)
