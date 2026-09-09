"""Unit tests of the fed-back note: it rises on an explicit request and comes down on its own.

Two things are pinned here. The bonus is **whole** on the cycle it was granted on — anything less and
the tool the model just called would have no effect on the turn it was called in. And the decay lives
on the write, which is the contract ``compute_notes`` reads against: the first pass adds
``state.reuse`` with no further factor of its own.

Recording an error is tested by absence: a failed call never reaches ``record_reuse``, so what is
checked is that nothing else writes the map.
"""

import pytest

from strands.vended_plugins.context_graph.scoring import (
    _DECAY,
    _REUSE_BONUS,
    compute_notes,
    expire_reuse,
    record_reuse,
)
from strands.vended_plugins.context_graph.state import Card, _GraphState

from .stubs import StubMatcher


def _card(title, turn, description):
    """A Card carrying only what the first pass reads: title, turn and description."""
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
        tags=(),
        description=description,
    )


def _state(*cards, turn=None):
    """A graph state holding ``cards``; ``turn`` defaults to one past the last turn ordinal."""
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
    state.turn = turn if turn is not None else (max((c.turn for c in cards), default=-1) + 1)
    return state


# --- granting -----------------------------------------------------------------------------------


def test_a_successful_request_grants_the_whole_bonus_on_the_cycle_it_was_asked_on():
    """Requirements 13.1, 13.2: the explicit request has to beat the threshold on its own turn."""
    state = _state(_card("t0", 0, "first"))

    record_reuse(state, "t0", cycle=3, reuse_ttl_cycles=5)

    assert state.reuse == {"t0": (_REUSE_BONUS, 8)}


def test_asking_again_restarts_the_countdown_instead_of_stacking():
    """Requirement 13.5: granting and renewing are the same write, mould of ``_renew``."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)
    expire_reuse(state, 3, reuse_ttl_cycles=5)
    decayed, _ = state.reuse["t0"]
    assert decayed < _REUSE_BONUS

    record_reuse(state, "t0", cycle=3, reuse_ttl_cycles=5)

    assert state.reuse == {"t0": (_REUSE_BONUS, 8)}


def test_a_ttl_of_zero_writes_nothing_at_all():
    """Requirement 13.6: a note discarded at the end of its own turn never crosses a boundary."""
    state = _state(_card("t0", 0, "first"))

    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=0)

    assert state.reuse == {}


def test_each_card_holds_its_own_countdown():
    state = _state(_card("t0", 0, "first"), _card("t1", 1, "second"))

    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)
    record_reuse(state, "t1", cycle=2, reuse_ttl_cycles=5)

    assert state.reuse == {"t0": (_REUSE_BONUS, 5), "t1": (_REUSE_BONUS, 7)}


def test_granting_touches_nothing_but_the_reuse_map():
    """Requirement 13.7: the fed-back note lives exclusively in the graph state."""
    state = _state(_card("t0", 0, "first"))
    cards_before = dict(state.cards)

    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)

    assert state.cards == cards_before
    assert state.links == {}
    assert state.turn == 1


# --- expiring -----------------------------------------------------------------------------------


def test_the_bonus_is_still_whole_on_the_cycle_of_the_grant():
    """Expiring on the granting cycle itself must not age a note that has not aged yet."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "t0", cycle=4, reuse_ttl_cycles=5)

    expire_reuse(state, 4, reuse_ttl_cycles=5)

    assert state.reuse == {"t0": (_REUSE_BONUS, 9)}


@pytest.mark.parametrize("elapsed", [1, 2, 3, 4])
def test_the_bonus_halves_once_per_cycle(elapsed):
    """Requirement 13.3: decay applies to the fed-back note, measured in cycles."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)

    expire_reuse(state, elapsed, reuse_ttl_cycles=5)

    assert state.reuse["t0"] == (_REUSE_BONUS * _DECAY**elapsed, 5)


def test_reaching_the_expiry_cycle_removes_the_note():
    """Requirement 13.4: it is removed outright, not left at a small bonus forever."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)

    expire_reuse(state, 5, reuse_ttl_cycles=5)

    assert state.reuse == {}


def test_expiring_twice_in_the_same_cycle_decays_only_once():
    """The decay is recomputed from the expiry, never compounded off the stored value."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)

    expire_reuse(state, 2, reuse_ttl_cycles=5)
    once = state.reuse["t0"]
    expire_reuse(state, 2, reuse_ttl_cycles=5)

    assert state.reuse["t0"] == once


def test_expiring_removes_only_the_notes_that_reached_their_own_expiry():
    state = _state(_card("t0", 0, "first"), _card("t1", 1, "second"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)
    record_reuse(state, "t1", cycle=3, reuse_ttl_cycles=5)

    expire_reuse(state, 5, reuse_ttl_cycles=5)

    assert set(state.reuse) == {"t1"}


def test_expiring_an_empty_map_is_a_no_op():
    state = _state(_card("t0", 0, "first"))

    expire_reuse(state, 7, reuse_ttl_cycles=5)

    assert state.reuse == {}


def test_a_note_for_a_title_the_graph_no_longer_holds_still_expires():
    """A Card can be removed by rebuild scan; its countdown must not outlive it forever."""
    state = _state(_card("t0", 0, "first"))
    record_reuse(state, "gone", cycle=0, reuse_ttl_cycles=2)

    expire_reuse(state, 2, reuse_ttl_cycles=2)

    assert state.reuse == {}


# --- what the first pass does with it -----------------------------------------------------------


def test_the_first_pass_adds_the_stored_bonus_with_no_further_factor():
    """Requirement 13.2: added after the first pass and before propagation, already decayed."""
    state = _state(_card("t0", 0, "first"), _card("t1", 1, "second"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=5)
    expire_reuse(state, 1, reuse_ttl_cycles=5)
    stored, _ = state.reuse["t0"]

    notes = compute_notes(state, "question", StubMatcher({"first": 0.2, "second": 0.2}))

    # ``t1`` is the active subject of turn 2, so only ``t0`` is free of the continuity bonus.
    assert notes["t0"] == pytest.approx(0.2 + stored)


def test_an_expired_note_leaves_the_note_at_the_bare_similarity():
    """Requirement 13.4: once removed, the Card is scored as though it had never been asked for."""
    state = _state(_card("t0", 0, "first"), _card("t1", 1, "second"))
    record_reuse(state, "t0", cycle=0, reuse_ttl_cycles=2)
    expire_reuse(state, 2, reuse_ttl_cycles=2)

    notes = compute_notes(state, "question", StubMatcher({"first": 0.2, "second": 0.2}))

    assert notes["t0"] == pytest.approx(0.2)
