"""Tests for the summarize method module."""

import unittest.mock

import pytest

from strands._context_manager.methods.summarize import (
    _flatten_messages_to_content,
    _summarize_content,
    _tool_result_to_content_blocks,
)
from strands.types.content import ContentBlock, Message


@pytest.fixture
def mock_model():
    model = unittest.mock.AsyncMock()
    model.stream = unittest.mock.AsyncMock()
    return model


def _make_stream_events(text: str):
    """Create async generator of stream events for a text response."""

    async def gen(*args, **kwargs):
        yield {"messageStart": {"role": "assistant"}}
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": text}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}}}

    return gen


class TestToolResultToContentBlocks:
    """Tests for converting tool result content to content blocks."""

    def test_converts_text_content(self):
        content = [{"text": "hello"}]
        tru_result = _tool_result_to_content_blocks(content)
        assert tru_result == [ContentBlock(text="hello")]

    def test_passes_through_non_text_content(self):
        content = [{"image": {"format": "png", "source": {"bytes": b"data"}}}]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 1

    def test_handles_mixed_content(self):
        content = [
            {"text": "first"},
            {"image": {"format": "png", "source": {"bytes": b"data"}}},
            {"text": "second"},
        ]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 3
        assert tru_result[0] == ContentBlock(text="first")
        assert tru_result[2] == ContentBlock(text="second")


class TestFlattenMessagesToContent:
    """Tests for flattening messages to content blocks."""

    def test_adds_role_markers(self):
        messages = [
            Message(role="user", content=[ContentBlock(text="hello")]),
            Message(role="assistant", content=[ContentBlock(text="hi")]),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result[0] == ContentBlock(text="\n---\n[user]")
        assert tru_result[1] == ContentBlock(text="hello")
        assert tru_result[2] == ContentBlock(text="\n---\n[assistant]")
        assert tru_result[3] == ContentBlock(text="hi")

    def test_extracts_tool_result_content(self):
        messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(
                        toolResult={
                            "toolUseId": "t1",
                            "status": "success",
                            "content": [{"text": "result data"}],
                        }
                    )
                ],
            ),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result[0] == ContentBlock(text="\n---\n[user]")
        assert tru_result[1] == ContentBlock(text="result data")


class TestSummarizeContent:
    """Tests for the summarize_content function."""

    @pytest.mark.asyncio
    async def test_returns_summary_text(self, mock_model):
        mock_model.stream = _make_stream_events("This is a summary.")
        content_blocks = [ContentBlock(text="Some long content to summarize.")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result == "This is a summary."

    @pytest.mark.asyncio
    async def test_returns_none_on_empty_response(self, mock_model):
        mock_model.stream = _make_stream_events("")
        content_blocks = [ContentBlock(text="content")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None or tru_result == ""

    @pytest.mark.asyncio
    async def test_uses_custom_system_prompt(self, mock_model):
        mock_model.stream = _make_stream_events("custom summary")
        content_blocks = [ContentBlock(text="content")]
        config = {"system_prompt": "Be very brief."}

        tru_result = await _summarize_content(content_blocks, mock_model, config)
        assert tru_result == "custom summary"

    @pytest.mark.asyncio
    async def test_text_only_fallback_on_exception(self, mock_model):
        """When the first call throws, retries with text-only blocks."""
        call_count = 0

        def stream_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("model error")
            return _make_stream_events("Fallback summary.")(*args, **kwargs)

        mock_model.stream = stream_side_effect
        content_blocks = [
            ContentBlock(text="some text"),
            ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "result"}]}),
        ]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result == "Fallback summary."
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_text_only_fallback_skipped_when_all_text(self, mock_model):
        """When all blocks are already text-only, no fallback retry happens."""

        def stream_side_effect(*args, **kwargs):
            raise RuntimeError("model error")

        mock_model.stream = stream_side_effect
        content_blocks = [ContentBlock(text="only text")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    @pytest.mark.asyncio
    async def test_text_only_fallback_skipped_when_no_text_blocks(self, mock_model):
        """When there are no text blocks at all, no fallback retry happens."""

        def stream_side_effect(*args, **kwargs):
            raise RuntimeError("model error")

        mock_model.stream = stream_side_effect
        content_blocks = [
            ContentBlock(toolResult={"toolUseId": "t1", "status": "success", "content": [{"text": "result"}]}),
        ]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    @pytest.mark.asyncio
    async def test_call_summarizer_no_text_in_response(self, mock_model):
        """When model returns a response with no text blocks, result is None."""

        async def no_text_stream(*args, **kwargs):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
            yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 0, "totalTokens": 10}}}

        mock_model.stream = no_text_stream
        content_blocks = [ContentBlock(text="content to summarize")]

        tru_result = await _summarize_content(content_blocks, mock_model, {})
        assert tru_result is None

    def test_format_summarized_uses_expected_prefix(self):
        from strands._context_manager.methods.summarize import _format_summarized

        assert _format_summarized("test", 100).startswith("[Summarized:")


class TestToolResultToContentBlocksJson:
    """Tests for JSON content in tool_result_to_content_blocks."""

    def test_converts_json_content_to_text(self):
        content = [{"json": {"key": "value", "count": 42}}]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 1
        assert tru_result[0]["text"] == '{\n  "key": "value",\n  "count": 42\n}'

    def test_handles_mixed_json_and_text(self):
        content = [
            {"text": "plain text"},
            {"json": {"nested": True}},
        ]
        tru_result = _tool_result_to_content_blocks(content)
        assert len(tru_result) == 2
        assert tru_result[0] == ContentBlock(text="plain text")
        assert tru_result[1]["text"] == '{\n  "nested": true\n}'
