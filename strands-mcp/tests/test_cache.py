"""Tests for cache module hydration and prefetch functionality."""

import os
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
