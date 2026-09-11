"""Tests for MCP server tools."""

from threading import Event, Lock
from unittest.mock import patch

import pytest

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

    def test_no_h2_headers_returns_bounded_content(self, mock_cache, no_h2_doc):
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/no-h2.md",
            title="No H2 Doc",
            content=no_h2_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/no-h2.md")

        # No ## sections means fallback to bounded content — capped at threshold
        assert tru_result["document_small"] is True
        assert tru_result["reason"] == "no_sections"
        assert "content" in tru_result
        # Verify content is bounded by SMALL_DOC_THRESHOLD
        assert len(tru_result["content"].encode("utf-8")) <= 8192, "no_sections content must be bounded"
        assert "sections" not in tru_result

    def test_no_sections_truncation_has_machine_readable_flag_and_notice(self, mock_cache, no_h2_doc):
        """Regression: no_sections path must set truncated: True and include notice."""
        mock_cache.ensure_page.return_value = Page(
            url="https://strandsagents.com/no-h2.md",
            title="No H2 Doc",
            content=no_h2_doc,
        )

        tru_result = fetch_doc(uri="https://strandsagents.com/no-h2.md")

        # Machine-readable truncation signal
        assert tru_result.get("truncated") is True, "Response must include 'truncated: True' for the no_sections case"
        # Human-readable notice in content
        assert "… (truncated, no parseable sections)" in tru_result["content"], (
            "Content must include the truncation notice string"
        )

    @pytest.mark.parametrize("kwargs", [{}, {"uri": ""}], ids=["no-args", "empty-uri"])
    def test_omitted_uri_returns_url_catalog(self, mock_cache, kwargs):
        mock_cache.get_url_titles.return_value = {"https://strandsagents.com/a.md": "Doc A"}

        tru_result = fetch_doc(**kwargs)

        assert tru_result == {"urls": [{"url": "https://strandsagents.com/a.md", "title": "Doc A"}]}


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
        mock_cache.get_failure_reason.return_value = None

        tru_result = fetch_doc(uri="https://strandsagents.com/missing.md")

        assert tru_result["error"] == "fetch failed"

    def test_fetch_failure_surfaces_reason(self, mock_cache):
        mock_cache.ensure_page.return_value = None
        mock_cache.get_failure_reason.return_value = "HTTPError: HTTP Error 404: Not Found"

        tru_result = fetch_doc(uri="https://strandsagents.com/missing.md")

        assert tru_result["error"] == "fetch failed: HTTPError: HTTP Error 404: Not Found"


class FailedSentinel:
    """Minimal sentinel simulating a negatively cached failed fetch entry.

    Has no .content attribute — same shape as cache._FailedEntry.
    """

    pass


@patch("strands_mcp_server.server.cache")
class TestSearchDocsWithNegativeCache:
    """Tests for search_docs resilience with negatively cached failed entries."""

    def test_failed_cache_entry_does_not_crash_hydration_loop(self, mock_cache):
        """search_docs must not crash when url_cache contains a failed sentinel."""
        mock_cache.ensure_ready.return_value = None
        mock_cache.SNIPPET_HYDRATE_MAX = 5

        # Set up a mock index that returns results for a failed URL
        mock_index = mock_cache.get_index.return_value
        mock_index.search.return_value = [
            (0.9, type("Doc", (), {"uri": "https://strandsagents.com/failed.md", "display_title": "Failed Doc"})())
        ]

        # url_cache contains a FailedSentinel for that URL
        mock_cache.get_url_cache.return_value = {
            "https://strandsagents.com/failed.md": FailedSentinel(),
        }

        # Must not raise AttributeError
        result = search_docs("test query")
        assert isinstance(result, list)

    def test_failed_entry_returns_title_as_snippet(self, mock_cache):
        """When a search result's page has a failed entry, the snippet should
        fall back to the display title rather than crashing."""
        mock_cache.ensure_ready.return_value = None
        mock_cache.SNIPPET_HYDRATE_MAX = 5

        mock_index = mock_cache.get_index.return_value
        mock_index.search.return_value = [
            (0.9, type("Doc", (), {"uri": "https://strandsagents.com/failed.md", "display_title": "Failed Doc"})())
        ]

        mock_cache.get_url_cache.return_value = {
            "https://strandsagents.com/failed.md": FailedSentinel(),
        }

        result = search_docs("test query")
        assert len(result) == 1
        assert result[0]["snippet"] == "Failed Doc"


class TestSearchDocsTTLExpiry:
    """TTL expiry through the real cache module, not a mocked one.

    Regression for the review on harness-sdk #3544: search_docs previously
    decided whether to hydrate by checking ``url_cache.get(uri) is None``, so a
    ``_FailedEntry`` (not None) never re-entered ``urls_to_hydrate`` even after
    its TTL expired. The expiry rule lived only inside ``ensure_page``, on a
    path search_docs had already decided not to call.
    """

    def test_expired_failed_entry_is_refetched_by_search_docs(self, monkeypatch):
        """A failed entry must be re-fetched once its TTL expires.

        Uses the real ``cache`` module (only ``fetch_and_clean`` is stubbed) so
        the expiry evaluation inside ``needs_hydration`` is exercised on the
        search_docs path.
        """
        from strands_mcp_server.utils import cache as real_cache

        url = "https://strandsagents.com/flaky.md"
        doc = Doc(uri=url, display_title="Flaky Doc", content="", index_title="")

        # Stub only the index plumbing; keep the real _URL_CACHE, needs_hydration,
        # ensure_page, and search_docs.
        index = type("Index", (), {"search": lambda self, q, k=5: [(1.0, doc)]})()
        monkeypatch.setattr(real_cache, "get_index", lambda: index)
        monkeypatch.setattr(real_cache, "ensure_ready", lambda: None)
        real_cache._URL_CACHE.clear()

        fetched_urls = []

        def fake_fetch_and_clean(_url):
            fetched_urls.append(_url)
            return type("Raw", (), {"title": "Flaky Doc", "content": "Recovered content"})()

        monkeypatch.setattr(
            "strands_mcp_server.utils.doc_fetcher.fetch_and_clean",
            fake_fetch_and_clean,
        )

        # Seed an unexpired failed entry — network was down moments ago.
        entry = real_cache._FailedEntry()
        real_cache._URL_CACHE[url] = entry

        # Within TTL: search_docs must NOT re-fetch (still failing).
        result = search_docs("test query")
        assert fetched_urls == []
        assert result[0]["snippet"] == "Flaky Doc"

        # Expire the entry — search_docs must re-fetch and recover the content.
        entry._timestamp -= real_cache._FAILED_TTL_SECONDS + 1
        result = search_docs("test query")
        assert fetched_urls == [url]
        assert result[0]["snippet"] == "Recovered content"


class TestFetchDocFailureReason:
    """End-to-end: a failed fetch records a reason that fetch_doc surfaces.

    Regression guard for #3328's error-path ask: consuming models must be able
    to tell a 404 from a DNS failure from a timeout instead of a bare
    "fetch failed".
    """

    def test_failed_fetch_surfaces_reason_in_error(self, monkeypatch):
        from strands_mcp_server.utils import cache as real_cache

        url = "https://strandsagents.com/missing.md"
        real_cache._URL_CACHE.clear()
        monkeypatch.setattr(real_cache, "ensure_ready", lambda: None)

        def boom(_url):
            raise Exception("HTTP Error 404: Not Found")

        monkeypatch.setattr(
            "strands_mcp_server.utils.doc_fetcher.fetch_and_clean",
            boom,
        )

        result = fetch_doc(uri=url)

        assert result["error"] == "fetch failed: Exception: HTTP Error 404: Not Found"
