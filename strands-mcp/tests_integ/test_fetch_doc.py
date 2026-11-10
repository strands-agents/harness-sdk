"""Integration tests for fetch_doc MCP tool against live documentation."""

import pytest

from strands_mcp_server.server import fetch_doc

from .conftest import LARGE_DOC_URL, integ_marks

pytestmark = integ_marks


class TestFetchDocTocModeLive:
    """Test TOC mode against real documentation pages."""

    def test_large_doc_returns_sections(self, live_cache, large_doc_page):
        """Hooks user guide should produce a non-empty TOC with summaries."""
        result = fetch_doc(uri=LARGE_DOC_URL)

        assert "sections" in result, f"Expected TOC but got: {list(result.keys())}"
        assert len(result["sections"]) >= 2, "Expected at least 2 ## sections"
        assert result["title"], "Title should not be empty"

        # Every section must have required fields
        for section in result["sections"]:
            assert "id" in section
            assert "title" in section
            assert "summary" in section
            assert "level" in section
            assert section["level"] == 2

        assert "preamble" in result, "TOC response should include preamble"
        assert result["preamble"], "Preamble should not be empty for this doc"


class TestFetchDocSectionModeLive:
    """Test section extraction against real documentation pages."""

    def test_extract_first_section(self, live_cache, large_doc_page):
        """Extracting section '1' should return content with the header."""
        result = fetch_doc(uri=LARGE_DOC_URL, section="1")

        assert "content" in result
        assert "section_id" in result
        assert result["section_id"] == "1"
        assert result["section_title"]
        assert result["content"].startswith("## ")


class TestFetchDocEdgeCasesLive:
    """Test edge cases and error paths against the real network."""

    def test_empty_uri_returns_catalog(self, live_cache):
        """Empty URI should return the full URL catalog from llms.txt."""
        result = fetch_doc(uri="")

        assert "urls" in result
        assert len(result["urls"]) >= 10, "Expected at least 10 docs in the catalog"
        # Each entry should have url and title
        for entry in result["urls"][:5]:
            assert "url" in entry
            assert "title" in entry

    @pytest.mark.parametrize("malicious_uri", ["https://strandsagents.com.evil.com/path"])
    def test_ssrf_bypass_vectors_rejected(self, malicious_uri):
        result = fetch_doc(uri=malicious_uri)

        assert "error" in result
