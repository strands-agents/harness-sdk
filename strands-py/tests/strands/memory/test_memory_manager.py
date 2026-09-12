"""Tests for ``MemoryManager``.

Ported from ``strands-ts/src/memory/__tests__/memory-manager.test.ts`` and the
manager-level / ``initAgent`` parts of
``strands-ts/src/memory/extraction/__tests__/extraction.test.ts``. Each TS
``it(...)`` maps to a ``test_...`` case here.

These tests are written test-first: ``MemoryManager`` lands in Task 10, so they
are expected to fail with an ``ImportError`` until that implementation exists.

Driving the built tools
-----------------------
The manager builds ``search_memory`` / ``add_memory`` via the ``tool()`` factory
wrapping async closures. ``DecoratedFunctionTool.__call__`` delegates straight to
the wrapped function, so a test invokes a tool by calling it with kwargs and
awaiting the returned coroutine (e.g. ``await search_tool(query="q")``). This
exercises the full closure (scope resolution + ``MemoryManager.search`` /
``.add``) without the agent runtime.

Fake stores
-----------
``_store`` builds each fake store as an instance of a freshly-created class whose
``search`` / ``add`` / ``add_messages`` / ``get_tools`` live on the *class* (as
mocks). The manager detects optional methods with ``_has_method``, which inspects
``type(store)`` (not the instance) -- so optional methods must be class
attributes, and are only defined when the store is meant to expose them. This
mirrors the TS ``createMockStore`` (writable -> ``add``; ``tools=`` ->
``get_tools``) and ``createExtractionStore`` helpers.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from strands._middleware.stages import InvokeModelContext, InvokeModelStage
from strands.hooks.events import AfterInvocationEvent, MessageAddedEvent
from strands.hooks.registry import HookOrder
from strands.memory import AggregateMemoryError
from strands.memory.extraction.model_extractor import ModelExtractor
from strands.memory.extraction.triggers import IntervalTrigger, InvocationTrigger
from strands.memory.extraction.types import ExtractionConfig, ExtractionResult
from strands.memory.memory_manager import DEFAULT_MAX_ENTRIES, DEFAULT_MAX_SEARCH_RESULTS, MemoryManager
from strands.memory.types import (
    MemoryAddOptions,
    MemoryAddToolConfig,
    MemoryEntry,
    MemoryInjectionConfig,
    MemorySearchOptions,
    MemoryStore,
    MemoryToolConfig,
    SearchOptions,
    _has_method,
    _has_write_sink,
)
from strands.tools.decorator import tool

# --------------------------------------------------------------------------- #
# Test fakes / helpers
# --------------------------------------------------------------------------- #


def _store(
    name: str,
    *,
    entries: list[MemoryEntry] | None = None,
    writable: bool = False,
    description: str | None = None,
    max_search_results: int | None = None,
    tools: list[Any] | None = None,
    extraction: ExtractionConfig | None = None,
    sinks: set[str] | None = None,
    search_error: BaseException | None = None,
    add_error: BaseException | None = None,
    add_messages_error: BaseException | None = None,
) -> Any:
    """Build a fake ``MemoryStore``.

    Optional write/tool methods are placed on a freshly-created class so the
    manager's ``_has_method`` (which inspects ``type(store)``) detects only the
    capabilities the store is meant to expose.

    Args:
        name: Store name.
        entries: Entries the store's ``search`` returns (manager attributes them).
        writable: Whether the store accepts writes.
        description: Store description (surfaces in tool descriptions).
        max_search_results: Per-store default search limit.
        tools: When given, the store exposes ``get_tools`` returning these.
        extraction: Extraction config for the store.
        sinks: Which write sinks to expose (subset of ``{"add", "add_messages"}``).
            Defaults to ``{"add"}`` when ``writable`` else no sinks.
        search_error: When set, ``search`` raises this.
        add_error: When set, ``add`` raises this.
        add_messages_error: When set, ``add_messages`` raises this.
    """
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
        methods["add_messages"] = (
            AsyncMock(side_effect=add_messages_error)
            if add_messages_error is not None
            else AsyncMock(return_value=None)
        )
    if tools is not None:
        methods["get_tools"] = MagicMock(return_value=list(tools))

    store_cls = type(f"_FakeStore_{name}", (), dict(methods))
    store = store_cls()
    store.name = name
    store.description = description
    store.max_search_results = max_search_results
    store.writable = writable
    store.extraction = extraction
    return store


def _make_extractor(entries: list[ExtractionResult]) -> Any:
    """Build a fake ``Extractor`` whose ``extract`` is an ``AsyncMock``."""
    extractor = SimpleNamespace()
    extractor.extract = AsyncMock(return_value=list(entries))
    return extractor


def _named_tool(name: str) -> Any:
    """Build a named function tool (mirrors the TS ``createNamedTool``)."""

    @tool(name=name, description=f"test tool {name}")
    def _t() -> str:
        return "ok"

    return _t


def _tool_named(mm: MemoryManager, name: str) -> Any:
    """Return the manager-registered tool with the given ``tool_name``."""
    for built in mm.tools:
        if built.tool_name == name:
            return built
    registered_names = [registered_tool.tool_name for registered_tool in mm.tools]
    raise AssertionError(f"tool {name!r} not registered; have {registered_names}")


def _tool_names(mm: MemoryManager) -> list[str]:
    return [registered_tool.tool_name for registered_tool in mm.tools]


def _added_metadata(call: Any) -> Any:
    """Pull the metadata argument from a recorded ``store.add`` call."""
    if len(call.args) > 1:
        return call.args[1]
    return call.kwargs.get("metadata")


def _added_content(call: Any) -> Any:
    """Pull the content argument from a recorded ``store.add`` call."""
    return call.args[0] if call.args else call.kwargs.get("content")


def _forwarded_max(mock: AsyncMock) -> Any:
    """Return the ``max_search_results`` forwarded to a store's ``search``."""
    call = mock.call_args
    options = call.args[1] if len(call.args) > 1 else call.kwargs.get("options")
    if options is None:
        return None
    if isinstance(options, dict):
        return options.get("max_search_results")
    return getattr(options, "max_search_results", None)


def _extractor_context(call: Any) -> Any:
    """Pull the ``ExtractorContext`` argument from a recorded ``extract`` call."""
    if len(call.args) > 1:
        return call.args[1]
    return call.kwargs.get("context")


def _user_msg(text: str) -> dict:
    return {"role": "user", "content": [{"text": text}]}


def _assistant_msg(text: str) -> dict:
    return {"role": "assistant", "content": [{"text": text}]}


class _FakeAgent:
    """Minimal agent stand-in for ``init_agent`` wiring.

    The manager uses ``agent.add_hook(callback, event_type, *, order=...)``,
    ``agent.model``, and ``agent._middleware_registry.add_middleware(...)`` (for
    default-on injection). Recorded hooks are kept as ``(callback, event_type,
    order)`` triples so tests can fire the matching events manually; the
    middleware registry is a mock so injection registration is a no-op here.
    """

    def __init__(self, model: Any = None) -> None:
        self.model = model
        self.state = MagicMock()
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


async def _add_messages(agent: _FakeAgent, *messages: dict) -> None:
    """Drive ``MessageAddedEvent`` for each message into the coordinator buffer."""
    for message in messages:
        await _invoke_all(agent, MessageAddedEvent(agent=agent, message=message))


async def _fire_invocation(agent: _FakeAgent, mm: MemoryManager) -> None:
    """Fire ``AfterInvocationEvent`` (drives triggers), then flush the manager."""
    await _invoke_all(agent, AfterInvocationEvent(agent=agent))
    await mm.flush()


# --------------------------------------------------------------------------- #
# Constructor / store validation (Requirement 2)
# --------------------------------------------------------------------------- #


def test_constructor_raises_when_stores_empty():
    with pytest.raises(Exception, match="at least one store is required"):
        MemoryManager(stores=[])


def test_constructor_creates_instance_with_valid_config_and_name():
    mm = MemoryManager(stores=[_store("test")])
    assert mm.name == "strands:memory-manager"


def test_constructor_raises_on_duplicate_store_name():
    with pytest.raises(Exception, match="duplicate store name"):
        MemoryManager(stores=[_store("dup"), _store("dup")])


def test_constructor_raises_when_writable_without_write_sink():
    broken = _store("broken", writable=True, sinks=set())
    with pytest.raises(Exception, match="no add or add_messages"):
        MemoryManager(stores=[broken])


@pytest.mark.asyncio
async def test_memory_store_subclass_inherited_defaults_are_not_capabilities():
    """A ``MemoryStore`` subclass implementing only ``search`` is a read-only store.

    Guards https://github.com/strands-agents/harness-sdk/issues/3965: the optional
    protocol methods carry default bodies so explicit subclasses are instantiable
    under static type checkers, and an inherited default must not register as an
    implemented capability.
    """

    class SearchOnlyStore(MemoryStore):
        def __init__(self) -> None:
            self.name = "search-only"
            self.description = None
            self.max_search_results = None
            self.writable = False
            self.extraction = None

        async def search(self, query: str, options: SearchOptions | None = None) -> list[MemoryEntry]:
            return []

    store = SearchOnlyStore()
    for method in ("add", "add_messages", "initialize", "get_tools"):
        assert not _has_method(store, method)
    assert not _has_write_sink(store)

    mm = MemoryManager(stores=[store])
    assert "add_memory" not in _tool_names(mm)
    with pytest.raises(Exception, match="no writable store matched"):
        await mm.add("fact")


def test_constructor_raises_when_add_tool_enabled_but_no_store_implements_add():
    with pytest.raises(Exception, match="no writable stores implement add"):
        MemoryManager(stores=[_store("a")], add_tool_config=True)


def test_constructor_allows_add_tool_config_true_with_single_writable_store():
    mm = MemoryManager(stores=[_store("a", writable=True)], add_tool_config=True)
    assert "add_memory" in _tool_names(mm)


def test_constructor_allows_add_tool_config_true_with_multiple_writable_stores():
    mm = MemoryManager(
        stores=[_store("a", writable=True), _store("b", writable=True)],
        add_tool_config=True,
    )
    assert "add_memory" in _tool_names(mm)


def test_constructor_raises_when_add_tool_config_stores_names_nonexistent():
    with pytest.raises(Exception, match="not found"):
        MemoryManager(
            stores=[_store("a", writable=True)],
            add_tool_config=MemoryAddToolConfig(stores=["nonexistent"]),
        )


def test_constructor_raises_when_add_tool_config_stores_names_non_writable():
    with pytest.raises(Exception, match="not writable"):
        MemoryManager(
            stores=[_store("a", writable=True), _store("readonly")],
            add_tool_config=MemoryAddToolConfig(stores=["readonly"]),
        )


def test_constructor_raises_when_add_tool_config_stores_names_writable_store_without_add():
    # R2.12: a referenced store is writable but exposes only ``add_messages`` (no
    # ``add``), so the add tool cannot write discrete entries to it. The
    # ``add``-capable peer keeps the construction otherwise valid up to this check.
    add_only = _store("add-only", writable=True, sinks={"add"})
    messages_only = _store("messages-only", writable=True, sinks={"add_messages"})
    with pytest.raises(Exception, match="has no add method"):
        MemoryManager(
            stores=[add_only, messages_only],
            add_tool_config=MemoryAddToolConfig(stores=["messages-only"]),
        )


@pytest.mark.asyncio
async def test_constructor_accepts_memory_store_instances_in_add_tool_config_stores():
    personal = _store("personal", writable=True)
    team = _store("team", writable=True)
    # Pass the store instance instead of its name; resolves by name to scope to it.
    mm = MemoryManager(stores=[personal, team], add_tool_config=MemoryAddToolConfig(stores=[personal]))

    await _tool_named(mm, "add_memory")(entries=["fact"])

    personal.add.assert_called_once()
    assert _added_content(personal.add.call_args) == "fact"
    team.add.assert_not_called()


def test_constructor_raises_when_add_tool_config_stores_instance_not_configured():
    configured = _store("configured", writable=True)
    stray = _store("stray", writable=True)
    with pytest.raises(Exception, match="not found"):
        MemoryManager(stores=[configured], add_tool_config=MemoryAddToolConfig(stores=[stray]))


# --- extraction-related construction validation (Requirement 2.5-2.8) ------- #


def test_constructor_raises_when_extraction_store_not_writable():
    store = _store("s", writable=False, sinks=set(), extraction=ExtractionConfig(trigger=InvocationTrigger()))
    with pytest.raises(Exception, match="not writable"):
        MemoryManager(stores=[store])


def test_constructor_raises_when_extraction_config_has_no_triggers():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=[]))
    with pytest.raises(Exception, match="no triggers"):
        MemoryManager(stores=[store])


def test_constructor_allows_store_writable_only_via_add_messages():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    # Should not raise.
    MemoryManager(stores=[store])


def test_constructor_rejects_add_tool_config_targeting_add_messages_only_store():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    with pytest.raises(Exception, match="no writable stores implement add"):
        MemoryManager(stores=[store], add_tool_config=True)


def test_constructor_raises_when_extraction_has_extractor_but_no_add():
    store = _store(
        "s",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(trigger=InvocationTrigger(), extractor=_make_extractor([])),
    )
    with pytest.raises(Exception, match="extractor but no add"):
        MemoryManager(stores=[store])


def test_constructor_defaults_add_only_store_to_model_extractor():
    # An add-only store with no explicit extractor resolves to a ModelExtractor
    # (capability-based default), so it is accepted -- its distilled entries are
    # written via ``add``. (In TS this is the ``boolean | ExtractionConfig`` shape;
    # Python mirrors it by resolving the same default extractor.)
    store = _store("s", writable=True, sinks={"add"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    mm = MemoryManager(stores=[store])
    binding = mm._extraction_stores[0]
    assert isinstance(binding.config.extractor, ModelExtractor)


def test_constructor_accepts_extraction_true_shorthand_on_add_messages_store():
    # ``extraction=True`` resolves to defaults: an add_messages store uses the
    # server-side passthrough (no extractor) and so requires only add_messages.
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=True)
    # Should not raise.
    MemoryManager(stores=[store])


def test_constructor_accepts_extraction_true_shorthand_on_add_only_store():
    # ``extraction=True`` on an add-only store resolves to a ModelExtractor, whose
    # entries are written via ``add`` -- so the add-only sink satisfies validation.
    store = _store("s", writable=True, sinks={"add"}, extraction=True)
    # Should not raise.
    MemoryManager(stores=[store])


def test_constructor_accepts_extraction_config_with_omitted_trigger():
    # An ``ExtractionConfig`` with no trigger defaults to an interval cadence, so it
    # has triggers and passes the "no triggers" validation.
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig())
    # Should not raise.
    MemoryManager(stores=[store])


@pytest.mark.asyncio
async def test_init_agent_extraction_true_defaults_to_interval_of_five():
    # With the default IntervalTrigger(turns=5), four invocations do not fire; the
    # fifth does. Drive the raw hook so interval gating is observable.
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=True)
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("a"))
    for _turn in range(4):
        await _invoke_all(agent, AfterInvocationEvent(agent=agent))
    store.add_messages.assert_not_called()

    await _invoke_all(agent, AfterInvocationEvent(agent=agent))  # fifth invocation fires
    await mm.flush()
    store.add_messages.assert_called_once()


@pytest.mark.asyncio
async def test_init_agent_extraction_true_on_add_only_store_uses_model_extractor():
    # ``extraction=True`` on an add-only store resolves to a ModelExtractor, which
    # calls the agent's model and writes distilled entries via ``add``.
    store = _store("s", writable=True, sinks={"add"}, extraction=True)
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    binding = mm._extraction_stores[0]
    assert isinstance(binding.config.extractor, ModelExtractor)


# --------------------------------------------------------------------------- #
# get_tools composition and ordering (Requirement 5)
# --------------------------------------------------------------------------- #


def test_get_tools_registers_search_tool_by_default():
    mm = MemoryManager(stores=[_store("test")])
    assert _tool_names(mm) == ["search_memory"]


def test_get_tools_registers_add_tool_when_enabled():
    mm = MemoryManager(stores=[_store("test", writable=True)], add_tool_config=True)
    assert _tool_names(mm) == ["search_memory", "add_memory"]


def test_get_tools_does_not_register_add_tool_by_default():
    mm = MemoryManager(stores=[_store("test", writable=True)])
    assert _tool_names(mm) == ["search_memory"]


def test_get_tools_empty_when_search_and_add_disabled_and_no_store_tools():
    mm = MemoryManager(
        stores=[_store("test", writable=True)],
        search_tool_config=False,
        add_tool_config=False,
    )
    assert mm.tools == []


def test_get_tools_uses_custom_tool_names():
    mm = MemoryManager(
        stores=[_store("test", writable=True)],
        search_tool_config=MemoryToolConfig(name="recall"),
        add_tool_config=MemoryAddToolConfig(name="remember"),
    )
    assert _tool_names(mm) == ["recall", "remember"]


def test_get_tools_includes_store_descriptions_in_search_description():
    store = _store("personal", description="User preferences")
    mm = MemoryManager(stores=[store])
    search = _tool_named(mm, "search_memory")
    description = search.tool_spec["description"]
    assert "personal: User preferences" in description
    assert "target one or more memory stores by name" in description


def test_get_tools_includes_store_descriptions_in_add_description():
    store = _store("notes", writable=True, description="Personal notes")
    mm = MemoryManager(stores=[store], add_tool_config=True)
    add = _tool_named(mm, "add_memory")
    description = add.tool_spec["description"]
    assert "notes: Personal notes" in description
    assert "target a specific store by name" in description


def test_get_tools_aggregates_tools_provided_by_a_store():
    store = _store("kb", tools=[_named_tool("kb_query")])
    mm = MemoryManager(stores=[store])
    assert _tool_names(mm) == ["search_memory", "kb_query"]


def test_get_tools_aggregates_store_tools_across_multiple_stores_with_manager_tools():
    store_a = _store("a", writable=True, tools=[_named_tool("a_tool")])
    store_b = _store("b", tools=[_named_tool("b_tool")])
    mm = MemoryManager(stores=[store_a, store_b], add_tool_config=True)
    assert _tool_names(mm) == ["search_memory", "add_memory", "a_tool", "b_tool"]


def test_get_tools_includes_store_tools_even_when_manager_registers_none():
    store = _store("kb", tools=[_named_tool("kb_query")])
    mm = MemoryManager(stores=[store], search_tool_config=False)
    assert _tool_names(mm) == ["kb_query"]


# --------------------------------------------------------------------------- #
# Programmatic search (Requirement 3)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_search_queries_all_stores_and_concatenates_results():
    store1 = _store("a", entries=[MemoryEntry(content="fact one")])
    store2 = _store("b", entries=[MemoryEntry(content="fact two")])
    mm = MemoryManager(stores=[store1, store2])

    results = await mm.search("query")

    assert results == [
        MemoryEntry(content="fact one", store_name="a"),
        MemoryEntry(content="fact two", store_name="b"),
    ]


@pytest.mark.asyncio
async def test_search_resolves_store_max_search_results_when_caller_omits():
    store = _store("a", max_search_results=5)
    mm = MemoryManager(stores=[store])

    await mm.search("query")

    assert _forwarded_max(store.search) == 5


@pytest.mark.asyncio
async def test_search_forwards_explicit_max_search_results_override():
    store = _store("a", max_search_results=5)
    mm = MemoryManager(stores=[store])

    await mm.search("query", MemorySearchOptions(max_search_results=2))

    assert _forwarded_max(store.search) == 2


@pytest.mark.asyncio
async def test_search_falls_back_to_default_when_neither_caller_nor_store_specifies():
    store = _store("a")
    mm = MemoryManager(stores=[store])

    await mm.search("query")

    assert _forwarded_max(store.search) == DEFAULT_MAX_SEARCH_RESULTS


@pytest.mark.asyncio
async def test_search_filters_to_named_stores():
    store1 = _store("personal", entries=[MemoryEntry(content="personal fact")])
    store2 = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[store1, store2])

    results = await mm.search("query", MemorySearchOptions(stores=["personal"]))

    assert results == [MemoryEntry(content="personal fact", store_name="personal")]
    store2.search.assert_not_called()


@pytest.mark.asyncio
async def test_search_skips_failing_stores_and_returns_the_rest():
    store1 = _store("failing", search_error=RuntimeError("network error"))
    store2 = _store("ok", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store1, store2])

    results = await mm.search("query")

    assert results == [MemoryEntry(content="fact", store_name="ok")]


@pytest.mark.asyncio
async def test_search_searches_all_stores_when_filter_omitted():
    store1 = _store("a", entries=[MemoryEntry(content="fact one")])
    store2 = _store("b", entries=[MemoryEntry(content="fact two")])
    mm = MemoryManager(stores=[store1, store2])

    results = await mm.search("query")

    assert results == [
        MemoryEntry(content="fact one", store_name="a"),
        MemoryEntry(content="fact two", store_name="b"),
    ]


@pytest.mark.asyncio
async def test_search_searches_no_stores_when_filter_is_empty_list():
    store1 = _store("a", entries=[MemoryEntry(content="fact one")])
    store2 = _store("b", entries=[MemoryEntry(content="fact two")])
    mm = MemoryManager(stores=[store1, store2])

    results = await mm.search("query", MemorySearchOptions(stores=[]))

    assert results == []
    store1.search.assert_not_called()
    store2.search.assert_not_called()


@pytest.mark.asyncio
async def test_search_raises_not_found_before_querying_when_named_store_missing():
    store = _store("personal", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store])

    with pytest.raises(Exception, match="not found"):
        await mm.search("query", MemorySearchOptions(stores=["nonexistent"]))
    store.search.assert_not_called()


# --------------------------------------------------------------------------- #
# Programmatic add (Requirement 4)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_add_writes_to_all_writable_stores():
    store1 = _store("a", writable=True)
    store2 = _store("b", writable=True)
    mm = MemoryManager(stores=[store1, store2])

    await mm.add("user likes coffee")

    assert _added_content(store1.add.call_args) == "user likes coffee"
    assert _added_metadata(store1.add.call_args) is None
    assert _added_content(store2.add.call_args) == "user likes coffee"
    assert _added_metadata(store2.add.call_args) is None


@pytest.mark.asyncio
async def test_add_passes_metadata_to_stores():
    store = _store("a", writable=True)
    mm = MemoryManager(stores=[store])

    await mm.add("fact", MemoryAddOptions(metadata={"source": "user"}))

    assert _added_content(store.add.call_args) == "fact"
    assert _added_metadata(store.add.call_args) == {"source": "user"}


@pytest.mark.asyncio
async def test_add_filters_to_named_stores():
    store1 = _store("personal", writable=True)
    store2 = _store("team", writable=True)
    mm = MemoryManager(stores=[store1, store2])

    await mm.add("my preference", MemoryAddOptions(stores=["personal"]))

    assert _added_content(store1.add.call_args) == "my preference"
    store2.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_dedupes_duplicate_store_names():
    store = _store("personal", writable=True)
    mm = MemoryManager(stores=[store])

    await mm.add("fact", MemoryAddOptions(stores=["personal", "personal"]))

    store.add.assert_called_once()


@pytest.mark.asyncio
async def test_add_raises_when_no_writable_stores_match():
    mm = MemoryManager(stores=[_store("a")])
    with pytest.raises(Exception, match="no writable store matched"):
        await mm.add("fact")


@pytest.mark.asyncio
async def test_add_raises_not_found_when_named_store_missing():
    mm = MemoryManager(stores=[_store("a", writable=True)])
    with pytest.raises(Exception, match="not found"):
        await mm.add("fact", MemoryAddOptions(stores=["nonexistent"]))


@pytest.mark.asyncio
async def test_add_raises_read_only_when_named_store_not_writable():
    mm = MemoryManager(stores=[_store("readonly")])
    with pytest.raises(Exception, match="read-only"):
        await mm.add("fact", MemoryAddOptions(stores=["readonly"]))


@pytest.mark.asyncio
async def test_add_awaits_writes_and_raises_aggregate_naming_failed_store():
    failing = _store("failing", writable=True, add_error=RuntimeError("write error"))
    ok = _store("ok", writable=True)
    mm = MemoryManager(stores=[failing, ok])

    with pytest.raises(AggregateMemoryError, match="failing") as exc_info:
        await mm.add("fact")

    # The remaining store still received its write (partial failure completes the rest).
    assert _added_content(ok.add.call_args) == "fact"
    assert len(exc_info.value.errors) == 1


# --------------------------------------------------------------------------- #
# Search tool scoping and attribution (Requirement 6)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_search_tool_queries_all_stores_when_stores_omitted():
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    team = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[personal, team])

    await _tool_named(mm, "search_memory")(query="q")

    personal.search.assert_called()
    team.search.assert_called()


@pytest.mark.asyncio
async def test_search_tool_treats_empty_stores_as_omitted():
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    team = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[personal, team])

    await _tool_named(mm, "search_memory")(query="q", stores=[])

    personal.search.assert_called()
    team.search.assert_called()


@pytest.mark.asyncio
async def test_search_tool_targets_only_the_requested_in_scope_store():
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    team = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[personal, team])

    await _tool_named(mm, "search_memory")(query="q", stores=["personal"])

    personal.search.assert_called()
    team.search.assert_not_called()


@pytest.mark.asyncio
async def test_search_tool_attributes_each_result_to_its_store():
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    team = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[personal, team])

    result = await _tool_named(mm, "search_memory")(query="q")

    assert result == [
        {"content": "personal fact", "store_name": "personal"},
        {"content": "team fact", "store_name": "team"},
    ]


@pytest.mark.asyncio
async def test_search_tool_keeps_valid_names_and_warns_on_out_of_scope(caplog):
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    team = _store("team", entries=[MemoryEntry(content="team fact")])
    mm = MemoryManager(stores=[personal, team])

    with caplog.at_level(logging.WARNING):
        await _tool_named(mm, "search_memory")(query="q", stores=["personal", "nonexistent"])

    personal.search.assert_called()
    team.search.assert_not_called()
    assert "nonexistent" in caplog.text


@pytest.mark.asyncio
async def test_search_tool_raises_when_every_requested_store_is_out_of_scope():
    personal = _store("personal", entries=[MemoryEntry(content="personal fact")])
    mm = MemoryManager(stores=[personal])

    with pytest.raises(Exception, match="none of the requested memory stores are available"):
        await _tool_named(mm, "search_memory")(query="q", stores=["nonexistent"])
    personal.search.assert_not_called()


# --------------------------------------------------------------------------- #
# Add tool scoping and write modes (Requirement 7)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_add_tool_writes_to_all_writable_stores_when_stores_omitted():
    personal = _store("personal", writable=True)
    team = _store("team", writable=True)
    mm = MemoryManager(stores=[personal, team], add_tool_config=True)

    await _tool_named(mm, "add_memory")(entries=["fact"])

    assert _added_content(personal.add.call_args) == "fact"
    assert _added_content(team.add.call_args) == "fact"


@pytest.mark.asyncio
async def test_add_tool_treats_empty_stores_as_omitted():
    personal = _store("personal", writable=True)
    team = _store("team", writable=True)
    mm = MemoryManager(stores=[personal, team], add_tool_config=True)

    await _tool_named(mm, "add_memory")(entries=["fact"], stores=[])

    personal.add.assert_called()
    team.add.assert_called()


@pytest.mark.asyncio
async def test_add_tool_is_scoped_to_allowlist_excluding_other_writable_stores():
    personal = _store("personal", writable=True)
    team = _store("team", writable=True)
    mm = MemoryManager(stores=[personal, team], add_tool_config=MemoryAddToolConfig(stores=["personal"]))

    # Omitting stores writes to the configured allowlist only -- not every writable store.
    await _tool_named(mm, "add_memory")(entries=["fact"])

    assert _added_content(personal.add.call_args) == "fact"
    team.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_tool_rejects_a_writable_store_excluded_from_allowlist():
    personal = _store("personal", writable=True)
    extraction_only = _store("extraction-only", writable=True)
    mm = MemoryManager(stores=[personal, extraction_only], add_tool_config=MemoryAddToolConfig(stores=["personal"]))

    with pytest.raises(Exception, match="none of the requested memory stores are available"):
        await _tool_named(mm, "add_memory")(entries=["fact"], stores=["extraction-only"])
    extraction_only.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_tool_excludes_read_only_stores_from_its_scope():
    personal = _store("personal", writable=True)
    readonly = _store("readonly")
    mm = MemoryManager(stores=[personal, readonly], add_tool_config=True)

    with pytest.raises(Exception, match="none of the requested memory stores are available"):
        await _tool_named(mm, "add_memory")(entries=["fact"], stores=["readonly"])
    personal.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_tool_keeps_valid_names_and_warns_on_out_of_scope(caplog):
    personal = _store("personal", writable=True)
    team = _store("team", writable=True)
    mm = MemoryManager(stores=[personal, team], add_tool_config=True)

    with caplog.at_level(logging.WARNING):
        await _tool_named(mm, "add_memory")(entries=["fact"], stores=["personal", "nonexistent"])

    assert _added_content(personal.add.call_args) == "fact"
    team.add.assert_not_called()
    assert "nonexistent" in caplog.text


@pytest.mark.asyncio
async def test_add_tool_raises_when_every_requested_store_is_out_of_scope():
    personal = _store("personal", writable=True)
    mm = MemoryManager(stores=[personal], add_tool_config=True)

    with pytest.raises(Exception, match="none of the requested memory stores are available"):
        await _tool_named(mm, "add_memory")(entries=["fact"], stores=["nonexistent"])
    personal.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_tool_rejects_an_empty_entries_list():
    # R7.2: an empty ``entries`` list is rejected without writing to any store.
    # NOTE: in TS this is enforced by the tool's Zod ``min(1)`` schema. The Python
    # @tool validation model is derived from the closure signature and does not
    # enforce the advertised JSON-schema ``minItems``, so calling the closure
    # directly relies on a manager-side guard. This test pins that guard.
    personal = _store("personal", writable=True)
    mm = MemoryManager(stores=[personal], add_tool_config=True)

    with pytest.raises(ValueError, match="requires at least one entry"):
        await _tool_named(mm, "add_memory")(entries=[])
    personal.add.assert_not_called()


@pytest.mark.asyncio
async def test_add_tool_returns_stored_count_by_default():
    store = _store("notes", writable=True)
    mm = MemoryManager(stores=[store], add_tool_config=True)

    result = await _tool_named(mm, "add_memory")(entries=["a", "b"])

    assert result == {"stored": 2}


@pytest.mark.asyncio
async def test_add_tool_raises_flattened_aggregate_with_concrete_reasons_on_failure():
    failing = _store("failing", writable=True, add_error=RuntimeError("write error"))
    mm = MemoryManager(stores=[failing], add_tool_config=True)

    with pytest.raises(AggregateMemoryError) as exc_info:
        await _tool_named(mm, "add_memory")(entries=["a", "b"])

    agg = exc_info.value
    assert "failed to add 2 of 2 entries" in str(agg)
    assert "write error" in str(agg)
    # Leaves are the underlying store errors, not the per-entry aggregate errors.
    assert len(agg.errors) == 2
    assert all(not isinstance(error, AggregateMemoryError) for error in agg.errors)


@pytest.mark.asyncio
async def test_add_tool_wait_for_writes_false_returns_accepted_count():
    store = _store("notes", writable=True)
    mm = MemoryManager(stores=[store], add_tool_config=MemoryAddToolConfig(wait_for_writes=False))

    result = await _tool_named(mm, "add_memory")(entries=["a", "b"])

    assert result == {"accepted": 2}
    await asyncio.sleep(0.05)  # let fire-and-forget writes drain


@pytest.mark.asyncio
async def test_add_tool_wait_for_writes_false_returns_accepted_even_when_a_write_fails():
    failing = _store("failing", writable=True, add_error=RuntimeError("write error"))
    mm = MemoryManager(stores=[failing], add_tool_config=MemoryAddToolConfig(wait_for_writes=False))

    result = await _tool_named(mm, "add_memory")(entries=["a", "b"])

    assert result == {"accepted": 2}
    await asyncio.sleep(0.05)  # let the (swallowed) failing writes drain


# --------------------------------------------------------------------------- #
# init_agent extraction wiring (Requirements 8, 9.1)
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_init_agent_does_not_throw_without_extraction():
    mm = MemoryManager(stores=[_store("test")])
    await mm.init_agent(_FakeAgent())  # should not raise


@pytest.mark.asyncio
async def test_init_agent_registers_no_hooks_when_no_store_has_extraction():
    store = _store("s", writable=True, sinks={"add"})
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()

    await mm.init_agent(agent)

    assert agent.hooks == []


@pytest.mark.asyncio
async def test_init_agent_no_extractor_passthrough_hands_raw_batch_to_add_messages():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("I prefer dark mode"), _assistant_msg("Noted"))
    await _fire_invocation(agent, mm)

    store.add_messages.assert_called_once()
    batch = store.add_messages.call_args.args[0]
    assert len(batch) == 2
    assert batch[0]["role"] == "user"
    assert batch[1]["role"] == "assistant"


@pytest.mark.asyncio
async def test_init_agent_extractor_route_writes_each_entry_via_add():
    extractor = _make_extractor([ExtractionResult(content="fact one"), ExtractionResult(content="fact two")])
    # The store exposes both sinks so the ``add_messages.assert_not_called()``
    # check below is a real assertion against a mock (not an AttributeError on a
    # missing attribute); the extractor route must still write via ``add`` only.
    store = _store(
        "s",
        writable=True,
        sinks={"add", "add_messages"},
        extraction=ExtractionConfig(trigger=InvocationTrigger(), extractor=extractor),
    )
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("something happened"))
    await _fire_invocation(agent, mm)

    extractor.extract.assert_called_once()
    assert store.add.call_count == 2
    store.add_messages.assert_not_called()


@pytest.mark.asyncio
async def test_init_agent_passes_agent_model_as_default_model_to_extractor():
    extractor = _make_extractor([])
    store = _store(
        "s",
        writable=True,
        sinks={"add"},
        extraction=ExtractionConfig(trigger=InvocationTrigger(), extractor=extractor),
    )
    mm = MemoryManager(stores=[store])
    fake_model = SimpleNamespace(id="model")
    agent = _FakeAgent(model=fake_model)
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("hi"))
    await _fire_invocation(agent, mm)

    extractor.extract.assert_called_once()
    context = _extractor_context(extractor.extract.call_args)
    assert context is not None
    assert context.default_model is fake_model


@pytest.mark.asyncio
async def test_init_agent_interval_trigger_fires_every_n_invocations():
    store = _store(
        "s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=IntervalTrigger(turns=2))
    )
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    # Fire the raw hook (not the flushing helper) so we observe interval gating.
    await _add_messages(agent, _user_msg("a"))
    await _invoke_all(agent, AfterInvocationEvent(agent=agent))  # count 1, no fire
    store.add_messages.assert_not_called()

    await _add_messages(agent, _user_msg("b"))
    await _fire_invocation(agent, mm)  # count 2, fire (+ flush drains it)
    store.add_messages.assert_called_once()
    assert len(store.add_messages.call_args.args[0]) == 2


@pytest.mark.asyncio
async def test_init_agent_accepts_a_single_trigger_not_wrapped_in_a_list():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("hi"))
    await _fire_invocation(agent, mm)

    store.add_messages.assert_called_once()


@pytest.mark.asyncio
async def test_init_agent_composes_multiple_triggers_fires_on_any():
    store = _store(
        "s",
        writable=True,
        sinks={"add_messages"},
        extraction=ExtractionConfig(trigger=[IntervalTrigger(turns=2), InvocationTrigger()]),
    )
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("a"))
    await _fire_invocation(agent, mm)

    # The invocation trigger fired on turn 1 even though the interval would not have.
    store.add_messages.assert_called_once()


@pytest.mark.asyncio
async def test_flush_is_a_no_op_when_extraction_is_not_configured():
    store = _store("s", writable=True, sinks={"add"})
    mm = MemoryManager(stores=[store])
    await mm.init_agent(_FakeAgent())

    assert await mm.flush() is None


@pytest.mark.asyncio
async def test_flush_force_extracts_a_buffered_tail_whose_trigger_never_fired():
    store = _store(
        "s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=IntervalTrigger(turns=5))
    )
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("a"))
    await _invoke_all(agent, AfterInvocationEvent(agent=agent))  # count 1, no fire
    await _add_messages(agent, _user_msg("b"))
    await _invoke_all(agent, AfterInvocationEvent(agent=agent))  # count 2, no fire
    store.add_messages.assert_not_called()

    await mm.flush()

    store.add_messages.assert_called_once()
    assert len(store.add_messages.call_args.args[0]) == 2


@pytest.mark.asyncio
async def test_flush_does_not_re_extract_messages_already_processed():
    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("a"))
    await _fire_invocation(agent, mm)  # already extracted + flushed
    store.add_messages.assert_called_once()

    await mm.flush()  # nothing fresh -> no-op
    store.add_messages.assert_called_once()


@pytest.mark.asyncio
async def test_init_agent_background_save_does_not_block_hook_and_flush_awaits_it():
    release = asyncio.Event()
    completed = {"v": False}

    async def add_messages_impl(messages: Any, context: Any = None) -> None:
        await release.wait()
        completed["v"] = True

    store = _store("s", writable=True, sinks={"add_messages"}, extraction=ExtractionConfig(trigger=InvocationTrigger()))
    store.add_messages.side_effect = add_messages_impl
    mm = MemoryManager(stores=[store])
    agent = _FakeAgent()
    await mm.init_agent(agent)

    await _add_messages(agent, _user_msg("hello"))
    # Fire the hook directly: it must return while the store write hangs.
    await _invoke_all(agent, AfterInvocationEvent(agent=agent))

    flushed = asyncio.ensure_future(mm.flush())
    await asyncio.sleep(0)
    assert completed["v"] is False

    release.set()
    await flushed
    assert completed["v"] is True


# --------------------------------------------------------------------------- #
# Injection
#
# Ported from the ``initAgent`` (injection registration) and ``injection``
# describe blocks of ``strands-ts/src/memory/__tests__/memory-manager.test.ts``.
#
# The injection delivery (folding text into the model input) is wired through the
# ``InvokeModelStage`` input middleware; the memory-owned provide pipeline (query
# derivation, search, formatting) is exercised directly via
# ``_provide_memory_context`` / ``_default_injection_format``, the callbacks the
# middleware invokes.
# --------------------------------------------------------------------------- #


def _tool_use_msg() -> dict:
    return {"role": "assistant", "content": [{"toolUse": {"toolUseId": "t1", "name": "x", "input": {}}}]}


def _tool_result_msg() -> dict:
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": "t1", "status": "success", "content": [{"text": "done"}]}}],
    }


class _InjectionAgent:
    """Agent stand-in that captures ``InvokeModelStage.Input`` middleware registrations."""

    def __init__(self) -> None:
        self.state = MagicMock()
        self._middleware_registry = MagicMock()

    @property
    def add_middleware_calls(self) -> Any:
        return self._middleware_registry.add_middleware.call_args_list


def _invoke_ctx(messages: list[dict], agent: Any) -> Any:
    return InvokeModelContext(
        agent=agent,
        messages=messages,
        system_prompt=None,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=getattr(agent, "model", None),
    )


async def _provide(mm: MemoryManager, messages: list[dict]) -> str | None:
    """Call the manager's provide pipeline with its resolved injection config (TS ``provide`` helper)."""
    config = mm._injection_config if mm._injection_config is not False else MemoryInjectionConfig()
    return await mm._provide_memory_context(messages, config)


# --- config resolution ---


def test_injection_defaults_to_enabled_when_omitted():
    assert MemoryManager(stores=[_store("s")])._injection_config == MemoryInjectionConfig()


def test_injection_is_disabled_when_explicitly_false():
    assert MemoryManager(stores=[_store("s")], injection=False)._injection_config is False


def test_injection_true_resolves_to_default_config():
    config = MemoryManager(stores=[_store("s")], injection=True)._injection_config
    assert config == MemoryInjectionConfig()


def test_injection_config_object_passes_through_unchanged():
    cfg = MemoryInjectionConfig(max_entries=5)
    assert MemoryManager(stores=[_store("s")], injection=cfg)._injection_config is cfg


# --- init_agent registration ---


@pytest.mark.asyncio
async def test_init_agent_does_not_register_injection_middleware_when_disabled():
    agent = _InjectionAgent()
    await MemoryManager(stores=[_store("s")], injection=False).init_agent(agent)
    agent._middleware_registry.add_middleware.assert_not_called()


@pytest.mark.asyncio
async def test_init_agent_registers_invoke_model_input_middleware_when_enabled():
    agent = _InjectionAgent()
    await MemoryManager(stores=[_store("s")], injection=True).init_agent(agent)

    agent._middleware_registry.add_middleware.assert_called_once()
    stage_or_phase, handler = agent.add_middleware_calls[0].args
    assert stage_or_phase is InvokeModelStage.Input
    assert callable(handler)


@pytest.mark.asyncio
async def test_init_agent_wires_middleware_to_provide_pipeline_folds_a_search_hit():
    store = _store("s", entries=[MemoryEntry(content="dark mode preferred")])
    agent = _InjectionAgent()
    await MemoryManager(stores=[store], injection=True).init_agent(agent)

    handler = agent.add_middleware_calls[0].args[1]
    messages = [_assistant_msg("prior"), _user_msg("what is my plan")]
    result = await handler(_invoke_ctx(messages, agent))

    assert result.messages == [
        {"role": "assistant", "content": [{"text": "prior"}]},
        {
            "role": "user",
            "content": [
                {"text": "what is my plan"},
                {"text": '\n\n<memory>\n<entry source="s">dark mode preferred</entry>\n</memory>'},
            ],
        },
    ]
    store.search.assert_called_once()
    assert store.search.call_args.args[0] == "what is my plan"


@pytest.mark.asyncio
async def test_init_agent_forwards_trigger_to_registered_middleware():
    # Default 'userTurn' would skip a tool-result turn; 'everyTurn' must fold on it, proving the
    # configured trigger is forwarded into the registered middleware.
    store = _store("s", entries=[MemoryEntry(content="fact")])
    agent = _InjectionAgent()
    await MemoryManager(stores=[store], injection=MemoryInjectionConfig(trigger="everyTurn")).init_agent(agent)

    handler = agent.add_middleware_calls[0].args[1]
    tool_result = _tool_result_msg()
    result = await handler(_invoke_ctx([_user_msg("task"), _assistant_msg("prev"), tool_result], agent))

    # everyTurn folds on the tool-result turn; the memory block is appended *after* the tool result
    # (which must stay first), and the query is derived from the most recent assistant text.
    assert result.messages == [
        {"role": "user", "content": [{"text": "task"}]},
        {"role": "assistant", "content": [{"text": "prev"}]},
        {
            "role": "user",
            "content": [
                tool_result["content"][0],
                {"text": '\n\n<memory>\n<entry source="s">fact</entry>\n</memory>'},
            ],
        },
    ]
    assert store.search.call_args.args[0] == "prev"


@pytest.mark.asyncio
async def test_init_agent_default_trigger_skips_tool_result_turn():
    # Default trigger is 'userTurn': a tool-result turn must be left untouched (no search, no fold).
    store = _store("s", entries=[MemoryEntry(content="fact")])
    agent = _InjectionAgent()
    await MemoryManager(stores=[store], injection=True).init_agent(agent)

    handler = agent.add_middleware_calls[0].args[1]
    messages = [_user_msg("task"), _assistant_msg("prev"), _tool_result_msg()]
    result = await handler(_invoke_ctx(messages, agent))

    assert result.messages == messages
    store.search.assert_not_called()


# --- query derivation ---


@pytest.mark.asyncio
async def test_injection_query_uses_latest_user_ask_on_user_turn():
    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=True)

    await _provide(mm, [_assistant_msg("prior step"), _user_msg("what is my plan")])

    assert store.search.call_args.args[0] == "what is my plan"
    assert _forwarded_max(store.search) == DEFAULT_MAX_ENTRIES


@pytest.mark.asyncio
async def test_injection_query_uses_recent_assistant_text_on_tool_result_turn():
    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=True)

    await _provide(mm, [_user_msg("task"), _assistant_msg("the previous step result"), _tool_result_msg()])

    assert store.search.call_args.args[0] == "the previous step result"


@pytest.mark.asyncio
async def test_injection_honors_a_custom_query():
    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=MemoryInjectionConfig(query=lambda context: "custom query"))

    await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")])

    assert store.search.call_args.args[0] == "custom query"


@pytest.mark.asyncio
async def test_injection_skips_when_custom_query_returns_none():
    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=MemoryInjectionConfig(query=lambda context: None))

    assert await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")]) is None
    store.search.assert_not_called()


@pytest.mark.asyncio
async def test_injection_fails_open_when_custom_query_raises():
    def boom(context: Any) -> str:
        raise ValueError("boom")

    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=MemoryInjectionConfig(query=boom))

    assert await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")]) is None
    store.search.assert_not_called()


@pytest.mark.asyncio
async def test_injection_skips_when_latest_assistant_message_has_no_text():
    store = _store("s", entries=[MemoryEntry(content="fact")])
    mm = MemoryManager(stores=[store], injection=True)

    assert await _provide(mm, [_tool_use_msg(), _tool_result_msg()]) is None
    store.search.assert_not_called()


# --- search ---


@pytest.mark.asyncio
async def test_injection_returns_none_when_search_yields_no_entries():
    store = _store("s", entries=[])
    mm = MemoryManager(stores=[store], injection=True)

    assert await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")]) is None
    store.search.assert_called()


@pytest.mark.asyncio
async def test_injection_honors_max_entries_and_caps_rendered_entries():
    store = _store("s", entries=[MemoryEntry(content="A"), MemoryEntry(content="B"), MemoryEntry(content="C")])
    mm = MemoryManager(
        stores=[store],
        injection=MemoryInjectionConfig(
            max_entries=2,
            format=lambda context: ",".join(entry.content for entry in context.entries),
        ),
    )

    text = await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")])

    assert store.search.call_args.args[0] == "ask"
    assert _forwarded_max(store.search) == 2
    assert text == "A,B"


# --- format ---


@pytest.mark.asyncio
async def test_injection_default_format_renders_memory_block_with_source():
    store = _store("s", entries=[MemoryEntry(content="dark mode preferred")])
    mm = MemoryManager(stores=[store], injection=True)

    # search() stamps store_name onto each entry, so the default format attributes the source.
    text = await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")])
    assert text == '<memory>\n<entry source="s">dark mode preferred</entry>\n</memory>'


def test_injection_default_format_omits_source_when_no_store_name():
    mm = MemoryManager(stores=[_store("s")], injection=True)
    text = mm._default_injection_format([MemoryEntry(content="no source")])
    assert text == "<memory>\n<entry>no source</entry>\n</memory>"


def test_injection_default_format_escapes_xml_in_content_and_source():
    mm = MemoryManager(stores=[_store("s")], injection=True)
    text = mm._default_injection_format([MemoryEntry(content="a < b & c > d </entry>", store_name='pre"f')])
    assert text == '<memory>\n<entry source="pre&quot;f">a &lt; b &amp; c &gt; d &lt;/entry&gt;</entry>\n</memory>'


@pytest.mark.asyncio
async def test_injection_honors_a_custom_format():
    store = _store("s", entries=[MemoryEntry(content="A")])
    mm = MemoryManager(
        stores=[store],
        injection=MemoryInjectionConfig(
            format=lambda context: f"[{'|'.join(entry.content for entry in context.entries)}]"
        ),
    )

    text = await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")])
    assert text == "[A]"


@pytest.mark.asyncio
async def test_injection_fails_open_when_custom_format_raises(caplog):
    def boom(context: Any) -> str:
        raise ValueError("boom")

    store = _store("s", entries=[MemoryEntry(content="A")])
    mm = MemoryManager(stores=[store], injection=MemoryInjectionConfig(format=boom))

    with caplog.at_level(logging.WARNING):
        assert await _provide(mm, [_assistant_msg("prior"), _user_msg("ask")]) is None
    assert "skipping injection" in caplog.text
