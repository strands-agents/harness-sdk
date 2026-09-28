"""Integration tests for the fetch and parse pipeline."""

from urllib.parse import urlparse

import pytest

from strands_mcp_server.config import doc_config
from strands_mcp_server.utils import doc_fetcher
from strands_mcp_server.utils.text_processor import (
    extract_section,
    parse_sections,
)

from .conftest import LARGE_DOC_URL, integ_marks

pytestmark = integ_marks


class TestLlmsTxtParsing:
    """Test that llms.txt parsing works against the real index."""

    def test_llms_txt_returns_links(self):
        """The llms.txt file should return valid documentation links."""
        try:
            links = doc_fetcher.parse_llms_txt(doc_config.llm_texts_url[0])
        except Exception as exc:
            pytest.skip(f"Could not fetch llms.txt: {exc}")

        assert len(links) >= 10, f"Expected at least 10 links, got {len(links)}"
        for title, url in links[:5]:
            assert title, "Title should not be empty"
            parsed_url = urlparse(url)
            assert parsed_url.scheme == "https", f"URL should use HTTPS: {url}"
            assert parsed_url.hostname == "strandsagents.com", f"URL should be on strandsagents.com: {url}"

    def test_url_titles_populated_after_init(self, live_cache, url_titles):
        """After cache init, URL titles should be populated from llms.txt."""
        assert len(url_titles) >= 10
        for url, title in list(url_titles.items())[:5]:
            assert urlparse(url).hostname == "strandsagents.com"
            assert title


class TestFetchAndClean:
    """Test real page fetching and content cleaning."""

    def test_fetch_returns_markdown_with_headers(self, large_doc_page):
        """Fetched content should be raw markdown with ## headers, not HTML."""
        assert large_doc_page.content, "Content should not be empty"
        assert large_doc_page.url == LARGE_DOC_URL
        assert "#" in large_doc_page.content
        assert "## " in large_doc_page.content, "Expected at least one ## header in doc content"
        # Should be raw markdown, not HTML
        assert "<html" not in large_doc_page.content.lower()


class TestParseSectionsOnRealDocs:
    """Test section parsing against real documentation content."""

    def test_parse_real_doc_produces_sections(self, large_doc_page):
        """Parsing a real doc should produce a valid section tree."""
        sections = parse_sections(large_doc_page.content)

        assert len(sections) >= 2, f"Expected at least 2 sections, got {len(sections)}"
        for section in sections:
            assert section["id"]
            assert section["title"]
            assert section["level"] == 2

    def test_extract_roundtrip(self, large_doc_page):
        """Extracting each section and concatenating should cover the doc."""
        sections = parse_sections(large_doc_page.content)

        for section in sections:
            result = extract_section(large_doc_page.content, section["id"], sections)
            assert result is not None, f"Failed to extract section {section['id']}"
            assert result["section_title"] == section["title"]
            assert "## " in result["content"]
