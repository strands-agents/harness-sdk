"""Tests for the summarize method module."""

from strands._context_manager.methods.summarize import _format_summarized


class TestFormatSummarized:
    """Tests for the summary marker."""

    def test_format_summarized_uses_expected_prefix(self):
        assert _format_summarized("test", 100).startswith("[Summarized:")
