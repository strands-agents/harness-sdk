"""Tests for FileMemoryStore."""

from unittest.mock import AsyncMock, patch

import pytest

from strands.storage.in_memory_storage import InMemoryStorage
from strands.vended_memory_stores.file_memory_store import FileMemoryStore


@pytest.fixture
def storage():
    return InMemoryStorage()


@pytest.fixture
def store(storage):
    return FileMemoryStore(name="test-store", description="A test file memory store", storage=storage)


class TestConstructor:
    def test_sets_name_and_description(self, store):
        assert store.name == "test-store"
        assert store.description == "A test file memory store"

    def test_defaults_writable_true(self, store):
        assert store.writable is True

    def test_respects_writable_false(self, storage):
        read_only = FileMemoryStore(name="readonly", storage=storage, writable=False)
        assert read_only.writable is False

    def test_defaults_no_description_when_omitted(self, storage):
        minimal = FileMemoryStore(name="minimal", storage=storage)
        assert minimal.description is None

    @pytest.mark.asyncio
    async def test_auto_scopes_keys_under_memory_name(self, store, storage):
        await store.add("User prefers dark mode")
        assert await storage.read("memory/test-store/user-prefers-dark-mode.md") is not None
        assert await storage.read("user-prefers-dark-mode.md") is None

    @pytest.mark.asyncio
    async def test_scopes_distinct_stores_on_shared_backend(self, storage):
        store_a = FileMemoryStore(name="store-a", storage=storage)
        store_b = FileMemoryStore(name="store-b", storage=storage)
        await store_a.add("User prefers dark mode")
        await store_b.add("User prefers light mode")

        raw_a = await storage.read("memory/store-a/user-prefers-dark-mode.md")
        raw_b = await storage.read("memory/store-b/user-prefers-light-mode.md")
        assert raw_a is not None
        assert b"dark mode" in raw_a
        assert raw_b is not None
        assert b"light mode" in raw_b

        results_a = await store_a.search("mode")
        results_b = await store_b.search("mode")
        assert len(results_a) == 1
        assert len(results_b) == 1

    @pytest.mark.asyncio
    async def test_does_not_re_scope_already_namespaced_storage(self, storage):
        pre_scoped = storage.namespace("memory/scoped")
        scoped_store = FileMemoryStore(name="scoped", storage=pre_scoped)
        await scoped_store.add("User prefers dark mode")
        assert await storage.read("memory/scoped/user-prefers-dark-mode.md") is not None
        assert await storage.read("memory/scoped/memory/scoped/user-prefers-dark-mode.md") is None


class TestAdd:
    @pytest.mark.asyncio
    async def test_writes_plain_markdown_content(self, store, storage):
        await store.add("User prefers dark mode")
        scoped = storage.namespace("memory/test-store")
        data = await scoped.read("user-prefers-dark-mode.md")
        assert data is not None
        assert data.decode() == "User prefers dark mode"

    @pytest.mark.asyncio
    async def test_derives_filename_from_first_line(self, store, storage):
        await store.add("The user likes vim keybindings\nMore details here")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert len(keys) == 1
        assert keys[0] == "the-user-likes-vim-keybindings.md"

    @pytest.mark.asyncio
    async def test_truncates_slug_at_50_chars(self, store, storage):
        long_content = "this is a very long sentence that should be truncated when used as a filename slug for storage"
        await store.add(long_content)
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        slug = keys[0].removesuffix(".md")
        assert len(slug) <= 50

    @pytest.mark.asyncio
    async def test_appends_new_facts_to_existing_entry(self, store, storage):
        await store.add("Python is great\nFast prototyping")
        await store.add("Python is great\nBut it has a GIL.")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert len(keys) == 1
        assert keys[0] == "python-is-great.md"
        content = (await scoped.read("python-is-great.md")).decode()
        assert content == "Python is great\nFast prototyping\nBut it has a GIL."

    @pytest.mark.asyncio
    async def test_does_not_duplicate_when_new_entry_has_only_heading(self, store, storage):
        await store.add("Python is great\nFast prototyping")
        await store.add("Python is great")
        scoped = storage.namespace("memory/test-store")
        content = (await scoped.read("python-is-great.md")).decode()
        assert content == "Python is great\nFast prototyping"

    @pytest.mark.asyncio
    async def test_fallback_slug_when_content_produces_empty(self, store, storage):
        await store.add("!!!???")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert len(keys) == 1
        assert keys[0].startswith("entry-")
        assert keys[0].endswith(".md")

    @pytest.mark.asyncio
    async def test_slugifies_special_characters(self, store, storage):
        await store.add("User's #1 testing rule!")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert keys[0] == "users-1-testing-rule.md"

    @pytest.mark.asyncio
    async def test_returns_canonical_key(self, store):
        key = await store.add("User prefers dark mode")
        assert key == "user-prefers-dark-mode.md"

    @pytest.mark.asyncio
    async def test_returns_same_key_on_append(self, store):
        key1 = await store.add("Python is great\nFirst fact")
        key2 = await store.add("Python is great\nSecond fact")
        assert key1 == key2

    @pytest.mark.asyncio
    async def test_strips_markdown_heading_prefix(self, store, storage):
        await store.add("# User preferences\nLikes dark mode")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert keys[0] == "user-preferences.md"
        content = (await scoped.read("user-preferences.md")).decode()
        assert content == "# User preferences\nLikes dark mode"

    @pytest.mark.asyncio
    async def test_strips_multiple_heading_levels(self, store, storage):
        await store.add("## Project setup\nTypeScript monorepo")
        scoped = storage.namespace("memory/test-store")
        keys = await scoped.list("")
        assert keys[0] == "project-setup.md"

    @pytest.mark.asyncio
    async def test_no_trailing_hyphen_on_truncation(self, store):
        content = "aaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh iiiii jjjjj"
        key = await store.add(content)
        assert not key.startswith("-")
        assert "-." not in key


class TestSearch:
    async def _populate(self, store):
        await store.add("User prefers dark mode for all editors")
        await store.add("Testing philosophy: integration first, mock at boundaries")
        await store.add("Deploy process uses blue-green strategy")

    @pytest.mark.asyncio
    async def test_returns_matching_entries_by_keyword(self, store):
        await self._populate(store)
        results = await store.search("dark mode")
        assert results[0].content == "User prefers dark mode for all editors"

    @pytest.mark.asyncio
    async def test_matches_against_filenames(self, store):
        await self._populate(store)
        results = await store.search("deploy")
        assert results[0].content == "Deploy process uses blue-green strategy"

    @pytest.mark.asyncio
    async def test_case_insensitive(self, store):
        await self._populate(store)
        results = await store.search("DARK MODE")
        assert results[0].content == "User prefers dark mode for all editors"

    @pytest.mark.asyncio
    async def test_returns_empty_for_no_matches(self, store):
        await self._populate(store)
        assert await store.search("quantum computing") == []

    @pytest.mark.asyncio
    async def test_returns_empty_for_empty_query(self, store):
        await self._populate(store)
        assert await store.search("") == []

    @pytest.mark.asyncio
    async def test_returns_empty_for_whitespace_query(self, store):
        await self._populate(store)
        assert await store.search("   ") == []

    @pytest.mark.asyncio
    async def test_respects_max_search_results_option(self, store):
        await self._populate(store)
        results = await store.search("process", {"max_search_results": 1})
        assert len(results) == 1

    @pytest.mark.asyncio
    async def test_ranks_by_distinct_matching_tokens(self, store):
        await self._populate(store)
        await store.add("covers deploy, testing, and integration boundaries")
        results = await store.search("deploy testing integration")
        assert results[0].content == "covers deploy, testing, and integration boundaries"

    @pytest.mark.asyncio
    async def test_includes_path_in_metadata(self, store):
        await self._populate(store)
        results = await store.search("deploy")
        assert results[0].metadata is not None
        assert results[0].metadata["path"] == "deploy-process-uses-blue-green-strategy.md"

    @pytest.mark.asyncio
    async def test_uses_default_max_search_results(self, storage):
        big_store = FileMemoryStore(name="big", storage=storage)
        for index in range(15):
            await big_store.add(f"Fact number {index}")
        results = await big_store.search("fact")
        assert len(results) == 10

    @pytest.mark.asyncio
    async def test_respects_config_max_search_results(self, storage):
        custom_store = FileMemoryStore(name="custom", storage=storage, max_search_results=2)
        for index in range(5):
            await custom_store.add(f"Fact number {index}")
        results = await custom_store.search("fact")
        assert len(results) == 2


class TestExtraction:
    @pytest.mark.asyncio
    async def test_extraction_true_creates_key_aware_extractor(self, storage):
        store = FileMemoryStore(name="ext-test", storage=storage, extraction=True)
        assert store.extraction is not None
        assert store.extraction is not True
        assert "extractor" in store.extraction

    @pytest.mark.asyncio
    async def test_extraction_dict_without_extractor_creates_key_aware(self, storage):
        from strands.memory.extraction.types import MemoryMessageFilter

        custom_filter = MemoryMessageFilter(exclude=["image"])
        store = FileMemoryStore(name="ext-test", storage=storage, extraction={"filter": custom_filter})
        assert store.extraction is not None
        assert "extractor" in store.extraction
        assert store.extraction["filter"] is custom_filter

    @pytest.mark.asyncio
    async def test_extraction_dict_with_extractor_preserves_it(self, storage):
        custom_extractor = AsyncMock()
        store = FileMemoryStore(name="ext-test", storage=storage, extraction={"extractor": custom_extractor})
        assert store.extraction["extractor"] is custom_extractor

    @pytest.mark.asyncio
    async def test_extraction_false_returns_false(self, storage):
        store = FileMemoryStore(name="ext-test", storage=storage, extraction=False)
        assert store.extraction is False

    @pytest.mark.asyncio
    async def test_extraction_none_returns_none(self, storage):
        store = FileMemoryStore(name="ext-test", storage=storage)
        assert store.extraction is None

    @pytest.mark.asyncio
    async def test_key_aware_extractor_includes_headings_in_prompt(self, storage):
        store = FileMemoryStore(name="ext-test", storage=storage, extraction=True)
        await store.add("# User preferences\nPrefers dark mode\nUses vim")
        await store.add("# Project setup\nTypeScript monorepo")

        extractor = store.extraction["extractor"]

        with patch("strands.vended_memory_stores.file_memory_store.store.ModelExtractor") as mock_model_extractor_cls:
            mock_instance = AsyncMock()
            mock_instance.extract = AsyncMock(return_value=[])
            mock_model_extractor_cls.return_value = mock_instance

            messages = [{"role": "user", "content": [{"text": "I also prefer light themes"}]}]
            await extractor.extract(messages, None)

            mock_model_extractor_cls.assert_called_once()
            call_kwargs = mock_model_extractor_cls.call_args[1]
            system_prompt = call_kwargs["system_prompt"]
            assert "Existing topics:" in system_prompt
            assert "user preferences" in system_prompt
            assert "project setup" in system_prompt
            assert "Reuse an existing topic heading" in system_prompt
