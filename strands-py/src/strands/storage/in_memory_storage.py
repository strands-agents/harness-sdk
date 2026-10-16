"""In-memory storage implementation."""

from __future__ import annotations

import builtins
import threading
from typing import TYPE_CHECKING

from ..types.exceptions import StorageError
from .search.keyword import KeywordSearchStrategy
from .storage import _EPHEMERAL, _NAMESPACED, _normalize_key, _normalize_prefix

if TYPE_CHECKING:
    from .search.types import SearchStrategy
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

    def __init__(self, *, search_strategy: SearchStrategy[InMemoryStorage] | None = None) -> None:
        """Initialize an empty in-memory store.

        Args:
            search_strategy: Optional search strategy. When set, ``write()``
                automatically indexes entries and ``search()`` delegates to the
                strategy instead of the default keyword scan.
        """
        # Shared with every instance returned by namespace(); each instance only sees keys under _prefix.
        self._store: dict[str, bytes] = {}
        self._lock = threading.Lock()
        self._prefix = ""
        self._search_strategy = search_strategy

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
            self._store[f"{self._prefix}{normalized}"] = bytes(data)

        if self._search_strategy is not None:
            try:
                await self._search_strategy.index(self, normalized, data)
            except Exception as error:
                raise StorageError(f"Wrote '{key}' but indexing failed") from error

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
            value = self._store.get(f"{self._prefix}{normalized}")
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
            self._store.pop(f"{self._prefix}{normalized}", None)

    async def list(self, query: str = "") -> builtins.list[str]:
        """List keys matching the given prefix.

        Args:
            query: A prefix string to filter keys. Empty string matches all.

        Returns:
            Matching keys sorted ascending.

        Raises:
            StorageError: If the prefix is invalid.
        """
        full_prefix = f"{self._prefix}{_normalize_prefix(query)}"
        with self._lock:
            keys = sorted(k[len(self._prefix) :] for k in self._store if k.startswith(full_prefix))
        return keys

    async def search(self, query: str) -> builtins.list[StorageSearchResult]:
        """Search stored content using the configured strategy.

        Delegates to the search strategy when one is set, otherwise falls back
        to keyword token-overlap scoring.

        Args:
            query: Natural-language search query.

        Returns:
            All matches with relevance scores, ranked best-first.
        """
        if self._search_strategy is not None:
            return await self._search_strategy.search(self, query)
        return await KeywordSearchStrategy().search(self, query)

    def namespace(self, prefix: str) -> InMemoryStorage:
        """Return an ``InMemoryStorage`` scoped to ``prefix``.

        The scoped instance shares this instance's entries and search strategy.
        Unlike a generic ``_NamespacedStorage`` wrapper, its ``search()`` only
        sees entries under the prefix and scores keys without it, so a query
        never matches every entry just because it contains a word from the prefix.

        The shared search strategy receives the scoped instance and keys relative
        to the prefix. A strategy that keeps its own index must keep each
        instance's entries apart; see ``SearchStrategy.index``.

        Args:
            prefix: Prefix to prepend to all keys.

        Returns:
            An ``InMemoryStorage`` scoped to the prefix.
        """
        normalized = _normalize_prefix(prefix).rstrip("/")
        scoped = InMemoryStorage(search_strategy=self._search_strategy)
        scoped._store = self._store
        scoped._lock = self._lock
        scoped._prefix = f"{self._prefix}{normalized}/" if normalized else self._prefix
        scoped._namespaced = _NAMESPACED  # type: ignore[attr-defined]
        return scoped

    def clear(self) -> None:
        """Remove all entries visible to this instance.

        That is every entry under its namespace, or every entry when not namespaced.
        """
        with self._lock:
            if not self._prefix:
                self._store.clear()
                return
            for key in [k for k in self._store if k.startswith(self._prefix)]:
                del self._store[key]
