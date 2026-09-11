"""Pluggable search strategy protocol for storage backends."""

from __future__ import annotations

from typing import Any, Protocol

from ..storage import Storage, StorageSearchResult


class SearchStrategy(Protocol):
    """A pluggable search strategy for storage backends.

    Strategies encapsulate a single approach to searching stored content --
    keyword/lexical scan, vector similarity, full-text index, etc. Storage
    backends delegate their ``search()`` to a strategy, and consumers (memory
    stores, context offloaders) can override the default.
    """

    async def search(self, storage: Storage, query: str, **kwargs: Any) -> list[StorageSearchResult]:
        """Search content in storage matching query.

        Args:
            storage: The storage to search over.
            query: A natural-language string query.
            **kwargs: Strategy-specific options for forward compatibility.

        Returns:
            Matched keys with relevance scores, ranked best-first.
        """
        ...
