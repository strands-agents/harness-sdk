"""Tests for ``TestMemoryStore``.

Test scaffolding:
- ``tmp_path`` backs every persistent store, so tests never touch the real ``~/.strands/memory``.
- ``make_store`` builds a store rooted at a unique file under ``tmp_path``.
- ``_FakeAgent`` / ``_invoke_all`` mirror the extraction wiring in the Bedrock store tests.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

import strands.vended_memory_stores.test_memory_store.store as store_module
from strands.hooks.events import AfterInvocationEvent, MessageAddedEvent
from strands.hooks.registry import HookOrder
from strands.memory.extraction.triggers import InvocationTrigger
from strands.memory.extraction.types import ExtractionConfig, ExtractionResult
from strands.memory.memory_manager import MemoryManager
from strands.storage import Storage
from strands.types.exceptions import StorageError
from strands.vended_memory_stores.test_memory_store import (
    TestMemoryAddResult,
    TestMemoryStore,
    TestMemoryStoreConfig,
)


class _YieldingStorage:
    """A ``Storage`` wrapper that awaits a real suspension point before delegating each operation.

    Forcing the write lock to actually suspend (rather than complete synchronously) is what binds a
    lock's internal waiter to the running loop, so a store reused across loops fails loudly on a
    loop-bound lock instead of passing by luck.
    """

    def __init__(self, inner: Storage) -> None:
        self._inner = inner

    async def write(self, key: str, data: bytes) -> None:
        await asyncio.sleep(0)
        await self._inner.write(key, data)

    async def read(self, key: str) -> bytes | None:
        await asyncio.sleep(0)
        return await self._inner.read(key)

    async def delete(self, key: str) -> None:
        await asyncio.sleep(0)
        await self._inner.delete(key)

    async def list(self, query: str = "") -> list[str]:
        await asyncio.sleep(0)
        return await self._inner.list(query)


@pytest.fixture
def store_path(tmp_path: Path) -> str:
    """A unique backing-file path under the test's temp dir."""
    return str(tmp_path / "notes.json")


@pytest.fixture
def make_store(store_path: str):
    """Factory building a persistent store at ``store_path`` with overridable config."""

    def _make(**overrides: Any) -> TestMemoryStore:
        config: dict[str, Any] = {"name": "notes", "path": store_path}
        config.update(overrides)
        return TestMemoryStore(**config)

    return _make


class TestPackageExport:
    def test_export_from_parent_package(self):
        from strands.vended_memory_stores import TestMemoryStore as Imported

        assert Imported is TestMemoryStore

    def test_unknown_attribute_raises(self):
        from strands.vended_memory_stores import __getattr__

        with pytest.raises(AttributeError):
            __getattr__("NoSuchStore")

    def test_test_prefixed_classes_are_not_collected_by_pytest(self):
        # The ``Test`` prefix would otherwise make pytest try to collect these classes as test suites
        # (emitting a PytestCollectionWarning). ``__test__ = False`` opts them out; assert it stays set
        # so a future edit that drops a guard fails here instead of silently re-enabling collection.
        assert TestMemoryStore.__test__ is False
        assert TestMemoryStoreConfig.__test__ is False
        assert TestMemoryAddResult.__test__ is False


class TestConstructor:
    def test_is_writable_by_default(self, make_store):
        assert make_store().writable is True

    def test_honors_explicit_writable_false(self, make_store):
        assert make_store(writable=False).writable is False

    def test_exposes_identity_fields(self, make_store):
        store = make_store(description="my notes", max_search_results=7)
        assert store.name == "notes"
        assert store.description == "my notes"
        assert store.max_search_results == 7

    def test_raises_when_max_search_results_below_one(self, make_store):
        with pytest.raises(ValueError, match="max_search_results must be at least 1"):
            make_store(max_search_results=0)

    def test_raises_when_name_is_empty(self, make_store):
        with pytest.raises(ValueError, match="name must not be empty"):
            make_store(name="   ")

    def test_raises_when_explicit_path_is_empty(self):
        with pytest.raises(ValueError, match="path must not be empty"):
            TestMemoryStore(name="notes", path="   ")

    def test_does_no_filesystem_io_on_construction(self, make_store, store_path):
        make_store()
        assert not Path(store_path).exists()

    @pytest.mark.asyncio
    async def test_defaults_to_a_sanitized_path_under_the_home_memory_dir(self, tmp_path, monkeypatch):
        # No explicit path: the store derives ~/.strands/memory/<sanitized-store-name>.json. Home is
        # redirected to tmp_path so the test never touches the real home dir, and the unsafe name
        # exercises sanitization.
        monkeypatch.setattr(store_module.Path, "home", classmethod(lambda cls: tmp_path))
        store = TestMemoryStore(name="../weird/name")
        await store.add("a fact worth keeping")
        expected = tmp_path / ".strands" / "memory" / "__weird_name.json"
        assert expected.is_file()


class TestAdd:
    @pytest.mark.asyncio
    async def test_raises_when_not_writable(self, make_store):
        store = make_store(writable=False)
        with pytest.raises(ValueError, match="store is not writable"):
            await store.add("fact")

    @pytest.mark.asyncio
    async def test_raises_on_empty_content(self, make_store):
        store = make_store()
        with pytest.raises(ValueError, match="content must not be empty"):
            await store.add("   ")

    @pytest.mark.asyncio
    async def test_returns_an_id(self, make_store):
        result = await make_store().add("user prefers dark mode")
        assert result.id

    @pytest.mark.asyncio
    async def test_uses_the_monkeypatchable_id_generator(self, make_store, monkeypatch):
        # _new_id is a module-level seam; patching it pins the id the store mints.
        monkeypatch.setattr(store_module, "_new_id", lambda: "fixed-id")
        result = await make_store().add("user prefers dark mode")
        assert result.id == "fixed-id"

    @pytest.mark.asyncio
    async def test_deduplicates_identical_content(self, make_store):
        store = make_store()
        first = await store.add("user prefers dark mode")
        second = await store.add("user prefers dark mode")
        assert second.id == first.id
        assert len(await store.search("dark mode preferences")) == 1

    @pytest.mark.asyncio
    async def test_persists_human_readable_json(self, make_store, store_path):
        store = make_store()
        await store.add("user prefers dark mode", {"source": "user"})
        raw = Path(store_path).read_text(encoding="utf-8")
        assert "\n  " in raw  # pretty-printed
        parsed = json.loads(raw)
        assert len(parsed) == 1
        assert parsed[0]["content"] == "user prefers dark mode"
        assert parsed[0]["metadata"] == {"source": "user"}
        assert parsed[0]["id"]
        assert parsed[0]["createdAt"]


class TestSearch:
    @pytest.mark.asyncio
    async def test_raises_when_max_search_results_below_one(self, make_store):
        store = make_store()
        with pytest.raises(ValueError, match="max_search_results must be at least 1"):
            await store.search("q", {"max_search_results": 0})

    @pytest.mark.asyncio
    async def test_returns_nothing_for_token_less_query(self, make_store):
        store = make_store()
        await store.add("user prefers dark mode")
        assert await store.search("") == []
        assert await store.search("   ...  ") == []

    @pytest.mark.asyncio
    async def test_ranks_higher_overlap_first_with_relevance_score(self, make_store):
        store = make_store()
        await store.add("the cat sat on the mat")
        await store.add("the cat chased the dog in the park")

        results = await store.search("cat dog park")
        assert len(results) == 2
        assert results[0].content == "the cat chased the dog in the park"
        assert results[0].metadata["_relevanceScore"] == 3
        assert results[1].metadata["_relevanceScore"] == 1

    @pytest.mark.asyncio
    async def test_excludes_records_with_no_token_overlap(self, make_store):
        store = make_store()
        await store.add("the cat sat on the mat")
        await store.add("a completely unrelated note")

        results = await store.search("cat")
        assert len(results) == 1
        assert results[0].content == "the cat sat on the mat"

    @pytest.mark.asyncio
    async def test_breaks_ties_by_recency(self, make_store, monkeypatch):
        store = make_store()
        timestamps = iter(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"])
        monkeypatch.setattr(store_module, "_now", lambda: next(timestamps))
        await store.add("coffee is great")
        await store.add("coffee is bitter")

        results = await store.search("coffee")
        assert results[0].content == "coffee is bitter"
        assert results[1].content == "coffee is great"

    @pytest.mark.asyncio
    async def test_caps_results_to_max_search_results(self, make_store):
        store = make_store()
        await store.add("alpha match")
        await store.add("beta match")
        await store.add("gamma match")
        assert len(await store.search("match", {"max_search_results": 2})) == 2

    @pytest.mark.asyncio
    async def test_tokenizes_non_ascii_content_as_whole_words(self, make_store):
        # Unicode-aware tokenization (matching the TS SDK): accented/non-Latin words stay intact, so
        # a query for the same word matches rather than being shredded into ASCII fragments.
        store = make_store()
        await store.add("the café in 日本 is naïve")
        assert len(await store.search("café")) == 1
        assert len(await store.search("日本")) == 1


class TestPersistence:
    @pytest.mark.asyncio
    async def test_survives_restart(self, make_store):
        first = make_store()
        await first.add("user lives in Berlin")

        second = make_store()
        results = await second.search("where does the user live")
        assert len(results) == 1
        assert results[0].content == "user lives in Berlin"

    @pytest.mark.asyncio
    async def test_ephemeral_writes_no_file_and_forgets(self, make_store, store_path):
        first = make_store(persist=False)
        await first.add("ephemeral fact")
        assert not Path(store_path).exists()

        second = make_store(persist=False)
        assert await second.search("ephemeral fact") == []

    @pytest.mark.asyncio
    async def test_starts_empty_when_file_missing(self, make_store):
        assert await make_store().search("anything") == []

    @pytest.mark.asyncio
    async def test_raises_clear_error_on_corrupt_file(self, make_store, store_path):
        Path(store_path).write_text("not json{", encoding="utf-8")
        store = make_store()
        with pytest.raises(ValueError, match="invalid JSON"):
            await store.search("anything")

    @pytest.mark.asyncio
    async def test_raises_clear_error_on_wrong_shape_file(self, make_store, store_path):
        # Valid JSON that is not an array of records (e.g. a hand-edited object) must fail fast with
        # a clear message rather than crashing opaquely deeper in search/add.
        Path(store_path).write_text("{}", encoding="utf-8")
        store = make_store()
        with pytest.raises(ValueError, match="expected a JSON array"):
            await store.search("anything")

    @pytest.mark.asyncio
    async def test_raises_clear_error_on_malformed_record(self, make_store, store_path):
        # A valid JSON array whose elements lack the required fields must also fail fast with a clear
        # message rather than raising a bare KeyError deeper in search/add.
        Path(store_path).write_text(json.dumps([{"foo": "bar"}]), encoding="utf-8")
        store = make_store()
        with pytest.raises(ValueError, match="each record must have string"):
            await store.search("anything")

    @pytest.mark.asyncio
    async def test_raises_clear_error_on_non_object_metadata(self, make_store, store_path):
        # A present-but-non-object metadata (e.g. a hand-edited or cross-SDK file) must fail fast
        # rather than crashing opaquely when search spreads it into the result.
        record = [{"id": "a", "content": "hi", "createdAt": "2026-01-01T00:00:00.000Z", "metadata": "oops"}]
        Path(store_path).write_text(json.dumps(record), encoding="utf-8")
        store = make_store()
        with pytest.raises(ValueError, match="'metadata', when present, must be a JSON object"):
            await store.search("hi")

    @pytest.mark.asyncio
    async def test_accepts_null_metadata_as_absent(self, make_store, store_path):
        # A record with null metadata is accepted and treated as absent, matching the TS store.
        record = [{"id": "a", "content": "hi there", "createdAt": "2026-01-01T00:00:00.000Z", "metadata": None}]
        Path(store_path).write_text(json.dumps(record), encoding="utf-8")
        store = make_store()
        results = await store.search("hi")
        assert len(results) == 1
        assert results[0].metadata == {"_relevanceScore": 1}

    @pytest.mark.asyncio
    async def test_keeps_all_entries_under_concurrent_writes(self, make_store, store_path):
        store = make_store()
        await asyncio.gather(*(store.add(f"fact number {index}") for index in range(10)))
        assert len(json.loads(Path(store_path).read_text(encoding="utf-8"))) == 10

    def test_reused_across_separate_event_loops(self, make_store, store_path):
        # A synchronous Agent runs each invocation on a fresh event loop, so a store reused across
        # invocations acquires its write lock on a different loop each time. A loop-bound lock created
        # once would raise "bound to a different event loop"; the lock must rebind per loop. Wrapping
        # the backend so each op suspends forces the lock to actually bind a waiter to the loop, so a
        # regression surfaces rather than passing by luck.
        store = make_store()
        store._storage = _YieldingStorage(store._storage)

        async def batch(tag: str) -> None:
            await asyncio.gather(store.add(f"{tag} one"), store.add(f"{tag} two"))

        asyncio.run(batch("first"))
        asyncio.run(batch("second"))
        assert len(json.loads(Path(store_path).read_text(encoding="utf-8"))) == 4

    @pytest.mark.asyncio
    async def test_raises_clear_error_when_path_is_unreachable(self, tmp_path):
        # Point the store under an existing FILE, so the backing path can't be reached — the backend
        # raises a StorageError naming the key rather than a bare OSError.
        blocker = tmp_path / "blocker"
        blocker.write_text("not a directory", encoding="utf-8")
        store = TestMemoryStore(name="notes", path=str(blocker / "notes.json"))
        with pytest.raises(StorageError, match="Failed to write"):
            await store.add("user prefers dark mode")


class TestCrossSdkInterop:
    """The on-disk format is shared with the TypeScript SDK; a file written by either loads in both."""

    @pytest.mark.asyncio
    async def test_loads_a_file_written_in_the_shared_camelcase_format(self, make_store, store_path):
        # A record shaped exactly as the TypeScript SDK writes it: camelCase keys and a millisecond,
        # Z-suffixed timestamp. The Python store must read it without translation.
        ts_written = [
            {
                "id": "019ed65a-fd27-746c-aa3a-693a4a5434df",
                "content": "the user prefers dark mode",
                "metadata": {"source": "ts"},
                "createdAt": "2026-01-02T00:00:00.000Z",
            }
        ]
        Path(store_path).write_text(json.dumps(ts_written), encoding="utf-8")

        store = make_store()
        results = await store.search("dark mode preference")
        assert len(results) == 1
        assert results[0].content == "the user prefers dark mode"
        assert results[0].metadata["source"] == "ts"
        assert results[0].metadata["_relevanceScore"] == 2

    @pytest.mark.asyncio
    async def test_now_matches_javascript_toisostring_shape(self):
        # Millisecond precision, 'Z' suffix — the same shape Date.prototype.toISOString() emits.
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", store_module._now())


class TestPackageExports:
    def test_lazily_exported_from_vended_memory_stores(self):
        import strands.vended_memory_stores as vended_memory_stores

        assert vended_memory_stores.TestMemoryStore is TestMemoryStore

    def test_unknown_attribute_raises_attribute_error(self):
        import strands.vended_memory_stores as vended_memory_stores

        with pytest.raises(AttributeError):
            _ = vended_memory_stores.NotAStore


class _FakeAgent:
    """Minimal agent stand-in for ``init_agent`` wiring (mirrors the Bedrock store tests)."""

    def __init__(self, model: Any = None) -> None:
        self.model = model
        self.hooks: list[tuple[Any, Any, float]] = []
        self._middleware_registry = MagicMock()

    def add_hook(self, callback: Any, event_type: Any = None, *, order: float = HookOrder.DEFAULT) -> None:
        self.hooks.append((callback, event_type, order))


async def _invoke_all(agent: _FakeAgent, event: Any) -> None:
    """Fire every recorded hook registered for ``event``'s type."""
    for callback, event_type, _order in list(agent.hooks):
        if event_type is type(event):
            result = callback(event)
            if inspect.isawaitable(result):
                await result


class TestMemoryManagerIntegration:
    @pytest.mark.asyncio
    async def test_manager_stamps_store_name(self, make_store):
        store = make_store()
        await store.add("user prefers dark mode")

        mm = MemoryManager(stores=[store])
        results = await mm.search("dark mode")
        assert len(results) == 1
        assert results[0].store_name == "notes"

    @pytest.mark.asyncio
    async def test_manager_add_writes_to_store(self, make_store, store_path):
        store = make_store()
        mm = MemoryManager(stores=[store], add_tool_config=True)
        await mm.add("user likes coffee")
        assert len(json.loads(Path(store_path).read_text(encoding="utf-8"))) == 1

    @pytest.mark.asyncio
    async def test_ingests_extracted_facts_through_add(self, make_store, store_path):
        extractor = MagicMock()

        async def _extract(messages, context=None):
            return [ExtractionResult(content="user prefers dark mode")]

        extractor.extract.side_effect = _extract

        store = make_store(extraction=ExtractionConfig(trigger=InvocationTrigger(), extractor=extractor))
        mm = MemoryManager(stores=[store])
        agent = _FakeAgent()
        await mm.init_agent(agent)

        message = {"role": "user", "content": [{"text": "I like dark mode"}]}
        await _invoke_all(agent, MessageAddedEvent(agent=agent, message=message))
        await _invoke_all(agent, AfterInvocationEvent(agent=agent))
        await mm.flush()

        extractor.extract.assert_called_once()
        parsed = json.loads(Path(store_path).read_text(encoding="utf-8"))
        assert len(parsed) == 1
        assert parsed[0]["content"] == "user prefers dark mode"
