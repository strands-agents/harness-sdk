"""Tests for the truncate method module."""

import pytest

from strands._context_manager.methods.truncate import (
    CHARS_PER_TOKEN,
    DEFAULT_PREVIEW_TOKENS,
    _build_preview,
    _head_share,
    _resolve_preview_tokens,
    _truncate_text_block,
    _truncate_tool_result_block,
)
from strands.types.content import ContentBlock
from strands.types.tools import ToolResult


class TestResolvePreviewTokens:
    @pytest.mark.parametrize(
        ("config", "expected"),
        [
            (None, DEFAULT_PREVIEW_TOKENS),
            ({}, DEFAULT_PREVIEW_TOKENS),
            ({"preview_tokens": 250}, 250),
            ({"preview_tokens": 0}, 0),
            ({"preview_tokens": -5}, 0),
            ({"preview_tokens": float("inf")}, DEFAULT_PREVIEW_TOKENS),
            ({"preview_tokens": True}, DEFAULT_PREVIEW_TOKENS),
        ],
    )
    def test_resolves_the_budget(self, config, expected):
        assert _resolve_preview_tokens(config) == expected

    @pytest.mark.parametrize(
        ("preview", "expected"),
        [("head", 1.0), ("tail", 0.0), ("head_tail", 0.6)],
    )
    def test_head_share_per_mode(self, preview, expected):
        assert _head_share({"preview": preview}) == expected

    def test_head_share_defaults_to_head_tail(self):
        assert _head_share() == _head_share({"preview": "head_tail"})


class TestBuildPreview:
    """Tests for the build_preview function."""

    def test_short_text_returns_original(self):
        text = "short"
        assert _build_preview(text, 1, {}) == text

    def test_head_mode(self):
        preview = _build_preview("a" * 200, 1, {"preview_tokens": 10, "preview": "head"})
        assert "[Truncated:" in preview
        assert "a" * 10 in preview

    def test_tail_mode(self):
        preview = _build_preview("x" * 100 + "y" * 100, 1, {"preview_tokens": 10, "preview": "tail"})
        assert "[Truncated:" in preview
        assert "y" * (10 * CHARS_PER_TOKEN) in preview

    def test_head_tail_mode_default(self):
        preview = _build_preview("a" * 200, 1, {"preview_tokens": 10})
        assert "[Truncated:" in preview
        assert "chars elided" in preview

    def test_uses_default_preview_tokens(self):
        text = "a" * (DEFAULT_PREVIEW_TOKENS * CHARS_PER_TOKEN * 3)
        assert "[Truncated:" in _build_preview(text, 1, {})

    def test_marker_names_the_blocks_and_their_size(self):
        preview = _build_preview("a" * 400, 2, {"preview_tokens": 10})
        assert preview.startswith("[Truncated: 2 blocks, ~100 tokens]")

    def test_returns_original_when_preview_longer_than_original(self):
        text = "short text"
        assert _build_preview(text, 1, {"preview_tokens": 1000}) == text


class TestTruncateToolResultBlock:
    """Tests for the tool result split into a preview and the items kept as they are."""

    def test_truncates_large_text_content(self):
        large_text = "x" * 50000
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=[{"text": large_text}])

        truncated = _truncate_tool_result_block(tool_result, {"preview_tokens": 100})

        assert truncated is not None
        assert "[Truncated:" in truncated.preview
        assert len(truncated.preview) < len(large_text)
        assert truncated.kept == []

    def test_returns_none_for_short_content(self):
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=[{"text": "short result"}])
        assert _truncate_tool_result_block(tool_result, {"preview_tokens": 100}) is None

    def test_truncates_json_content(self):
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=[{"json": {"key": "v" * 50000}}])

        truncated = _truncate_tool_result_block(tool_result, {"preview_tokens": 100})

        assert truncated is not None
        assert "[Truncated:" in truncated.preview

    def test_keeps_media_as_it_is(self):
        image = {"image": {"format": "png", "source": {"bytes": b"img"}}}
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=[{"text": "x" * 50000}, image])

        truncated = _truncate_tool_result_block(tool_result, {"preview_tokens": 100})

        assert truncated is not None
        assert truncated.kept == [image]

    def test_keeps_a_placeholder_out_of_the_preview(self):
        placeholder = {"text": "[Dropped: ~5 tokens]", "offloaded": {"method": "drop"}}
        tool_result = ToolResult(toolUseId="tool-1", status="success", content=[placeholder, {"text": "y" * 50000}])

        truncated = _truncate_tool_result_block(tool_result, {"preview_tokens": 100})

        assert truncated is not None
        assert truncated.kept == [placeholder]
        assert "[Dropped:" not in truncated.preview

    def test_returns_none_when_no_textual_content(self):
        tool_result = ToolResult(
            toolUseId="tool-1",
            status="success",
            content=[{"image": {"format": "png", "source": {"bytes": b"img"}}}],
        )
        assert _truncate_tool_result_block(tool_result) is None


class TestTruncateTextBlock:
    """Tests for the preview a text block is shortened to."""

    def test_truncates_large_text_block(self):
        preview = _truncate_text_block(ContentBlock(text="z" * 50000), {"preview_tokens": 100})

        assert preview is not None
        assert "[Truncated:" in preview
        assert len(preview) < 50000

    def test_returns_none_for_short_text(self):
        assert _truncate_text_block(ContentBlock(text="short"), {"preview_tokens": 100}) is None

    @pytest.mark.parametrize("preview_mode", ["head", "tail", "head_tail"])
    def test_supports_all_preview_modes(self, preview_mode):
        block = ContentBlock(text="a" * 50000)

        preview = _truncate_text_block(block, {"preview_tokens": 100, "preview": preview_mode})

        assert preview is not None
        assert "[Truncated:" in preview
