"""Tests for the search module."""

import pytest

from strands.vended_plugins.context_offloader.search import _is_searchable_content, _search_content


class TestIsSearchableContent:
    def test_text_types(self):
        assert _is_searchable_content("text/plain") is True
        assert _is_searchable_content("text/html") is True

    def test_application_json(self):
        assert _is_searchable_content("application/json") is True

    def test_binary_types(self):
        assert _is_searchable_content("image/png") is False
        assert _is_searchable_content("video/mp4") is False
        assert _is_searchable_content("application/pdf") is False

    def test_canonical_text_document_types(self):
        """Text-based document formats stored under canonical text/* types are searchable."""
        assert _is_searchable_content("text/csv") is True
        assert _is_searchable_content("text/markdown") is True

    def test_legacy_text_document_types(self):
        """Legacy application/{format} aliases for text-based documents stay searchable."""
        assert _is_searchable_content("application/csv") is True
        assert _is_searchable_content("application/txt") is True
        assert _is_searchable_content("application/md") is True
        assert _is_searchable_content("application/html") is True

    def test_legacy_binary_document_types_not_searchable(self):
        assert _is_searchable_content("application/docx") is False
        assert _is_searchable_content("application/xlsx") is False
        assert _is_searchable_content("application/octet-stream") is False


class TestSearchContentEmpty:
    def test_empty_string(self):
        result = _search_content("", pattern="x", context_lines=5, max_chars=10_000)
        assert result == "Content is empty (0 lines)."

    def test_single_empty_line(self):
        result = _search_content("\n", line_range=(1, 1), context_lines=5, max_chars=10_000)
        assert "Content is empty" not in result


class TestSearchContentLineRangeValidation:
    text = "line 1\nline 2\nline 3\nline 4\nline 5"

    def test_start_less_than_one(self):
        with pytest.raises(ValueError, match="must be >= 1"):
            _search_content(self.text, line_range=(0, 3), context_lines=5, max_chars=10_000)

    def test_negative_start(self):
        with pytest.raises(ValueError, match="must be >= 1"):
            _search_content(self.text, line_range=(-2, 3), context_lines=5, max_chars=10_000)

    def test_start_greater_than_end(self):
        with pytest.raises(ValueError, match="must be <= line_range.end"):
            _search_content(self.text, line_range=(5, 2), context_lines=5, max_chars=10_000)

    def test_start_beyond_total_lines(self):
        with pytest.raises(ValueError, match=r"beyond content length \(5 lines\)"):
            _search_content(self.text, line_range=(100, 200), context_lines=5, max_chars=10_000)

    def test_clamps_end_to_total_lines(self):
        result = _search_content(self.text, line_range=(3, 999), context_lines=5, max_chars=10_000)
        assert "[Lines 3-5 of 5]" in result
        assert "line 3" in result
        assert "line 5" in result


class TestSearchContentPatternSearch:
    text = "\n".join(f"line {i + 1}" for i in range(20))

    def test_single_match_with_context(self):
        result = _search_content(self.text, pattern="line 10", context_lines=2, max_chars=10_000)
        assert "[1 match for /line 10/]" in result
        assert "> 10| line 10" in result
        assert "   8| line 8" in result
        assert "  12| line 12" in result
        assert "line 7" not in result

    def test_multiple_matches(self):
        result = _search_content(self.text, pattern="line [12]0", context_lines=0, max_chars=10_000)
        assert "2 matches" in result
        assert "> 10| line 10" in result
        assert "> 20| line 20" in result

    def test_no_matches(self):
        result = _search_content(self.text, pattern="nonexistent", context_lines=5, max_chars=10_000)
        assert "No matches found for pattern 'nonexistent'" in result
        assert "searched 20 lines" in result

    def test_zero_context_lines(self):
        result = _search_content(self.text, pattern="line 5", context_lines=0, max_chars=10_000)
        assert "> 5| line 5" in result
        assert "line 4" not in result
        assert "line 6" not in result

    def test_merges_overlapping_context(self):
        result = _search_content(self.text, pattern="line [67]", context_lines=2, max_chars=10_000)
        assert "2 matches" in result
        assert "---" not in result

    def test_separates_non_overlapping_groups(self):
        result = _search_content(self.text, pattern="line (1|20)", context_lines=0, max_chars=10_000)
        assert "---" in result

    def test_falls_back_to_literal_on_invalid_regex(self):
        text = "foo (bar\nbaz\nfoo (bar again"
        result = _search_content(text, pattern="foo (bar", context_lines=0, max_chars=10_000)
        assert "2 matches" in result
        assert "> 1| foo (bar" in result
        assert "> 3| foo (bar again" in result

    def test_sanitizes_pattern_in_header(self):
        text = "test line\nanother line"
        result = _search_content(text, pattern="test]\nline", context_lines=0, max_chars=10_000)
        header = result.split("\n")[0]
        assert "]/" not in header


class TestSearchContentPatternWithLineRange:
    text = "\n".join(f"item {i + 1}" for i in range(30))

    def test_searches_only_within_range(self):
        result = _search_content(self.text, pattern="item 1", line_range=(10, 20), context_lines=0, max_chars=10_000)
        assert "in lines 10-20" in result
        assert "> 10| item 10" in result
        assert "> 11| item 11" in result
        assert "> 1|" not in result

    def test_no_matches_within_range(self):
        result = _search_content(self.text, pattern="item 5", line_range=(10, 20), context_lines=0, max_chars=10_000)
        assert "No matches found" in result
        assert "in lines 10-20" in result


class TestSearchContentLineRangeNoPattern:
    text = "\n".join(f"line {i + 1}" for i in range(50))

    def test_returns_range_with_header(self):
        result = _search_content(self.text, line_range=(5, 10), context_lines=5, max_chars=10_000)
        assert "[Lines 5-10 of 50]" in result
        assert "  5| line 5" in result
        assert " 10| line 10" in result

    def test_does_not_show_lines_outside_range(self):
        result = _search_content(self.text, line_range=(5, 10), context_lines=5, max_chars=10_000)
        assert "line 4" not in result
        assert "line 11" not in result

    def test_no_separators_for_contiguous_lines(self):
        result = _search_content(self.text, line_range=(1, 10), context_lines=5, max_chars=10_000)
        assert "---" not in result


class TestSearchContentTruncation:
    def test_truncates_pattern_results(self):
        text = "\n".join(f"match line {i + 1}" for i in range(500))
        result = _search_content(text, pattern="match", context_lines=0, max_chars=200)
        assert "output truncated, narrow your search" in result
        assert len(result) <= 250

    def test_truncates_line_range_results(self):
        text = "\n".join(f"line {i + 1}" for i in range(500))
        result = _search_content(text, line_range=(1, 500), context_lines=5, max_chars=200)
        assert "output truncated, narrow your range" in result
        assert len(result) <= 250

    def test_no_truncation_when_fits(self):
        text = "short\ncontent"
        result = _search_content(text, line_range=(1, 2), context_lines=5, max_chars=10_000)
        assert "truncated" not in result

    def test_single_long_line_pattern_result_keeps_body(self):
        # A body with no internal newlines must still appear when truncated —
        # the truncator can't mistake the header separator for a body line break.
        long_json = '{"key":"' + "x" * 5_000 + '"}'
        result = _search_content(long_json, pattern="key", context_lines=0, max_chars=500)
        assert "[1 match for /key/]" in result
        assert '> 1| {"key":"xxxx' in result
        assert "output truncated, narrow your search" in result

    def test_single_long_line_range_result_keeps_body(self):
        # Same guarantee on the line-range path: a single long line survives truncation.
        long_json = '{"key":"' + "x" * 5_000 + '"}'
        result = _search_content(long_json, line_range=(1, 1), context_lines=0, max_chars=500)
        assert "[Lines 1-1 of 1]" in result
        assert '  1| {"key":"xxxx' in result
        assert "output truncated, narrow your range" in result


class TestSearchContentEdgeCases:
    def test_negative_context_lines_clamps_to_zero(self):
        text = "\n".join(f"line {i + 1}" for i in range(10))
        result = _search_content(text, pattern="line 5", context_lines=-3, max_chars=10_000)
        assert "1 match" in result
        assert "> 5| line 5" in result
        assert "line 4" not in result
        assert "line 6" not in result

    def test_long_valid_regex_is_truncated_but_still_matches(self):
        text = "line 5\nother\nmore"
        long_pattern = "(line 5)" + "|x" * 120
        result = _search_content(text, pattern=long_pattern, context_lines=0, max_chars=10_000)
        assert "1 match" in result
        assert "> 1| line 5" in result

    def test_long_invalid_regex_falls_back_to_literal(self):
        text = "foo(bar\nother\nfoo(bar again"
        long_pattern = "foo(bar" + "z" * 200
        result = _search_content(text, pattern=long_pattern, context_lines=0, max_chars=10_000)
        assert "No matches" in result

    def test_empty_indices_format(self):
        from strands.vended_plugins.context_offloader.search import _format_lines

        assert _format_lines(["a", "b"], [], set()) == ""
