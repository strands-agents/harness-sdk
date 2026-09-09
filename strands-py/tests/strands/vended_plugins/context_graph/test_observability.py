"""Unit tests of the graph's observability: one example per record it emits.

Every emission here is deliberately outside what the property tests cover, and the design says why:
a log record does not vary with the input the way a Resolution does, so one example per record is the
whole verification. What *is* a property — the same result whether an emission raised or not — is
Property 21, and it lands in this same file with task 18.4.

Four records carry Requirement 17, and each is asserted on its fields rather than on its wording:

* **The turn choice**, at info, with the counts per axis and the overhead of computing it. A Card holds
  one Resolution per axis, so the dialogue's three rungs and the evidence's two are counted separately,
  each partitioning the graph's Cards; and ``choice_micros`` spans the choice and nothing else, which is
  what makes the overhead readable separately from the model call (Requirements 17.6, 17.12).
* **The delivery**, at debug, with messages received, messages projected, final blocks added and the
  estimated input tokens of the call (Requirement 17.7).
* **The compaction ratio**, at debug, once per Card projected at description (Requirement 17.10).
* **The retrieval cycles of the turn**, at info, read once per turn immediately before the counter is
  reset (Requirement 17.8), and the count of names the supplemental referenced source published
  (Requirement 17.9).

Nothing here reaches a network or a model: the matcher is a double and the delivery handler is called
directly.
"""

from __future__ import annotations

import logging
import re
from typing import Any

import pytest

from strands._middleware.stages import InvokeModelContext
from strands.hooks.events import BeforeInvocationEvent
from strands.vended_plugins.context_graph.plugin import (
    RETRIEVAL_TOOL_NAMES,
    ContextStrategy,
    _GraphStrategy,
)
from strands.vended_plugins.context_graph.state import Card, CardChoice, _GraphState

from .conftest import frozen_choice
from .stubs import StubMatcher

PLUGIN_LOGGER = "strands.vended_plugins.context_graph.plugin"
"""The only logger these tests read, so an unrelated record never inflates a count."""


class FakeAgent:
    """Weak-referenceable stand-in carrying just what the instrumented paths read."""

    def __init__(self, messages: list[dict[str, Any]] | None = None) -> None:
        self.messages: list[dict[str, Any]] = messages if messages is not None else []
        self.state: dict[str, Any] = {}
        self.hooks: list[tuple[Any, Any]] = []

    def add_hook(self, callback: Any, event_type: Any = None, **_kwargs: Any) -> None:
        self.hooks.append((callback, event_type))


def _user(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def _assistant(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def _conversation() -> list[dict[str, Any]]:
    """Three turns: turn zero, turn one, and turn two still open."""
    return [
        _user("turn zero ask", "d0"),
        _assistant("answer zero", "a0"),
        _user("turn one ask", "d1"),
        _assistant("answer one", "a1"),
        _user("turn two ask", "d2"),
    ]


def _card(title: str, turn: int, dialogue_ids: tuple[str, ...], description: str = "") -> Card:
    return Card(
        title=title,
        kind="subject",
        turn=turn,
        dialogue_ids=dialogue_ids,
        evidence_ids=(),
        pairs=(),
        tool_names=frozenset({"run_query"}),
        references=(),
        numeric_lines=(),
        tags=(),
        description=description,
    )


def _graph(**overrides: Any) -> _GraphStrategy:
    """A ``_GraphStrategy`` reached the way production reaches it: through the dispatch."""
    return ContextStrategy(strategy="graph", matcher=StubMatcher(), **overrides)._impl


def _context(agent: FakeAgent, messages: list[dict[str, Any]] | None = None) -> InvokeModelContext:
    return InvokeModelContext(
        agent=agent,  # type: ignore[arg-type]
        messages=agent.messages if messages is None else messages,
        system_prompt="be brief",
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=object(),
        projected_input_tokens=7,
        dynamic_trailing_blocks=0,
    )


def _collapsing_state() -> _GraphState:
    """A state whose choice puts turn one's dialogue in description and leaves the rest alone."""
    state = _GraphState()
    state.cards["turn one ask"] = _card(
        "turn one ask",
        1,
        ("d1", "a1"),
        description="turn one ask\nbalance: 1.200,00",
    )
    state.turn = 2
    state.choice = frozen_choice({"turn one ask": CardChoice(dialogue="description", evidence="full")})
    return state


def _records(caplog: pytest.LogCaptureFixture, level: int, contains: str) -> list[str]:
    """The formatted messages of the plugin's own records at ``level`` that mention ``contains``."""
    return [
        record.getMessage()
        for record in caplog.records
        if record.name == PLUGIN_LOGGER and record.levelno == level and contains in record.getMessage()
    ]


def _field(message: str, name: str) -> str:
    """Read one ``name=<value>`` field out of a record, so a test never asserts on wording."""
    found = re.search(rf"{name}=<([^>]*)>", message)
    assert found is not None, f"{name} missing from {message!r}"
    return found.group(1)


# --- the turn choice, at info -------------------------------------------------------------------


class TestChoiceRecord:
    """Requirement 17.6: one info record per choice, with the counts of each axis.

    A Card holds one Resolution per axis, not one Resolution, so the record reports three counts for
    the dialogue and two for the evidence — the evidence axis has two rungs and no ``title``.
    """

    def _start_turn(self, graph: _GraphStrategy, agent: FakeAgent, state: _GraphState) -> None:
        """Fire the hook with the choice the state already carries.

        The choice is pinned rather than computed: what is under test is the record, and a scored
        choice would make the counts depend on the matcher instead of on the resolutions.
        """
        pinned = state.choice
        graph._states[agent] = state  # type: ignore[index]
        graph._compute_choice = lambda *_args, **_kwargs: pinned  # type: ignore[method-assign]
        graph._on_before_invocation(BeforeInvocationEvent(agent=agent, messages=agent.messages))  # type: ignore[arg-type]

    def _state_with(self, choices: dict[str, CardChoice], **kwargs: Any) -> _GraphState:
        state = _GraphState()
        for index, title in enumerate(choices):
            state.cards[title] = _card(title, index, (f"d{index}",), description=f"{title}\nvalue: {index}0,00")
        state.choice = frozen_choice(choices, **kwargs)
        return state

    def test_counts_each_axis_separately(self, caplog):
        """The dialogue's three rungs and the evidence's two, each counted on its own axis.

        The two axes are decided independently, so a Card whose dialogue fell to its title line while
        its evidence still travels whole has to be visible on both counts. Folded into one bucket it
        would read as a single Card at description, and the dialogue ladder would look like two rungs.
        """
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with(
            {
                "whole": CardChoice(dialogue="full", evidence="full"),
                "collapsed": CardChoice(dialogue="description", evidence="description"),
                "also collapsed": CardChoice(dialogue="title", evidence="description"),
                "gone": CardChoice(dialogue="title", evidence="full"),
            }
        )

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert _field(record, "dialogue_full") == "1"
        assert _field(record, "dialogue_description") == "1"
        assert _field(record, "dialogue_title") == "2"
        assert _field(record, "evidence_full") == "2"
        assert _field(record, "evidence_description") == "2"

    def test_each_axis_counts_every_card_exactly_once(self, caplog):
        """Both partitions cover the graph, so a Card is never counted twice or not at all."""
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with(
            {
                "whole": CardChoice(dialogue="full", evidence="full"),
                "collapsed": CardChoice(dialogue="title", evidence="description"),
            }
        )

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        dialogue = ("dialogue_full", "dialogue_description", "dialogue_title")
        evidence = ("evidence_full", "evidence_description")
        assert sum(int(_field(record, name)) for name in dialogue) == len(state.cards)
        assert sum(int(_field(record, name)) for name in evidence) == len(state.cards)

    def test_the_evidence_axis_has_no_title_count(self, caplog):
        """``distribute`` never yields ``"title"`` for evidence, so the record reports no such rung.

        A zero there would read as an empty rung rather than as an absent one.
        """
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with({"whole": CardChoice(dialogue="full", evidence="full")})

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert "evidence_title" not in record

    def test_a_card_absent_from_the_choice_counts_at_full_content_on_both_axes(self, caplog):
        """Absent means keep, the same way the removal and the compaction read it."""
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with({"collapsed": CardChoice(dialogue="description", evidence="description")})
        state.cards["derived later"] = _card("derived later", 9, ("d9",), description="derived later")

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert _field(record, "dialogue_full") == "1"
        assert _field(record, "dialogue_description") == "1"
        assert _field(record, "evidence_full") == "1"
        assert _field(record, "evidence_description") == "1"

    def test_a_full_pass_counts_every_card_at_full_content_on_both_axes(self, caplog):
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with(
            {
                "collapsed": CardChoice(dialogue="description", evidence="description"),
                "gone": CardChoice(dialogue="title", evidence="description"),
            },
            full_pass=True,
        )

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert _field(record, "dialogue_full") == "2"
        assert _field(record, "dialogue_description") == "0"
        assert _field(record, "dialogue_title") == "0"
        assert _field(record, "evidence_full") == "2"
        assert _field(record, "evidence_description") == "0"

    def test_records_the_choice_overhead_on_its_own(self, caplog):
        """Requirement 17.12: the choice's own duration, with no model call inside the measured span."""
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())

        self._start_turn(graph, agent, self._state_with({"whole": CardChoice(dialogue="full", evidence="full")}))

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert int(_field(record, "choice_micros")) >= 0

    def test_names_the_turn_the_choice_governs(self, caplog):
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with({"whole": CardChoice(dialogue="full", evidence="full")})
        state.turn = 4

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "turn choice computed")
        assert _field(record, "turn") == "5"

    def test_one_record_per_turn(self, caplog):
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = self._state_with({"whole": CardChoice(dialogue="full", evidence="full")})

        self._start_turn(graph, agent, state)
        self._start_turn(graph, agent, state)

        assert len(_records(caplog, logging.INFO, "turn choice computed")) == 2


# --- the retrieval cycle counter, at info --------------------------------------------------------


class TestRetrievalCycleRecord:
    """Requirement 17.8: incremented per tool invocation, recorded once per turn."""

    def _start_turn(self, graph: _GraphStrategy, agent: FakeAgent, state: _GraphState) -> None:
        graph._states[agent] = state  # type: ignore[index]
        graph._on_before_invocation(BeforeInvocationEvent(agent=agent, messages=agent.messages))  # type: ignore[arg-type]

    def test_records_the_count_of_the_turn_that_just_ended(self, caplog):
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = _collapsing_state()
        state.retrieval_cycles = 3

        self._start_turn(graph, agent, state)

        (record,) = _records(caplog, logging.INFO, "retrieval cycles counted")
        assert _field(record, "retrieval_cycles") == "3"
        assert _field(record, "turn") == "2"

    def test_reads_the_counter_before_it_is_reset(self, caplog):
        """The record and the reset are the same instant, so no turn's count is ever lost."""
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        graph, agent = _graph(), FakeAgent(_conversation())
        state = _collapsing_state()
        state.retrieval_cycles = 2

        self._start_turn(graph, agent, state)
        state.retrieval_cycles = 5
        self._start_turn(graph, agent, state)

        counted = [_field(record, "retrieval_cycles") for record in _records(caplog, logging.INFO, "retrieval cycles")]
        assert counted == ["2", "5"]
        assert state.retrieval_cycles == 0


# --- the delivery, at debug ---------------------------------------------------------------------


class TestDeliveryRecord:
    """Requirement 17.7: four fields per delivery, and Requirement 17.9's published names."""

    @pytest.mark.asyncio
    async def test_records_the_four_fields_of_a_collapsing_delivery(self, caplog):
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        graph._states[agent] = _collapsing_state()  # type: ignore[index]

        delivered = await graph._delivery_handler(_context(agent))

        (record,) = _records(caplog, logging.DEBUG, "delivery produced")
        assert _field(record, "received") == "5"
        assert _field(record, "projected") == str(len(delivered.messages))
        assert _field(record, "final_blocks") == "1"
        assert int(_field(record, "input_tokens")) > 0

    @pytest.mark.asyncio
    async def test_a_full_pass_is_recorded_as_the_delivery_that_changed_nothing(self, caplog):
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        state = _collapsing_state()
        state.choice = frozen_choice(
            {"turn one ask": CardChoice(dialogue="description", evidence="full")},
            full_pass=True,
        )
        graph._states[agent] = state  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        (record,) = _records(caplog, logging.DEBUG, "delivery produced")
        assert _field(record, "received") == _field(record, "projected")
        assert _field(record, "final_blocks") == "0"

    @pytest.mark.asyncio
    async def test_records_how_many_names_the_referenced_source_published(self, caplog):
        """Requirement 17.9."""
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        graph._states[agent] = _collapsing_state()  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        (record,) = _records(caplog, logging.DEBUG, "supplemental referenced source published")
        # The Card's own name, plus the three retrieval tools the rendered block names.
        assert _field(record, "names") == str(1 + len(RETRIEVAL_TOOL_NAMES))

    @pytest.mark.asyncio
    async def test_nothing_is_measured_when_debug_is_off(self, caplog):
        """The estimate is never paid for by a caller who would not see it."""
        caplog.set_level(logging.INFO, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        graph._states[agent] = _collapsing_state()  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        assert _records(caplog, logging.DEBUG, "delivery produced") == []


# --- the compaction ratio, at debug -------------------------------------------------------------


class TestCompactionRatioRecord:
    """Requirement 17.10: one ratio per Card projected at description."""

    @pytest.mark.asyncio
    async def test_records_the_ratio_of_a_card_at_description(self, caplog):
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        graph._states[agent] = _collapsing_state()  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        (record,) = _records(caplog, logging.DEBUG, "card compaction ratio")
        assert _field(record, "title") == "turn one ask"
        full_tokens = int(_field(record, "full_tokens"))
        description_tokens = int(_field(record, "description_tokens"))
        assert description_tokens > 0
        assert float(_field(record, "ratio")) == pytest.approx(full_tokens / description_tokens, abs=0.01)

    @pytest.mark.asyncio
    async def test_a_card_at_full_content_reports_no_ratio(self, caplog):
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        state = _collapsing_state()
        state.cards["turn zero ask"] = _card("turn zero ask", 0, ("d0", "a0"), description="turn zero ask")
        state.choice = frozen_choice(
            {
                "turn one ask": CardChoice(dialogue="description", evidence="full"),
                "turn zero ask": CardChoice(dialogue="full", evidence="full"),
            }
        )
        graph._states[agent] = state  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        titles = [_field(record, "title") for record in _records(caplog, logging.DEBUG, "card compaction ratio")]
        assert titles == ["turn one ask"]

    @pytest.mark.asyncio
    async def test_an_empty_description_reports_no_ratio(self, caplog):
        """No infinite ratio: a Description of nothing has nothing to compare against."""
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        state = _collapsing_state()
        state.cards["turn one ask"] = _card("turn one ask", 1, ("d1", "a1"), description="")
        graph._states[agent] = state  # type: ignore[index]

        await graph._delivery_handler(_context(agent))

        assert _records(caplog, logging.DEBUG, "card compaction ratio") == []


# --- Requirement 17.11, by example. The property version arrives with task 18.4 ------------------


class TestFailingEmission:
    """A raising emission is swallowed, without a log of its own, and changes no result."""

    @pytest.mark.asyncio
    async def test_a_raising_logger_leaves_the_delivery_untouched(self, monkeypatch, caplog):
        caplog.set_level(logging.DEBUG, logger=PLUGIN_LOGGER)
        agent, graph = FakeAgent(_conversation()), _graph()
        graph._states[agent] = _collapsing_state()  # type: ignore[index]
        healthy = await graph._delivery_handler(_context(agent))

        monkeypatch.setattr(
            logging.getLogger(PLUGIN_LOGGER),
            "debug",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("logging is down")),
        )
        broken = await graph._delivery_handler(_context(agent))

        assert broken.messages == healthy.messages
        assert broken.dynamic_trailing_blocks == healthy.dynamic_trailing_blocks

    def test_a_raising_logger_leaves_the_choice_untouched(self, monkeypatch):
        graph, agent = _graph(), FakeAgent(_conversation())
        state = _collapsing_state()
        graph._states[agent] = state  # type: ignore[index]
        monkeypatch.setattr(
            logging.getLogger(PLUGIN_LOGGER),
            "info",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("logging is down")),
        )

        graph._on_before_invocation(BeforeInvocationEvent(agent=agent, messages=agent.messages))  # type: ignore[arg-type]

        assert state.turn == 3
        assert state.retrieval_cycles == 0
        assert state.choice is not None
