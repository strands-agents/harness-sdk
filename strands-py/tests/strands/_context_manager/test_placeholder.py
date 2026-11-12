"""Tests for offload placeholders and the wording of each marker they carry."""

import pytest

from strands._context_manager.placeholder import (
    carried_tokens,
    format_dropped,
    format_dropped_messages,
    format_elided,
    format_offloaded,
    format_summarized,
    format_truncated,
    is_offloaded,
    offload_placeholder,
    placeholder_result,
)
from strands.types.content import ContentBlock
from strands.types.tools import ToolResult


class TestOffloadPlaceholder:
    def test_appends_the_stash_ref_and_records_what_it_stands_for(self):
        block = offload_placeholder("drop", "[Dropped: earlier messages]", "removed-abc", 1200)

        assert block == ContentBlock(
            text="[Dropped: earlier messages] [ref: removed-abc]",
            offloaded={"method": "drop", "ref": "removed-abc", "tokens": 1200},
        )

    def test_leaves_out_the_ref_when_the_original_was_not_stashed(self):
        assert offload_placeholder("drop", "[Dropped]", None) == ContentBlock(
            text="[Dropped]", offloaded={"method": "drop"}
        )


class TestMarkers:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            (format_dropped(2525), "[Dropped: ~2,525 tokens]"),
            (format_dropped(0), "[Dropped]"),
            (
                format_dropped(2525, "image"),
                "[Dropped: image, ~2,525 tokens, removed from context after it was received]",
            ),
            (format_dropped(0, "image"), "[Dropped: image, removed from context after it was received]"),
            (format_dropped_messages(1200), "[Dropped: earlier messages, ~1,200 tokens]"),
            (format_dropped_messages(0), "[Dropped: earlier messages]"),
            (format_offloaded(2525), "[Offloaded: ~2,525 tokens]"),
            (format_offloaded(0), "[Offloaded]"),
            (
                format_offloaded(2525, "document"),
                "[Offloaded: document, ~2,525 tokens, removed from context after it was received]",
            ),
            (format_offloaded(0, "image"), "[Offloaded: image, removed from context after it was received]"),
            (format_summarized("tool result", 2525, "short"), "[Summarized: tool result, ~2,525 tokens]\n\nshort"),
            (format_summarized("media block", 0, "a red square"), "[Summarized: media block]\n\na red square"),
            (format_truncated(1, 7500, "head"), "[Truncated: 1 block, ~7,500 tokens]\n\nhead"),
            (format_truncated(2, 7500, "head"), "[Truncated: 2 blocks, ~7,500 tokens]\n\nhead"),
            (format_elided(1200), "[... earlier messages elided, ~1,200 tokens ...]"),
            (format_elided(0), "[... earlier messages elided ...]"),
        ],
    )
    def test_formats_a_marker(self, text, expected):
        assert text == expected


class TestPlaceholderResult:
    def test_keeps_the_id_and_status_that_pair_it_to_its_tool_use(self):
        tool_result = ToolResult(toolUseId="tu-1", status="error", content=[{"text": "original"}])
        placeholder = offload_placeholder("truncate", "[Truncated]", "tu-1")

        block = placeholder_result(tool_result, [placeholder])

        assert block == ContentBlock(toolResult=ToolResult(toolUseId="tu-1", status="error", content=[placeholder]))


class TestIsOffloaded:
    def test_detects_a_placeholder(self):
        assert is_offloaded(offload_placeholder("drop", "[Dropped]", None))

    @pytest.mark.parametrize(
        "block",
        [{"text": "plain text"}, {"text": "see [ref: x] for details"}, {"json": {"offloaded": True}}],
    )
    def test_ignores_content_that_only_looks_like_one(self, block):
        assert not is_offloaded(block)


class TestCarriedTokens:
    def test_sums_the_tokens_the_placeholders_already_stand_for(self):
        blocks = [
            offload_placeholder("drop", "[Dropped]", "a", 100),
            ContentBlock(text="kept"),
            offload_placeholder("truncate", "[Truncated]", "b", 250),
        ]

        assert carried_tokens(blocks) == 350

    def test_includes_placeholders_inside_a_tool_result(self):
        tool_result = ToolResult(
            toolUseId="tu-1",
            status="success",
            content=[offload_placeholder("truncate", "[Truncated]", "tu-1", 400), {"text": "preview"}],
        )

        assert carried_tokens([ContentBlock(toolResult=tool_result)]) == 400

    def test_counts_nothing_for_a_placeholder_the_token_count_never_measured(self):
        assert carried_tokens([offload_placeholder("drop", "[Dropped]", "a")]) == 0
