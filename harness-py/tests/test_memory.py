"""Tests for file-based memory resolution and its wiring into ``create_harness``.

Manager internals (``_search_stores``, ``_extraction_stores``) are read directly: they are the only
seam to assert the harness's policy (which stores are managed, which model extraction runs on) without a
live model. The helpers raise loudly if the SDK renames a field, so an SDK bump fails here with an
actionable message rather than a cryptic ``None`` downstream.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from strands.agent.state import AgentState
from strands.memory import MemoryEntry, MemoryManager, MemoryStore
from strands.models import BedrockModel, Model, ModelRouter
from strands.vended_memory_stores.file_memory_store import FileMemoryStore

from strands_harness import agent as agent_module
from strands_harness import create_harness, resolve_memory
from strands_harness.memory import _ReadOnlyStore
from strands_harness.options import _normalize_builtin_tools
from strands_harness.tools.subagent import build_default_subagent

DEFAULT_MODEL = "bedrock/global.anthropic.claude-opus-4-8"

_MISSING = object()


def _stores_of(manager: MemoryManager) -> list[MemoryStore]:
    stores = getattr(manager, "_search_stores", _MISSING)
    if stores is _MISSING:
        raise AttributeError("MemoryManager._search_stores shape changed; update this test for the new SDK internals.")
    return stores


def _store_of(manager: MemoryManager) -> MemoryStore:
    stores = _stores_of(manager)
    if not stores:
        raise AssertionError("MemoryManager wraps no stores; expected at least one.")
    return stores[0]


def _extraction_model(manager: MemoryManager) -> Model | None:
    bindings = getattr(manager, "_extraction_stores", _MISSING)
    if bindings is _MISSING:
        raise AttributeError(
            "MemoryManager._extraction_stores shape changed; update this test for the new SDK internals."
        )
    if not bindings:
        return None
    extractor = bindings[0].config.extractor
    return getattr(extractor, "_model", None) if extractor is not None else None


def _model_id(model: Model | None) -> str | None:
    return model.config["model_id"] if model is not None else None


def _tool_names(manager: MemoryManager) -> list[str]:
    return [tool.tool_name for tool in manager.tools]


def _injection_trigger(manager: MemoryManager) -> object:
    config = getattr(manager, "_injection_config", _MISSING)
    if config is _MISSING:
        raise AttributeError(
            "MemoryManager._injection_config shape changed; update this test for the new SDK internals."
        )
    if not isinstance(config, dict):
        raise AssertionError(f"expected an enabled injection config, got {config!r}")
    return config.get("trigger")


class _StubStore:
    """A minimal consumer store, used to assert pass-through and read-only wrapping."""

    def __init__(self, name: str, *, writable: bool) -> None:
        self.name = name
        self.writable = writable
        self.description = None
        self.max_search_results = None
        self.extraction = None

    async def search(self, query: str, options=None) -> list[MemoryEntry]:
        return []

    async def add(self, content: str, metadata=None) -> str:
        return content


class TestResolveMemory:
    def test_builds_writable_file_store_named_memory(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path))
        assert isinstance(manager, MemoryManager)
        store = _store_of(manager)
        assert isinstance(store, FileMemoryStore)
        assert store.name == "memory"
        assert store.writable is True

    def test_exposes_search_but_no_add_tool(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path))
        names = _tool_names(manager)
        assert "search_memory" in names
        assert "add_memory" not in names

    def test_distills_on_the_small_provider_model(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path))
        assert _model_id(_extraction_model(manager)) == "global.anthropic.claude-haiku-4-5-20251001-v1:0"

    def test_extracts_on_a_router_default_model(self, tmp_path):
        default = BedrockModel(model_id="fast")
        router = ModelRouter([default, BedrockModel(model_id="deep")])
        manager = resolve_memory(model=router, memory_dir=str(tmp_path))
        assert _extraction_model(manager) is default

    async def test_writes_files_flat_under_the_memory_dir(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path))
        await _store_of(manager).add("# Stack\nThe user works in Python.")
        stack = tmp_path / "stack.md"
        assert stack.exists()
        assert "Python" in stack.read_text()

    def test_extracts_on_an_explicit_web_fetch_model_override(self, tmp_path):
        manager = resolve_memory(
            model=DEFAULT_MODEL,
            memory_dir=str(tmp_path),
            web_fetch_model="bedrock/us.amazon.nova-lite-v1:0",
        )
        assert _model_id(_extraction_model(manager)) == "us.amazon.nova-lite-v1:0"

    def test_injects_on_every_turn(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path))
        assert _injection_trigger(manager) == "everyTurn"

    def test_recall_only_store_when_not_writable(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path), writable=False)
        store = _store_of(manager)
        assert isinstance(store, FileMemoryStore)
        assert store.writable is False
        assert "search_memory" in _tool_names(manager)
        assert _extraction_model(manager) is None
        assert _injection_trigger(manager) == "everyTurn"

    def test_manages_consumer_supplied_stores(self):
        first = _StubStore("first", writable=True)
        second = _StubStore("second", writable=False)
        manager = resolve_memory(stores=[first, second])
        assert _stores_of(manager) == [first, second]

    def test_empty_stores_list_falls_back_to_default(self, tmp_path):
        manager = resolve_memory(model=DEFAULT_MODEL, memory_dir=str(tmp_path), stores=[])
        store = _store_of(manager)
        assert isinstance(store, FileMemoryStore)
        assert store.name == "memory"

    async def test_wraps_consumer_stores_read_only_when_not_writable(self):
        entries = [MemoryEntry(content="recalled")]

        class _Backing:
            def __init__(self) -> None:
                self.name = "backing"
                self.description = "org knowledge"
                self.max_search_results = 7
                self.writable = True
                self.initialize = AsyncMock()

            async def search(self, query: str, options=None) -> list[MemoryEntry]:
                return entries

            async def add(self, content: str, metadata=None) -> str:
                return content

            async def add_messages(self, messages) -> None:
                return None

        backing = _Backing()
        manager = resolve_memory(stores=backing, writable=False)
        view = _store_of(manager)
        assert isinstance(view, _ReadOnlyStore)
        assert view.name == "backing"
        assert view.description == "org knowledge"
        assert view.max_search_results == 7
        assert view.writable is False
        assert not hasattr(view, "add")
        assert not hasattr(view, "add_messages")
        assert not hasattr(view, "get_tools")
        assert await view.search("anything") == entries
        await view.initialize()
        backing.initialize.assert_awaited_once()
        assert _extraction_model(manager) is None
        assert "search_memory" in _tool_names(manager)


class TestCreateHarnessMemory:
    def test_attaches_a_memory_manager_by_default(self, tmp_path):
        agent = create_harness(memory={"dir": str(tmp_path)})
        assert isinstance(agent.memory_manager, MemoryManager)

    def test_empty_config_is_on_with_harness_defaults(self, monkeypatch, tmp_path):
        monkeypatch.chdir(tmp_path)
        agent = create_harness(memory={})
        assert isinstance(agent.memory_manager, MemoryManager)
        assert _store_of(agent.memory_manager).name == "memory"

    def test_no_manager_when_memory_disabled(self):
        agent = create_harness(memory=False)
        assert agent.memory_manager is None

    def test_treats_none_as_disabled(self):
        agent = create_harness(memory=None)
        assert agent.memory_manager is None

    def test_explicit_memory_manager_kwarg_wins(self):
        explicit = MemoryManager(stores=[_StubStore("custom", writable=False)])
        agent = create_harness(memory_manager=explicit)
        assert agent.memory_manager is explicit

    def test_memory_manager_instance_is_used_verbatim(self):
        explicit = MemoryManager(stores=[_StubStore("custom", writable=False)])
        agent = create_harness(memory=explicit)
        assert agent.memory_manager is explicit

    async def test_honors_a_custom_memory_dir(self, tmp_path):
        agent = create_harness(memory={"dir": str(tmp_path)})
        await _store_of(agent.memory_manager).add("# Note\nremember this")
        assert (tmp_path / "note.md").exists()

    def test_manages_consumer_memory_stores_under_policy(self):
        custom = _StubStore("custom", writable=True)
        agent = create_harness(memory={"stores": [custom]})
        assert _store_of(agent.memory_manager) is custom
        assert "search_memory" in _tool_names(agent.memory_manager)


class _StubResult:
    stop_reason = "end_turn"
    interrupts: list = []

    def __str__(self) -> str:
        return "done"


class _StubAgent:
    def __init__(self) -> None:
        self.state = AgentState()
        self._interrupt_state = SimpleNamespace(activated=False, interrupts={})

    async def stream_async(self, prompt, cancel_signal=None):
        yield {"result": _StubResult()}


def _parent_config(**overrides):
    config = {
        "model": None,
        "effort": "auto",
        "caching": None,
        "context_manager": "auto",
        "builtin_tools": _normalize_builtin_tools(None),
        "builtin_plugins": None,
        "skills": False,
        "memory": False,
        "session": False,
        "interventions": None,
    }
    config.update(overrides)
    return config


async def _run_subagent(tool):
    tool_use = {"toolUseId": "t1", "name": "subagent", "input": {"task": "do it"}}
    async for _ in tool.stream(tool_use, {"agent": None}):
        pass


class TestSubagentMemoryForwarding:
    async def test_delegate_gets_a_recall_only_manager_when_memory_on(self, tmp_path):
        captured: dict = {}

        def fake_factory(**kwargs):
            captured.update(kwargs)
            return _StubAgent()

        tool = build_default_subagent(fake_factory, _parent_config(memory={"dir": str(tmp_path)}))
        await _run_subagent(tool)

        manager = captured["memory"]
        assert isinstance(manager, MemoryManager)
        assert _store_of(manager).writable is False
        assert _extraction_model(manager) is None
        assert "memory_manager" not in captured

    async def test_delegate_shares_the_parent_stores_read_only(self, tmp_path):
        captured: dict = {}
        store = _StubStore("custom", writable=True)

        def fake_factory(**kwargs):
            captured.update(kwargs)
            return _StubAgent()

        tool = build_default_subagent(fake_factory, _parent_config(memory={"stores": [store]}))
        await _run_subagent(tool)

        wrapped = _store_of(captured["memory"])
        assert isinstance(wrapped, _ReadOnlyStore)
        assert wrapped.writable is False

    async def test_delegate_gets_no_manager_when_parent_memory_off(self, tmp_path):
        captured: dict = {}

        def fake_factory(**kwargs):
            captured.update(kwargs)
            return _StubAgent()

        tool = build_default_subagent(fake_factory, _parent_config(memory=False))
        await _run_subagent(tool)

        assert captured["memory"] is False

    async def test_memory_false_opts_the_delegate_out(self, tmp_path):
        captured: dict = {}

        def fake_factory(**kwargs):
            captured.update(kwargs)
            return _StubAgent()

        tool = build_default_subagent(fake_factory, _parent_config(memory={"dir": str(tmp_path)}), memory=False)
        await _run_subagent(tool)

        assert captured["memory"] is False

    def test_parent_custom_manager_disables_delegate_memory(self, monkeypatch):
        captured: list[dict] = []

        def capturing(build_agent, parent_config, **kwargs):
            captured.append(parent_config)
            return build_default_subagent(build_agent, parent_config, **kwargs)

        monkeypatch.setattr(agent_module, "build_default_subagent", capturing)
        create_harness(memory_manager=MemoryManager(stores=[_StubStore("custom", writable=False)]))
        assert captured[0]["memory"] is False

    def test_parent_memory_store_forwarded_to_delegate(self, monkeypatch):
        captured: list[dict] = []

        def capturing(build_agent, parent_config, **kwargs):
            captured.append(parent_config)
            return build_default_subagent(build_agent, parent_config, **kwargs)

        store = _StubStore("custom", writable=True)
        monkeypatch.setattr(agent_module, "build_default_subagent", capturing)
        create_harness(memory={"stores": [store]})
        assert captured[0]["memory"] == {"stores": [store]}

    def test_parent_memory_true_forwards_an_empty_config(self, monkeypatch):
        captured: list[dict] = []

        def capturing(build_agent, parent_config, **kwargs):
            captured.append(parent_config)
            return build_default_subagent(build_agent, parent_config, **kwargs)

        monkeypatch.setattr(agent_module, "build_default_subagent", capturing)
        create_harness(memory=True)
        assert captured[0]["memory"] == {}


@pytest.mark.parametrize("value", [True, {}])
def test_memory_default_is_on(value):
    agent = create_harness(memory=value)
    assert isinstance(agent.memory_manager, MemoryManager)


def test_memory_auto_string_is_no_longer_accepted():
    with pytest.raises(ValueError, match=r"not a string \('auto'\); \"auto\" is no longer a value"):
        create_harness(memory="auto")
