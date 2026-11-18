"""BM25 full-text search strategy powered by SQLite FTS5.

Maintains a SQLite-backed inverted index over storage contents and uses BM25
scoring for relevance ranking. Accounts for term frequency, inverse document
frequency, and document length normalization.

Indexes entries at write time via :meth:`Bm25SearchStrategy.index` so searches
do not need to re-read storage contents. Requires a ``base_dir`` property on
the storage instance only to locate the SQLite database file on the host
filesystem.

Zero external dependencies -- uses Python's stdlib ``sqlite3`` module which
ships FTS5 support on all modern platforms.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from ..storage import StorageSearchResult
from .keyword import STOP_WORDS, tokenize

if TYPE_CHECKING:
    from ..local_file_storage import LocalFileStorage


def _build_query(query: str) -> str | None:
    """Build an FTS5 match expression from a natural-language query.

    Filters stop words and single-character tokens, appends a prefix
    wildcard to each term, then joins with implicit AND so all terms
    must be present as prefixes (ranked by BM25).

    Args:
        query: Natural-language search query.

    Returns:
        FTS5 match expression, or None if no meaningful terms remain.
    """
    terms = sorted(term for term in tokenize(query) if len(term) > 1 and term not in STOP_WORDS)
    if not terms:
        return None
    return " ".join(f"{term}*" for term in terms)


@dataclass
class Bm25SearchStrategyConfig:
    """Configuration for :class:`Bm25SearchStrategy`.

    Attributes:
        db_path: Path to the SQLite database file for the FTS5 index.
            Defaults to ``.<dir>-fts5.sqlite`` alongside the storage directory,
            which gives each directory its own index. An explicit ``db_path``
            holds one directory's index, so a strategy with ``db_path`` set
            raises ``ValueError`` if it is then used with a second directory
            (for example a second ``FileMemoryStore`` on the same storage).
    """

    db_path: str | None = field(default=None)


class Bm25SearchStrategy:
    """BM25 full-text search strategy powered by SQLite FTS5.

    Maintains a SQLite-backed inverted index over the storage contents and uses
    BM25 scoring for relevance ranking. Accounts for term frequency, inverse
    document frequency, and document length normalization.

    Indexes entries at write time via :meth:`index` -- consumers call
    ``strategy.index(storage, key, data)`` on each write, and ``search()``
    queries the pre-built index. Only entries passed through ``index()`` are
    searchable; pre-existing storage contents are not backfilled automatically.

    The FTS5 index is persisted on the host filesystem via the storage's
    ``base_dir`` and is not sandbox-aware.

    Keeps one index per storage directory, so one instance can serve several
    namespaced storages, such as multiple ``FileMemoryStore`` instances on the same
    ``LocalFileStorage``, and :meth:`close` closes all of them.

    Example:
        ```python
        from strands.storage import LocalFileStorage
        from strands.storage.search.bm25 import Bm25SearchStrategy

        storage = LocalFileStorage("./memory/")
        strategy = Bm25SearchStrategy()

        await strategy.index(storage, "auth.md", b"OAuth2 authentication flow")
        results = await strategy.search(storage, "authentication flow")
        await strategy.close()
        ```
    """

    requires_host_fs: Literal[True] = True

    def __init__(self, config: Bm25SearchStrategyConfig | None = None) -> None:
        """Initialize the BM25 search strategy.

        Args:
            config: Optional configuration. See :class:`Bm25SearchStrategyConfig`.
        """
        self._config = config or Bm25SearchStrategyConfig()
        # One FTS5 connection per absolute storage directory, so namespaced storages (e.g. one per
        # FileMemoryStore) share this strategy without closing each other's index.
        self._conns: dict[str, sqlite3.Connection] = {}
        self._lock = asyncio.Lock()

    async def index(self, storage: LocalFileStorage, key: str, data: bytes, **kwargs: Any) -> None:
        """Index a single entry for future searches.

        Skips hidden files (keys whose final segment starts with '.').
        Uses content hashing to avoid redundant re-indexing when the
        data has not changed.

        Args:
            storage: The storage backend (used to locate the index db).
            key: The storage key being written.
            data: The raw bytes being stored.
            **kwargs: Unused; accepted for protocol compatibility.
        """
        if key.rsplit("/", maxsplit=1)[-1].startswith("."):
            return

        content = data.decode("utf-8", errors="replace")
        content_hash = hashlib.md5(data, usedforsecurity=False).hexdigest()

        async with self._lock:
            conn = self._ensure_connection(storage)
            await asyncio.shield(asyncio.to_thread(self._upsert, conn, key, content, content_hash))

    async def search(self, storage: LocalFileStorage, query: str, **kwargs: Any) -> list[StorageSearchResult]:
        """Search the index using BM25 full-text search.

        Args:
            storage: The storage backend (used to locate the index db).
            query: Natural-language search query.
            **kwargs: Unused; accepted for protocol compatibility.

        Returns:
            Matched keys with BM25 relevance scores, ranked best-first.

        Raises:
            RuntimeError: If the SQLite build lacks FTS5 support.
        """
        fts_query = _build_query(query)
        if not fts_query:
            return []

        async with self._lock:
            conn = self._ensure_connection(storage)
            return await asyncio.shield(asyncio.to_thread(self._query, conn, fts_query))

    async def close(self) -> None:
        """Close every SQLite connection this strategy has opened and release resources."""
        async with self._lock:
            conns = list(self._conns.values())
            self._conns.clear()
            for conn in conns:
                conn.close()

    def _ensure_connection(self, storage: LocalFileStorage) -> sqlite3.Connection:
        """Return the connection for the storage's directory, opening it on first use.

        Raises:
            ValueError: If an explicit ``db_path`` is configured and already holds another directory's index.
        """
        storage_path = os.path.abspath(self._resolve_storage_path(storage))

        conn = self._conns.get(storage_path)
        if conn is not None:
            return conn

        db_path = self._config.db_path
        if db_path is not None and self._conns:
            bound_path = next(iter(self._conns))
            raise ValueError(
                f"Bm25SearchStrategy db_path '{db_path}' already indexes '{bound_path}' and cannot also index "
                f"'{storage_path}'. Omit db_path to keep one index per directory (e.g. per FileMemoryStore), "
                "or use one strategy per storage."
            )

        os.makedirs(storage_path, exist_ok=True)
        if db_path is None:
            parent = os.path.dirname(storage_path)
            basename = os.path.basename(storage_path)
            db_path = os.path.join(parent, f".__strands_{basename}-fts5.sqlite")

        conn = sqlite3.connect(db_path, check_same_thread=False)
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS documents USING fts5(key, content)")
        except sqlite3.OperationalError as error:
            conn.close()
            raise RuntimeError("SQLite build lacks FTS5 support") from error
        conn.execute("CREATE TABLE IF NOT EXISTS doc_hashes (key TEXT PRIMARY KEY, hash TEXT NOT NULL)")
        conn.commit()

        self._conns[storage_path] = conn
        return conn

    def _upsert(self, conn: sqlite3.Connection, key: str, content: str, content_hash: str) -> None:
        """Insert or replace a single document in the FTS5 index."""
        row = conn.execute("SELECT hash FROM doc_hashes WHERE key = ?", (key,)).fetchone()
        if row and row[0] == content_hash:
            return
        conn.execute("DELETE FROM documents WHERE key = ?", (key,))
        conn.execute("INSERT INTO documents (key, content) VALUES (?, ?)", (key, content))
        conn.execute("INSERT OR REPLACE INTO doc_hashes (key, hash) VALUES (?, ?)", (key, content_hash))
        conn.commit()

    @staticmethod
    def _query(conn: sqlite3.Connection, fts_query: str) -> list[StorageSearchResult]:
        """Execute the FTS5 query and return scored results."""
        cursor = conn.execute(
            "SELECT key, rank FROM documents WHERE documents MATCH ? ORDER BY rank",
            (fts_query,),
        )
        results: list[StorageSearchResult] = []
        for row in cursor.fetchall():
            raw_score = abs(row[1])
            score = raw_score / (1.0 + raw_score)
            results.append(StorageSearchResult(key=row[0], score=score))
        return results

    @staticmethod
    def _resolve_storage_path(storage: LocalFileStorage) -> str:
        """Extract base_dir from the storage instance."""
        return storage.base_dir
