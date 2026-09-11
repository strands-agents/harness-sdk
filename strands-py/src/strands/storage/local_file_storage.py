"""Local filesystem storage implementation."""

from __future__ import annotations

import builtins
import os
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

from ..types.exceptions import StorageError
from .search.keyword import KeywordSearchStrategy
from .storage import _NAMESPACED, _normalize_key, _normalize_prefix

if TYPE_CHECKING:
    from ..sandbox.base import Sandbox
    from .storage import StorageSearchResult

_TMP_MARKER = ".__strands_tmp"


class LocalFileStorage:
    """Persists each key as a file under a base directory.

    Key segments separated by '/' map to directory segments. Writes on the host
    filesystem are atomic (write to temp file, then rename).

    Example:
        ```python
        from strands.storage import LocalFileStorage

        storage = LocalFileStorage("./.strands/")
        await storage.write("session/abc/state.json", data)
        ```
    """

    def __init__(self, base_dir: str = "./.strands/", *, sandbox: Sandbox | None = None) -> None:
        """Initialize local file storage.

        Args:
            base_dir: Root directory under which all keys are stored.
            sandbox: Optional sandbox to route I/O through.
        """
        self._base_dir = os.path.normpath(base_dir)
        self._sandbox = sandbox

    @property
    def base_dir(self) -> str:
        """The root directory under which all keys are stored."""
        return self._base_dir

    def for_sandbox(self, sandbox: Sandbox) -> LocalFileStorage:
        """Return a copy bound to the given sandbox.

        If already bound to the same sandbox, returns self.

        Args:
            sandbox: Sandbox to bind to.

        Returns:
            A LocalFileStorage instance bound to the sandbox.
        """
        if self._sandbox is sandbox:
            return self
        bound = LocalFileStorage(self._base_dir, sandbox=sandbox)
        if getattr(self, "_namespaced", None) is _NAMESPACED:
            bound._namespaced = _NAMESPACED  # type: ignore[attr-defined]
        return bound

    async def write(self, key: str, data: bytes) -> None:
        """Store data as a file, creating parent directories as needed.

        On the host filesystem, writes are atomic via write-to-temp-then-rename.

        Args:
            key: Opaque string key identifying the value.
            data: Raw bytes to persist.

        Raises:
            StorageError: If the write fails.
        """
        normalized = _normalize_key(key)
        path = self._path_for(normalized)

        try:
            if self._sandbox is not None:
                await self._sandbox.write_file(path, data)
                return

            parent = os.path.dirname(path)
            os.makedirs(parent, exist_ok=True)

            tmp_path = os.path.join(parent, f"{_TMP_MARKER}_{uuid.uuid4().hex}")
            try:
                with open(tmp_path, "wb") as f:
                    f.write(data)
                os.replace(tmp_path, path)
            except BaseException:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except StorageError:
            raise
        except Exception as error:
            raise StorageError(f"Failed to write '{key}'") from error

    async def read(self, key: str) -> bytes | None:
        """Read the file corresponding to key.

        Args:
            key: The key to read.

        Returns:
            The file contents as bytes, or None if the file does not exist.

        Raises:
            StorageError: If the read fails for a reason other than a missing file.
        """
        normalized = _normalize_key(key)
        path = self._path_for(normalized)

        try:
            if self._sandbox is not None:
                return await self._sandbox.read_file(path)

            with open(path, "rb") as f:
                return f.read()
        except (FileNotFoundError, NotADirectoryError):
            return None
        except StorageError:
            raise
        except Exception as error:
            raise StorageError(f"Failed to read '{key}'") from error

    async def delete(self, key: str) -> None:
        """Delete the file corresponding to key. No-op if it does not exist.

        Args:
            key: The key to delete.

        Raises:
            StorageError: If the delete fails.
        """
        normalized = _normalize_key(key)
        path = self._path_for(normalized)

        try:
            if self._sandbox is not None:
                try:
                    await self._sandbox.remove_file(path)
                except (FileNotFoundError, NotADirectoryError):
                    pass
                return

            try:
                os.unlink(path)
            except (FileNotFoundError, NotADirectoryError):
                pass
        except StorageError:
            raise
        except Exception as error:
            raise StorageError(f"Failed to delete '{key}'") from error

    async def list(self, query: str = "") -> builtins.list[str]:
        """List keys matching the given prefix by walking the directory tree.

        Args:
            query: A prefix string to filter keys. Empty string matches all.

        Returns:
            Matching keys sorted ascending.

        Raises:
            StorageError: If the listing fails.
        """
        prefix = _normalize_prefix(query)

        try:
            if self._sandbox is not None:
                keys = await self._list_keys_sandbox(prefix)
            else:
                keys = self._list_keys_host(prefix)
            return sorted(k for k in keys if k.startswith(prefix))
        except StorageError:
            raise
        except Exception as error:
            raise StorageError(f"Failed to list keys with prefix '{query}'") from error

    async def search(self, query: str) -> builtins.list[StorageSearchResult]:
        """Search stored content by keyword token-overlap scoring.

        Args:
            query: Natural-language search query.

        Returns:
            All matches with relevance scores, ranked best-first.
        """
        return await KeywordSearchStrategy().search(self, query)

    def namespace(self, prefix: str) -> LocalFileStorage:
        """Return a new LocalFileStorage scoped to a subdirectory.

        Unlike a generic ``_NamespacedStorage`` wrapper, this returns a real
        ``LocalFileStorage`` whose ``base_dir`` incorporates the prefix. This
        preserves access to ``base_dir`` for strategies that need the filesystem
        path (e.g. index-based search), and ``for_sandbox`` continues to work.

        Args:
            prefix: Prefix to prepend to all keys.

        Returns:
            A new LocalFileStorage rooted at the sub-path.
        """
        normalized = _normalize_prefix(prefix).rstrip("/")
        sub_dir = os.path.join(self._base_dir, *normalized.split("/")) if normalized else self._base_dir
        scoped = LocalFileStorage(sub_dir, sandbox=self._sandbox)
        scoped._namespaced = _NAMESPACED  # type: ignore[attr-defined]
        return scoped

    def _path_for(self, key: str) -> str:
        """Map a normalized key to a filesystem path."""
        return os.path.join(self._base_dir, key)

    def _list_keys_host(self, prefix: str) -> builtins.list[str]:
        """Recursively walk the base directory to find all stored keys."""
        base = Path(self._base_dir)

        narrow_dir = base
        if prefix:
            parts = prefix.rstrip("/").split("/")
            for part in parts[:-1]:
                candidate = narrow_dir / part
                if candidate.is_dir():
                    narrow_dir = candidate
                else:
                    break

        keys: builtins.list[str] = []
        if not narrow_dir.exists():
            return keys

        for dirpath, _, filenames in os.walk(narrow_dir):
            for filename in filenames:
                if _TMP_MARKER in filename:
                    continue
                full_path = os.path.join(dirpath, filename)
                rel = os.path.relpath(full_path, self._base_dir)
                key = rel.replace(os.sep, "/")
                keys.append(key)

        return keys

    async def _list_keys_sandbox(self, prefix: str) -> builtins.list[str]:
        """List keys via sandbox file listing."""
        base = Path(self._base_dir)

        keys: builtins.list[str] = []
        await self._walk_sandbox(base, keys)
        return keys

    async def _walk_sandbox(self, directory: Path, keys: builtins.list[str]) -> None:
        """Recursively walk sandbox directories to collect keys."""
        try:
            entries = await self._sandbox.list_files(str(directory))  # type: ignore[union-attr]
        except (FileNotFoundError, NotADirectoryError):
            return

        for entry in entries:
            if _TMP_MARKER in entry.name:
                continue
            full_path = directory / entry.name
            if entry.is_dir:
                await self._walk_sandbox(full_path, keys)
            else:
                rel = os.path.relpath(str(full_path), self._base_dir)
                keys.append(rel.replace(os.sep, "/"))
