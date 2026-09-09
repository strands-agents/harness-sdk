"""Unit tests of the supplemental referenced source: what the graph publishes, and who reads it.

The channel exists to close a defect the graph would otherwise **introduce**. Lowering a Card to
description takes its ``toolUse`` blocks out of the retained history, so the tool name drops out of
``referenced`` and its specification falls from block four to block five — while the Card's own
description keeps naming the tool. The model would read about a tool it no longer knows how to call.

Three claims carry the design, and every test here is one of them.

* **Exactly the derivable.** Names of Cards whose evidence is at full content or description, and
  nothing that only a Card at title mentions. In production that is *every* name: the evidence axis has
  two rungs, so the omission of Requirement 10.8 is vacuous by construction and the states that
  exercise it are built by hand here — see ``TITLE``.
* **Published before returning.** ``ProgressiveToolDisclosure`` runs later in the same chain, and the
  set has to be there when it composes ``tool_specs`` for this very call.
* **One channel only.** The graph writes its own per-agent state and never ``context.tool_specs``,
  never ``agent.state``, and never a new field of ``InvokeModelContext``. Ownership of the level
  decision stays with ``ProgressiveToolDisclosure``.

The chain is driven by hand: the graph's handler, then B's ``_project`` over the context it returned.
That is the composition the stage performs, and it is the only way to observe the ordering claim.
"""

from __future__ import annotations

import copy
import dataclasses
from typing import Any

import pytest

from strands._middleware.stages import InvokeModelContext
from strands.vended_plugins.context_graph.plugin import (
    RETRIEVAL_TOOL_NAMES,
    ContextStrategy,
    _derive_referenced,
)
from strands.vended_plugins.context_graph.state import Card, CardChoice, _GraphState
from strands.vended_plugins.progressive_tool_disclosure.plugin import (
    FIND_TOOLS_NAME,
    _project,
)

from .conftest import frozen_choice


class FakeAgent:
    """Weak-referenceable stand-in: the one attribute the delivery path reads, and nothing else."""

    def __init__(self, messages: list[dict[str, Any]] | None = None) -> None:
        self.messages = messages if messages is not None else _conversation()


def _user(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def _assistant(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def _conversation() -> list[dict[str, Any]]:
    """Three closed turns and one open: one Card per closed turn, the open one never removed."""
    return [
        _user("the full turn", "d0"),
        _assistant("answer zero", "a0"),
        _user("the collapsed turn", "d1"),
        _assistant("answer one", "a1"),
        _user("the forgotten turn", "d2"),
        _assistant("answer two", "a2"),
        _user("the turn in progress", "d3"),
    ]


def _card(title: str, turn: int, ids: tuple[str, ...], tool_names: frozenset[str]) -> Card:
    return Card(
        title=title,
        kind="subject",
        turn=turn,
        dialogue_ids=ids,
        evidence_ids=(),
        pairs=(),
        tool_names=tool_names,
        references=(),
        numeric_lines=(),
        tags=(),
        description=f"{title}\ntools used: {', '.join(sorted(tool_names))}",
    )


FULL = CardChoice(dialogue="full", evidence="full")
"""The turn that travels whole: its ``toolUse`` blocks stay in the retained history."""

DESCRIPTION = CardChoice(dialogue="description", evidence="description")
"""The turn that collapsed: its messages left, and its description still names the tool."""

TITLE = CardChoice(dialogue="title", evidence="title")
"""The turn that kept only its address — **a state ``scoring.distribute`` never produces.**

The evidence axis has two rungs and two only, so no scored choice puts a Card here. It is constructed
by hand because the omission of Requirement 10.8 is otherwise unobservable: with evidence at full the
``toolUse`` blocks are in the retained history, and with evidence at description the final block still
names the tool, so in production every name is published and there is nothing to withhold. What the
tests below pin is the *direction* of the criterion, should the evidence axis ever gain a third rung.
"""


def _state(*, shared: bool = False) -> _GraphState:
    """A graph over the three resolutions, one tool name each.

    Args:
        shared: Whether the title Card also mentions the description Card's tool, which is the
            "exclusively" of Requirement 10.8 seen from the other side.
    """
    state = _GraphState()
    state.cards["the full turn"] = _card("the full turn", 0, ("d0", "a0"), frozenset({"run_query"}))
    state.cards["the collapsed turn"] = _card("the collapsed turn", 1, ("d1", "a1"), frozenset({"fetch_positions"}))
    forgotten = frozenset({"list_connectors", "fetch_positions"} if shared else {"list_connectors"})
    state.cards["the forgotten turn"] = _card("the forgotten turn", 2, ("d2", "a2"), forgotten)
    state.turn = 3
    state.choice = frozen_choice(
        {
            "the full turn": FULL,
            "the collapsed turn": DESCRIPTION,
            "the forgotten turn": TITLE,
        }
    )
    return state


def _graph(**overrides: Any) -> Any:
    """The graph strategy, reached the way production reaches it: through the dispatch."""
    return ContextStrategy(strategy="graph", **overrides)._impl


def _wired(state: _GraphState | None = None) -> tuple[ContextStrategy, Any, FakeAgent]:
    """A plugin, its graph and an agent carrying ``state``."""
    plugin = ContextStrategy(strategy="graph")
    graph = plugin._impl
    agent = FakeAgent()
    graph._states[agent] = _state() if state is None else state
    return plugin, graph, agent


def _context(agent: FakeAgent, specs: list[dict[str, Any]] | None = None) -> InvokeModelContext:
    return InvokeModelContext(
        agent=agent,  # type: ignore[arg-type]
        messages=agent.messages,
        system_prompt="be brief",
        tool_specs=[] if specs is None else specs,
        tool_choice=None,
        invocation_state={},
        model=object(),
        projected_input_tokens=7,
        dynamic_trailing_blocks=0,
    )


def _spec(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": "Does something useful, at length, so the catalog entry is visibly shorter.",
        "inputSchema": {"json": {"type": "object", "properties": {"q": {"type": "string"}}}},
    }


INCOMING = [_spec(FIND_TOOLS_NAME), _spec("run_query"), _spec("fetch_positions"), _spec("list_connectors")]
"""What the registry hands the call: the search tool plus the three tools the graph's Cards mention."""

HISTORY_NAMES = frozenset({"run_query"})
"""What B reads off the retained history: only the turn that travelled whole still shows its blocks."""


def _published(*card_names: str) -> frozenset[str]:
    """The names a collapsing call publishes: the Cards' own, plus the three the block names.

    The retrieval tools ride along because the block tells the model to call them, and a
    pre-specification carries no ``inputSchema`` — an invitation to call a tool the model cannot call
    is not an escape hatch. Spelling it as a union rather than a literal keeps these tests reading as
    "the Cards' names, and the block's" instead of restating the set.
    """
    return frozenset(card_names) | RETRIEVAL_TOOL_NAMES


def _names(specs: list[dict[str, Any]]) -> list[str]:
    return [spec["name"] for spec in specs]


def _full_spec_names(specs: list[dict[str, Any]]) -> set[str]:
    """The names that came out with a schema, which is what blocks one to four emit."""
    return {spec["name"] for spec in specs if spec["inputSchema"]["json"].get("properties")}


# --- exactly the derivable ------------------------------------------------------------------------


def test_full_content_and_description_are_published_and_a_hand_built_title_is_not():
    """Requirements 10.7, 10.8, over a choice ``distribute`` cannot produce — see ``TITLE``.

    The omission is vacuous by construction, so the only way to exercise it is to build the state by
    hand. In production every name is published, and that is the correct outcome.
    """
    state = _state()

    assert _derive_referenced(state, state.choice) == _published("run_query", "fetch_positions")


def test_a_name_a_card_above_title_also_mentions_stays_published():
    """Requirement 10.8 is about "exclusively": one mention above title is enough."""
    state = _state(shared=True)

    assert _derive_referenced(state, state.choice) == _published("run_query", "fetch_positions")


def test_a_graph_with_no_card_publishes_nothing():
    empty = _GraphState()

    assert _derive_referenced(empty, empty.choice) == frozenset()


def test_a_card_absent_from_the_choice_is_read_as_full_content():
    """The same fail-safe direction the removal and the compaction take: absent means keep."""
    state = _state()
    state.choice = frozen_choice({"the collapsed turn": TITLE, "the forgotten turn": TITLE})

    assert _derive_referenced(state, state.choice) == _published("run_query")


def test_a_full_pass_publishes_every_name():
    """Under a full pass the whole history travels whole, so every name is referenced anyway."""
    state = _state()
    state.choice = frozen_choice({}, full_pass=True)

    assert _derive_referenced(state, state.choice) == {"run_query", "fetch_positions", "list_connectors"}


# --- published before returning -------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_handler_publishes_before_it_returns():
    """Requirement 10.9: the set is in place by the time the next link of the chain runs."""
    _plugin, graph, agent = _wired()

    await graph._delivery_handler(_context(agent))

    assert graph._states[agent].referenced == _published("run_query", "fetch_positions")


@pytest.mark.asyncio
async def test_a_full_pass_publishes_before_the_short_circuit():
    """The early return is a delivery decision, not a reason for B to read a stale set."""
    state = _state()
    state.choice = frozen_choice({}, full_pass=True)
    _plugin, graph, agent = _wired(state)
    context = _context(agent)

    assert await graph._delivery_handler(context) is context
    assert graph._states[agent].referenced == {"run_query", "fetch_positions", "list_connectors"}


@pytest.mark.asyncio
async def test_the_published_set_is_replaced_and_never_accumulated():
    """Each call publishes what this call's choice derives, so a name never lingers past its turn."""
    _plugin, graph, agent = _wired()
    await graph._delivery_handler(_context(agent))

    state = graph._states[agent]
    state.choice = frozen_choice(dict.fromkeys(state.cards, TITLE))
    await graph._delivery_handler(_context(agent))

    assert state.referenced == RETRIEVAL_TOOL_NAMES


@pytest.mark.asyncio
async def test_the_source_reads_the_agent_of_the_call():
    """Requirement 10.10: one instance, many agents, and no global state to confuse them."""
    plugin, graph, first = _wired()
    second = FakeAgent()
    graph._states[second] = _GraphState()

    await graph._delivery_handler(_context(first))
    await graph._delivery_handler(_context(second))

    assert plugin.referenced_tool_names(first) == _published("run_query", "fetch_positions")
    assert plugin.referenced_tool_names(second) == frozenset()


@pytest.mark.asyncio
async def test_the_retrieval_tools_reach_the_call_with_a_schema_to_call_them_by():
    """The final block invites the model to retrieve; the invitation needs a callable tool.

    Under disclosure, a tool nobody references arrives as a pre-specification — its name and a
    truncated description, with an empty ``inputSchema``. Measured across every run of this strategy,
    the retrieval cycle count was zero in all of them, and the three tools were in ``tool_specs`` and
    exposed by nothing. The block was naming tools the model had no way to call.
    """
    _plugin, graph, agent = _wired()
    specs = [_spec(FIND_TOOLS_NAME), *(_spec(name) for name in sorted(RETRIEVAL_TOOL_NAMES))]

    delivered = await graph._delivery_handler(_context(agent, specs))
    projected = _project(
        delivered,
        exposed=(),
        referenced=HISTORY_NAMES,
        always_available=(),
        catalog_tokens=20,
        referenced_source=lambda _agent: graph._states[agent].referenced,
    )

    assert _full_spec_names(projected.tool_specs) >= RETRIEVAL_TOOL_NAMES


@pytest.mark.asyncio
async def test_a_full_pass_does_not_publish_the_retrieval_tools():
    """Nothing collapsed means no block, and no block means no invitation to justify the schemas."""
    state = _state()
    state.choice = frozen_choice({}, full_pass=True)
    _plugin, graph, agent = _wired(state)

    await graph._delivery_handler(_context(agent))

    assert graph._states[agent].referenced.isdisjoint(RETRIEVAL_TOOL_NAMES)


def test_an_agent_this_strategy_never_wired_publishes_nothing():
    """B composes ``referenced`` from the retained history alone, which is today's behaviour."""
    plugin = ContextStrategy(strategy="graph")

    assert plugin.referenced_tool_names(FakeAgent()) == frozenset()  # type: ignore[arg-type]


# --- one channel only -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_handler_writes_no_tool_specs_and_adds_no_field():
    """Requirements 10.11, 12.15: the graph moves the boundary, it never emits a specification."""
    _plugin, graph, agent = _wired()
    specs = [_spec("run_query")]
    context = _context(agent, specs)
    before = copy.deepcopy(specs)
    fields = {field.name for field in dataclasses.fields(context)}

    delivered = await graph._delivery_handler(context)

    assert delivered.tool_specs is specs
    assert specs == before
    assert {field.name for field in dataclasses.fields(delivered)} == fields


@pytest.mark.asyncio
async def test_nothing_is_written_on_the_agent():
    """Requirement 10.10: per-agent state of the strategy's own, not of the agent's."""
    _plugin, graph, agent = _wired()

    await graph._delivery_handler(_context(agent))

    assert not hasattr(agent, "state")


def test_no_tool_of_the_strategy_raises_a_pre_specification():
    """Requirement 12.15: the three tools address turns and artifacts, never a specification level."""
    plugin = ContextStrategy(strategy="graph")

    assert {tool.tool_name for tool in plugin._tools} == {"expand_card", "expand_artifact", "find_context"}


# --- the chain: the graph, then B -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_b_composes_the_union_and_the_collapsed_turn_keeps_its_schema():
    """Requirement 10.2 read from the graph's side: description qualifies for a full specification."""
    plugin, graph, agent = _wired()

    delivered = await graph._delivery_handler(_context(agent, list(INCOMING)))
    projected = _project(
        delivered,
        exposed=(),
        referenced=HISTORY_NAMES,
        always_available=(),
        catalog_tokens=20,
        referenced_source=plugin.referenced_tool_names,
    )

    assert _full_spec_names(projected.tool_specs) == {FIND_TOOLS_NAME, "run_query", "fetch_positions"}
    # The turn nobody can see any more is the one tool that falls to a pre-specification.
    assert _names(projected.tool_specs) == [FIND_TOOLS_NAME, "run_query", "fetch_positions", "list_connectors"]


@pytest.mark.asyncio
async def test_without_the_source_the_collapsed_turn_loses_its_schema():
    """The defect the channel closes, shown by removing the channel and nothing else."""
    _plugin, graph, agent = _wired()

    delivered = await graph._delivery_handler(_context(agent, list(INCOMING)))
    projected = _project(
        delivered,
        exposed=(),
        referenced=HISTORY_NAMES,
        always_available=(),
        catalog_tokens=20,
        referenced_source=None,
    )

    assert _full_spec_names(projected.tool_specs) == {FIND_TOOLS_NAME, "run_query"}


@pytest.mark.asyncio
async def test_publishing_with_nobody_reading_changes_nothing_and_raises_nothing():
    """Requirement 10.12: ``ProgressiveToolDisclosure`` absent is a shape, not an error."""
    _plugin, graph, agent = _wired()
    specs = list(INCOMING)

    delivered = await graph._delivery_handler(_context(agent, specs))

    assert delivered.tool_specs is specs
    assert graph._states[agent].referenced == _published("run_query", "fetch_positions")
