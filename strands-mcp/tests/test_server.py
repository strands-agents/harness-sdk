"""Tests for MCP server tools."""

from threading import Event, Lock
from unittest.mock import patch

import pytest

from strands_mcp_server import server
from strands_mcp_server.server import fetch_doc, search_docs
from strands_mcp_server.utils.doc_fetcher import Page
from strands_mcp_server.utils.indexer import Doc


@patch("strands_mcp_server.server.cache")
def test_search_docs_hydrates_pages_concurrently(mock_cache):
    """Guard against serial snippet hydration (#3329)."""
    docs = [
        Doc(uri=f"https://strandsagents.com/{index}.md", display_title=f"Doc {index}", content="", index_title="")
        for index in range(2)
    ]
    ranked_docs = [docs[0], docs[0], docs[1]]
    mock_cache.get_index.return_value.search.return_value = [(1.0, doc) for doc in ranked_docs]
    mock_cache.get_url_cache.return_value = {doc.uri: None for doc in docs}
    mock_cache.SNIPPET_HYDRATE_MAX = 5

    fetch_lock = Lock()
    both_fetches_started = Event()
    active_fetches = 0
    max_active_fetches = 0

    def ensure_page(_url: str) -> None:
        nonlocal active_fetches, max_active_fetches
        with fetch_lock:
            active_fetches += 1
            max_active_fetches = max(max_active_fetches, active_fetches)
            if active_fetches == len(docs):
                both_fetches_started.set()
        both_fetches_started.wait(timeout=0.5)
        with fetch_lock:
            active_fetches -= 1

    mock_cache.ensure_page.side_effect = ensure_page

    tru_result = search_docs("agent")

    assert max_active_fetches == 2
    assert mock_cache.ensure_page.call_count == 2
    assert {call.args[0] for call in mock_cache.ensure_page.call_args_list} == {doc.uri for doc in docs}
    assert [result["url"] for result in tru_result] == [doc.uri for doc in ranked_docs]


@patch("strands_mcp_server.server.cache")
class TestFetchDocTocMode:
    """Tests for fetch_doc TOC mode (no section param)."""

    def test_returns_toc_for_large_doc(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md")

        assert "sections" in tru_result
        assert len(tru_result["sections"]) == 3
        assert tru_result["title"] == "Test Doc"

        # Internal fields must not leak into tool responses
        for section in tru_result["sections"]:
            for key in section:
                assert not key.startswith("_"), f"Internal field '{key}' leaked"

    def test_small_doc_returns_full_content(self, mock_cache, small_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/small.md",
            title="Small Doc",
            content=small_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/small.md")

        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "size"
        assert "content" in tru_result
        assert "sections" not in tru_result

    def test_small_doc_ignores_section_param(self, mock_cache, small_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/small.md",
            title="Small Doc",
            content=small_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/small.md", section="1")

        # Section param should be ignored for small docs
        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "size"
        assert "content" in tru_result
        assert "section_id" not in tru_result

    def test_toc_includes_preamble(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md")

        assert "preamble" in tru_result
        assert "Experimental hook events" in tru_result["preamble"]

    def test_no_h2_headers_returns_full_content(self, mock_cache, no_h2_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/no-h2.md",
            title="No H2 Doc",
            content=no_h2_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/no-h2.md")

        # No ## sections means fallback to full content
        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "no_sections"
        assert "content" in tru_result
        assert "sections" not in tru_result

    @pytest.mark.parametrize("kwargs", [{}, {"uri": ""}], ids=["no-args", "empty-uri"])
    def test_omitted_uri_returns_url_catalog(self, mock_cache, kwargs):
        mock_cache.get_url_titles.return_value = {"https://strandsagents.com/a.md": "Doc A"}

        tru_result = fetch_doc(**kwargs)

        assert tru_result == {
            "urls": [{"url": "https://strandsagents.com/a.md", "title": "Doc A"}],
            "total": 1,
            "offset": 0,
            "limit": server.CATALOG_PAGE_SIZE,
        }


@patch("strands_mcp_server.server.cache")
class TestFetchDocCatalogPagination:
    """Catalog mode returns a bounded page instead of every URL (#3326)."""

    @staticmethod
    def _catalog(size):
        return {f"https://strandsagents.com/{i:04d}.md": f"Doc {i}" for i in range(size)}

    def test_large_catalog_is_capped_at_default_page_size(self, mock_cache):
        mock_cache.get_url_titles.return_value = self._catalog(763)

        tru_result = fetch_doc()

        assert len(tru_result["urls"]) == server.CATALOG_PAGE_SIZE
        assert tru_result["total"] == 763
        assert tru_result["next_offset"] == server.CATALOG_PAGE_SIZE

    def test_offset_and_limit_select_a_slice(self, mock_cache):
        mock_cache.get_url_titles.return_value = self._catalog(50)

        tru_result = fetch_doc(offset=10, limit=5)

        assert [entry["title"] for entry in tru_result["urls"]] == [f"Doc {i}" for i in range(10, 15)]
        assert tru_result["offset"] == 10
        assert tru_result["limit"] == 5
        assert tru_result["next_offset"] == 15

    def test_last_page_omits_next_offset(self, mock_cache):
        mock_cache.get_url_titles.return_value = self._catalog(10)

        tru_result = fetch_doc(offset=5, limit=5)

        assert len(tru_result["urls"]) == 5
        assert "next_offset" not in tru_result

    def test_offset_past_the_end_returns_empty_page(self, mock_cache):
        mock_cache.get_url_titles.return_value = self._catalog(10)

        tru_result = fetch_doc(offset=999)

        assert tru_result["urls"] == []
        assert tru_result["total"] == 10
        assert "next_offset" not in tru_result

    def test_paging_covers_every_entry_exactly_once(self, mock_cache):
        catalog = self._catalog(25)
        mock_cache.get_url_titles.return_value = catalog

        seen, offset = [], 0
        while True:
            page = fetch_doc(offset=offset, limit=7)
            seen.extend(entry["url"] for entry in page["urls"])
            if "next_offset" not in page:
                break
            offset = page["next_offset"]

        assert seen == list(catalog)

    @pytest.mark.parametrize("limit,expected", [(0, 1), (-5, 1), (10_000, 500)])
    def test_limit_is_clamped_to_a_usable_range(self, mock_cache, limit, expected):
        mock_cache.get_url_titles.return_value = self._catalog(600)

        tru_result = fetch_doc(limit=limit)

        assert tru_result["limit"] == expected
        assert len(tru_result["urls"]) == expected

    def test_negative_offset_is_treated_as_zero(self, mock_cache):
        mock_cache.get_url_titles.return_value = self._catalog(10)

        tru_result = fetch_doc(offset=-5, limit=3)

        assert tru_result["offset"] == 0
        assert [entry["title"] for entry in tru_result["urls"]] == ["Doc 0", "Doc 1", "Doc 2"]


@patch("strands_mcp_server.server.cache")
class TestFetchDocSectionMode:
    """Tests for fetch_doc section mode."""

    def test_returns_section_content(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md", section="1")

        assert tru_result["section_id"] == "1"
        assert "content" in tru_result
        assert "sections" not in tru_result


@patch("strands_mcp_server.server.cache")
class TestFetchDocErrors:
    """Tests for fetch_doc error handling."""

    @pytest.mark.parametrize(
        "malicious_uri",
        [
            "https://strandsagents.com.evil.com/path",
            "https://strandsagents.com@evil.com/path",
            "http://strandsagents.com/path",
            "ftp://strandsagents.com/path",
            "https://evil.com/hack",
        ],
    )
    def test_ssrf_bypass_vectors_rejected(self, mock_cache, malicious_uri):
        tru_result = fetch_doc(uri=malicious_uri)

        assert "error" in tru_result
        assert tru_result["error"] == "only https://strandsagents.com URLs allowed"

    def test_invalid_section_returns_error(self, mock_cache, api_reference_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/test.md",
            title="Test Doc",
            content=api_reference_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/test.md", section="99")

        assert "error" in tru_result

    def test_fetch_failure_returns_error(self, mock_cache):
        mock_cache.ensure_page.return_value = None

        tru_result = fetch_doc(uri="https://strandsagents.com/missing.md")

        assert tru_result["error"] == "fetch failed"
