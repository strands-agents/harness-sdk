"""Tests for the ProgressiveToolDisclosure plugin internals."""

import copy
from types import SimpleNamespace
from typing import cast

import pytest

from strands._middleware.stages import InvokeModelContext
from strands.agent.agent import Agent
from strands.hooks.events import BeforeToolCallEvent
from strands.models.model import Model
from strands.types.tools import ToolContext
from strands.vended_plugins.progressive_tool_disclosure.index import ToolMatch
from strands.vended_plugins.progressive_tool_disclosure.plugin import (
    FIND_TOOLS_NAME,
    ProgressiveToolDisclosure,
    _compose_projection,
    _project,
    _should_passthrough,
    _union_referenced,
)


def test_projects_when_every_name_is_registered_and_search_tool_is_present():
    incoming = [FIND_TOOLS_NAME, "list_accounts"]
    registry = {FIND_TOOLS_NAME, "list_accounts", "get_balance"}

    assert _should_passthrough(incoming, registry) is False


def test_passthrough_when_a_name_is_absent_from_the_registry():
    """Forced structured output arrives as a synthetic spec that was never registered."""
    incoming = ["StructuredOutputTool"]
    registry = {FIND_TOOLS_NAME, "list_accounts"}

    assert _should_passthrough(incoming, registry) is True


def test_passthrough_when_the_search_tool_is_absent_from_the_call():
    """The window between init_agent and the registration of the vended tool."""
    incoming = ["list_accounts"]
    registry = {FIND_TOOLS_NAME, "list_accounts"}

    assert _should_passthrough(incoming, registry) is True


def test_passthrough_when_the_call_carries_no_specs_at_all():
    assert _should_passthrough([], {FIND_TOOLS_NAME}) is True


def _spec(name: str, description: str = "Does something useful.") -> dict:
    return {
        "name": name,
        "description": description,
        "inputSchema": {"json": {"type": "object", "properties": {"q": {"type": "string"}}}},
    }


_INCOMING = [
    _spec(FIND_TOOLS_NAME),
    _spec("list_accounts"),
    _spec("get_balance"),
    _spec("send_wire"),
    _spec("audit_log"),
]


def test_blocks_are_emitted_in_order_with_the_search_tool_first():
    projected = _compose_projection(
        _INCOMING,
        exposed={"send_wire"},
        referenced={"audit_log"},
        always_available={"get_balance"},
        catalog_tokens=20,
    )

    assert [s["name"] for s in projected] == [
        FIND_TOOLS_NAME,
        "get_balance",
        "send_wire",
        "audit_log",
        "list_accounts",
    ]


def test_order_inside_a_block_follows_the_incoming_order():
    """Not the order of the block's own container: two exposures come out as they arrived."""
    projected = _compose_projection(
        _INCOMING,
        exposed={"audit_log", "list_accounts"},
        referenced=set(),
        always_available=(),
        catalog_tokens=None,
    )

    assert [s["name"] for s in projected] == [FIND_TOOLS_NAME, "list_accounts", "audit_log"]


def test_full_specification_wins_over_the_catalog_entry():
    projected = _compose_projection(
        _INCOMING,
        exposed={"list_accounts"},
        referenced={"list_accounts"},
        always_available={"list_accounts"},
        catalog_tokens=20,
    )

    names = [s["name"] for s in projected]
    assert names.count("list_accounts") == 1
    by_name = {s["name"]: s for s in projected}
    assert by_name["list_accounts"]["inputSchema"]["json"]["properties"] == {"q": {"type": "string"}}
    assert by_name["get_balance"]["inputSchema"]["json"]["properties"] == {}


def test_always_available_name_absent_from_the_call_is_omitted():
    projected = _compose_projection(
        _INCOMING,
        exposed=set(),
        referenced=set(),
        always_available={"deploy_to_prod"},
        catalog_tokens=None,
    )

    assert [s["name"] for s in projected] == [FIND_TOOLS_NAME]


def test_referenced_name_absent_from_the_call_is_omitted():
    projected = _compose_projection(
        _INCOMING,
        exposed=set(),
        referenced={"retired_tool"},
        always_available=(),
        catalog_tokens=None,
    )

    assert [s["name"] for s in projected] == [FIND_TOOLS_NAME]


def test_catalog_tokens_none_omits_every_catalog_entry_and_keeps_the_other_blocks():
    projected = _compose_projection(
        _INCOMING,
        exposed={"send_wire"},
        referenced={"audit_log"},
        always_available={"get_balance"},
        catalog_tokens=None,
    )

    assert [s["name"] for s in projected] == [FIND_TOOLS_NAME, "get_balance", "send_wire", "audit_log"]


def test_catalog_entry_is_built_for_every_tool_left_over():
    projected = _compose_projection(_INCOMING, set(), set(), (), catalog_tokens=20)

    assert [s["name"] for s in projected] == [s["name"] for s in _INCOMING]
    assert all(s["inputSchema"]["json"]["properties"] == {} for s in projected[1:])


def test_projection_never_repeats_a_name_and_stays_a_subset_of_the_call():
    projected = _compose_projection(
        _INCOMING,
        exposed={FIND_TOOLS_NAME, "send_wire"},
        referenced={FIND_TOOLS_NAME, "send_wire", "audit_log"},
        always_available=[FIND_TOOLS_NAME, "send_wire"],
        catalog_tokens=20,
    )

    names = [s["name"] for s in projected]
    assert len(names) == len(set(names))
    assert set(names) <= {s["name"] for s in _INCOMING}


def test_incoming_specs_are_not_mutated():
    before = copy.deepcopy(_INCOMING)
    _compose_projection(_INCOMING, {"send_wire"}, set(), ("get_balance",), catalog_tokens=1)
    assert _INCOMING == before


def test_project_replaces_tool_specs_and_leaves_every_other_field_alone():
    context = InvokeModelContext(
        agent=cast("Agent", object()),
        messages=[{"role": "user", "content": [{"text": "hi"}]}],
        system_prompt="be brief",
        tool_specs=list(_INCOMING),
        tool_choice=None,
        invocation_state={"k": "v"},
        model=cast("Model", object()),
    )

    result = _project(context, exposed={"send_wire"}, referenced=set(), always_available=(), catalog_tokens=None)

    assert result is not context
    assert [s["name"] for s in result.tool_specs] == [FIND_TOOLS_NAME, "send_wire"]
    assert [s["name"] for s in context.tool_specs] == [s["name"] for s in _INCOMING]
    assert result.messages is context.messages
    assert result.agent is context.agent
    assert result.system_prompt == context.system_prompt
    assert result.invocation_state is context.invocation_state
    assert result.model is context.model


def _fake_spec(name: str, required: list[str] | None = None) -> dict:
    """A registered specification, requiring the parameters named in ``required``."""
    return {
        "name": name,
        "description": f"{name} does something",
        "inputSchema": {"json": {"type": "object", "properties": {}, "required": required or []}},
    }


class _FakeAgent:
    """The smallest agent the pre-call hook reads. A class, not a namespace: the state map needs a
    weak reference, and ``SimpleNamespace`` does not support one."""

    def __init__(self, registry_names: tuple[str, ...], cycle: int, required: list[str] | None = None) -> None:
        # Registry entries carry a ``tool_spec``, which is what the premature-call guard reads.
        self.tool_registry = SimpleNamespace(
            registry={name: SimpleNamespace(tool_spec=_fake_spec(name, required)) for name in registry_names}
        )
        self.event_loop_metrics = SimpleNamespace(cycle_count=cycle)


def _before_tool_call_event(agent: _FakeAgent, name: str, tool_input: dict | None = None):
    """Build a real ``BeforeToolCallEvent`` so the write guards of the event are exercised."""
    return BeforeToolCallEvent(
        agent=cast("Agent", agent),
        selected_tool=None,
        tool_use={"toolUseId": "t1", "name": name, "input": tool_input if tool_input is not None else {}},
        invocation_state={},
    )


def test_call_of_a_registered_tool_renews_the_exposure_at_the_current_cycle():
    """Requirement 7.3."""
    plugin = ProgressiveToolDisclosure()
    agent = _FakeAgent(("list_accounts",), cycle=7)

    plugin._on_before_tool_call(_before_tool_call_event(agent, "list_accounts"))

    assert plugin._states[cast("Agent", agent)].exposed == {"list_accounts": 7}


def test_a_later_call_of_the_same_tool_moves_its_last_use_forward():
    """Requirement 7.4: renewal, not a second exposure."""
    plugin = ProgressiveToolDisclosure()
    agent = _FakeAgent(("list_accounts",), cycle=2)

    plugin._on_before_tool_call(_before_tool_call_event(agent, "list_accounts"))
    agent.event_loop_metrics.cycle_count = 9
    plugin._on_before_tool_call(_before_tool_call_event(agent, "list_accounts"))

    assert plugin._states[cast("Agent", agent)].exposed == {"list_accounts": 9}


def test_name_absent_from_the_registry_is_neither_cancelled_nor_exposed():
    """Requirement 8.6."""
    plugin = ProgressiveToolDisclosure()
    agent = _FakeAgent(("list_accounts",), cycle=3)
    event = _before_tool_call_event(agent, "not_a_tool")

    plugin._on_before_tool_call(event)

    assert event.cancel_tool is False
    assert plugin._states.get(cast("Agent", agent)) is None


def test_the_hook_leaves_the_tool_use_and_the_registry_untouched():
    """Requirement 8.7."""
    plugin = ProgressiveToolDisclosure()
    agent = _FakeAgent(("list_accounts", "get_balance"), cycle=1)
    event = _before_tool_call_event(agent, "list_accounts", {"account_id": "A1"})
    tool_use_before = copy.deepcopy(event.tool_use)
    registry_before = dict(agent.tool_registry.registry)

    plugin._on_before_tool_call(event)

    assert event.tool_use == tool_use_before
    assert agent.tool_registry.registry == registry_before


class _SpyIndex:
    """Records every ``build`` it receives. Structural: the protocol is checked by member."""

    def __init__(self) -> None:
        self.builds: list[list[str]] = []
        self.searched: list[str] = []

    def build(self, specs) -> None:
        self.builds.append([spec["name"] for spec in specs])

    def search(self, need: str, top_k: int):
        self.searched.append(need)
        return [ToolMatch(name=name, score=1.0) for name in self.builds[-1][:top_k]] if self.builds else []


class _AsyncSpyIndex(_SpyIndex):
    """Same recorder, with an awaitable ``build`` — the protocol allows either shape."""

    async def build(self, specs) -> None:  # type: ignore[override]
        super().build(specs)


def _model_call(agent: _FakeAgent, names: tuple[str, ...]) -> InvokeModelContext:
    return InvokeModelContext(
        agent=cast("Agent", agent),
        messages=[],
        system_prompt=None,
        tool_specs=[_spec(name) for name in names],
        tool_choice=None,
        invocation_state={},
        model=cast("Model", object()),
    )


@pytest.mark.asyncio
async def test_the_first_projection_builds_the_index_once_and_records_the_fingerprint():
    """Requirement 6.5."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    names = (FIND_TOOLS_NAME, "list_accounts")
    agent = _FakeAgent(names, cycle=0)

    await plugin._projection_handler(_model_call(agent, names))

    assert index.builds == [[FIND_TOOLS_NAME, "list_accounts"]]
    assert plugin._states[cast("Agent", agent)].fingerprint == frozenset(names)


@pytest.mark.asyncio
async def test_an_unchanged_fingerprint_never_builds_again():
    """Requirement 6.6."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    names = (FIND_TOOLS_NAME, "list_accounts")
    agent = _FakeAgent(names, cycle=0)

    for _ in range(3):
        await plugin._projection_handler(_model_call(agent, names))

    assert len(index.builds) == 1


@pytest.mark.asyncio
async def test_a_changed_fingerprint_rebuilds_once_over_the_current_call_and_replaces_it():
    """Requirement 6.7."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    first = (FIND_TOOLS_NAME, "list_accounts")
    second = (FIND_TOOLS_NAME, "list_accounts", "get_balance")
    agent = _FakeAgent(second, cycle=0)

    await plugin._projection_handler(_model_call(agent, first))
    await plugin._projection_handler(_model_call(agent, second))

    assert index.builds == [list(first), list(second)]
    assert plugin._states[cast("Agent", agent)].fingerprint == frozenset(second)


@pytest.mark.asyncio
async def test_an_order_only_change_is_the_same_fingerprint():
    """The fingerprint is a set of names: arrival order has no say over what gets indexed."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    agent = _FakeAgent((FIND_TOOLS_NAME, "list_accounts"), cycle=0)

    await plugin._projection_handler(_model_call(agent, (FIND_TOOLS_NAME, "list_accounts")))
    await plugin._projection_handler(_model_call(agent, ("list_accounts", FIND_TOOLS_NAME)))

    assert len(index.builds) == 1


@pytest.mark.asyncio
async def test_an_awaitable_build_is_awaited_before_the_fingerprint_is_recorded():
    index = _AsyncSpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    names = (FIND_TOOLS_NAME, "list_accounts")
    agent = _FakeAgent(names, cycle=0)

    await plugin._projection_handler(_model_call(agent, names))

    assert index.builds == [list(names)]
    assert plugin._states[cast("Agent", agent)].fingerprint == frozenset(names)


@pytest.mark.asyncio
async def test_a_tool_registered_late_is_findable_from_the_projection_it_first_appears_in():
    """Requirement 6.11."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index, top_k=3)
    agent = _FakeAgent((FIND_TOOLS_NAME, "list_accounts"), cycle=0)

    await plugin._projection_handler(_model_call(agent, (FIND_TOOLS_NAME, "list_accounts")))
    assert "get_balance" not in index.builds[-1]

    # The tool is registered after the index was built, and shows up on the next call.
    agent.tool_registry.registry["get_balance"] = SimpleNamespace(tool_spec=_fake_spec("get_balance"))
    await plugin._projection_handler(_model_call(agent, (FIND_TOOLS_NAME, "list_accounts", "get_balance")))

    assert "get_balance" in index.builds[-1]
    result = await plugin.find_tools(
        "check the balance", cast("ToolContext", SimpleNamespace(agent=cast("Agent", agent)))
    )
    assert "get_balance" in result


@pytest.mark.asyncio
async def test_a_passthrough_call_never_builds_the_index():
    """The guards run first: a call the projection does not apply to indexes nothing."""
    index = _SpyIndex()
    plugin = ProgressiveToolDisclosure(index=index)
    agent = _FakeAgent(("list_accounts",), cycle=0)

    context = _model_call(agent, ("list_accounts",))
    assert await plugin._projection_handler(context) is context
    assert index.builds == []


_AN_AGENT = cast("Agent", object())


def test_a_source_of_none_returns_the_referenced_object_itself():
    """Requirement 10.3: the regression guarantee is by identity, not by comparison."""
    referenced = {"list_accounts"}

    assert _union_referenced(referenced, None, _AN_AGENT) is referenced


def test_a_valid_source_unions_its_names_with_the_history_ones_in_order():
    """Requirement 10.2."""
    referenced = _tool_names_referenced_in_history(("list_accounts", "get_balance"))

    merged = _union_referenced(referenced, lambda agent: ["send_wire", "list_accounts"], _AN_AGENT)

    assert list(merged) == ["list_accounts", "get_balance", "send_wire"]


def test_the_source_receives_the_agent_of_the_call():
    """The supplemental set is per agent, so the source cannot need global state."""
    seen: list[object] = []

    _union_referenced(set(), lambda agent: seen.append(agent) or (), _AN_AGENT)

    assert seen == [_AN_AGENT]


def test_a_source_that_raises_degrades_to_the_retained_history_with_one_debug_log(caplog):
    """Requirement 10.5."""

    def boom(agent):
        raise RuntimeError("no source today")

    referenced = {"list_accounts"}
    with caplog.at_level("DEBUG", logger="strands.vended_plugins.progressive_tool_disclosure.plugin"):
        merged = _union_referenced(referenced, boom, _AN_AGENT)

    assert merged is referenced
    records = [r for r in caplog.records if "referenced_source failed" in r.message]
    assert len(records) == 1
    assert records[0].levelname == "DEBUG"
    assert records[0].exc_info is not None


def test_a_source_returning_a_non_iterable_degrades_to_the_retained_history(caplog):
    """Requirement 10.5: the iteration is what raises on it, and the same guard reports it."""
    referenced = {"list_accounts"}
    with caplog.at_level("DEBUG", logger="strands.vended_plugins.progressive_tool_disclosure.plugin"):
        merged = _union_referenced(referenced, lambda agent: 7, _AN_AGENT)

    assert merged is referenced
    assert len([r for r in caplog.records if "referenced_source failed" in r.message]) == 1


def test_a_source_returning_a_non_string_element_degrades_to_the_retained_history(caplog):
    """Requirement 10.5: a malformed return is not honored in part."""
    referenced = {"list_accounts"}
    with caplog.at_level("DEBUG", logger="strands.vended_plugins.progressive_tool_disclosure.plugin"):
        merged = _union_referenced(referenced, lambda agent: ["send_wire", 42], _AN_AGENT)

    assert merged is referenced
    records = [r for r in caplog.records if "referenced_source failed" in r.message]
    assert len(records) == 1
    assert records[0].exc_info is not None


def test_a_failing_source_never_leaves_a_half_built_union():
    """The try covers the call and the materialization only."""

    def half(agent):
        yield "send_wire"
        raise RuntimeError("stopped halfway")

    referenced = {"list_accounts"}
    assert _union_referenced(referenced, half, _AN_AGENT) is referenced


@pytest.mark.parametrize("bad", [7, "not_a_callable", ["send_wire"], object()])
def test_a_referenced_source_that_is_not_callable_is_rejected_at_construction(bad):
    """Requirement 10.4."""
    with pytest.raises(ValueError, match="referenced_source"):
        ProgressiveToolDisclosure(referenced_source=bad)


def test_a_referenced_source_of_none_is_accepted():
    assert ProgressiveToolDisclosure(referenced_source=None)._referenced_source is None


def test_project_gives_the_supplemental_names_a_full_specification():
    """Requirements 10.2 and 10.6: the decision of which names get a full spec stays in the plugin."""
    context = _model_call(_FakeAgent((FIND_TOOLS_NAME,), cycle=0), (FIND_TOOLS_NAME, "list_accounts", "send_wire"))

    result = _project(
        context,
        exposed=set(),
        referenced=set(),
        always_available=(),
        catalog_tokens=20,
        referenced_source=lambda agent: ["send_wire"],
    )

    by_name = {spec["name"]: spec for spec in result.tool_specs}
    assert by_name["send_wire"]["inputSchema"] == context.tool_specs[2]["inputSchema"]
    # Untouched by the source, list_accounts is still a catalog entry.
    assert by_name["list_accounts"]["inputSchema"]["json"]["properties"] == {}


def test_project_without_a_source_comes_out_field_for_field_as_before():
    """Requirement 10.3."""
    context = _model_call(_FakeAgent((FIND_TOOLS_NAME,), cycle=0), (FIND_TOOLS_NAME, "list_accounts", "send_wire"))
    kwargs = dict(exposed={"send_wire"}, referenced=set(), always_available=(), catalog_tokens=20)

    assert _project(context, **kwargs).tool_specs == _project(context, **kwargs, referenced_source=None).tool_specs


def _tool_names_referenced_in_history(names: tuple[str, ...]):
    """The ordered-set view the projection handler passes as ``referenced``."""
    from strands.vended_plugins.progressive_tool_disclosure.plugin import _tool_names_referenced_in

    return _tool_names_referenced_in(
        [{"role": "assistant", "content": [{"toolUse": {"toolUseId": n, "name": n, "input": {}}}]} for n in names]
    )
