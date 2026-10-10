"""The selection: which Cards a call addresses, and what happens to the ones it does not.

Selection is the change that gives the links a job. With every Card addressed, propagation only ever
breaks ties in a ranking nobody is excluded from, so an edge can never be the reason a Card is
reached. These tests pin the three sources the selection draws from, and — the point of the whole
change — that one hop from the note's pick reaches a Card the question does not resemble.

The matcher is a canned map throughout: the interesting inputs here are exact scores, and a
similarity double that derives them from words would decide the test in the fixture.
"""

import pytest

from strands.vended_plugins.context_graph.compaction import _SEARCHABLE, render_final_block
from strands.vended_plugins.context_graph.scoring import distribute, select
from strands.vended_plugins.context_graph.state import Card, CardChoice, Link, ToolPair, _GraphState

from .test_compaction import _DESCRIPTION_TOKENS, _context


def _card(title, turn, *, kind="subject", references=(), pairs=()):
    """A Card carrying only what the selection and the block read."""
    return Card(
        title=title,
        kind=kind,
        turn=turn,
        dialogue_ids=(f"d{turn}",),
        evidence_ids=(f"e{turn}",) if pairs else (),
        pairs=tuple(pairs),
        tool_names=frozenset(),
        references=tuple(references),
        numeric_lines=(),
        tags=(),
        description=f"about {title}",
    )


def _state(*cards, links=None):
    """A graph state over ``cards``, with optional outgoing edges per title."""
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
        state.links[card.title] = []
    for title, edges in (links or {}).items():
        state.links[title] = list(edges)
    state.turn = len(state.cards)
    return state


def _config(**overrides):
    """The distribution arguments, so a test varies exactly one thing."""
    return {
        "expand_threshold": 0.55,
        "collapse_floor": 0.45,
        "body_budget": None,
        **overrides,
    }


class TestTheRecencyWindow:
    def test_the_last_cards_are_addressed_whatever_their_note(self):
        """The referent of a question with no content words is almost always the last few turns."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(6)])
        notes = {f"t{turn}": 0.0 for turn in range(6)}

        selected = select(notes, state, recent_cards=2, select_top_k=0)

        assert selected == {"t4", "t5"}

    def test_a_conversation_shorter_than_the_window_is_wholly_addressed(self):
        """Why the policy needs no warm-up parameter: it does nothing until there is a tail to cut."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(3)])
        notes = {f"t{turn}": 0.0 for turn in range(3)}

        assert select(notes, state, recent_cards=10, select_top_k=0) == {"t0", "t1", "t2"}

    def test_a_window_of_zero_selects_by_note_alone(self):
        """``0`` and ``None`` are different configurations: no window, against no selection."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(4)])
        notes = {"t0": 0.9, "t1": 0.1, "t2": 0.1, "t3": 0.1}

        assert select(notes, state, recent_cards=0, select_top_k=1) == {"t0"}


class TestTheNotesPick:
    def test_the_highest_notes_outside_the_window_are_addressed(self):
        """The return to an old subject, which recency by definition cannot cover."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(6)])
        notes = {"t0": 0.9, "t1": 0.8, "t2": 0.1, "t3": 0.1, "t4": 0.1, "t5": 0.1}

        selected = select(notes, state, recent_cards=2, select_top_k=1)

        assert selected == {"t0", "t4", "t5"}

    def test_the_pick_does_not_spend_its_places_on_the_window(self):
        """A Card already inside the window is selected either way, so it takes no place of the pick."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(4)])
        notes = {"t0": 0.1, "t1": 0.2, "t2": 0.9, "t3": 0.95}

        selected = select(notes, state, recent_cards=2, select_top_k=1)

        assert selected == {"t1", "t2", "t3"}


class TestTheHop:
    def test_one_hop_from_the_pick_reaches_a_card_the_question_does_not_resemble(self):
        """The case the graph exists for, and the only one the other two sources miss.

        The question resembles the Card about the error, which cites an artifact belonging to a Card
        about the report — and that Card resembles the question not at all. The edge is the only route.
        """
        error = _card("that error", 5)
        report = _card("the report I asked for", 0)
        state = _state(error, report, links={"that error": [Link("artifact", "the report I asked for", 0.6)]})
        notes = {"that error": 0.9, "the report I asked for": 0.0}

        selected = select(notes, state, recent_cards=0, select_top_k=1)

        assert selected == {"that error", "the report I asked for"}

    def test_the_similarity_edge_is_followed_and_this_is_its_only_job(self):
        """The note does not inherit along a ``similar`` edge, so the hop is all it does.

        Widening what the call reaches is the question the edge answers. Measured offline, that is
        where it pays — recall of the required Card rose to 100% from 85.7% and 68.4% on the two
        question families — while letting it feed the note instead cost two thirds of the ranking.
        """
        answer = _card("the statement figures", 0)
        asked = _card("the connector status", 5)
        state = _state(asked, answer, links={"the connector status": [Link("similar", "the statement figures", 0.7)]})

        selected = select(
            {"the connector status": 0.9, "the statement figures": 0.0}, state, recent_cards=0, select_top_k=1
        )

        assert selected == {"the connector status", "the statement figures"}

    def test_a_tool_edge_is_not_followed(self):
        """A tool name is not a Card: it is the axis two Cards reach each other *through*, and the note
        already carries that hop."""
        state = _state(_card("t0", 0), links={"t0": [Link("tool", "run_query", 0.6)]})

        assert select({"t0": 0.9}, state, recent_cards=0, select_top_k=1) == {"t0"}

    def test_an_edge_to_a_card_the_graph_lost_is_skipped(self):
        """A dangling target is a stale edge, not a corrupt state."""
        state = _state(_card("t0", 0), links={"t0": [Link("similar", "gone", 0.9)]})

        assert select({"t0": 0.9}, state, recent_cards=0, select_top_k=1) == {"t0"}


class TestWhatAnUnaddressedCardCosts:
    def test_it_is_decided_rather_than_omitted_so_its_messages_leave(self):
        """The removal reads an absent entry as full content, so omitting would keep what was excluded."""
        state = _state(_card("keep", 1), _card("drop", 0))

        choice = distribute({"keep": 0.9, "drop": 0.0}, state, selected=frozenset({"keep"}), **_config())

        assert choice.by_title["drop"] == CardChoice(dialogue="title", evidence="title")

    def test_it_contributes_no_entry_to_the_final_block(self):
        """Not even its Title. What the model gets instead is the count, and a tool to reach it with."""
        state = _state(_card("keep", 1), _card("drop", 0))
        state.choice = distribute({"keep": 0.2, "drop": 0.0}, state, selected=frozenset({"keep"}), **_config())

        block = render_final_block(_context(), state, frozenset({"d0", "d1"}), description_tokens=_DESCRIPTION_TOKENS)

        assert "drop" not in block
        assert "keep" in block

    def test_the_block_states_how_many_turns_were_left_out(self):
        """Requirement 4.2 wanted the model to know more exists and how to reach it. This is that,
        bounded: a gap the model can see is a gap it can close."""
        state = _state(*[_card(f"t{turn}", turn) for turn in range(5)])
        state.choice = distribute(
            {f"t{turn}": 0.0 for turn in range(5)}, state, selected=frozenset({"t4"}), **_config()
        )

        block = render_final_block(
            _context(),
            state,
            frozenset(f"d{turn}" for turn in range(5)),
            description_tokens=_DESCRIPTION_TOKENS,
        )

        assert _SEARCHABLE.format(count=4) in block
        assert "find_context" in block


class TestSelectionOff:
    def test_no_selection_addresses_every_card(self):
        """``recent_cards=None`` is the behavior before selection existed, and it stays the default."""
        state = _state(_card("t0", 0), _card("t1", 1))

        choice = distribute({"t0": 0.0, "t1": 0.0}, state, selected=None, **_config())

        assert choice.selected is None
        assert all(entry.evidence != "title" for entry in choice.by_title.values())

    def test_an_empty_selection_is_not_the_same_as_no_selection(self):
        """One means the selection ran and chose nothing; the other means it never ran."""
        state = _state(_card("t0", 0))

        chosen_nothing = distribute({"t0": 0.0}, state, selected=frozenset(), **_config())

        assert chosen_nothing.by_title["t0"].dialogue == "title"


@pytest.mark.parametrize("kind", ["subject", "artifact"])
def test_the_selection_is_frozen_and_covers_every_card(kind):
    """Every Card is decided, whether or not the call addresses it: no Card is silently missing."""
    state = _state(_card("t0", 0, kind=kind), _card("t1", 1, pairs=(ToolPair("tu", "run", ("e1",), True),)))

    choice = distribute({"t0": 0.9, "t1": 0.0}, state, selected=frozenset({"t0"}), **_config())

    assert set(choice.by_title) == set(state.cards)
    with pytest.raises(TypeError):
        choice.by_title["t0"] = CardChoice("full", "full")
