"""Tests for the BM25 search strategy."""

import asyncio
import os
import tempfile

import pytest

from strands.storage.local_file_storage import LocalFileStorage
from strands.storage.search.bm25 import STOP_WORDS, Bm25SearchStrategy, Bm25SearchStrategyConfig, _build_query


class TestBuildQuery:
    def test_returns_none_for_empty_query(self):
        assert _build_query("") is None

    def test_returns_none_for_stop_words_only(self):
        assert _build_query("the and is") is None

    def test_returns_none_for_single_char_terms(self):
        assert _build_query("a I") is None

    def test_filters_stop_words_and_short_terms(self):
        result = _build_query("the authentication flow")
        assert result == "authentication flow"

    def test_joins_terms_sorted(self):
        result = _build_query("OAuth authentication tokens")
        assert result == "authentication oauth tokens"


class TestStopWords:
    def test_contains_common_words(self):
        assert "the" in STOP_WORDS
        assert "and" in STOP_WORDS
        assert "is" in STOP_WORDS

    def test_does_not_contain_content_words(self):
        assert "authentication" not in STOP_WORDS
        assert "deploy" not in STOP_WORDS


class TestBm25SearchStrategy:
    @pytest.fixture
    def temp_dir(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield tmpdir

    @pytest.fixture
    def storage(self, temp_dir):
        return LocalFileStorage(temp_dir)

    @pytest.fixture
    def strategy(self):
        return Bm25SearchStrategy()

    @pytest.mark.asyncio
    async def test_indexes_and_returns_relevant_results(self, storage, strategy):
        await strategy.index(storage, "auth.md", b"# Authentication\nUsers authenticate via OAuth2 with JWT tokens.")
        await strategy.index(storage, "deploy.md", b"# Deployment\nWe deploy to ECS using Fargate with auto-scaling.")
        await strategy.index(storage, "testing.md", b"# Testing\nUnit tests use pytest. Integration tests hit DBs.")

        results = await strategy.search(storage, "authentication JWT tokens")
        await strategy.close()

        assert len(results) > 0
        assert results[0].key == "auth.md"
        assert results[0].score > 0
        assert results[0].score <= 1

    @pytest.mark.asyncio
    async def test_returns_empty_for_unrelated_queries(self, storage, strategy):
        await strategy.index(
            storage, "recipes.md", b"# Recipes\nChocolate cake requires flour, sugar, and cocoa powder."
        )

        results = await strategy.search(storage, "kubernetes cluster networking")
        await strategy.close()

        assert results == []

    @pytest.mark.asyncio
    async def test_picks_up_newly_indexed_entries(self, storage, strategy):
        await strategy.index(storage, "initial.md", b"# Initial\nThis file exists from the start.")
        await strategy.search(storage, "initial")

        await strategy.index(storage, "added.md", b"# Caching\nRedis is used for session caching and rate limiting.")

        results = await strategy.search(storage, "Redis caching")
        await strategy.close()

        assert len(results) > 0
        assert results[0].key == "added.md"

    @pytest.mark.asyncio
    async def test_handles_overwritten_entries(self, storage, strategy):
        await strategy.index(storage, "mutable.md", b"# Original\nContent about authentication protocols.")

        results = await strategy.search(storage, "authentication")
        assert len(results) > 0

        await strategy.index(storage, "mutable.md", b"# Changed\nContent about deployment pipelines.")

        results = await strategy.search(storage, "authentication")
        assert results == []

        results = await strategy.search(storage, "deployment pipelines")
        await strategy.close()

        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_scores_are_normalized_between_0_and_1(self, storage, strategy):
        await strategy.index(storage, "doc.md", b"authentication authentication authentication tokens OAuth")

        results = await strategy.search(storage, "authentication tokens")
        await strategy.close()

        assert len(results) > 0
        for result in results:
            assert 0 < result.score <= 1

    @pytest.mark.asyncio
    async def test_close_releases_resources(self, storage, strategy):
        await strategy.index(storage, "doc.md", b"Content about testing.")

        await strategy.search(storage, "testing")
        await strategy.close()

        assert strategy._conn is None
        assert strategy._storage_path is None

    @pytest.mark.asyncio
    async def test_custom_db_path(self, temp_dir, storage):
        db_path = os.path.join(temp_dir, "custom.sqlite")
        strategy = Bm25SearchStrategy(Bm25SearchStrategyConfig(db_path=db_path))

        await strategy.index(storage, "doc.md", b"Content about authentication.")
        await strategy.search(storage, "authentication")
        await strategy.close()

        assert os.path.exists(db_path)

    @pytest.mark.asyncio
    async def test_raises_for_storage_without_base_dir(self):
        class NoBaseDirStorage:
            async def write(self, key, data):
                pass

            async def read(self, key):
                return None

            async def delete(self, key):
                pass

            async def list(self, query=""):
                return []

            async def search(self, query):
                return []

        strategy = Bm25SearchStrategy()
        with pytest.raises(RuntimeError, match="base_dir"):
            await strategy.search(NoBaseDirStorage(), "test query")

    @pytest.mark.asyncio
    async def test_returns_empty_for_stop_words_only_query(self, storage, strategy):
        await strategy.index(storage, "doc.md", b"Some content here.")

        results = await strategy.search(storage, "the and is")
        await strategy.close()

        assert results == []

    @pytest.mark.asyncio
    async def test_skips_hidden_files(self, storage, strategy):
        await strategy.index(storage, ".hidden", b"Secret authentication content.")
        await strategy.index(storage, "visible.md", b"Public deployment content.")

        results = await strategy.search(storage, "authentication")
        await strategy.close()

        assert results == []

    @pytest.mark.asyncio
    async def test_handles_subdirectories(self, storage, strategy):
        await strategy.index(storage, "notes/auth.md", b"# Auth\nOAuth2 authentication flow.")

        results = await strategy.search(storage, "authentication flow")
        await strategy.close()

        assert len(results) > 0
        assert results[0].key == "notes/auth.md"

    @pytest.mark.asyncio
    async def test_skips_reindex_for_unchanged_content(self, storage, strategy):
        data = b"Content about authentication."
        await strategy.index(storage, "doc.md", data)
        await strategy.index(storage, "doc.md", data)

        results = await strategy.search(storage, "authentication")
        await strategy.close()

        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_reconnects_when_storage_changes(self, temp_dir):
        strategy = Bm25SearchStrategy()
        storage_a = LocalFileStorage(os.path.join(temp_dir, "a"))
        storage_b = LocalFileStorage(os.path.join(temp_dir, "b"))

        await strategy.index(storage_a, "doc.md", b"Content about authentication.")
        results = await strategy.search(storage_a, "authentication")
        assert len(results) > 0

        await strategy.index(storage_b, "doc.md", b"Content about deployment.")
        results = await strategy.search(storage_b, "deployment")
        await strategy.close()

        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_concurrent_index_same_key(self, storage, strategy):
        tasks = [strategy.index(storage, "race.md", b"OAuth2 authentication flow") for _ in range(10)]
        await asyncio.gather(*tasks)

        results = await strategy.search(storage, "authentication")
        await strategy.close()

        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_search_after_close_and_reuse(self, storage, strategy):
        await strategy.index(storage, "doc.md", b"OAuth2 authentication flow")
        await strategy.close()

        await strategy.index(storage, "doc.md", b"OAuth2 authentication flow")
        results = await strategy.search(storage, "authentication")
        await strategy.close()

        assert len(results) > 0

    @pytest.mark.asyncio
    async def test_empty_data(self, storage, strategy):
        await strategy.index(storage, "empty.md", b"")
        results = await strategy.search(storage, "anything")
        await strategy.close()

        assert results == []

    @pytest.mark.asyncio
    async def test_binary_non_utf8_data(self, storage, strategy):
        await strategy.index(storage, "binary.bin", b"\x80\x81\x82\xff")
        results = await strategy.search(storage, "authentication")
        await strategy.close()

        assert results == []

    @pytest.mark.asyncio
    async def test_special_chars_in_content(self, storage, strategy):
        await strategy.index(storage, "special.md", b"C++ error(404) Python3")

        results = await strategy.search(storage, "Python3")
        await strategy.close()

        assert len(results) > 0
        assert results[0].key == "special.md"
