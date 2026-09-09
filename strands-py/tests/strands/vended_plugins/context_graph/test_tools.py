"""Unit tests of the three retrieval tools: every success path and every error mode.

Driven through ``_GraphStrategy`` rather than through ``tools.py`` directly, because the claims are
about the tool as the model reaches it: the state it is handed, the cycle counter it ages notes by, and
the configuration it reads thresholds from all arrive through the strategy. Calling the module functions
would test the same arithmetic with the wiring assumed.

Four claims run through the whole file.

* **No error is an exception.** Every failure mode comes back as prose naming what was missing, so the
  suite asserts on the text and never on ``pytest.raises``.
* **An error records nothing.** The fed-back note map and the frozen choice are checked *by identity*
  after every failing call, which is a stronger statement than checking they are equal to what they
  were.
* **``agent.messages`` is never touched.** Asserted against a deep copy taken before the call, on all
  three tools.
* **No language model, and no network.** The matcher is always a double, and the package-wide guard in
  ``conftest.py`` fails the test on the first outbound socket.

``expand_artifact`` runs against a real ``ContextOffloader`` over ``InMemoryStorage``: the design's whole
argument for that tool is that it delegates the read to storage that already carries the traversal
guards, so doubling the storage would double away the thing under test.
"""

from __future__ import annotations

import copy
from types import MappingProxyType, SimpleNamespace
from typing import Any

import pytest

from strands.vended_plugins.context_graph.plugin import _GraphStrategy
from strands.vended_plugins.context_graph.scoring import _REUSE_BONUS
from strands.vended_plugins.context_graph.state import Card, CardChoice, TurnChoice, _GraphState
from strands.vended_plugins.context_offloader import ContextOffloader
from strands.vended_plugins.context_offloader.storage import InMemoryStorage

from .stubs import StubMatcher

CONFIG: dict[str, Any] = {
    "expand_threshold": 0.55,
    "collapse_floor": 0.15,
    "description_tokens": 100,
    "tags_per_card": 5,
    "rarity_weight": 0.70,
    "body_budget": None,
    "min_cards": 3,
    "link_threshold": 0.50,
    "reuse_ttl_cycles": 5,
    "recent_cards": None,
    "select_top_k": 5,
    "reranker": None,
    "persist": False,
}
"""The construction defaults, so a test that varies one of them varies exactly one thing."""


# --- doubles ------------------------------------------------------------------------------------


class FakePluginRegistry:
    """Just the mapping ``tools._offloader_of`` reads."""

    def __init__(self, *plugins: Any) -> None:
        self._plugins: dict[str, Any] = {plugin.name: plugin for plugin in plugins}


class FakeAgent:
    """Weakref-able agent double carrying only what the three tools touch."""

    def __init__(self, *plugins: Any, cycle: int = 0) -> None:
        self.messages: list[dict[str, Any]] = [
            {"role": "user", "content": [{"text": "the question of the turn"}], "tracking_id": "m0"},
            {"role": "assistant", "content": [{"text": "the answer of the turn"}], "tracking_id": "m1"},
        ]
        self._plugin_registry = FakePluginRegistry(*plugins)
        self.event_loop_metrics = SimpleNamespace(cycle_count=cycle)


# --- builders -----------------------------------------------------------------------------------


def subject_card(title: str, turn: int, description: str, tags: tuple[str, ...] = ()) -> Card:
    """A Subject Card carrying what the three tools read: title, turn, tags and description."""
    return Card(
        title=title,
        kind="subject",
        turn=turn,
        dialogue_ids=(f"{title}-d",),
        evidence_ids=(f"{title}-e",),
        pairs=(),
        tool_names=frozenset(),
        references=(),
        numeric_lines=(),
        tags=tags,
        description=description,
    )


def artifact_card(title: str, turn: int, reference: str, description: str = "an artifact") -> Card:
    """An Artifact Card, which ``expand_card`` must refuse and ``expand_artifact`` records against."""
    return Card(
        title=title,
        kind="artifact",
        turn=turn,
        dialogue_ids=(),
        evidence_ids=(),
        pairs=(),
        tool_names=frozenset(),
        references=(reference,),
        numeric_lines=(),
        tags=(),
        description=description,
        reference=reference,
        content_type="text/plain",
        size_bytes=42,
    )


def state_with(*cards: Card, full_pass: bool = False) -> _GraphState:
    """A graph state holding ``cards``, with a frozen choice covering every one of them."""
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
    state.turn = max((card.turn for card in cards), default=-1) + 1
    state.choice = TurnChoice(
        by_title=MappingProxyType(
            {} if full_pass else {card.title: CardChoice("description", "description") for card in cards}
        ),
        full_pass=full_pass,
    )
    return state


def strategy_over(state: _GraphState, agent: Any, matcher: Any = None, **overrides: Any) -> _GraphStrategy:
    """A graph strategy whose state for ``agent`` is ``state``, with a doubled matcher."""
    strategy = _GraphStrategy(**{**CONFIG, **overrides, "matcher": matcher or StubMatcher()})
    strategy._states[agent] = state
    return strategy


def context_for(agent: Any) -> Any:
    """The slice of ``ToolContext`` the three tools read."""
    return SimpleNamespace(agent=agent)


async def offloaded(agent: FakeAgent, content: bytes, content_type: str = "text/plain") -> tuple[ContextOffloader, str]:
    """Register an offloader on ``agent`` and store ``content`` in it, returning its reference."""
    storage = InMemoryStorage()
    offloader = ContextOffloader(storage=storage)
    agent._plugin_registry._plugins[offloader.name] = offloader
    reference = await storage.store("tool-1_0", content, content_type)
    return offloader, reference


# --- expand_card --------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expand_card_raises_both_axes_for_the_rest_of_the_turn():
    """Requirement 12.2: dialogue and evidence together — a turn without its tool results is not the turn."""
    agent = FakeAgent(cycle=2)
    state = state_with(subject_card("the ask", 0, "about the ask"), subject_card("another", 1, "about another"))
    strategy = strategy_over(state, agent)
    before = copy.deepcopy(agent.messages)

    answer = await strategy.expand_card("the ask", context_for(agent))

    assert "the ask" in answer
    assert state.choice.by_title["the ask"] == CardChoice("full", "full")
    # Every other Card is left exactly as the turn's choice decided it.
    assert state.choice.by_title["another"] == CardChoice("description", "description")
    assert state.choice.full_pass is False
    # Requirement 12.13: no message moved, and no model was reachable from here.
    assert agent.messages == before


@pytest.mark.asyncio
async def test_expand_card_records_the_fed_back_note_on_the_cycle_it_was_asked_on():
    """Requirements 13.1, 12.14: the elevation ends with the turn, the note carries the request past it."""
    agent = FakeAgent(cycle=4)
    state = state_with(subject_card("the ask", 0, "about the ask"))
    strategy = strategy_over(state, agent)

    await strategy.expand_card("the ask", context_for(agent))

    assert state.reuse == {"the ask": (_REUSE_BONUS, 9)}


@pytest.mark.asyncio
async def test_expand_card_under_a_full_pass_leaves_the_choice_alone():
    """A full pass is already Full Content everywhere, and flipping it would cost the identity short circuit."""
    agent = FakeAgent()
    state = state_with(subject_card("the ask", 0, "about the ask"), full_pass=True)
    strategy = strategy_over(state, agent)
    choice = state.choice

    await strategy.expand_card("the ask", context_for(agent))

    assert state.choice is choice
    assert state.reuse == {"the ask": (_REUSE_BONUS, 5)}


@pytest.mark.asyncio
async def test_expand_card_with_reuse_ttl_zero_still_raises_the_resolution():
    """Requirement 13.6: the note is discarded, but the tool still has an effect on its own turn."""
    agent = FakeAgent()
    state = state_with(subject_card("the ask", 0, "about the ask"))
    strategy = strategy_over(state, agent, reuse_ttl_cycles=0)

    await strategy.expand_card("the ask", context_for(agent))

    assert state.choice.by_title["the ask"] == CardChoice("full", "full")
    assert state.reuse == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("title", ["a title nobody used", "an artifact"])
async def test_expand_card_names_the_title_and_changes_no_resolution(title):
    """Requirement 12.3: an unknown Title, and an Artifact Card, are the same refusal."""
    agent = FakeAgent()
    state = state_with(subject_card("the ask", 0, "about the ask"), artifact_card("an artifact", 1, "mem_1"))
    strategy = strategy_over(state, agent)
    choice = state.choice
    before = copy.deepcopy(agent.messages)

    answer = await strategy.expand_card(title, context_for(agent))

    assert title in answer
    assert state.choice is choice
    assert state.reuse == {}
    assert agent.messages == before


@pytest.mark.asyncio
async def test_expand_card_counts_the_retrieval_cycle_even_when_it_refuses():
    """Requirement 17.8: a cycle spent on a request that came back empty was still spent."""
    agent = FakeAgent()
    state = state_with(subject_card("the ask", 0, "about the ask"))
    strategy = strategy_over(state, agent)

    await strategy.expand_card("the ask", context_for(agent))
    await strategy.expand_card("nothing like it", context_for(agent))

    assert state.retrieval_cycles == 2


# --- expand_artifact ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_expand_artifact_without_an_offloader_names_the_missing_storage():
    """Requirement 15.6: absence of A degrades to a message, never to an exception."""
    agent = FakeAgent()
    state = state_with(artifact_card("an artifact", 0, "mem_1_tool-1_0"))
    strategy = strategy_over(state, agent)
    choice = state.choice
    before = copy.deepcopy(agent.messages)

    answer = await strategy.expand_artifact("mem_1_tool-1_0", context_for(agent))

    assert "storage" in answer
    assert "mem_1_tool-1_0" in answer
    assert state.choice is choice
    assert state.reuse == {}
    assert agent.messages == before


@pytest.mark.asyncio
async def test_expand_artifact_whole_records_that_it_reinjects_every_token():
    """Requirement 12.5: the cheapest request to write must not also be the silent one."""
    agent = FakeAgent(cycle=1)
    _offloader, reference = await offloaded(agent, b"line one\nline two\nline three")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)
    before = copy.deepcopy(agent.messages)

    answer = await strategy.expand_artifact(reference, context_for(agent))

    assert "line one\nline two\nline three" in answer
    assert "entire token count" in answer
    assert reference in answer
    # Requirement 13.1: the note lands on the artifact's own Card.
    assert state.reuse == {"an artifact": (_REUSE_BONUS, 6)}
    assert agent.messages == before


@pytest.mark.asyncio
async def test_expand_artifact_by_line_range_returns_only_that_span():
    """Requirement 12.4: the read is delegated, and the span is the offloader's own 1-indexed contract."""
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"alpha\nbravo\ncharlie\ndelta")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)

    answer = await strategy.expand_artifact(reference, context_for(agent), {"start": 2, "end": 3})

    assert "bravo" in answer
    assert "charlie" in answer
    assert "alpha" not in answer
    assert "delta" not in answer
    # A targeted read is not the whole artifact, so it carries no whole-token notice.
    assert "entire token count" not in answer


@pytest.mark.asyncio
async def test_expand_artifact_by_pattern_returns_the_matching_lines():
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"ok\nERROR: it broke\nok again")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)

    answer = await strategy.expand_artifact(reference, context_for(agent), None, "ERROR")

    assert "ERROR: it broke" in answer


@pytest.mark.asyncio
async def test_expand_artifact_with_an_unknown_reference_names_it():
    """Requirement 12.6: unknown reference, no Resolution changed, nothing recorded."""
    agent = FakeAgent()
    await offloaded(agent, b"some content")
    state = state_with(artifact_card("an artifact", 0, "mem_1_tool-1_0"))
    strategy = strategy_over(state, agent)
    choice = state.choice

    answer = await strategy.expand_artifact("mem_99_nope", context_for(agent))

    assert "mem_99_nope" in answer
    assert state.choice is choice
    assert state.reuse == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line_range", "pattern"),
    [({"start": 1, "end": 2}, None), (None, "needle")],
)
async def test_expand_artifact_on_non_textual_content_names_the_content_type(line_range, pattern):
    """Requirement 12.7: a line range does not apply to a PNG, and the answer says which type it was."""
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"\x89PNG\r\n", "image/png")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)
    choice = state.choice

    answer = await strategy.expand_artifact(reference, context_for(agent), line_range, pattern)

    assert "image/png" in answer
    assert state.choice is choice
    assert state.reuse == {}


@pytest.mark.asyncio
async def test_expand_artifact_with_a_malformed_line_range_names_it():
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"alpha\nbravo")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)

    answer = await strategy.expand_artifact(reference, context_for(agent), {"from": 1})

    assert "line_range" in answer
    assert state.reuse == {}


@pytest.mark.asyncio
async def test_expand_artifact_with_a_line_range_outside_the_content_answers_in_prose():
    """The offloader's own validation raises; the graph turns it into something the model can act on."""
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"alpha\nbravo")
    state = state_with(artifact_card("an artifact", 0, reference))
    strategy = strategy_over(state, agent)

    answer = await strategy.expand_artifact(reference, context_for(agent), {"start": 90, "end": 99})

    assert reference in answer
    assert state.reuse == {}


@pytest.mark.asyncio
async def test_expand_artifact_reads_a_reference_the_graph_never_carded():
    """A reference storage holds but no Card addresses: the read succeeds, and no note has a home."""
    agent = FakeAgent()
    _offloader, reference = await offloaded(agent, b"orphaned content")
    state = state_with(subject_card("the ask", 0, "about the ask"))
    strategy = strategy_over(state, agent)

    answer = await strategy.expand_artifact(reference, context_for(agent))

    assert "orphaned content" in answer
    assert state.reuse == {}


# --- find_context -------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_find_context_returns_title_tags_and_description_per_candidate():
    """Requirements 12.8, 12.11: each candidate carries all three, best first."""
    agent = FakeAgent(cycle=3)
    state = state_with(
        subject_card("the invoice", 0, "about the invoice", ("invoice", "1200")),
        subject_card("the weather", 1, "about the weather", ("weather",)),
    )
    matcher = StubMatcher({"about the invoice": 0.9, "about the weather": 0.05})
    strategy = strategy_over(state, agent, matcher)
    before = copy.deepcopy(agent.messages)

    answer = await strategy.find_context("what did we say about billing", context_for(agent))

    assert "the invoice" in answer
    assert "invoice, 1200" in answer
    assert "about the invoice" in answer
    # Below ``collapse_floor``, so it is not a candidate at all.
    assert "the weather" not in answer
    # Requirement 13.1: only what was actually returned gets the note.
    assert state.reuse == {"the invoice": (_REUSE_BONUS, 8)}
    assert agent.messages == before


@pytest.mark.asyncio
async def test_find_context_scores_over_one_matcher_call_and_no_second_index():
    """Requirement 12.10: the index is the one the turn choice uses, reached through ``score`` once."""
    agent = FakeAgent()
    state = state_with(
        subject_card("first", 0, "about first"),
        subject_card("second", 1, "about second"),
    )
    matcher = StubMatcher({"about first": 0.8, "about second": 0.7})
    strategy = strategy_over(state, agent, matcher)

    await strategy.find_context("either of them", context_for(agent))

    assert matcher.call_count == 1
    assert matcher.calls == [("either of them", ("about first", "about second"))]
    # Nothing was written to the vector cache: this tool reads an index, it does not build one.
    assert state.vectors == {}


@pytest.mark.asyncio
async def test_find_context_with_a_tag_restricts_to_the_normalized_value():
    """Requirement 12.9: ``R$ 1.200,00`` and ``1200`` are the same Tag, which is the case that matters."""
    agent = FakeAgent()
    state = state_with(
        subject_card("the invoice", 0, "about the invoice", ("invoice", "1200")),
        subject_card("the refund", 1, "about the refund", ("refund",)),
    )
    matcher = StubMatcher({"about the invoice": 0.8, "about the refund": 0.9})
    strategy = strategy_over(state, agent, matcher)

    answer = await strategy.find_context("the amount", context_for(agent), "R$ 1.200,00")

    assert "the invoice" in answer
    # Higher scoring, and excluded anyway: the tag decides membership, not the score.
    assert "the refund" not in answer
    assert matcher.calls == [("the amount", ("about the invoice",))]


@pytest.mark.asyncio
async def test_find_context_without_a_tag_scores_every_card():
    """The same graph, unrestricted: the tag is the only thing that narrows the candidate set."""
    agent = FakeAgent()
    state = state_with(
        subject_card("the invoice", 0, "about the invoice", ("invoice",)),
        subject_card("the refund", 1, "about the refund", ("refund",)),
    )
    matcher = StubMatcher({"about the invoice": 0.8, "about the refund": 0.9})
    strategy = strategy_over(state, agent, matcher)

    answer = await strategy.find_context("the amount", context_for(agent))

    assert "the invoice" in answer
    assert "the refund" in answer
    # Best first, whatever the turn order.
    assert answer.index("the refund") < answer.index("the invoice")


@pytest.mark.asyncio
async def test_find_context_returns_at_most_five_candidates():
    """Requirement 12.11: a search that answers with the whole graph re-injected what the graph collapsed."""
    agent = FakeAgent()
    cards = [subject_card(f"turn {index}", index, f"about turn {index}") for index in range(8)]
    state = state_with(*cards)
    matcher = StubMatcher({card.description: 0.9 - index * 0.01 for index, card in enumerate(cards)})
    strategy = strategy_over(state, agent, matcher)

    answer = await strategy.find_context("all of them", context_for(agent))

    assert answer.count("- title:") == 5
    # The five best, and the note lands on exactly those five.
    assert set(state.reuse) == {f"turn {index}" for index in range(5)}


@pytest.mark.asyncio
async def test_find_context_below_the_floor_names_the_need_and_records_nothing():
    """Requirement 12.12: an empty result is still an answer, and it still costs a cycle."""
    agent = FakeAgent()
    state = state_with(subject_card("the invoice", 0, "about the invoice"))
    matcher = StubMatcher({"about the invoice": 0.05})
    strategy = strategy_over(state, agent, matcher)
    choice = state.choice
    before = copy.deepcopy(agent.messages)

    answer = await strategy.find_context("something else entirely", context_for(agent))

    assert "something else entirely" in answer
    assert "- title:" not in answer
    assert state.choice is choice
    assert state.reuse == {}
    assert state.retrieval_cycles == 1
    assert agent.messages == before


@pytest.mark.asyncio
async def test_find_context_with_a_tag_nothing_carries_names_both():
    """Naming the Tag too is what lets the model tell "not discussed" from "not tagged that way"."""
    agent = FakeAgent()
    state = state_with(subject_card("the invoice", 0, "about the invoice", ("invoice",)))
    strategy = strategy_over(state, agent, StubMatcher({"about the invoice": 0.9}))

    answer = await strategy.find_context("the amount", context_for(agent), "refund")

    assert "the amount" in answer
    assert "refund" in answer
    assert state.reuse == {}


@pytest.mark.asyncio
async def test_find_context_on_an_empty_graph_answers_empty():
    agent = FakeAgent()
    state = state_with()
    matcher = StubMatcher()
    strategy = strategy_over(state, agent, matcher)

    answer = await strategy.find_context("anything at all", context_for(agent))

    assert "anything at all" in answer
    # Nothing to score, so the matcher is never reached: no embedding is paid for an empty graph.
    assert matcher.call_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "matcher",
    [
        StubMatcher(fail=RuntimeError("matcher unavailable")),
        StubMatcher(answer=[0.9]),
        StubMatcher(answer="not a sequence of floats"),
    ],
)
async def test_find_context_with_an_unusable_matcher_answers_empty(matcher):
    """Requirement 16.8: a matcher that raises or answers malformed reads as "no candidate"."""
    agent = FakeAgent()
    state = state_with(
        subject_card("first", 0, "about first"),
        subject_card("second", 1, "about second"),
    )
    strategy = strategy_over(state, agent, matcher)
    choice = state.choice

    answer = await strategy.find_context("either of them", context_for(agent))

    assert "either of them" in answer
    assert "- title:" not in answer
    assert state.choice is choice
    assert state.reuse == {}
