"""Tests for the summarize method module."""

import json
import unittest.mock

import pytest

from strands._context_manager.methods.summarize import (
    _flatten_messages_to_content,
    _summarize_content,
    _tool_result_to_content_blocks,
)
from strands.types.content import ContentBlock, Message, Messages
from strands.types.tools import ToolResult, ToolUse


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
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="result data"),
        ]
        assert tru_result == exp_result

    def test_excludes_reasoning(self):
        messages = [
            Message(
                role="assistant",
                content=[
                    ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}}),
                    ContentBlock(text="hi"),
                ],
            ),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result == [ContentBlock(text="\n---\n[assistant]"), ContentBlock(text="hi")]

    def test_skips_marker_for_reasoning_only_message(self):
        messages = [
            Message(
                role="assistant",
                content=[ContentBlock(reasoningContent={"reasoningText": {"text": "plan", "signature": "sig"}})],
            ),
            Message(role="user", content=[ContentBlock(text="next")]),
        ]
        tru_result = _flatten_messages_to_content(messages)
        assert tru_result == [ContentBlock(text="\n---\n[user]"), ContentBlock(text="next")]

    def test_passes_only_text_images_and_documents_and_renders_other_blocks_as_text(self):
        image = ContentBlock(image={"format": "png", "source": {"bytes": b"\x01"}})
        tool_result = ToolResult(
            toolUseId="call_1",
            status="success",
            content=[{"json": {"ok": True}}, {"video": {"format": "mp4", "source": {"bytes": b"\x01"}}}],
        )
        messages: Messages = [
            Message(
                role="user",
                content=[
                    ContentBlock(guardContent={"text": {"text": "guarded text", "qualifiers": []}}),
                    ContentBlock(video={"format": "mp4", "source": {"bytes": b"\x01"}}),
                    ContentBlock(audio={"format": "mp3", "source": {"bytes": b"\x01"}}),
                    image,
                    ContentBlock(cachePoint={"type": "default"}),
                    ContentBlock(toolResult=tool_result),
                ],
            ),
            Message(
                role="assistant",
                content=[ContentBlock(citationsContent={"citations": [], "content": [{"text": "cited answer"}]})],
            ),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="guarded text"),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="[audio omitted]"),
            image,
            ContentBlock(text="[tool result]"),
            ContentBlock(text=json.dumps({"ok": True}, indent=2)),
            ContentBlock(text="[video omitted]"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text="cited answer"),
        ]
        assert tru_result == exp_result

    def test_renders_tool_calls_and_their_results_as_labeled_text(self):
        # guards against tool-use blocks reaching the summarizer in a user turn (#5291)
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        tool_result = ToolResult(toolUseId="call_1", status="success", content=[{"text": "a.ts b.ts"}])
        messages: Messages = [
            Message(role="user", content=[ContentBlock(text="fix the build")]),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=tool_result)]),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="fix the build"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command":"ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell]"),
            ContentBlock(text="a.ts b.ts"),
        ]
        assert tru_result == exp_result

    def test_labels_error_results_and_results_without_a_matching_call(self):
        tool_use = ToolUse(toolUseId="call_1", name="shell", input={"command": "ls"})
        unmatched_error = ToolResult(toolUseId="call_2", status="error", content=[{"text": "not found"}])
        unmatched_success = ToolResult(toolUseId="call_3", status="success", content=[{"text": "ok"}])
        failed = ToolResult(toolUseId="call_1", status="error", content=[{"text": "denied"}])
        messages: Messages = [
            Message(
                role="user",
                content=[ContentBlock(toolResult=unmatched_error), ContentBlock(toolResult=unmatched_success)],
            ),
            Message(role="assistant", content=[ContentBlock(toolUse=tool_use)]),
            Message(role="user", content=[ContentBlock(toolResult=failed)]),
        ]

        tru_result = _flatten_messages_to_content(messages)
        exp_result = [
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result (error)]"),
            ContentBlock(text="not found"),
            ContentBlock(text="[tool result]"),
            ContentBlock(text="ok"),
            ContentBlock(text="\n---\n[assistant]"),
            ContentBlock(text='[tool call: shell] {"command":"ls"}'),
            ContentBlock(text="\n---\n[user]"),
            ContentBlock(text="[tool result: shell (error)]"),
            ContentBlock(text="denied"),
        ]
        assert tru_result == exp_result


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
    async def test_propagates_model_error_without_retrying(self, mock_model):
        # guards against summarizer failures being hidden by a lossy retry (#5291)
        mock_model.stream = unittest.mock.Mock(side_effect=RuntimeError("images unsupported"))
        content_blocks = [
            ContentBlock(text="some text"),
            ContentBlock(image={"format": "png", "source": {"bytes": b"\x01"}}),
        ]

        with pytest.raises(RuntimeError, match="images unsupported"):
            await _summarize_content(content_blocks, mock_model, {})
        assert mock_model.stream.call_count == 1

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
