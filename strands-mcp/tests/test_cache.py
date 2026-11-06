"""Tests for cache module hydration and prefetch functionality."""

import os
from concurrent.futures import ThreadPoolExecutor, wait
from threading import Event
from unittest.mock import MagicMock, patch

import pytest

from strands_mcp_server.utils import cache, indexer
from strands_mcp_server.utils.doc_fetcher import Page


@pytest.fixture(autouse=True)
def reset_cache_state():
    """Reset cache module global state before each test."""
    cache._INDEX = None
    cache._URL_CACHE = {}
    cache._URL_TITLES = {}
    cache._LINKS_LOADED = False
    cache._PREFETCH_STARTED = False
    yield
    cache._INDEX = None
    cache._URL_CACHE = {}
    cache._URL_TITLES = {}
    cache._LINKS_LOADED = False
    cache._PREFETCH_STARTED = False


class TestEnsureReady:
    """First-use initialization must not duplicate documents across concurrent calls (#5860)."""

    def test_concurrent_calls_load_index_once(self):
        first_fetch = Event()
        release_fetch = Event()
        url = "https://strandsagents.com/test.md"

        def parse_links(_source):
            if not first_fetch.is_set():
                first_fetch.set()
                assert release_fetch.wait(5)
            return [("Test guide", url, "")]

        with (
            patch.object(cache.doc_fetcher, "parse_llms_txt", side_effect=parse_links),
            patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "0"}),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            first = executor.submit(cache.ensure_ready)
            try:
                assert first_fetch.wait(5)
                second = executor.submit(cache.ensure_ready)
                wait([second], timeout=1)
            finally:
                release_fetch.set()
            first.result(timeout=5)
            second.result(timeout=5)

        assert [doc.uri for doc in cache.get_index().docs] == [url]


class TestEnsurePageIndexUpdate:
    """Tests for ensure_page updating the index."""

    def test_ensure_page_updates_index_with_content(self):
        cache._INDEX = indexer.IndexSearch()
        cache._URL_CACHE["https://strandsagents.com/test.md"] = None
        doc = indexer.Doc(
            uri="https://strandsagents.com/test.md",
            display_title="Test Doc",
            content="",
            index_title="test doc",
        )
        cache._INDEX.add(doc)

        results_before = cache._INDEX.search("guardrail")
        assert len(results_before) == 0

        mock_raw = MagicMock()
        mock_raw.title = "Test Doc"
        mock_raw.content = "This document explains guardrail implementation patterns."

        with patch("strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean", return_value=mock_raw):
            with patch("strands_mcp_server.utils.cache.text_processor.format_display_title", return_value="Test Doc"):
                page = cache.ensure_page("https://strandsagents.com/test.md")

        assert page is not None
        assert page.content == mock_raw.content

        results_after = cache._INDEX.search("guardrail")
        assert len(results_after) == 1
        assert results_after[0][1].uri == "https://strandsagents.com/test.md"

    def test_ensure_page_idempotent_on_cached(self):
        cached_page = Page(url="https://example.com/cached", title="Cached", content="content")
        cache._URL_CACHE["https://example.com/cached"] = cached_page

        with patch("strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean") as mock_fetch:
            result = cache.ensure_page("https://example.com/cached")

        assert result is cached_page
        mock_fetch.assert_not_called()

    def test_ensure_page_handles_fetch_failure(self):
        cache._URL_CACHE["https://example.com/fail"] = None

        with patch(
            "strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean", side_effect=Exception("Network error")
        ):
            result = cache.ensure_page("https://example.com/fail")

        assert result is None


class TestPrefetchEnvVar:
    """Tests for background prefetch environment variable."""

    def test_prefetch_disabled_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            if cache.PREFETCH_ENV_VAR in os.environ:
                del os.environ[cache.PREFETCH_ENV_VAR]
            assert cache._is_prefetch_enabled() is False

    def test_prefetch_enabled_with_1(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "1"}):
            assert cache._is_prefetch_enabled() is True

    def test_prefetch_enabled_with_true(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "true"}):
            assert cache._is_prefetch_enabled() is True

    def test_prefetch_enabled_with_yes(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "yes"}):
            assert cache._is_prefetch_enabled() is True

    def test_prefetch_disabled_with_other_values(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "0"}):
            assert cache._is_prefetch_enabled() is False

        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "false"}):
            assert cache._is_prefetch_enabled() is False

        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "no"}):
            assert cache._is_prefetch_enabled() is False


class TestBackgroundPrefetch:
    """Tests for background prefetch functionality."""

    def test_start_prefetch_only_when_enabled(self):
        with patch.dict(os.environ, {}, clear=True):
            with patch("strands_mcp_server.utils.cache.threading.Thread") as mock_thread:
                cache._start_background_prefetch()
                mock_thread.assert_not_called()

    def test_start_prefetch_when_enabled(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "1"}):
            with patch("strands_mcp_server.utils.cache.threading.Thread") as mock_thread:
                mock_instance = MagicMock()
                mock_thread.return_value = mock_instance

                cache._start_background_prefetch()

                mock_thread.assert_called_once()
                mock_instance.start.assert_called_once()

    def test_start_prefetch_idempotent(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "1"}):
            with patch("strands_mcp_server.utils.cache.threading.Thread") as mock_thread:
                mock_instance = MagicMock()
                mock_thread.return_value = mock_instance

                cache._start_background_prefetch()
                cache._start_background_prefetch()
                cache._start_background_prefetch()

                assert mock_thread.call_count == 1

    def test_load_links_only_triggers_prefetch_when_enabled(self):
        with patch.dict(os.environ, {cache.PREFETCH_ENV_VAR: "1"}):
            with patch("strands_mcp_server.utils.cache.doc_fetcher.parse_llms_txt", return_value=[]):
                with patch("strands_mcp_server.utils.cache.doc_config") as mock_config:
                    mock_config.llm_texts_url = []
                    with patch("strands_mcp_server.utils.cache.threading.Thread") as mock_thread:
                        mock_instance = MagicMock()
                        mock_thread.return_value = mock_instance

                        cache.load_links_only()

                        mock_thread.assert_called_once()


LLMS_TXT = """# Strands Agents

- [Quickstart](https://strandsagents.com/docs/user-guide/sdk/quickstart/python/index.md): Get an agent running.
- [quickstart](https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/index.md): Run your first evaluation.
- [sessions](https://strandsagents.com/docs/user-guide/harness/configure/sessions/index.md): Persist a conversation.
- [Changelog](https://strandsagents.com/changelog/index.md): All releases
"""


class TestLoadLinksIndexing:
    """Tests for what load_links_only and ensure_page make searchable."""

    @pytest.fixture(autouse=True)
    def loaded(self):
        with patch("strands_mcp_server.utils.cache.doc_fetcher._get", return_value=LLMS_TXT):
            with patch("strands_mcp_server.utils.cache.doc_config") as mock_config:
                mock_config.llm_texts_url = ["https://strandsagents.com/llms.txt"]
                cache.load_links_only()

    def test_url_path_words_are_searchable(self):
        results = cache._INDEX.search("evals quickstart")

        assert results[0][1] == indexer.Doc(
            uri="https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/index.md",
            display_title="quickstart",
            content="",
            index_title="quickstart docs user guide evals sdk quickstart Run your first evaluation.",
        )

    def test_llms_txt_description_is_searchable(self):
        results = cache._INDEX.search("persist conversation")

        assert [doc.uri for _, doc in results] == [
            "https://strandsagents.com/docs/user-guide/harness/configure/sessions/index.md"
        ]

    def test_aggregate_page_body_is_not_indexed(self):
        url = "https://strandsagents.com/changelog/index.md"
        with patch(
            "strands_mcp_server.utils.cache.doc_fetcher.fetch_and_clean",
            return_value=Page(url, "x", "quickstart " * 100),
        ):
            page = cache.ensure_page(url)

        assert page == Page(url, "Changelog", "quickstart " * 100)
        assert [doc.uri for _, doc in cache._INDEX.search("quickstart")] == [
            "https://strandsagents.com/docs/user-guide/sdk/quickstart/python/index.md",
            "https://strandsagents.com/docs/user-guide/evals-sdk/quickstart/index.md",
        ]
