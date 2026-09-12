"""In-memory storage implementation."""

from __future__ import annotations

import builtins
import threading
from typing import TYPE_CHECKING

from .search.keyword import KeywordSearchStrategy
from .storage import _EPHEMERAL, _NamespacedStorage, _normalize_key, _normalize_prefix

if TYPE_CHECKING:
    from .storage import StorageSearchResult


class InMemoryStorage:
    """Map-backed storage for testing and short-lived processes.

    Content does not survive process restarts. The store is unbounded — consumers
    manage eviction themselves.

    Example:
        ```python
        from strands.storage import InMemoryStorage

        storage = InMemoryStorage()
        await storage.write("sessions/abc/state.json", b'{"messages": []}')
        data = await storage.read("sessions/abc/state.json")
        ```
    """

    _ephemeral = _EPHEMERAL

    def __init__(self) -> None:
        """Initialize an empty in-memory store."""
        self._store: dict[str, bytes] = {}
        self._lock = threading.Lock()

    async def write(self, key: str, data: bytes) -> None:
        """Store data under key, overwriting any existing value.

        Args:
            key: Opaque string key identifying the value.
            data: Raw bytes to persist.

        Raises:
            StorageError: If the key is invalid.
        """
        normalized = _normalize_key(key)
        with self._lock:
            self._store[normalized] = bytes(data)

    async def read(self, key: str) -> bytes | None:
        """Retrieve the bytes previously stored under key.

        Args:
            key: The key to read.

        Returns:
            The stored bytes, or None if no value exists for key.

        Raises:
            StorageError: If the key is invalid.
        """
        normalized = _normalize_key(key)
        with self._lock:
            value = self._store.get(normalized)
        return value

    async def delete(self, key: str) -> None:
        """Delete the value stored under key. A no-op if the key does not exist.

        Args:
            key: The key to delete.

        Raises:
            StorageError: If the key is invalid.
        """
        normalized = _normalize_key(key)
        with self._lock:
            self._store.pop(normalized, None)

    async def list(self, query: str = "") -> builtins.list[str]:
        """List keys matching the given prefix.

        Args:
            query: A prefix string to filter keys. Empty string matches all.

        Returns:
            Matching keys sorted ascending.

        Raises:
            StorageError: If the prefix is invalid.
        """
        prefix = _normalize_prefix(query)
        with self._lock:
            keys = sorted(k for k in self._store if k.startswith(prefix))
        return keys

    async def search(self, query: str) -> builtins.list[StorageSearchResult]:
        """Search stored content by keyword token-overlap scoring.

        Args:
            query: Natural-language search query.

        Returns:
            All matches with relevance scores, ranked best-first.
        """
        return await KeywordSearchStrategy().search(self, query)

    def namespace(self, prefix: str) -> _NamespacedStorage:
        """Return a view of this storage with all keys prefixed.

        Args:
            prefix: Prefix to prepend to all keys.

        Returns:
            A namespaced storage view.
        """
        return _NamespacedStorage(self, prefix)

    def clear(self) -> None:
        """Remove all stored entries."""
        with self._lock:
            self._store.clear()
