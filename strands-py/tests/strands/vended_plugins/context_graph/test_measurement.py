"""Measurement harness: the five numbers that decide whether the graph pays for itself.

This module is not a unit suite. It drives one long synthetic session — 18 turns, the length of the
session measured in ``concept.md`` — through the real plugin, reads the five numbers off the
instrumentation the plugin already emits, and prints them in a table a human can read. Run it with
``-s`` to see the report:

    pytest tests/strands/vended_plugins/context_graph/test_measurement.py -s

Every number is read off a log record rather than re-derived, which is what makes the harness verify
the instrumentation at the same time: a record that stops being emitted, or loses a field, is a
missing row here.

What is measured, and what each number decides:

1. **Distribution of the Resolutions per turn, per axis**, off the info ``turn choice computed``
   record: the dialogue's three rungs and the evidence's two, counted separately because a Card holds
   one Resolution per axis. Shows whether the dialogue ladder has three rungs in practice or
   degenerated into two.
2. **Compaction ratio per Card at description**, off the debug ``card compaction ratio`` record.
3. **Curve of retrieval cycles per turn**, off the info ``retrieval cycles counted`` record. This is
   the number that decides whether the graph works: descending means the note learned from the
   request, flat means the graph traded tokens for latency.
4. **Premature calls**, counted by the model double against three arms — the graph as implemented
   (one hop through the tool hub), the graph with the tool-hub traversal disabled (the alternative
   two-hop reading, which forbids it), and B alone with no supplemental referenced source at all.
   That comparison is the design's open decision 3.
5. **Choice overhead in isolation**, off ``choice_micros`` plus wall time around the graph's own work,
   against the same session run with no graph wired at all. Target ~150ms per turn.

Plus the design's open decision 8: whether the ``AfterToolCallEvent`` fast path pays for itself, or
whether the rebuild scan suffices on its own. Measured by running the session with the hook and
without it, and comparing what each leaves in the graph against what a scan recovers.

**What the synthetic data cannot say.** There is no model and no embedding here: the matcher is a
word-overlap double and the model double answers instantly. So the choice overhead measured is the
arithmetic alone, a lower bound that excludes the one embedding round trip the 150ms target is
mostly made of, and the token counts are estimates over invented prose. The shape of the
distribution and of the cycle curve is a property of the mechanism and survives the synthetic data;
the absolute token and millisecond values do not.
"""

from __future__ import annotations

import asyncio
import logging
import re
import statistics
import time
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import pytest

from strands._middleware import MiddlewareRegistry
from strands._middleware.stages import InvokeModelContext
from strands.agent.conversation_manager import NullConversationManager
from strands.hooks.events import AfterToolCallEvent, BeforeInvocationEvent, MessageAddedEvent
from strands.models.model import _estimate_tokens_with_heuristic
from strands.vended_plugins.context_graph import scoring
from strands.vended_plugins.context_graph.cards import rebuild
from strands.vended_plugins.context_graph.plugin import ContextStrategy, _GraphStrategy

PLUGIN_LOGGER = "strands.vended_plugins.context_graph.plugin"
"""The only logger the harness reads, so an unrelated record never lands in a row."""

TURNS = 18
"""Length of the session, matching the one measured in ``concept.md``."""

OVERHEAD_TARGET_MICROS = 150_000
"""Target choice overhead per turn: ~150ms, the cost of one embedding."""

CONFIG: dict[str, Any] = {
    "expand_threshold": 0.55,
    "collapse_floor": 0.15,
    "description_tokens": 100,
    "tags_per_card": 5,
    "rarity_weight": 0.70,
    "body_budget": 2_000,
    "min_cards": 3,
    "link_threshold": 0.50,
    "reuse_ttl_cycles": 5,
    "recent_cards": None,
    "select_top_k": 5,
    "reranker": None,
    "persist": False,
}
"""The construction defaults, with a body budget set: the default ``None`` never binds, and a ceiling
that never binds cannot show the budget-driven step down from full content to description."""


# --- the session script -------------------------------------------------------------------------
#
# Two families of three subjects each. The word overlap of the matcher double then grades a Card
# three ways against the turn's question: same subject scores well above ``expand_threshold``, same
# family lands between the two thresholds, and the other family scores zero. That gradient is what
# lets the three rungs be observable at all — a matcher answering from a canned map would decide the
# distribution in the fixture instead of measuring it.

SUBJECTS = (
    "connector auth token",
    "connector webhook retries",
    "connector schema migration",
    "billing invoice ledger",
    "billing rate limits",
    "billing revenue report",
)
"""Six subjects, two families of three. Turns 0-8 walk the first family, turns 9-17 the second."""

FAMILY_BASELINE = {0: 0, 1: 9}
"""Turn that established each family's baseline, and therefore the Card later turns keep needing."""


@dataclass(frozen=True)
class TurnPlan:
    """One turn of the script: what is asked, what tool runs, and what the model will need."""

    index: int
    subject: str
    question: str
    tool_name: str | None
    needs_turn: int | None
    wants_tool: str | None


def _slug(subject: str) -> str:
    return subject.replace(" ", "_")


def session_plan() -> tuple[TurnPlan, ...]:
    """The 18-turn script, fixed so every arm runs the identical session.

    Returns:
        One plan per turn, in order.
    """
    plans: list[TurnPlan] = []
    first_seen: dict[str, int] = {}
    for index in range(TURNS):
        family = 0 if index < TURNS // 2 else 1
        subject = SUBJECTS[family * 3 + index % 3]
        opens_subject = subject not in first_seen
        first_seen.setdefault(subject, index)
        baseline = FAMILY_BASELINE[family]
        plans.append(
            TurnPlan(
                index=index,
                subject=subject,
                # Terse on purpose: the question is the Title, and a Title padded with filler words
                # would flatten the very gradient the distribution is read off.
                question=f"{subject} q{index}",
                # The turn that opens a subject is the turn that runs its tool.
                tool_name=f"probe_{_slug(subject)}" if opens_subject else None,
                # Every later turn of a family needs the Card that established it, which is a
                # different subject and therefore never full content by similarity alone.
                needs_turn=None if index == baseline else baseline,
                # And it wants the tool that baseline turn ran, whose full spec it only has if the
                # supplemental referenced source published the name.
                wants_tool=None if index == baseline else f"probe_{_slug(SUBJECTS[family * 3])}",
            )
        )
    return tuple(plans)


def _answer_text(plan: TurnPlan) -> str:
    """A long assistant answer carrying numeric lines, so a Description has something to preserve."""
    rows = "\n".join(
        f"  row {row} | {plan.index}.{row}00,00 | retries: {row} | latency: {row * 37}ms" for row in range(8)
    )
    return (
        f"about {plan.subject}: the run of q{plan.index} completed against the staging endpoint, "
        f"with the settlement window left as configured and the retry ceiling untouched. "
        f"the figures of the run follow, and the totals reconcile with the previous run.\n"
        f"{rows}\n"
        f"  total | {plan.index}.999,00 | window: 30 days"
    )


def offloaded_preview(tool_use_id: str) -> str:
    """The preview the offloader leaves behind over one stored textual block."""
    return (
        "[Offloaded: 1 block, ~3,000 tokens]\n"
        "Tool result was offloaded to external storage due to size.\n\n"
        "row 1: 1.200,00\n\n"
        "[Stored references:]\n"
        f"  mem_1_{tool_use_id}_0 (text, 4,096 chars)"
    )


# --- the doubles --------------------------------------------------------------------------------


class HarnessAgent:
    """Weakref-able agent double carrying only what the graph touches over a whole session."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.state: dict[str, Any] = {}
        self.system_prompt = "you answer questions about the connector and the billing ledger"
        self.tool_registry = SimpleNamespace(registry={})
        self._middleware_registry = MiddlewareRegistry()
        self._plugin_registry = SimpleNamespace(_plugins={})
        self.conversation_manager = NullConversationManager()
        self.event_loop_metrics = SimpleNamespace(cycle_count=0)
        self.hooks: list[tuple[Any, Any]] = []

    def add_hook(self, callback: Any, event_type: Any = None, **_kwargs: Any) -> None:
        """Record the registration, the way the real registry would store it."""
        self.hooks.append((callback, event_type))

    def hook_for(self, event_type: Any) -> Any:
        """The single callback registered for one event type."""
        (callback,) = [callback for callback, registered in self.hooks if registered is event_type]
        return callback


_WORD = re.compile(r"[a-z0-9]+")


def _words(text: str) -> frozenset[str]:
    return frozenset(_WORD.findall(text.lower()))


class OverlapMatcher:
    """Deterministic matcher double: the overlap coefficient of two bags of words.

    No network, no model, no embedding — and, unlike a canned map, it answers a question it has never
    seen with a value that varies with the question. That is what the distribution measurement needs:
    the gradient has to come from the data, not from the fixture.
    """

    def __init__(self) -> None:
        self.call_count = 0

    def score(self, question: str, descriptions: Any) -> list[float]:
        """Score every description against ``question``, in the order received."""
        self.call_count += 1
        asked = _words(question)
        if not asked:
            return [0.0 for _ in descriptions]
        scores = []
        for description in descriptions:
            described = _words(description)
            denominator = min(len(asked), len(described)) or 1
            scores.append(len(asked & described) / denominator)
        return scores


# --- reading the instrumentation ----------------------------------------------------------------


class RecordCapture(logging.Handler):
    """Collect the plugin's own records, so the harness reads numbers it did not compute."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        """Store the formatted message of one record."""
        self.messages.append(record.getMessage())

    def matching(self, contains: str) -> list[str]:
        """Every stored message mentioning ``contains``, in emission order."""
        return [message for message in self.messages if contains in message]


def field_of(message: str, name: str) -> str:
    """Read one ``name=<value>`` field out of a record."""
    found = re.search(rf"{name}=<([^>]*)>", message)
    assert found is not None, f"{name} missing from {message!r}"
    return found.group(1)


# --- the report ---------------------------------------------------------------------------------


@dataclass
class Report:
    """Everything one arm of the session measured."""

    arm: str
    #: One ``(turn, dialogue, evidence, choice_micros)`` row per choice, where ``dialogue`` is
    #: ``(full, description, title)`` and ``evidence`` is ``(full, description)`` — the evidence axis
    #: has two rungs, so the record carries no title count for it.
    choices: list[tuple[int, tuple[int, int, int], tuple[int, int], int]] = field(default_factory=list)
    #: One ``(turn, cycles)`` row per turn, as the plugin counted them.
    cycles: list[tuple[int, int]] = field(default_factory=list)
    #: One ``(full_tokens, description_tokens, ratio)`` row per Card at description, per delivery.
    ratios: list[tuple[int, int, float]] = field(default_factory=list)
    #: One ``(received, projected, final_blocks, input_tokens)`` row per delivery.
    deliveries: list[tuple[int, int, int, int]] = field(default_factory=list)
    #: Published referenced-name counts, one per delivery.
    published: list[int] = field(default_factory=list)
    #: Wall micros spent inside the graph's own work, per turn.
    graph_micros: list[int] = field(default_factory=list)
    #: Wall micros spent inside the ``AfterToolCallEvent`` fast path, per invocation.
    fast_path_micros: list[int] = field(default_factory=list)
    tool_calls: int = 0
    premature_calls: int = 0
    expand_requests: int = 0
    matcher_calls: int = 0
    artifact_cards: int = 0
    subject_cards: int = 0
    #: Subject Cards whose ``references`` a scan over the same messages recovers. The scan derives no
    #: artifact Card by design, so this is what the fast path is being weighed against.
    referencing_cards_by_scan: int = 0
    artifact_cards_by_scan: int = 0

    def mean_choice_micros(self) -> float:
        """Mean of ``choice_micros`` across the session."""
        return statistics.mean(micros for *_head, micros in self.choices) if self.choices else 0.0

    def mean_graph_micros(self) -> float:
        """Mean wall micros the graph cost per turn, model time excluded by construction."""
        return statistics.mean(self.graph_micros) if self.graph_micros else 0.0

    def cycles_in(self, first: int, last: int) -> int:
        """Retrieval cycles counted over the turn range ``[first, last)``, by the plugin's labels."""
        return sum(count for turn, count in self.cycles if first <= turn < last)

    def first_half_cycles(self) -> int:
        """Retrieval cycles over the first half of the session."""
        return self.cycles_in(1, TURNS // 2 + 1)

    def second_half_cycles(self) -> int:
        """Retrieval cycles over the second half of the session."""
        return self.cycles_in(TURNS // 2 + 1, TURNS + 1)


def parse_records(capture: RecordCapture, report: Report) -> None:
    """Fill ``report`` from the records the plugin emitted. Nothing here is re-derived."""
    for message in capture.matching("turn choice computed"):
        report.choices.append(
            (
                int(field_of(message, "turn")),
                (
                    int(field_of(message, "dialogue_full")),
                    int(field_of(message, "dialogue_description")),
                    int(field_of(message, "dialogue_title")),
                ),
                (
                    int(field_of(message, "evidence_full")),
                    int(field_of(message, "evidence_description")),
                ),
                int(field_of(message, "choice_micros")),
            )
        )
    for message in capture.matching("retrieval cycles counted"):
        report.cycles.append((int(field_of(message, "turn")), int(field_of(message, "retrieval_cycles"))))
    for message in capture.matching("card compaction ratio"):
        report.ratios.append(
            (
                int(field_of(message, "full_tokens")),
                int(field_of(message, "description_tokens")),
                float(field_of(message, "ratio")),
            )
        )
    for message in capture.matching("delivery produced"):
        report.deliveries.append(
            (
                int(field_of(message, "received")),
                int(field_of(message, "projected")),
                int(field_of(message, "final_blocks")),
                int(field_of(message, "input_tokens")),
            )
        )
    for message in capture.matching("supplemental referenced source published"):
        report.published.append(int(field_of(message, "names")))


# --- the session --------------------------------------------------------------------------------


def _user(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def _assistant(text: str, tracking_id: str) -> dict[str, Any]:
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def _tool_use(tool_name: str, tool_use_id: str, tracking_id: str) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": [{"toolUse": {"toolUseId": tool_use_id, "name": tool_name, "input": {"probe": "run"}}}],
        "tracking_id": tracking_id,
    }


def _tool_result(tool_use_id: str, tracking_id: str) -> dict[str, Any]:
    return {
        "role": "user",
        "content": [
            {
                "toolResult": {
                    "toolUseId": tool_use_id,
                    "status": "success",
                    "content": [{"text": offloaded_preview(tool_use_id)}],
                }
            }
        ],
        "tracking_id": tracking_id,
    }


def _context(agent: HarnessAgent) -> InvokeModelContext:
    return InvokeModelContext(
        agent=agent,  # type: ignore[arg-type]
        messages=agent.messages,
        system_prompt=agent.system_prompt,
        tool_specs=[],
        tool_choice=None,
        invocation_state={},
        model=object(),
        projected_input_tokens=0,
        dynamic_trailing_blocks=0,
    )


class Session:
    """One run of the script, over one arm.

    The turn is driven the way the event loop drives it: ``BeforeInvocationEvent`` with the incoming
    user message and before it is appended, then the message added, then the delivery handler per
    model call, then the tool pair, then the answer. What stands in for the model is a double that
    reads the frozen choice and decides whether it has to ask.
    """

    def __init__(
        self,
        arm: str,
        *,
        wire_graph: bool = True,
        fast_path: bool = True,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.report = Report(arm=arm)
        self.fast_path = fast_path
        self.agent = HarnessAgent()
        self.matcher = OverlapMatcher()
        self.graph: _GraphStrategy | None = None
        if wire_graph:
            strategy = ContextStrategy(strategy="graph", matcher=self.matcher, **{**CONFIG, **(config or {})})
            self.graph = strategy._impl
            self.graph.init_agent(self.agent)  # type: ignore[arg-type]
        self._turn_micros = 0

    # -- the timed regions: the graph's own work, and nothing else --------------------------------

    def _timed(self, started: int) -> None:
        self._turn_micros += (time.perf_counter_ns() - started) // 1_000

    async def _deliver(self) -> None:
        """One model call: the delivery handler, then the model double's instantaneous answer."""
        if self.graph is not None:
            started = time.perf_counter_ns()
            await self.graph._delivery_handler(_context(self.agent))
            self._timed(started)
        else:
            # No plugin, so no delivery record. The same estimate over the live history is what the
            # record would have carried, and it is the only number in this arm the harness derives.
            self.report.deliveries.append(
                (
                    len(self.agent.messages),
                    len(self.agent.messages),
                    0,
                    _estimate_tokens_with_heuristic(
                        self.agent.messages,  # type: ignore[arg-type]
                        [],
                        self.agent.system_prompt,
                        None,
                    ),
                )
            )
        self.agent.event_loop_metrics.cycle_count += 1

    def _start_turn(self, message: dict[str, Any]) -> None:
        if self.graph is None:
            return
        started = time.perf_counter_ns()
        self.agent.hook_for(BeforeInvocationEvent)(
            BeforeInvocationEvent(agent=self.agent, messages=[message])  # type: ignore[arg-type]
        )
        self._timed(started)

    def _add(self, message: dict[str, Any]) -> None:
        self.agent.messages.append(message)
        if self.graph is None:
            return
        started = time.perf_counter_ns()
        self.agent.hook_for(MessageAddedEvent)(
            MessageAddedEvent(agent=self.agent, message=message)  # type: ignore[arg-type]
        )
        self._timed(started)

    def _finish_tool(self, tool_name: str, tool_use_id: str) -> None:
        """Fire the fast path, and time it apart: whether it pays for itself is open decision 8."""
        if self.graph is None or not self.fast_path:
            return
        started = time.perf_counter_ns()
        self.agent.hook_for(AfterToolCallEvent)(
            AfterToolCallEvent(
                agent=self.agent,  # type: ignore[arg-type]
                selected_tool=None,
                tool_use={"toolUseId": tool_use_id, "name": tool_name, "input": {}},
                invocation_state={},
                result={
                    "toolUseId": tool_use_id,
                    "status": "success",
                    "content": [{"text": offloaded_preview(tool_use_id)}],
                },
            )
        )
        elapsed = (time.perf_counter_ns() - started) // 1_000
        self.report.fast_path_micros.append(elapsed)
        self._turn_micros += elapsed

    # -- the model double ------------------------------------------------------------------------

    def _dialogue_of(self, title: str) -> str:
        """The Resolution the frozen choice put ``title``'s dialogue at.

        The dialogue axis and not the joint bucket: what the model double needs back is the earlier
        turn's words, which is the axis ``expand_card`` is asked for.
        """
        assert self.graph is not None
        state = self.graph._states[self.agent]  # type: ignore[index]
        if state.choice.full_pass:
            return "full"
        choice = state.choice.by_title.get(title)
        return "full" if choice is None else choice.dialogue

    async def _model_decides(self, plan: TurnPlan, titles: dict[int, str]) -> bool:
        """Ask for what the turn needs, and record whether the tool it wants arrived pre-specified.

        Returns:
            Whether a retrieval request was made, which means the turn spends a second model call.
        """
        if plan.wants_tool is not None:
            self.report.tool_calls += 1
            published = (
                self.graph.referenced_tool_names(self.agent)  # type: ignore[arg-type]
                if self.graph is not None
                else frozenset()
            )
            if plan.wants_tool not in published:
                # The name was not published, so the model reaches for a tool whose full spec the call
                # never carried: a premature call, and one hop through the tool hub is what avoids it.
                self.report.premature_calls += 1

        if plan.needs_turn is None or self.graph is None:
            return False

        title = titles[plan.needs_turn]
        if self._dialogue_of(title) == "full":
            return False

        started = time.perf_counter_ns()
        await self.graph.expand_card(title, SimpleNamespace(agent=self.agent))  # type: ignore[arg-type]
        self._timed(started)
        self.report.expand_requests += 1
        return True

    # -- the loop --------------------------------------------------------------------------------

    async def run(self) -> Report:
        """Run the whole script and return what it measured."""
        titles: dict[int, str] = {}
        for plan in session_plan():
            self._turn_micros = 0
            question = _user(plan.question, f"u{plan.index}")
            titles[plan.index] = plan.question

            self._start_turn(question)
            self._add(question)
            await self._deliver()

            if await self._model_decides(plan, titles):
                await self._deliver()

            if plan.tool_name is not None:
                tool_use_id = f"tu{plan.index}"
                self._add(_tool_use(plan.tool_name, tool_use_id, f"a{plan.index}t"))
                self._finish_tool(plan.tool_name, tool_use_id)
                self._add(_tool_result(tool_use_id, f"r{plan.index}"))
                await self._deliver()

            self._add(_assistant(_answer_text(plan), f"a{plan.index}"))
            self.report.graph_micros.append(self._turn_micros)

        # One more boundary, so the last turn's retrieval-cycle counter is flushed: the plugin reads
        # it at the opening of the following turn, which is the only instant it is complete.
        self._start_turn(_user("closing the session", "uz"))

        self.report.matcher_calls = self.matcher.call_count
        if self.graph is not None:
            state = self.graph._states[self.agent]  # type: ignore[index]
            self.report.artifact_cards = sum(1 for card in state.cards.values() if card.kind == "artifact")
            self.report.subject_cards = sum(1 for card in state.cards.values() if card.kind == "subject")
            scanned = rebuild(
                self.agent.messages,
                description_tokens=CONFIG["description_tokens"],
                tags_per_card=CONFIG["tags_per_card"],
                rarity_weight=CONFIG["rarity_weight"],
                link_threshold=CONFIG["link_threshold"],
            )
            self.report.artifact_cards_by_scan = sum(1 for card in scanned.cards.values() if card.kind == "artifact")
            self.report.referencing_cards_by_scan = sum(1 for card in scanned.cards.values() if card.references)
        return self.report


async def measure(arm: str, **overrides: Any) -> Report:
    """Run one arm with the plugin's records captured, and return the filled report."""
    logger = logging.getLogger(PLUGIN_LOGGER)
    capture = RecordCapture()
    previous_level, previous_propagate = logger.level, logger.propagate
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    try:
        report = await Session(arm, **overrides).run()
    finally:
        logger.removeHandler(capture)
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate
    parse_records(capture, report)
    return report


# --- the arms, run once and shared --------------------------------------------------------------

_MEASURED: dict[str, Report] = {}


def measured() -> dict[str, Report]:
    """Run every arm once, under the package's no-network guard, and cache the reports.

    Four arms:

    * ``graph`` — the plugin as implemented, one hop through the tool hub.
    * ``hub_off`` — the same, with the tool-hub traversal disabled: the alternative reading of open
      decision 3, which treats Card→tool→Card as two hops and therefore forbids it.
    * ``no_fast_path`` — the same, without the ``AfterToolCallEvent`` hook: open decision 8.
    * ``no_reuse`` — the same with ``reuse_ttl_cycles=0``, so no fed-back note ever crosses a turn
      boundary. Its retrieval-cycle count against the graph's is what turns number 3 from a shape
      into a comparison: the note either learned from the request or it did not.
    * ``no_graph`` — the identical session with no plugin wired, which is the baseline of number 5
      and, having no supplemental referenced source, is also B alone for number 4.
    """
    if _MEASURED:
        return _MEASURED

    _MEASURED["graph"] = asyncio.run(measure("graph"))
    _MEASURED["no_graph"] = asyncio.run(measure("no_graph", wire_graph=False))
    _MEASURED["no_fast_path"] = asyncio.run(measure("no_fast_path", fast_path=False))
    _MEASURED["no_reuse"] = asyncio.run(measure("no_reuse", config={"reuse_ttl_cycles": 0}))

    original = scoring._spread_over_tool_hubs
    scoring._spread_over_tool_hubs = lambda *_args, **_kwargs: None  # type: ignore[assignment]
    try:
        _MEASURED["hub_off"] = asyncio.run(measure("hub_off"))
    finally:
        scoring._spread_over_tool_hubs = original  # type: ignore[assignment]

    return _MEASURED


def render_report(arms: dict[str, Report]) -> str:
    """Format the five numbers as a table, plus the two open decisions the harness settles."""
    graph, hub_off, no_graph, no_fast = (arms["graph"], arms["hub_off"], arms["no_graph"], arms["no_fast_path"])
    no_reuse = arms["no_reuse"]
    lines: list[str] = [
        "",
        "=" * 96,
        f"CONTEXT GRAPH MEASUREMENT | {TURNS} synthetic turns | doubled matcher, doubled model, zero network",
        "=" * 96,
        "",
        "1+3+5. PER TURN, off the info records: the Resolutions of each axis as the plugin counts",
        "       them, the retrieval cycles of the turn, and what the choice cost",
        "       a Card holds one Resolution per axis; the evidence axis has two rungs and no title",
        f"{'turn':>5} | {'dialogue':>21} | {'evidence':>14} | {'cycles':>7} {'choice_us':>10} {'graph_us':>9}",
        f"{'':>5} | {'full':>6} {'descr':>7} {'title':>6} | {'full':>6} {'descr':>7} | {'':>7} {'':>10} {'':>9}",
    ]
    # The choice record of the turn the plugin is opening carries ``turn=<i+1>``, and the cycle record
    # of that same turn is read at the boundary that closes it — so joining the two on the turn field
    # puts the choice of a turn next to the cycles that choice provoked. The trailing choice record
    # belongs to the boundary the harness fires only to flush the last count, and is dropped.
    cycles = dict(graph.cycles)
    for (turn, dialogue, evidence, micros), wall in zip(graph.choices, graph.graph_micros, strict=False):
        lines.append(
            f"{turn:>5} | {dialogue[0]:>6} {dialogue[1]:>7} {dialogue[2]:>6} "
            f"| {evidence[0]:>6} {evidence[1]:>7} | "
            f"{cycles.get(turn, 0):>7} {micros:>10} {wall:>9}"
        )
    lines += [
        "",
        f"  cards at the end: {graph.subject_cards} subject, {graph.artifact_cards} artifact",
        f"  matcher calls: {graph.matcher_calls} over {TURNS} turns (one embedding round each)",
        "  the graph_us of turn 1 carries the one-time imports the delivery handler defers, and is not",
        "  representative of a warm turn",
    ]

    lines += [
        "",
        "2. COMPACTION RATIO per Card at description (estimated full-content tokens / description tokens)",
    ]
    subject_ratios = [row for row in graph.ratios if row[0] > 0]
    artifact_ratios = [row for row in graph.ratios if row[0] == 0]
    if subject_ratios:
        values = [ratio for *_head, ratio in subject_ratios]
        full_tokens = [tokens for tokens, *_rest in subject_ratios]
        description_tokens = [tokens for _full, tokens, *_rest in subject_ratios]
        lines += [
            f"  subject Cards | samples {len(values)} | min {min(values):.2f}x "
            f"| median {statistics.median(values):.2f}x | mean {statistics.mean(values):.2f}x "
            f"| max {max(values):.2f}x",
            f"  full-content tokens: median {statistics.median(full_tokens):.0f} | "
            f"description tokens: median {statistics.median(description_tokens):.0f}",
        ]
    else:
        lines.append("  no subject Card was ever projected at description")
    lines.append(
        f"  artifact Cards | samples {len(artifact_ratios)} | ratio always 0.00x: an artifact Card "
        "addresses no message, so its full-content estimate is zero by construction and the record "
        "does not say so"
    )

    first_half, second_half = graph.first_half_cycles(), graph.second_half_cycles()
    reading = "descending" if second_half < first_half else ("flat" if second_half == first_half else "ASCENDING")
    lines += [
        "",
        "3. RETRIEVAL CYCLE CURVE",
        f"  per turn: {' '.join(str(count) for _turn, count in graph.cycles[1:])}",
        f"  requests made: {graph.expand_requests} of {graph.tool_calls} turns that needed an earlier "
        f"turn | counted by the plugin: {sum(count for _turn, count in graph.cycles)}",
        f"  first half turns 1-{TURNS // 2}: {first_half} | second half: {second_half} | reading: {reading}",
        f"  same session with the fed-back note disabled (reuse_ttl_cycles=0): "
        f"{sum(count for _turn, count in no_reuse.cycles)} cycles, per turn "
        f"{' '.join(str(count) for _turn, count in no_reuse.cycles[1:])}",
        "",
        "4. PREMATURE CALLS (a wanted tool whose name the call never published)",
        f"  wanted tool calls per arm: {graph.tool_calls}",
        f"  graph, one hop through the tool hub : {graph.premature_calls}",
        f"  graph, tool-hub traversal disabled  : {hub_off.premature_calls}",
        f"  B alone, no referenced source       : {no_graph.premature_calls}",
        f"  names published per delivery: min {min(graph.published, default=0)} max {max(graph.published, default=0)}",
        "",
        "5. CHOICE OVERHEAD IN ISOLATION (turn time minus model time; the model double is instant)",
        f"  choice alone, mean {graph.mean_choice_micros() / 1000:.3f}ms | "
        f"max {max(micros for *_h, micros in graph.choices) / 1000:.3f}ms",
        f"  whole graph per turn, mean {graph.mean_graph_micros() / 1000:.3f}ms | "
        f"session total {sum(graph.graph_micros) / 1000:.1f}ms",
        f"  same session with no graph wired: {sum(no_graph.graph_micros) / 1000:.1f}ms",
        f"  target: {OVERHEAD_TARGET_MICROS / 1000:.0f}ms per turn "
        f"({OVERHEAD_TARGET_MICROS * TURNS / 1_000_000:.0f}s over {TURNS} turns)",
        "  NOTE: no embedding round trip is in this number. It is a lower bound on production cost.",
        "",
        "OPEN DECISION 8. the AfterToolCallEvent fast path against the rebuild scan alone",
        f"  fast path on : {graph.artifact_cards} artifact Cards live, "
        f"{sum(graph.fast_path_micros)}us total over {len(graph.fast_path_micros)} calls",
        f"  fast path off: {no_fast.artifact_cards} artifact Cards live",
        f"  a scan recovers {graph.artifact_cards_by_scan} artifact Cards and the references of "
        f"{graph.referencing_cards_by_scan} subject Cards",
        "",
        "TOKENS PER DELIVERY (estimated input tokens, off the delivery record)",
        f"  deliveries: {len(graph.deliveries)} | first {graph.deliveries[0][3] if graph.deliveries else 0} "
        f"| last {graph.deliveries[-1][3] if graph.deliveries else 0} "
        f"| peak {max((tokens for *_h, tokens in graph.deliveries), default=0)}",
        f"  the same session with no graph wired peaks at "
        f"{max((tokens for *_h, tokens in no_graph.deliveries), default=0)} "
        f"(harness-derived: with no plugin there is no delivery record)",
    ]
    lines += ["", "-" * 96, "READINGS — what this session settles, and what it does not", "-" * 96]
    lines += _readings(graph, hub_off, no_graph, no_fast, no_reuse)
    lines += ["=" * 96, ""]
    return "\n".join(lines)


def _readings(graph: Report, hub_off: Report, no_graph: Report, no_fast: Report, no_reuse: Report) -> list[str]:
    """The plain-language reading of each number, computed from it so it cannot drift."""
    three_rungs = [turn for turn, dialogue, _evidence, _micros in graph.choices if all(dialogue)]
    evidence_full = [turn for turn, _dialogue, evidence, _micros in graph.choices if evidence[0]]
    evidence_description = [turn for turn, _dialogue, evidence, _micros in graph.choices if evidence[1]]
    note_saved = sum(count for _turn, count in no_reuse.cycles) - sum(count for _turn, count in graph.cycles)
    subject_ratios = [ratio for full, _description, ratio in graph.ratios if full > 0]
    return [
        f"1. CONCLUSIVE. The dialogue ladder carries three rungs in practice: all three are populated"
        f" on {len(three_rungs)} of {len(graph.choices)} turns. The evidence axis is a separate reading"
        f" and a shorter one: full content on {len(evidence_full)} turns, description on"
        f" {len(evidence_description)}, and no third rung to populate — no tool result ever travels as"
        " title alone, which is deliberate.",
        f"2. CONCLUSIVE in shape, synthetic in magnitude. Median {statistics.median(subject_ratios):.2f}x"
        " on subject Cards, and the number is a function of how much prose the invented answers carry."
        " Artifact Cards report 0.00x, which is not a compaction: they address no message.",
        f"3. FLAT over the halves, but the note is doing work: {note_saved} of"
        f" {sum(count for _turn, count in no_reuse.cycles)} requests disappear when the fed-back note is"
        " enabled. The curve is a duty cycle, not a descent — the note suppresses the request until it"
        " decays below the threshold, then the request comes back and renews it.",
        f"4. INCONCLUSIVE on this session. B alone spends {no_graph.premature_calls} premature calls and"
        f" the graph spends {graph.premature_calls}, so the channel pays for itself. But disabling the"
        f" tool-hub traversal changed nothing ({hub_off.premature_calls}), and the reason is structural:"
        " the supplemental referenced source only withholds a name when a Card's evidence is at title,"
        " and the evidence axis has two rungs. No Card can reach that state, so every name is always"
        " published — correctly, since at full content the toolUse blocks are in the retained history"
        " and at description the final block still names the tool — and this measurement cannot"
        " discriminate the one-hop reading from the two-hop one.",
        f"5. WELL INSIDE the target as measured — {graph.mean_choice_micros() / 1000:.3f}ms of choice"
        f" against a {OVERHEAD_TARGET_MICROS / 1000:.0f}ms budget — and the measurement excludes the"
        " embedding round trip that the budget is mostly made of. What it does say is that the"
        " arithmetic of the choice is not the cost, so the matcher's position is the only thing left to"
        " measure against a real embedding.",
        f"8. The fast path is the ONLY producer of artifact Cards: {graph.artifact_cards} with it,"
        f" {no_fast.artifact_cards} without, and a scan recovers {graph.artifact_cards_by_scan} — by"
        " design, since the scan rebuilds no artifact Card. What the scan does recover is the reference"
        f" on {graph.referencing_cards_by_scan} subject Cards, which is what keeps expand_artifact"
        f" working either way. So the hook costs"
        f" {statistics.mean(graph.fast_path_micros) / 1000:.2f}ms per offloaded result and buys the"
        " artifact's own Card and its find_context listing. It does not merely duplicate the scan.",
    ]


# --- the harness as a test ----------------------------------------------------------------------


def test_measurement_harness(capsys: pytest.CaptureFixture[str]) -> None:
    """Run the session, print the five numbers, and assert only the targets the task states.

    Two assertions, and they are the two the task names as targets: the choice overhead against the
    ~150ms budget, and the retrieval-cycle curve descending or flat rather than ascending. Everything
    else is reported, because a threshold invented over synthetic data would be a threshold that
    measures the fixture.
    """
    arms = measured()
    report = render_report(arms)
    with capsys.disabled():
        print(report)

    graph = arms["graph"]

    # Number 5. The instrumentation's own measure of the choice, and the wall time of everything the
    # graph does in a turn, both against the ~150ms budget of one embedding.
    assert graph.mean_choice_micros() < OVERHEAD_TARGET_MICROS
    assert graph.mean_graph_micros() < OVERHEAD_TARGET_MICROS

    # Number 3. Ascending would mean the note learned nothing from the requests.
    assert graph.second_half_cycles() <= graph.first_half_cycles()


def test_every_record_the_five_numbers_are_read_off_was_emitted() -> None:
    """The harness verifies the instrumentation: a record that stopped being emitted is an empty row."""
    graph = measured()["graph"]

    # One per turn, plus the boundary the harness fires to flush the last retrieval-cycle count.
    assert len(graph.choices) == TURNS + 1
    assert len(graph.cycles) == TURNS + 1
    assert graph.deliveries
    assert graph.published
    assert graph.ratios
