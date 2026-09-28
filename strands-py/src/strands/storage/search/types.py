"""Pluggable search strategy protocol for storage backends."""

from __future__ import annotations

from typing import Any, Literal, Protocol

from typing_extensions import TypeVar

from ..storage import Storage, StorageSearchResult

S = TypeVar("S", bound=Storage, default=Storage, contravariant=True)


class SearchStrategy(Protocol[S]):
    """A pluggable search strategy for storage backends.

    Strategies encapsulate a single approach to searching stored content --
    keyword/lexical scan, vector similarity, full-text index, etc. Storage
    backends delegate their ``search()`` to a strategy, and consumers (memory
    stores, context offloaders) can override the default.

    The ``S`` type parameter controls which storage backends the strategy is
    compatible with. Defaults to :class:`Storage` (any backend). Strategies
    that require specific backend features (e.g. ``base_dir``) can narrow
    this to a concrete type like :class:`LocalFileStorage`.
    """

    async def index(self, storage: S, key: str, data: bytes, **kwargs: Any) -> None:
        """Index a single entry for future searches.

        Consumers should call this on each write so strategies that maintain
        an index (FTS5, vector, etc.) can update incrementally. Strategies
        that search on the fly (keyword) may no-op.

        Args:
            storage: The storage backend the entry belongs to.
            key: The storage key being written.
            data: The raw bytes being stored.
            **kwargs: Strategy-specific options for forward compatibility.
        """
        ...

    async def search(self, storage: S, query: str, **kwargs: Any) -> list[StorageSearchResult]:
        """Search content in storage matching query.

        Args:
            storage: The storage to search over.
            query: A natural-language string query.
            **kwargs: Strategy-specific options for forward compatibility.

        Returns:
            Matched keys with relevance scores, ranked best-first.
        """
        ...


class SandboxSafeSearchStrategy(Protocol[S]):
    """A search strategy that works inside a sandbox.

    Strategies that operate purely through the :class:`Storage` API (e.g.
    keyword scan) are sandbox-safe. Strategies that persist state on the
    host filesystem (e.g. BM25 with a SQLite index) are not.

    Declare ``requires_host_fs: Literal[False] = False`` on a strategy
    class to mark it as sandbox-safe.
    """

    requires_host_fs: Literal[False]

    async def index(self, storage: S, key: str, data: bytes, **kwargs: Any) -> None:
        """Index a single entry for future searches."""
        ...

    async def search(self, storage: S, query: str, **kwargs: Any) -> list[StorageSearchResult]:
        """Search content in storage matching query."""
        ...
