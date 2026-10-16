"""Tests for InMemoryStorage."""

from unittest.mock import AsyncMock

import pytest

from strands.storage import InMemoryStorage
from strands.storage.storage import _NAMESPACED
from strands.types.exceptions import StorageError


class TestInMemoryStorage:
    @pytest.fixture
    def storage(self):
        return InMemoryStorage()

    @pytest.mark.asyncio
    async def test_write_and_read(self, storage):
        await storage.write("key", b"hello")
        assert await storage.read("key") == b"hello"

    @pytest.mark.asyncio
    async def test_read_missing_returns_none(self, storage):
        assert await storage.read("nonexistent") is None

    @pytest.mark.asyncio
    async def test_write_overwrites(self, storage):
        await storage.write("key", b"first")
        await storage.write("key", b"second")
        assert await storage.read("key") == b"second"

    @pytest.mark.asyncio
    async def test_delete_existing(self, storage):
        await storage.write("key", b"data")
        await storage.delete("key")
        assert await storage.read("key") is None

    @pytest.mark.asyncio
    async def test_delete_missing_is_noop(self, storage):
        await storage.delete("nonexistent")

    @pytest.mark.asyncio
    async def test_list_all(self, storage):
        await storage.write("b/2", b"")
        await storage.write("a/1", b"")
        await storage.write("c/3", b"")
        keys = await storage.list("")
        assert keys == ["a/1", "b/2", "c/3"]

    @pytest.mark.asyncio
    async def test_list_with_prefix(self, storage):
        await storage.write("sessions/a", b"")
        await storage.write("sessions/b", b"")
        await storage.write("offloader/x", b"")
        keys = await storage.list("sessions/")
        assert keys == ["sessions/a", "sessions/b"]

    @pytest.mark.asyncio
    async def test_list_empty_store(self, storage):
        assert await storage.list("") == []

    @pytest.mark.asyncio
    async def test_key_normalization(self, storage):
        await storage.write("//foo///bar//", b"data")
        assert await storage.read("/foo/bar/") == b"data"

    @pytest.mark.asyncio
    async def test_rejects_empty_key(self, storage):
        with pytest.raises(StorageError):
            await storage.write("", b"data")

    @pytest.mark.asyncio
    async def test_rejects_path_traversal(self, storage):
        with pytest.raises(StorageError):
            await storage.write("../etc/passwd", b"data")

    @pytest.mark.asyncio
    async def test_clear(self, storage):
        await storage.write("key", b"data")
        storage.clear()
        result = await storage.read("key")
        assert result is None

    @pytest.mark.asyncio
    async def test_namespace(self, storage):
        ns = storage.namespace("scope")
        await ns.write("key", b"value")
        assert await ns.read("key") == b"value"
        assert await storage.read("scope/key") == b"value"

    @pytest.mark.asyncio
    async def test_namespace_returns_scoped_instance(self, storage):
        scoped = storage.namespace("memory/agent")
        await scoped.write("notes.md", b"hello")

        assert isinstance(scoped, InMemoryStorage)
        assert getattr(scoped, "_namespaced", None) is _NAMESPACED
        assert await storage.list("") == ["memory/agent/notes.md"]
        assert await scoped.list("") == ["notes.md"]
        await scoped.delete("notes.md")
        assert await storage.list("") == []

    @pytest.mark.asyncio
    async def test_namespace_composes(self, storage):
        await storage.namespace("a").namespace("b/").write("k", b"v")
        assert await storage.list("") == ["a/b/k"]

    @pytest.mark.asyncio
    async def test_namespace_search_is_scoped(self, storage):
        await storage.write("other/memory-agent-notes.md", b"unrelated")
        scoped = storage.namespace("memory/agent")
        await scoped.write("deploy.md", b"blue green deploys")
        await scoped.write("theme.md", b"dark mode")

        results = await scoped.search("memory agent deploy")

        assert [result.key for result in results] == ["deploy.md"]

    @pytest.mark.asyncio
    async def test_namespace_passes_scoped_instance_to_strategy(self):
        strategy = AsyncMock()
        strategy.search.return_value = []
        scoped = InMemoryStorage(search_strategy=strategy).namespace("memory/agent")

        await scoped.write("deploy.md", b"x")
        await scoped.search("query")

        strategy.index.assert_awaited_once_with(scoped, "deploy.md", b"x")
        strategy.search.assert_awaited_once_with(scoped, "query")

    @pytest.mark.asyncio
    async def test_namespace_clear_only_clears_prefix(self, storage):
        await storage.write("keep.md", b"x")
        scoped = storage.namespace("memory")
        await scoped.write("drop.md", b"y")

        scoped.clear()

        assert await storage.list("") == ["keep.md"]

    @pytest.mark.asyncio
    async def test_bytes_are_copied_on_write(self, storage):
        data = bytearray(b"mutable")
        await storage.write("key", data)
        data[0] = 0xFF
        assert await storage.read("key") == b"mutable"

    @pytest.mark.asyncio
    async def test_search_returns_matching_results(self, storage):
        await storage.write("dark-mode.md", b"enable dark mode in settings")
        await storage.write("deploy.md", b"deploy to production")
        results = await storage.search("dark mode")
        assert len(results) == 1
        assert results[0].key == "dark-mode.md"
        assert results[0].score > 0

    @pytest.mark.asyncio
    async def test_write_indexes_with_search_strategy(self):
        strategy = AsyncMock()
        storage = InMemoryStorage(search_strategy=strategy)
        await storage.write("key", b"data")
        strategy.index.assert_awaited_once_with(storage, "key", b"data")

    @pytest.mark.asyncio
    async def test_search_delegates_to_strategy(self):
        strategy = AsyncMock()
        strategy.search.return_value = []
        storage = InMemoryStorage(search_strategy=strategy)
        await storage.search("query")
        strategy.search.assert_awaited_once_with(storage, "query")
