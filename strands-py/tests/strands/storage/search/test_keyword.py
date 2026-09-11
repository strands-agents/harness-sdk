"""Tests for the keyword search strategy."""

import pytest

from strands.storage.in_memory_storage import InMemoryStorage
from strands.storage.search.keyword import KeywordSearchStrategy, token_overlap_score, tokenize


class TestTokenize:
    def test_splits_on_non_word_characters(self):
        result = tokenize("hello world")
        assert result == {"hello", "world"}

    def test_lowercases_tokens(self):
        result = tokenize("Hello WORLD")
        assert result == {"hello", "world"}

    def test_drops_empty_strings(self):
        result = tokenize("  hello   world  ")
        assert result == {"hello", "world"}

    def test_empty_input_returns_empty_set(self):
        assert tokenize("") == set()

    def test_whitespace_only_returns_empty_set(self):
        assert tokenize("   ") == set()

    def test_includes_underscores_in_tokens(self):
        result = tokenize("snake_case variable")
        assert "snake_case" in result

    def test_handles_unicode(self):
        result = tokenize("café résumé")
        assert "café" in result
        assert "résumé" in result


class TestTokenOverlapScore:
    def test_counts_matching_tokens(self):
        query_tokens = {"dark", "mode"}
        score = token_overlap_score(query_tokens, "enable dark mode in settings")
        assert score == 2

    def test_returns_zero_for_no_overlap(self):
        query_tokens = {"kubernetes", "deployment"}
        score = token_overlap_score(query_tokens, "completely unrelated content")
        assert score == 0

    def test_case_insensitive(self):
        query_tokens = {"dark", "mode"}
        score = token_overlap_score(query_tokens, "Dark Mode Toggle")
        assert score == 2


class TestKeywordSearch:
    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.mark.asyncio
    async def test_returns_matching_entries_scored_by_token_overlap(self, storage):
        await storage.write("notes/dark-mode.md", b"enable dark mode in settings")
        await storage.write("notes/deploy.md", b"deploy to production")

        results = await KeywordSearchStrategy().search(storage, "dark mode")

        assert len(results) == 1
        assert results[0].key == "notes/dark-mode.md"
        assert results[0].score > 0

    @pytest.mark.asyncio
    async def test_returns_empty_for_empty_query(self, storage):
        await storage.write("key", b"content")
        results = await KeywordSearchStrategy().search(storage, "")
        assert results == []

    @pytest.mark.asyncio
    async def test_returns_empty_for_whitespace_query(self, storage):
        await storage.write("key", b"content")
        results = await KeywordSearchStrategy().search(storage, "   ")
        assert results == []

    @pytest.mark.asyncio
    async def test_matches_case_insensitively(self, storage):
        await storage.write("note.md", b"Dark Mode Toggle")
        results = await KeywordSearchStrategy().search(storage, "dark mode")
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_includes_key_in_scoring(self, storage):
        await storage.write("dark-mode.md", b"some unrelated body")
        results = await KeywordSearchStrategy().search(storage, "dark mode")
        assert len(results) == 1
        assert results[0].key == "dark-mode.md"

    @pytest.mark.asyncio
    async def test_ranks_by_score_descending(self, storage):
        await storage.write("a.md", b"dark")
        await storage.write("b.md", b"dark mode toggle feature")

        results = await KeywordSearchStrategy().search(storage, "dark mode")

        assert len(results) == 2
        assert results[0].score >= results[1].score

    @pytest.mark.asyncio
    async def test_skips_keys_where_read_returns_none(self, storage):
        await storage.write("exists.md", b"dark mode content")
        storage._store["ghost.md"] = b"dark"
        original_read = storage.read

        async def patched_read(key):
            if key == "ghost.md":
                return None
            return await original_read(key)

        storage.read = patched_read

        results = await KeywordSearchStrategy().search(storage, "dark")
        assert len(results) == 1
        assert results[0].key == "exists.md"

    @pytest.mark.asyncio
    async def test_returns_empty_for_no_matches(self, storage):
        await storage.write("note.md", b"completely unrelated content")
        results = await KeywordSearchStrategy().search(storage, "kubernetes deployment")
        assert results == []
