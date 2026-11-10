"""Tests for OpenTelemetry tracing of the memory subsystem.

These cover the span lifecycle wired into ``MemoryManager.search`` / ``add`` /
``_provide_memory_context`` and ``ExtractionCoordinator._extract``. Each test
patches ``get_tracer`` at the call site so it can assert which span methods fire
(start/end, error vs OK) without a live exporter.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from strands.memory import AggregateMemoryError
from strands.memory.extraction.coordinator import ExtractionCoordinator, _ExtractionBinding
from strands.memory.extraction.resolve_extraction_config import _resolve_extraction_config
from strands.memory.extraction.triggers import InvocationTrigger
from strands.memory.extraction.types import ExtractionConfig, ExtractionResult
from strands.memory.memory_manager import MemoryManager
from strands.memory.types import MemoryAddOptions, MemoryEntry, MemorySearchOptions

pytestmark = pytest.mark.asyncio


def _store(
    name: str,
    *,
    entries: list[MemoryEntry] | None = None,
    writable: bool = False,
    sinks: set[str] | None = None,
    extraction: Any = None,
    search_error: BaseException | None = None,
    add_error: BaseException | None = None,
) -> Any:
    """Build a fake ``MemoryStore`` with optional methods on its class."""
    methods: dict[str, Any] = {}
    if search_error is not None:
        methods["search"] = AsyncMock(side_effect=search_error)
    else:
        methods["search"] = AsyncMock(return_value=list(entries or []))

    if sinks is None:
        sinks = {"add"} if writable else set()
    if "add" in sinks:
        methods["add"] = AsyncMock(side_effect=add_error) if add_error is not None else AsyncMock(return_value=None)
    if "add_messages" in sinks:
        methods["add_messages"] = AsyncMock(return_value=None)

    store_cls = type(f"_FakeStore_{name}", (), dict(methods))
    store = store_cls()
    store.name = name
    store.description = None
    store.max_search_results = None
    store.writable = writable
    store.extraction = extraction
    return store


@pytest.fixture
def mock_tracer():
    """Patch the tracer used by ``memory_manager``.

    ``start_*`` methods return distinct span mocks so callers can assert which span
    was ended.
    """
    tracer = MagicMock()
    tracer.start_memory_search_span.return_value = MagicMock(name="search_span")
    tracer.start_memory_add_span.return_value = MagicMock(name="add_span")
    tracer.start_memory_inject_span.return_value = MagicMock(name="inject_span")
    with patch("strands.memory.memory_manager.get_tracer", return_value=tracer):
        yield tracer


async def test_search_records_span(mock_tracer):
    """A successful search starts/ends the search span with the retrieved entries."""
    entry = MemoryEntry(content="user prefers dark mode")
    manager = MemoryManager(stores=[_store("personal", entries=[entry])], injection=False)

    results = await manager.search("preferences")

    assert len(results) == 1
    mock_tracer.start_memory_search_span.assert_called_once()
    end_call = mock_tracer.end_memory_search_span.call_args
    assert end_call.kwargs["store_failure_count"] == 0
    assert [e.content for e in end_call.kwargs["entries"]] == ["user prefers dark mode"]


async def test_search_partial_store_failure_ends_ok(mock_tracer):
    """A per-store search failure is counted but the span ends OK (not an error)."""
    good = _store("good", entries=[MemoryEntry(content="hit")])
    bad = _store("bad", search_error=RuntimeError("boom"))
    manager = MemoryManager(stores=[good, bad], injection=False)

    results = await manager.search("q")

    assert len(results) == 1
    end_call = mock_tracer.end_memory_search_span.call_args
    assert end_call.kwargs["store_failure_count"] == 1
    assert "error" not in end_call.kwargs or end_call.kwargs["error"] is None


async def test_search_unknown_store_ends_with_error(mock_tracer):
    """An unknown named store raises ValueError and ends the span with the error."""
    manager = MemoryManager(stores=[_store("personal")], injection=False)

    with pytest.raises(ValueError):
        await manager.search("q", MemorySearchOptions(stores=["missing"]))

    end_call = mock_tracer.end_memory_search_span.call_args
    assert isinstance(end_call.kwargs["error"], ValueError)


async def test_add_success_records_span(mock_tracer):
    """A successful add starts/ends the add span with no error."""
    manager = MemoryManager(stores=[_store("personal", writable=True)], injection=False)

    await manager.add("remember this")

    mock_tracer.start_memory_add_span.assert_called_once()
    end_call = mock_tracer.end_memory_add_span.call_args
    assert end_call.kwargs.get("error") is None


async def test_add_failure_ends_with_error(mock_tracer):
    """A store write failure surfaces an AggregateMemoryError and ends the span with it."""
    store = _store("personal", writable=True, add_error=RuntimeError("disk full"))
    manager = MemoryManager(stores=[store], injection=False)

    with pytest.raises(AggregateMemoryError):
        await manager.add("remember this")

    end_call = mock_tracer.end_memory_add_span.call_args
    assert isinstance(end_call.kwargs["error"], AggregateMemoryError)
    assert end_call.kwargs["store_failure_count"] == 1


async def test_add_detached_forces_root_span(mock_tracer):
    """The fire-and-forget add path forces a root span (force_root=True)."""
    manager = MemoryManager(stores=[_store("personal", writable=True)], injection=False)

    await manager.add("remember this", MemoryAddOptions(stores=["personal"]), _detached=True)

    assert mock_tracer.start_memory_add_span.call_args.kwargs["force_root"] is True


async def test_injection_happy_path(mock_tracer):
    """Injection with results ends the span injected=True with the entry count."""
    entry = MemoryEntry(content="user prefers dark mode", store_name="personal")
    manager = MemoryManager(stores=[_store("personal", entries=[entry])], injection=True)

    rendered = await manager._provide_memory_context([{"role": "user", "content": [{"text": "hi"}]}], {})

    assert rendered is not None and "dark mode" in rendered
    end_call = mock_tracer.end_memory_inject_span.call_args
    assert end_call.kwargs["injected"] is True
    assert end_call.kwargs["entry_count"] == 1


async def test_injection_no_query_ends_not_injected(mock_tracer):
    """No derivable query ends the inject span injected=False without searching."""
    manager = MemoryManager(stores=[_store("personal")], injection=True)

    rendered = await manager._provide_memory_context([], {})

    assert rendered is None
    mock_tracer.end_memory_inject_span.assert_called_once_with(
        mock_tracer.start_memory_inject_span.return_value, injected=False, entry_count=0, format_error=False
    )


async def test_injection_format_error_fails_open(mock_tracer):
    """A raising format callback ends the inject span OK with format_error=True."""
    entry = MemoryEntry(content="x", store_name="personal")
    manager = MemoryManager(stores=[_store("personal", entries=[entry])], injection=True)

    def _boom(_context: Any) -> str:
        raise ValueError("bad format")

    rendered = await manager._provide_memory_context([{"role": "user", "content": [{"text": "hi"}]}], {"format": _boom})

    assert rendered is None
    end_call = mock_tracer.end_memory_inject_span.call_args
    assert end_call.kwargs["injected"] is False
    assert end_call.kwargs["format_error"] is True


async def test_injection_search_failure_ends_span_and_propagates(mock_tracer):
    """A search() failure during injection ends the inject span (no leak) and re-raises.

    ``MemoryManager.search`` swallows per-store errors, so to exercise the inject guard we
    make ``search`` itself raise (e.g. an unexpected internal error).
    """
    manager = MemoryManager(stores=[_store("personal")], injection=True)

    with patch.object(manager, "search", AsyncMock(side_effect=RuntimeError("search exploded"))):
        with pytest.raises(RuntimeError, match="search exploded"):
            await manager._provide_memory_context([{"role": "user", "content": [{"text": "hi"}]}], {})

    # The span must be ended even though search raised, so it does not leak open.
    mock_tracer.end_memory_inject_span.assert_called_once()
    assert mock_tracer.end_memory_inject_span.call_args.kwargs["injected"] is False


# --------------------------------------------------------------------------- #
# Extraction coordinator
# --------------------------------------------------------------------------- #


def _binding(store: Any) -> _ExtractionBinding:
    config = _resolve_extraction_config(store.extraction, store)
    assert config is not None
    return _ExtractionBinding(store=store, config=config)


@pytest.fixture
def mock_coordinator_tracer():
    """Patch the tracer used by ``coordinator``."""
    tracer = MagicMock()
    tracer.start_memory_extract_span.return_value = MagicMock(name="extract_span")
    with patch("strands.memory.extraction.coordinator.get_tracer", return_value=tracer):
        yield tracer


async def test_extract_records_root_span(mock_coordinator_tracer):
    """A successful extraction starts a root span and ends OK."""
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    coordinator.record({"role": "user", "content": [{"text": "remember dark mode"}]})

    await coordinator._extract(store)

    mock_coordinator_tracer.start_memory_extract_span.assert_called_once()
    end_call = mock_coordinator_tracer.end_memory_extract_span.call_args
    assert end_call.kwargs.get("error") is None
    store.add_messages.assert_awaited_once()


async def test_extract_failure_ends_with_error_and_is_swallowed(mock_coordinator_tracer):
    """A failing write ends the extract span with the error but never raises."""
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    store.add_messages = AsyncMock(side_effect=RuntimeError("backend down"))
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    coordinator.record({"role": "user", "content": [{"text": "remember dark mode"}]})

    # Must not raise: saving never breaks the agent loop.
    await coordinator._extract(store)

    end_call = mock_coordinator_tracer.end_memory_extract_span.call_args
    assert isinstance(end_call.kwargs["error"], RuntimeError)


async def test_extract_no_fresh_messages_creates_no_span(mock_coordinator_tracer):
    """An empty buffer (nothing fresh) creates no extract span."""
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())

    await coordinator._extract(store)

    mock_coordinator_tracer.start_memory_extract_span.assert_not_called()


async def test_extract_with_extractor_records_entry_count(mock_coordinator_tracer):
    """The extractor path passes the written entry count to the span end."""
    extractor = SimpleNamespace(
        extract=AsyncMock(return_value=[ExtractionResult(content="fact one"), ExtractionResult(content="fact two")])
    )
    store = _store(
        "personal",
        writable=True,
        sinks={"add"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()], extractor=extractor),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    coordinator.record({"role": "user", "content": [{"text": "remember two things"}]})

    await coordinator._extract(store)

    # The count is threaded to the real span via end_memory_extract_span, not an implicit current span.
    mock_coordinator_tracer.end_memory_extract_span.assert_called_once_with(
        mock_coordinator_tracer.start_memory_extract_span.return_value, entry_count=2
    )


async def test_extract_fully_filtered_records_zero_entries(mock_coordinator_tracer):
    """A turn whose messages are entirely filtered out records entry_count=0, not nothing."""
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    # The default filter excludes toolResult blocks, so this message is fully filtered.
    coordinator.record({"role": "user", "content": [{"toolResult": {"toolUseId": "1", "content": []}}]})

    await coordinator._extract(store)

    store.add_messages.assert_not_awaited()
    mock_coordinator_tracer.end_memory_extract_span.assert_called_once_with(
        mock_coordinator_tracer.start_memory_extract_span.return_value, entry_count=0
    )


async def test_extract_telemetry_failure_does_not_corrupt_save(mock_coordinator_tracer):
    """A span failure after a successful save must not raise nor mark the save as failed."""
    # Ending the span raises, simulating a broken tracer provider.
    mock_coordinator_tracer.end_memory_extract_span.side_effect = RuntimeError("tracer down")
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    coordinator.record({"role": "user", "content": [{"text": "remember dark mode"}]})

    # Must not raise despite the telemetry failure.
    await coordinator._extract(store)

    # The save itself succeeded and was not rolled back / marked failed.
    store.add_messages.assert_awaited_once()
    assert coordinator._consecutive_failures.get(id(store), 0) == 0


async def test_schedule_captures_live_agent_span_as_link(mock_coordinator_tracer):
    """When scheduled inside a live recording span, that span is captured for linking."""
    store = _store(
        "personal",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(triggers=[InvocationTrigger()]),
    )
    coordinator = ExtractionCoordinator([_binding(store)], default_model=MagicMock())
    coordinator.record({"role": "user", "content": [{"text": "remember dark mode"}]})

    live_span = MagicMock()
    live_span.is_recording.return_value = True
    live_span.get_span_context.return_value = MagicMock(is_valid=True)
    with patch("strands.memory.extraction.coordinator.trace_api.get_current_span", return_value=live_span):
        link_context = coordinator._current_span_context()
        assert link_context is live_span.get_span_context.return_value

        # And a non-recording span yields no link context.
        live_span.is_recording.return_value = False
        assert coordinator._current_span_context() is None
