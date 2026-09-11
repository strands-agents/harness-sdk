"""Tests for LocalFileStorage."""

import os

import pytest

from strands.storage import LocalFileStorage
from strands.types.exceptions import StorageError


class TestLocalFileStorage:
    @pytest.fixture
    def storage(self, tmp_path):
        return LocalFileStorage(str(tmp_path) + "/")

    @pytest.mark.asyncio
    async def test_write_and_read(self, storage):
        await storage.write("key.txt", b"hello")
        assert await storage.read("key.txt") == b"hello"

    @pytest.mark.asyncio
    async def test_write_creates_directories(self, storage, tmp_path):
        await storage.write("a/b/c/file.txt", b"deep")
        assert await storage.read("a/b/c/file.txt") == b"deep"
        assert os.path.isfile(os.path.join(str(tmp_path), "a/b/c/file.txt"))

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
        await storage.write("b", b"")
        await storage.write("a", b"")
        await storage.write("c", b"")
        keys = await storage.list("")
        assert keys == ["a", "b", "c"]

    @pytest.mark.asyncio
    async def test_list_with_prefix(self, storage):
        await storage.write("sessions/a", b"")
        await storage.write("sessions/b", b"")
        await storage.write("offloader/x", b"")
        keys = await storage.list("sessions/")
        assert keys == ["sessions/a", "sessions/b"]

    @pytest.mark.asyncio
    async def test_list_nested(self, storage):
        await storage.write("a/1", b"")
        await storage.write("a/2", b"")
        await storage.write("a/sub/3", b"")
        keys = await storage.list("a/")
        assert keys == ["a/1", "a/2", "a/sub/3"]

    @pytest.mark.asyncio
    async def test_list_empty_dir(self, storage):
        assert await storage.list("") == []

    @pytest.mark.asyncio
    async def test_rejects_path_traversal(self, storage):
        with pytest.raises(StorageError):
            await storage.write("../escape", b"data")

    @pytest.mark.asyncio
    async def test_rejects_empty_key(self, storage):
        with pytest.raises(StorageError):
            await storage.write("", b"data")

    @pytest.mark.asyncio
    async def test_atomic_write(self, storage, tmp_path):
        await storage.write("file.txt", b"content")
        # No temp files remain
        all_files = list(tmp_path.rglob("*"))
        assert not any("__strands_tmp" in str(f) for f in all_files)

    @pytest.mark.asyncio
    async def test_namespace(self, storage):
        ns = storage.namespace("scope")
        await ns.write("key", b"value")
        assert await ns.read("key") == b"value"
        assert await storage.read("scope/key") == b"value"

    def test_namespace_returns_local_file_storage(self, storage, tmp_path):
        from strands.storage.storage import _NAMESPACED

        ns = storage.namespace("scope")
        assert isinstance(ns, LocalFileStorage)
        assert ns.base_dir == os.path.join(str(tmp_path), "scope")
        assert ns._namespaced is _NAMESPACED

    def test_normpath_prevents_trailing_slash_in_namespace(self, tmp_path):
        storage = LocalFileStorage(str(tmp_path) + "/")
        ns = storage.namespace("scope")
        assert not ns.base_dir.endswith("/")
        assert os.sep + "scope" in ns.base_dir

    @pytest.mark.asyncio
    async def test_search_returns_matching_results(self, storage):
        await storage.write("notes/dark-mode.md", b"enable dark mode in settings")
        await storage.write("notes/deploy.md", b"deploy to production")
        results = await storage.search("dark mode")
        assert len(results) == 1
        assert results[0].key == "notes/dark-mode.md"
        assert results[0].score > 0

    @pytest.mark.asyncio
    async def test_key_normalization(self, storage):
        await storage.write("//foo///bar//", b"data")
        assert await storage.read("foo/bar") == b"data"

    @pytest.mark.asyncio
    async def test_binary_round_trip(self, storage):
        binary_data = bytes(range(256))
        await storage.write("binary.bin", binary_data)
        assert await storage.read("binary.bin") == binary_data

    def test_for_sandbox_returns_self_if_same(self, tmp_path):
        from unittest.mock import MagicMock

        sandbox = MagicMock()
        storage = LocalFileStorage(str(tmp_path), sandbox=sandbox)
        assert storage.for_sandbox(sandbox) is storage

    def test_for_sandbox_returns_new_if_different(self, tmp_path):
        from unittest.mock import MagicMock

        sandbox1 = MagicMock()
        sandbox2 = MagicMock()
        storage = LocalFileStorage(str(tmp_path), sandbox=sandbox1)
        new_storage = storage.for_sandbox(sandbox2)
        assert new_storage is not storage

    @pytest.mark.asyncio
    async def test_sandbox_binary_round_trip(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        binary_data = bytes(range(256))
        sandbox = MagicMock()
        sandbox.write_file = AsyncMock()
        sandbox.read_file = AsyncMock(return_value=binary_data)

        storage = LocalFileStorage(str(tmp_path), sandbox=sandbox)
        await storage.write("img.png", binary_data)
        sandbox.write_file.assert_called_once()
        assert sandbox.write_file.call_args[0][1] == binary_data

        result = await storage.read("img.png")
        assert result == binary_data

    @pytest.mark.asyncio
    async def test_sandbox_delete(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        sandbox = MagicMock()
        sandbox.remove_file = AsyncMock()
        storage = LocalFileStorage(str(tmp_path), sandbox=sandbox)
        await storage.delete("key.txt")
        sandbox.remove_file.assert_called_once()

    @pytest.mark.asyncio
    async def test_sandbox_delete_missing_is_noop(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        sandbox = MagicMock()
        sandbox.remove_file = AsyncMock(side_effect=FileNotFoundError)
        storage = LocalFileStorage(str(tmp_path), sandbox=sandbox)
        await storage.delete("missing.txt")

    @pytest.mark.asyncio
    async def test_sandbox_list(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        entry = MagicMock()
        entry.name = "file.txt"
        entry.is_dir = False
        sandbox = MagicMock()
        sandbox.list_files = AsyncMock(return_value=[entry])
        storage = LocalFileStorage(str(tmp_path) + "/", sandbox=sandbox)
        keys = await storage.list("")
        assert keys == ["file.txt"]

    @pytest.mark.asyncio
    async def test_sandbox_list_nested(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        dir_entry = MagicMock()
        dir_entry.name = "sub"
        dir_entry.is_dir = True
        file_entry = MagicMock()
        file_entry.name = "nested.txt"
        file_entry.is_dir = False
        sandbox = MagicMock()
        sandbox.list_files = AsyncMock(side_effect=[[dir_entry], [file_entry]])
        storage = LocalFileStorage(str(tmp_path) + "/", sandbox=sandbox)
        keys = await storage.list("")
        assert "sub/nested.txt" in keys

    @pytest.mark.asyncio
    @pytest.mark.skipif(os.name == "nt", reason="Windows allows writing to arbitrary paths differently")
    async def test_write_error_raises_storage_error(self, tmp_path):
        storage = LocalFileStorage("/nonexistent/readonly/path/")
        with pytest.raises(StorageError):
            await storage.write("key", b"data")

    @pytest.mark.asyncio
    @pytest.mark.skipif(os.name == "nt", reason="Windows does not enforce chmod restrictions")
    async def test_read_error_raises_storage_error(self, tmp_path):
        storage = LocalFileStorage(str(tmp_path) + "/")
        await storage.write("key", b"data")
        os.chmod(os.path.join(str(tmp_path), "key"), 0o000)
        try:
            with pytest.raises(StorageError):
                await storage.read("key")
        finally:
            os.chmod(os.path.join(str(tmp_path), "key"), 0o644)

    def test_namespace_preserves_for_sandbox(self, tmp_path):
        from unittest.mock import MagicMock

        from strands.storage.storage import _NAMESPACED

        sandbox = MagicMock()
        storage = LocalFileStorage(str(tmp_path))
        ns = storage.namespace("scope")
        assert hasattr(ns, "for_sandbox")
        bound = ns.for_sandbox(sandbox)
        assert bound is not ns
        assert bound._namespaced is _NAMESPACED

    @pytest.mark.asyncio
    async def test_list_prefix_narrows_directory(self, storage, tmp_path):
        await storage.write("deep/nested/a.txt", b"a")
        await storage.write("deep/nested/b.txt", b"b")
        await storage.write("deep/other/c.txt", b"c")
        keys = await storage.list("deep/nested/")
        assert keys == ["deep/nested/a.txt", "deep/nested/b.txt"]

    @pytest.mark.asyncio
    async def test_list_prefix_nonexistent_dir(self, storage):
        keys = await storage.list("nonexistent/path/")
        assert keys == []

    @pytest.mark.asyncio
    async def test_list_prefix_partial_match_dir(self, storage, tmp_path):
        await storage.write("ab/file.txt", b"data")
        keys = await storage.list("abc/")
        assert keys == []

    @pytest.mark.asyncio
    async def test_delete_error_raises_storage_error(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        sandbox = MagicMock()
        sandbox.remove_file = AsyncMock(side_effect=PermissionError("forbidden"))
        storage = LocalFileStorage(str(tmp_path) + "/", sandbox=sandbox)
        with pytest.raises(StorageError):
            await storage.delete("key.txt")

    @pytest.mark.asyncio
    async def test_list_error_raises_storage_error(self, tmp_path):
        from unittest.mock import AsyncMock, MagicMock

        sandbox = MagicMock()
        sandbox.list_files = AsyncMock(side_effect=PermissionError("forbidden"))
        storage = LocalFileStorage(str(tmp_path) + "/", sandbox=sandbox)
        with pytest.raises(StorageError):
            await storage.list("")

    @pytest.mark.asyncio
    async def test_write_atomic_cleanup_on_replace_failure(self, tmp_path, monkeypatch):
        storage = LocalFileStorage(str(tmp_path) + "/")
        # First write succeeds to create the directory
        await storage.write("key", b"original")

        # Patch os.replace to fail, simulating atomic rename failure
        def failing_replace(src, dst):
            raise OSError("replace failed")

        monkeypatch.setattr(os, "replace", failing_replace)
        with pytest.raises(StorageError):
            await storage.write("key", b"new data")

        # Temp file should be cleaned up
        all_files = list(tmp_path.rglob("*"))
        assert not any("__strands_tmp" in str(f) for f in all_files)
