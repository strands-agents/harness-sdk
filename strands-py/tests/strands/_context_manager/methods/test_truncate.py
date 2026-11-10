"""Tests for the truncate method module."""

import pytest

from strands._context_manager.methods.truncate import (
    CHARS_PER_TOKEN,
    DEFAULT_PREVIEW_TOKENS,
    _build_preview,
    _truncate_text_block,
    _truncate_tool_result,
)
from strands.types.content import ContentBlock
from strands.types.tools import ToolResult


class TestBuildPreview:
    """Tests for the build_preview function."""

    def test_short_text_returns_original(self):
        text = "short"
        tru_result = _build_preview(text, 1, {})
        assert tru_result == text

    def test_head_mode(self):
        text = "a" * 200
        config = {"preview_tokens": 10, "preview": "head"}
        tru_result = _build_preview(text, 1, config)
        assert "[Truncated:" in tru_result
        assert "a" * 10 in tru_result

    def test_tail_mode(self):
        text = "x" * 100 + "y" * 100
        config = {"preview_tokens": 10, "preview": "tail"}
        tru_result = _build_preview(text, 1, config)
        assert "[Truncated:" in tru_result
        assert "y" * (10 * CHARS_PER_TOKEN) in tru_result

    def test_head_tail_mode_default(self):
        text = "a" * 200
        config = {"preview_tokens": 10}
        tru_result = _build_preview(text, 1, config)
        assert "[Truncated:" in tru_result
        assert "a" in tru_result

    def test_uses_default_preview_tokens(self):
        text = "a" * (DEFAULT_PREVIEW_TOKENS * CHARS_PER_TOKEN * 3)
        tru_result = _build_preview(text, 1, {})
        assert "[Truncated:" in tru_result


class TestTruncateToolResult:
    """Tests for truncate_tool_result."""

    def test_truncates_large_text_content(self):
        large_text = "x" * 50000
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"text": large_text}],
        )
        tru_result = _truncate_tool_result(tool_result, {"preview_tokens": 100})
        text_content = tru_result["content"][0]["text"]
        assert "[Truncated:" in text_content
        assert len(text_content) < len(large_text)

    def test_preserves_short_content(self):
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"text": "short result"}],
        )
        tru_result = _truncate_tool_result(tool_result, {"preview_tokens": 100})
        assert tru_result["content"][0]["text"] == "short result"

    def test_preserves_tool_use_id_and_status(self):
        tool_result = ToolResult(
            toolUseId="tool-abc",
            status="error",
            content=[{"text": "x" * 50000}],
        )
        tru_result = _truncate_tool_result(tool_result, {"preview_tokens": 100})
        assert tru_result["toolUseId"] == "tool-abc"
        assert tru_result["status"] == "error"

    def test_truncates_json_content(self):
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"json": {"key": "v" * 50000}}],
        )
        tru_result = _truncate_tool_result(tool_result, {"preview_tokens": 100})
        assert "[Truncated:" in tru_result["content"][0]["text"]

    def test_preserves_opaque_blocks(self):
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"text": "x" * 50000}, {"image": {"format": "png", "source": {"bytes": b"img"}}}],
        )
        tru_result = _truncate_tool_result(tool_result, {"preview_tokens": 100})
        assert len(tru_result["content"]) == 2
        assert "image" in tru_result["content"][1]

    def test_returns_original_when_no_textual_content(self):
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"image": {"format": "png", "source": {"bytes": b"img"}}}],
        )
        tru_result = _truncate_tool_result(tool_result)
        assert tru_result is tool_result

    def test_returns_original_when_preview_longer_than_original(self):
        text = "short text"
        tru_result = _build_preview(text, 1, {"preview_tokens": 1000})
        assert tru_result == text


class TestTruncateTextBlock:
    """Tests for truncate_text_block."""

    def test_truncates_large_text_block(self):
        block = ContentBlock(text="z" * 50000)
        tru_result = _truncate_text_block(block, {"preview_tokens": 100})
        assert tru_result is not None
        assert "[Truncated:" in tru_result["text"]
        assert len(tru_result["text"]) < 50000

    def test_returns_original_for_short_text(self):
        block = ContentBlock(text="short")
        tru_result = _truncate_text_block(block, {"preview_tokens": 100})
        assert tru_result is block

    @pytest.mark.parametrize("preview_mode", ["head", "tail", "head_tail"])
    def test_supports_all_preview_modes(self, preview_mode):
        block = ContentBlock(text="a" * 50000)
        tru_result = _truncate_text_block(block, {"preview_tokens": 100, "preview": preview_mode})
        assert tru_result is not None
        assert "[Truncated:" in tru_result["text"]
