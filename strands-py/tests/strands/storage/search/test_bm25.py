"""Tests for the BM25 search strategy."""

import asyncio
import os
import sqlite3
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
        assert result == "authentication* flow*"

    def test_joins_terms_sorted(self):
        result = _build_query("OAuth authentication tokens")
        assert result == "authentication* oauth* tokens*"


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

        assert strategy._conns == {}

    @pytest.mark.asyncio
    async def test_custom_db_path(self, temp_dir, storage):
        db_path = os.path.join(temp_dir, "custom.sqlite")
        strategy = Bm25SearchStrategy(Bm25SearchStrategyConfig(db_path=db_path))

        await strategy.index(storage, "doc.md", b"Content about authentication.")
        await strategy.search(storage, "authentication")
        await strategy.close()

        assert os.path.exists(db_path)

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
    async def test_keeps_one_index_per_directory_when_storages_alternate(self, temp_dir):
        strategy = Bm25SearchStrategy()
        storage_a = LocalFileStorage(os.path.join(temp_dir, "a"))
        storage_b = LocalFileStorage(os.path.join(temp_dir, "b"))

        await strategy.index(storage_a, "doc.md", b"Content about authentication.")
        conn_a = strategy._ensure_connection(storage_a)
        await strategy.index(storage_b, "doc.md", b"Content about deployment.")

        results_a = await strategy.search(storage_a, "authentication")
        results_b = await strategy.search(storage_b, "deployment")
        cross = await strategy.search(storage_a, "deployment")

        assert strategy._ensure_connection(storage_a) is conn_a
        assert len(strategy._conns) == 2
        await strategy.close()

        assert [r.key for r in results_a] == ["doc.md"]
        assert [r.key for r in results_b] == ["doc.md"]
        assert cross == []
        assert os.path.exists(os.path.join(temp_dir, ".__strands_a-fts5.sqlite"))
        assert os.path.exists(os.path.join(temp_dir, ".__strands_b-fts5.sqlite"))

    @pytest.mark.asyncio
    async def test_namespaced_storages_share_strategy_without_reopening(self, temp_dir):
        strategy = Bm25SearchStrategy()
        root = LocalFileStorage(temp_dir, search_strategy=strategy)
        memory_a = root.namespace("memory/a")
        memory_b = root.namespace("memory/b")

        await memory_a.write("notes.md", b"OAuth2 authentication flow")
        await memory_b.write("notes.md", b"ECS deployment pipeline")
        for _ in range(3):
            assert [r.key for r in await memory_a.search("authentication")] == ["notes.md"]
            assert [r.key for r in await memory_b.search("deployment")] == ["notes.md"]
            assert await memory_a.search("deployment") == []

        assert len(strategy._conns) == 2
        await strategy.close()

    @pytest.mark.asyncio
    async def test_close_closes_every_connection(self, temp_dir):
        strategy = Bm25SearchStrategy()
        storage_a = LocalFileStorage(os.path.join(temp_dir, "a"))
        storage_b = LocalFileStorage(os.path.join(temp_dir, "b"))
        await strategy.index(storage_a, "doc.md", b"authentication")
        await strategy.index(storage_b, "doc.md", b"deployment")
        conns = list(strategy._conns.values())

        await strategy.close()

        assert strategy._conns == {}
        for conn in conns:
            with pytest.raises(sqlite3.ProgrammingError):
                conn.execute("SELECT 1")

    @pytest.mark.asyncio
    async def test_explicit_db_path_rejects_a_second_directory(self, temp_dir):
        db_path = os.path.join(temp_dir, "shared.sqlite")
        strategy = Bm25SearchStrategy(Bm25SearchStrategyConfig(db_path=db_path))
        storage_a = LocalFileStorage(os.path.join(temp_dir, "a"))
        storage_b = LocalFileStorage(os.path.join(temp_dir, "b"))
        await strategy.index(storage_a, "doc.md", b"Content about authentication.")

        with pytest.raises(ValueError, match="already indexes .* and cannot also index"):
            await strategy.index(storage_b, "doc.md", b"Content about deployment.")
        with pytest.raises(ValueError, match="already indexes"):
            await strategy.search(storage_b, "deployment")

        results = await strategy.search(storage_a, "authentication")
        await strategy.close()
        assert [r.key for r in results] == ["doc.md"]

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
