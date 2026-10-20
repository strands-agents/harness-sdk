"""Tests for the keyword search strategy."""

import asyncio

import pytest

from strands.storage.in_memory_storage import InMemoryStorage
from strands.storage.search.keyword import KeywordSearchStrategy, token_overlap_score, tokenize
from strands.types.exceptions import StorageError


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

    @pytest.mark.asyncio
    async def test_index_is_noop(self, storage):
        await KeywordSearchStrategy().index(storage, "key", b"data")

    @pytest.mark.asyncio
    async def test_skips_entries_whose_read_fails(self, storage):
        await storage.write("good.md", b"dark mode")
        await storage.write("locked.md", b"dark mode")
        original_read = storage.read

        async def failing_read(key):
            if key == "locked.md":
                raise StorageError("Failed to read 'locked.md'")
            return await original_read(key)

        storage.read = failing_read

        results = await KeywordSearchStrategy().search(storage, "dark mode")
        assert [result.key for result in results] == ["good.md"]

    @pytest.mark.asyncio
    async def test_ignores_stop_words_in_query(self, storage):
        await storage.write("deploy.md", b"the deploy process runs nightly")
        await storage.write("weather.md", b"what is the weather like")

        results = await KeywordSearchStrategy().search(storage, "what is the deploy process")
        assert [result.key for result in results] == ["deploy.md"]

    @pytest.mark.asyncio
    async def test_returns_empty_for_stop_word_only_query(self, storage):
        await storage.write("note.md", b"what is the plan")
        assert await KeywordSearchStrategy().search(storage, "what is the") == []

    @pytest.mark.asyncio
    async def test_does_not_score_key_file_extension(self, storage):
        await storage.write("release-notes.md", b"ship on fridays")

        assert await KeywordSearchStrategy().search(storage, "update AGENTS.md") == []
        results = await KeywordSearchStrategy().search(storage, "release")
        assert [result.key for result in results] == ["release-notes.md"]

    @pytest.mark.asyncio
    async def test_reads_entries_in_concurrent_batches_of_at_most_8(self, storage):
        for index in range(20):
            await storage.write(f"note-{index}.md", b"dark mode")
        original_read = storage.read
        in_flight = 0
        max_in_flight = 0

        async def tracking_read(key):
            nonlocal in_flight, max_in_flight
            in_flight += 1
            max_in_flight = max(max_in_flight, in_flight)
            await asyncio.sleep(0.001)
            in_flight -= 1
            return await original_read(key)

        storage.read = tracking_read

        results = await KeywordSearchStrategy().search(storage, "dark mode")
        assert len(results) == 20
        assert max_in_flight == 8
