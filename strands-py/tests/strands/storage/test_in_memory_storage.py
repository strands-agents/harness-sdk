"""Tests for InMemoryStorage."""

from unittest.mock import AsyncMock

import pytest

from strands.storage import InMemoryStorage
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
