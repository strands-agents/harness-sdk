"""A :class:`~strands.memory.types.MemoryStore` that persists to a local JSON file.

A zero-infrastructure store for prototyping and testing. It persists to disk by default so memories persist
across sessions, and can be set to ephemeral for testing.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from typing_extensions import Unpack

from ...memory.types import MemoryEntry, MemoryStore, Metadata, SearchOptions
from ...storage import InMemoryStorage, LocalFileStorage, Storage
from ...storage.search.keyword import token_overlap_score, tokenize
from .types import TestMemoryAddResult, TestMemoryStoreConfig

DEFAULT_MAX_SEARCH_RESULTS = 10

# Synthetic metadata key holding the token-overlap relevance score on a search result.
RELEVANCE_SCORE_KEY = "_relevanceScore"


def _new_id() -> str:
    """Return a fresh record identifier."""
    return str(uuid.uuid4())


def _now() -> str:
    """Return the current UTC time as a millisecond-precision, ``Z``-suffixed ISO 8601 string.

    This matches the format JavaScript's ``Date.prototype.toISOString()`` emits, so a record written
    by either SDK carries the same timestamp shape.
    """
    now = datetime.now(timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


def _sanitize_name(name: str) -> str:
    r"""Sanitize a store name into a safe single-path-segment filename.

    Collapses parent-directory and separator sequences, then replaces any remaining unsafe
    character, guarding the default-path branch against a name that would escape the memory
    directory. Ensures cross-SDK compatibility.
    """
    sanitized = name.replace("..", "_").replace("/", "_").replace("\\", "_")
    return re.sub(r"[^\w\-.]", "_", sanitized, flags=re.ASCII)


class TestMemoryStore(MemoryStore):
    """A :class:`~strands.memory.types.MemoryStore` backed by a local JSON file.

    A zero-infrastructure store for prototyping and testing. It persists to disk by default so memories persist
    across sessions. Set ``persist=False`` for an ephemeral, single-session store.

    Recall is lexical: results are ranked by how many query tokens overlap an entry's content, with
    the most recent entry winning ties. This is keyword matching, not the semantic search a managed
    vector store (e.g. :class:`~strands.vended_memory_stores.bedrock_knowledge_base.BedrockKnowledgeBaseStore`)
    provides.

    Each :meth:`add` rewrites the whole file, so this fits modest volumes (hundreds to low thousands
    of entries), not production workloads — use a managed store like ``BedrockKnowledgeBaseStore`` for
    that. Writes within one event loop are serialized; concurrent writers across processes are not.

    Persistence is backed by the unified :class:`~strands.storage.Storage` interface internally:
    ``persist=True`` (the default) uses a :class:`~strands.storage.LocalFileStorage`, ``persist=False``
    an ephemeral :class:`~strands.storage.InMemoryStorage`. Unlike other subsystems
    (SnapshotSessionManager, ContextOffloader), this store does not accept an external ``Storage``
    or resolve from the agent-level ``storage`` — it manages its own backend via ``persist`` and
    ``path``.

    The on-disk format is shared with the TypeScript SDK's ``TestMemoryStore``: records use the same
    camelCase keys (``id``, ``content``, ``metadata``, ``createdAt``) and the same timestamp shape, so
    a backing file written by either SDK can be read by the other.

    Example:
        ```python
        from strands.vended_memory_stores.test_memory_store import TestMemoryStore

        # Persists to ~/.strands/memory/notes.json by default.
        store = TestMemoryStore(name="notes")

        result = await store.add("User prefers dark mode")
        results = await store.search("what theme does the user like?")
        ```
    """

    # Tell pytest not to collect this class as a test suite despite its ``Test`` prefix.
    __test__ = False

    def __init__(self, **store_config: Unpack[TestMemoryStoreConfig]) -> None:
        """Initialize the store.

        Args:
            **store_config: See :class:`TestMemoryStoreConfig`.

        Raises:
            ValueError: If ``name`` or ``path`` is empty/whitespace, or ``max_search_results`` is
                less than 1.
        """
        self.name = store_config["name"]
        if not self.name.strip():
            raise ValueError("TestMemoryStore: name must not be empty.")
        self.description = store_config.get("description")
        max_search_results = store_config.get("max_search_results")
        if max_search_results is not None and max_search_results < 1:
            raise ValueError("TestMemoryStore: max_search_results must be at least 1.")
        self.max_search_results = max_search_results
        # A local store is writable by default: the point is a zero-setup store you can write to.
        self.writable = store_config.get("writable", True)
        self.extraction = store_config.get("extraction")

        persist = store_config.get("persist", True)
        path = store_config.get("path")
        if path is not None and not path.strip():
            raise ValueError("TestMemoryStore: path must not be empty.")

        # Persistence runs on the unified Storage interface. Resolve a (backend, key) pair whose
        # on-disk location matches the pre-Storage behavior exactly:
        #   persist=False       -> ephemeral in-memory store
        #   persist=True + path  -> the file at `path` (backend rooted at its parent dir)
        #   persist=True default -> ~/.strands/memory/<sanitized-name>.json
        # LocalFileStorage/InMemoryStorage construction touches no filesystem, so building the store
        # never does I/O.
        if not persist:
            self._storage: Storage = InMemoryStorage()
            self._key = f"{_sanitize_name(self.name)}.json"
        elif path is not None:
            file = Path(path)
            self._storage = LocalFileStorage(str(file.parent))
            self._key = file.name
        else:
            self._storage = LocalFileStorage(str(Path.home() / ".strands" / "memory"))
            self._key = f"{_sanitize_name(self.name)}.json"

        # Serializes the read-modify-write cycle of add so concurrent adds don't each read the same
        # snapshot and clobber one another (last-write-wins). The lock is created lazily per running
        # loop (see _get_lock): an asyncio.Lock binds to the first loop that uses it, so a store
        # reused across the fresh loops a synchronous Agent creates per invocation would otherwise
        # raise "bound to a different event loop".
        self._lock: asyncio.Lock | None = None
        self._lock_loop: asyncio.AbstractEventLoop | None = None

    async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
        """Search stored entries for those whose content overlaps the query.

        Results are ranked by query-token overlap, with the most recent entry winning ties.

        Args:
            query: The search query text.
            options: Optional search configuration.

        Returns:
            Matching memory entries ordered by relevance. Each entry's ``metadata`` includes a
            reserved synthetic ``_relevanceScore`` key (the token-overlap count). An empty or
            token-less query returns no results.

        Raises:
            ValueError: If ``options.max_search_results`` is less than 1, or the backing file is
                malformed (invalid JSON, not an array, or a record missing required fields).
            StorageError: If the backend read fails.
        """
        caller_max = options.get("max_search_results") if options is not None else None
        if caller_max is not None and caller_max < 1:
            raise ValueError("TestMemoryStore: max_search_results must be at least 1.")
        limit = caller_max or self.max_search_results or DEFAULT_MAX_SEARCH_RESULTS

        query_tokens = tokenize(query)
        if not query_tokens:
            return []

        records = await self._read()

        scored: list[tuple[dict[str, Any], int]] = []
        for record in records:
            score = token_overlap_score(query_tokens, record["content"])
            if score > 0:
                scored.append((record, score))

        scored.sort(key=lambda item: (item[1], item[0]["createdAt"]), reverse=True)

        entries: list[MemoryEntry] = []
        for record, score in scored[:limit]:
            metadata: Metadata = {**(record.get("metadata") or {}), RELEVANCE_SCORE_KEY: score}
            entries.append(MemoryEntry(content=record["content"], metadata=metadata))
        return entries

    async def add(self, content: str, metadata: Metadata | None = None) -> TestMemoryAddResult:
        """Add ``content`` (with optional ``metadata``) to the store.

        Identical content is deduplicated: a repeat write returns the existing record's id without
        storing a second copy, so the at-least-once retries that extraction may perform never
        accumulate duplicates.

        Args:
            content: The text content to store.
            metadata: Optional metadata to attach to the entry. The key ``_relevanceScore`` is
                reserved: :meth:`search` populates it on results, so a value stored under it here is
                overwritten in search output.

        Returns:
            The id of the stored (or already-present) record.

        Raises:
            ValueError: If the store is not writable, ``content`` is empty/whitespace, or the
                existing backing file is malformed.
            StorageError: If the backend read or write fails.
        """
        if not self.writable:
            raise ValueError("TestMemoryStore: store is not writable. Set writable=True in config to enable add().")
        if not content.strip():
            raise ValueError("TestMemoryStore: content must not be empty.")

        # The lock serializes the whole read-modify-write cycle so concurrent adds on the same event
        # loop don't each read the same snapshot and clobber one another. Reading inside the critical
        # section guarantees add #N sees add #N-1's write. Serialization is per event loop; adds
        # driven from separate loops/processes against a shared file remain last-write-wins.
        async with self._get_lock():
            records = await self._read()

            normalized_content = content.strip()
            for record in records:
                if record["content"].strip() == normalized_content:
                    return TestMemoryAddResult(id=record["id"])

            new_record: dict[str, Any] = {"id": _new_id(), "content": content, "createdAt": _now()}
            if metadata is not None:
                new_record["metadata"] = metadata

            await self._write([*records, new_record])
            return TestMemoryAddResult(id=new_record["id"])

    def _get_lock(self) -> asyncio.Lock:
        """Return the write lock for the running event loop, creating a fresh one when the loop changes.

        An ``asyncio.Lock`` binds to the first loop that uses it, so a lock created once and reused
        across loops raises ``RuntimeError``. A synchronous ``Agent`` runs each invocation on a fresh
        loop, so a store reused across invocations must rebind. Rebinding per loop keeps the
        serialization guarantee within a single loop (the only scope concurrency happens in) while
        never carrying a lock across loops.
        """
        running_loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not running_loop:
            self._lock = asyncio.Lock()
            self._lock_loop = running_loop
        return self._lock

    async def _read(self) -> list[dict[str, Any]]:
        """Read and parse the record file from storage; a missing key (or empty store) starts empty.

        Reads fresh on every call — there is no in-memory cache, so a search always reflects the
        latest write.

        Raises:
            ValueError: If the stored file is not valid JSON, is not an array, or holds a record
                missing the required string fields.
            StorageError: If the backend read fails.
        """
        data = await self._storage.read(self._key)
        if data is None:
            return []

        try:
            parsed_file = json.loads(data)
        except json.JSONDecodeError as error:
            raise ValueError(f"TestMemoryStore: invalid JSON in {self._key}: {error}") from error

        if not isinstance(parsed_file, list):
            raise ValueError(f"TestMemoryStore: invalid backing file {self._key}: expected a JSON array of records")
        for record in parsed_file:
            if (
                not isinstance(record, dict)
                or not isinstance(record.get("id"), str)
                or not isinstance(record.get("content"), str)
                or not isinstance(record.get("createdAt"), str)
            ):
                raise ValueError(
                    f"TestMemoryStore: invalid backing file {self._key}: "
                    "each record must have string 'id', 'content', and 'createdAt' fields"
                )
            metadata = record.get("metadata")
            if metadata is not None and not isinstance(metadata, dict):
                raise ValueError(
                    f"TestMemoryStore: invalid backing file {self._key}: "
                    "a record's 'metadata', when present, must be a JSON object"
                )
        return parsed_file

    async def _write(self, records: list[dict[str, Any]]) -> None:
        """Persist ``records`` as a single JSON file through the storage backend.

        Callers serialize invocations via the instance lock; atomicity is the backend's
        responsibility. A backend I/O failure surfaces as its own ``StorageError``, naming the key.
        """
        data = json.dumps(records, indent=2, ensure_ascii=False).encode("utf-8")
        await self._storage.write(self._key, data)
