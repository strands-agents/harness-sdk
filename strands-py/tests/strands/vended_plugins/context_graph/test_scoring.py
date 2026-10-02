"""Unit tests of the Note — the warm-up short circuit, the first pass, and propagation.

Two things are pinned down here that no later test can recover once they are wrong: the matcher is
**not** called when the choice is skipped, and the three terms of the first pass enter with no factor
at all. Both are checked by observation rather than by patching — the stub counts its own calls, and
the notes are compared against the exact arithmetic sum, not against an inequality.

``deepcopy`` guards the no-mutation contract instead of an identity check on the container: replacing
a tuple in place would leave the container identical and still be a mutation.
"""

import copy
import dataclasses
import logging

import pytest

from strands.vended_plugins.context_graph.cards import register_card
from strands.vended_plugins.context_graph.scoring import (
    _CONTINUITY_BONUS,
    _DECAY,
    _W_ARTIFACT,
    _W_PREVIOUS,
    _W_TOOL,
    compute_notes,
    distribute,
    full_pass_choice,
    titles_in_turn_order,
    warm_up_choice,
)
from strands.vended_plugins.context_graph.state import Card, Link, ToolPair, _GraphState

from .stubs import StubMatcher


def _card(title, turn, description):
    """Build a Card carrying only what the first pass reads: the title, the turn and the description."""
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
    state.turn = turn if turn is not None else (max((f.turn for f in cards), default=-1) + 1)
    return state


def _three_cards():
    """Three Cards in turn order, with distinct descriptions so scores are addressable."""
    return _state(
        _card("t0", 0, "first subject"),
        _card("t1", 1, "second subject"),
        _card("t2", 2, "third subject"),
    )


# --- the warm-up short circuit ------------------------------------------------------------------


def test_expand_threshold_of_zero_skips_the_choice_without_reaching_the_matcher():
    """Requirement 2.20: the off switch is a fixed full pass, not a threshold every note clears."""
    state = _three_cards()
    matcher = StubMatcher()

    choice = warm_up_choice(state, expand_threshold=0.0, min_cards=3)

    assert choice is not None
    assert choice.full_pass is True
    assert dict(choice.by_title) == {}
    assert matcher.call_count == 0


@pytest.mark.parametrize("card_count", [0, 1, 2])
def test_fewer_cards_than_the_floor_skips_the_choice_without_reaching_the_matcher(card_count):
    """Requirement 7.7: below ``min_cards`` the only possible decision is "send it all"."""
    state = _state(*[_card(f"t{index}", index, f"subject {index}") for index in range(card_count)])
    matcher = StubMatcher()

    choice = warm_up_choice(state, expand_threshold=0.55, min_cards=3)

    assert choice is not None
    assert choice.full_pass is True
    assert matcher.call_count == 0


def test_at_the_floor_the_choice_proceeds():
    """``min_cards`` is a floor, not a gap: exactly that many Cards is enough to score."""
    assert warm_up_choice(_three_cards(), expand_threshold=0.55, min_cards=3) is None


def test_full_pass_choice_is_frozen():
    """Requirement 8.1: the choice is stored as an immutable mapping, never a live dict."""
    choice = full_pass_choice()

    with pytest.raises(TypeError):
        choice.by_title["t0"] = None  # type: ignore[index] - MappingProxyType rejects assignment


# --- fixed order ---------------------------------------------------------------------------------


def test_titles_come_back_in_ascending_turn_order_whatever_the_insertion_order():
    """Requirement 8.12: a fixed order is what makes two runs agree, Card by Card."""
    late_first = _state(
        _card("t2", 2, "third"),
        _card("t0", 0, "first"),
        _card("t1", 1, "second"),
    )

    assert titles_in_turn_order(late_first) == ("t0", "t1", "t2")


def test_descriptions_reach_the_matcher_in_turn_order_and_unmutated():
    """Requirement 7.12: the sequence handed over keeps its elements, its order and its size."""
    state = _state(
        _card("t2", 2, "third subject"),
        _card("t0", 0, "first subject"),
        _card("t1", 1, "second subject"),
    )
    before = copy.deepcopy(state.cards)
    matcher = StubMatcher({"first subject": 0.9})

    compute_notes(state, "why?", matcher)

    assert matcher.call_count == 1
    question, descriptions = matcher.calls[0]
    assert question == "why?"
    assert descriptions == ("first subject", "second subject", "third subject")
    assert state.cards == before


# --- the first pass ------------------------------------------------------------------------------


def test_the_note_is_exactly_the_similarity_with_no_active_subject_and_no_reuse():
    """Requirement 7.6: no decay and no factor touches the similarity of the first pass."""
    state = _three_cards()
    state.turn = 0  # no closed turn before this one, so there is no active subject
    matcher = StubMatcher({"first subject": 0.25, "second subject": 0.5, "third subject": 0.75})

    notes = compute_notes(state, "why?", matcher)

    assert notes == {"t0": 0.25, "t1": 0.5, "t2": 0.75}


def test_continuity_lands_on_the_active_subject_alone():
    """Requirement 7.2: continuity is added in the first pass, before propagation."""
    state = _three_cards()  # turn == 3, so the Card of turn 2 is the active subject
    matcher = StubMatcher({"first subject": 0.1, "second subject": 0.2, "third subject": 0.3})

    notes = compute_notes(state, "why?", matcher)

    assert notes == {"t0": 0.1, "t1": 0.2, "t2": 0.3 + _CONTINUITY_BONUS}


def test_continuity_beats_any_admissible_threshold():
    """Requirement 6.6 holds by arithmetic: even a zero similarity clears a threshold of 1.0."""
    state = _three_cards()
    matcher = StubMatcher()

    notes = compute_notes(state, "why?", matcher)

    assert notes["t2"] >= 1.0


def test_no_active_subject_when_no_card_stands_for_the_previous_turn():
    """A gap in the turn ordinals is not an error: nobody gets the bonus."""
    state = _state(
        _card("t0", 0, "first subject"),
        _card("t1", 1, "second subject"),
        _card("t2", 2, "third subject"),
        turn=9,
    )
    matcher = StubMatcher({"third subject": 0.3})

    notes = compute_notes(state, "why?", matcher)

    assert notes == {"t0": 0.0, "t1": 0.0, "t2": 0.3}


def test_the_fed_back_note_is_added_without_decay_at_read_time():
    """Requirement 7.6: the Fed-Back Note is decayed where it is written, never where it is read."""
    state = _three_cards()
    state.turn = 0
    state.reuse = {"t1": (1.0, 5), "absent-title": (1.0, 5)}
    matcher = StubMatcher({"second subject": 0.2})

    notes = compute_notes(state, "why?", matcher)

    assert notes == {"t0": 0.0, "t1": 1.2, "t2": 0.0}


def test_the_note_never_drops_below_the_similarity():
    """The three terms of the first pass only add; there is no lateral inhibition in this version."""
    state = _three_cards()
    state.reuse = {"t0": (1.0, 5)}
    similarities = {"first subject": 0.4, "second subject": 0.5, "third subject": 0.6}
    matcher = StubMatcher(similarities)

    notes = compute_notes(state, "why?", matcher)

    for title, description in (("t0", "first subject"), ("t1", "second subject"), ("t2", "third subject")):
        assert notes[title] >= similarities[description]


@pytest.mark.parametrize(
    ("answered", "expected"),
    [(-0.5, 0.0), (0.0, 0.0), (1.0, 1.0), (7.0, 1.0), (float("nan"), 0.0)],
)
def test_the_similarity_is_clamped_into_the_closed_unit_interval(answered, expected):
    """Requirement 7.10: the scale the two thresholds read is ``[0.0, 1.0]``, whatever came back."""
    state = _three_cards()
    state.turn = 0
    matcher = StubMatcher({"first subject": answered})

    notes = compute_notes(state, "why?", matcher)

    assert notes["t0"] == expected


def test_every_card_gets_exactly_one_entry():
    """No Card is omitted from the notes, which is what keeps the distribution total."""
    state = _three_cards()
    notes = compute_notes(state, "why?", StubMatcher())

    assert set(notes) == set(state.cards)


# --- failing open --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "matcher",
    [
        StubMatcher(fail=RuntimeError("matcher unavailable")),
        StubMatcher(fail=TimeoutError("matcher timed out")),
        StubMatcher(answer=[]),
        StubMatcher(answer=[0.5, 0.5]),
        StubMatcher(answer=[0.5] * 4),
        StubMatcher(answer=object()),
        StubMatcher(answer=["not-a-number", 0.5, 0.5]),
    ],
    ids=["exception", "timeout", "empty", "short", "long", "not_iterable", "not_numeric"],
)
def test_every_failure_mode_yields_no_notes_and_exactly_one_debug_log(matcher, caplog):
    """Requirements 7.11 and 16.9: fail open, log once with ``exc_info``, propagate nothing."""
    state = _three_cards()

    with caplog.at_level(logging.DEBUG, logger="strands.vended_plugins.context_graph.scoring"):
        notes = compute_notes(state, "why?", matcher)

    assert notes == {}
    records = [record for record in caplog.records if record.name.endswith("context_graph.scoring")]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG
    assert records[0].exc_info is not None


def test_a_failure_leaves_the_state_untouched():
    """Requirement 16.3: no failure state is persisted, so the next turn scores again."""
    state = _three_cards()
    state.reuse = {"t0": (1.0, 5)}
    cards_before = copy.deepcopy(state.cards)
    reuse_before = copy.deepcopy(state.reuse)

    compute_notes(state, "why?", StubMatcher(fail=RuntimeError("boom")))

    assert state.cards == cards_before
    assert state.reuse == reuse_before
    assert state.turn == 3


# --- propagation ---------------------------------------------------------------------------------


def _linked_state(links, *, similarities=None, turn=0):
    """Three Cards, no active subject, plus the outgoing edges given per title.

    ``turn=0`` on purpose: continuity would drown the arithmetic being checked here, and it is already
    pinned down by the first-pass tests.
    """
    state = _three_cards()
    state.turn = turn
    for title, edges in links.items():
        state.links[title] = list(edges)
    return state, StubMatcher(similarities or {})


def _naive_notes(state, base):
    """Reference propagation, written the expensive way: pairwise per hub, degree squared.

    The tool hub is walked as every ordered pair of Cards sharing a tool name, which is the definition
    the linear implementation has to agree with. Nothing here is shared with the implementation.
    """
    kind_weights = {"follows": _W_PREVIOUS, "artifact": _W_ARTIFACT}
    note = dict(base)

    for title in state.cards:
        for link in state.links.get(title, ()):
            if link.kind in kind_weights and link.target in note:
                note[link.target] += base[title] * link.weight * kind_weights[link.kind] * _DECAY

    for title in state.cards:
        for link in state.links.get(title, ()):
            if link.kind != "tool":
                continue
            for other in state.cards:
                if other == title:
                    continue
                if any(edge.kind == "tool" and edge.target == link.target for edge in state.links.get(other, ())):
                    note[title] += base[other] * link.weight * _W_TOOL * _DECAY
    return note


def test_a_card_edge_hands_the_target_the_source_note_decayed_once():
    """Requirement 7.3: the target receives source note times link weight times the decay factor."""
    state, matcher = _linked_state(
        {"t1": [Link(kind="follows", target="t0", weight=1.0)]},
        similarities={"second subject": 0.8},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t0"] == pytest.approx(0.8 * _W_PREVIOUS * _DECAY)
    assert notes["t1"] == pytest.approx(0.8)


def test_the_similarity_edge_hands_the_note_nothing():
    """The similarity edge answers what the call reaches, not what the note ranks.

    Its weight is a measured cosine of 0.5 to 0.8, while the band the matcher answers in spans 0.35 to
    0.75 — so inheriting along it hands over more than the ranking it would be correcting. Measured
    offline over a recorded session, it moved the required Card from rank 4 to rank 23 of 24.
    """
    state, matcher = _linked_state(
        {"t0": [Link(kind="similar", target="t2", weight=0.9)]},
        similarities={"first subject": 0.6},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t2"] == 0.0
    assert notes["t0"] == pytest.approx(0.6)


def test_the_artifact_edge_propagates_with_the_artifact_weight():
    """An artifact Card is reached from the Card that cited its reference."""
    state, matcher = _linked_state(
        {"t0": [Link(kind="artifact", target="t1", weight=1.0)]},
        similarities={"first subject": 0.5},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t1"] == pytest.approx(0.5 * _W_ARTIFACT * _DECAY)


def test_propagation_stops_at_one_hop():
    """Requirement 7.4: a Card two edges away from a lit Card receives nothing at all.

    This is the frozen ``base`` observed from outside: if the second edge read the note just written
    onto ``t1``, ``t2`` would come back non-zero.
    """
    state, matcher = _linked_state(
        {
            "t0": [Link(kind="artifact", target="t1", weight=1.0)],
            "t1": [Link(kind="artifact", target="t2", weight=1.0)],
        },
        similarities={"first subject": 1.0},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t1"] == pytest.approx(_W_ARTIFACT * _DECAY)
    assert notes["t2"] == 0.0


def test_a_cycle_of_edges_still_terminates_at_one_hop_each_way():
    """Two Cards pointing at each other exchange note once, never round and round."""
    state, matcher = _linked_state(
        {
            "t0": [Link(kind="artifact", target="t1", weight=1.0)],
            "t1": [Link(kind="artifact", target="t0", weight=1.0)],
        },
        similarities={"first subject": 0.4, "second subject": 0.2},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t0"] == pytest.approx(0.4 + 0.2 * _W_ARTIFACT * _DECAY)
    assert notes["t1"] == pytest.approx(0.2 + 0.4 * _W_ARTIFACT * _DECAY)


def test_the_kind_factor_is_applied_once_over_links_the_derivation_built():
    """The weight of a kind belongs to the scoring, and an edge carries a measurement or nothing.

    Every other propagation test hands ``compute_notes`` a hand-built ``Link``, so all of them held
    while the derivation was also storing the kind factor in ``Link.weight`` and the note was
    multiplying it in a second time. This one builds the edge the way the writing half does, which is
    the only way the two halves can be compared.
    """
    state = _three_cards()
    state.turn = 0
    # 1.01 is unreachable for a cosine, so the similarity edge is out of the way and what is left is
    # the structural edge the derivation writes.
    register_card(state, state.cards["t1"], [], link_threshold=1.01, tags_per_card=5, rarity_weight=0.7)

    (follows,) = [link for link in state.links["t1"] if link.kind == "follows"]
    assert follows.weight == 1.0

    notes = compute_notes(state, "why?", StubMatcher({"second subject": 0.8}))

    assert notes[follows.target] == pytest.approx(0.8 * _W_PREVIOUS * _DECAY)


def test_two_cards_on_the_same_tool_hub_reach_each_other_in_one_step():
    """A tool name is not a Card: it is the axis, and the note lands on the other Card."""
    state, matcher = _linked_state(
        {
            "t0": [Link(kind="tool", target="run_query", weight=1.0)],
            "t1": [Link(kind="tool", target="run_query", weight=1.0)],
        },
        similarities={"first subject": 0.4, "second subject": 0.2},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t0"] == pytest.approx(0.4 + 0.2 * _W_TOOL * _DECAY)
    assert notes["t1"] == pytest.approx(0.2 + 0.4 * _W_TOOL * _DECAY)
    assert "run_query" not in notes


def test_a_card_does_not_propagate_note_to_itself_through_its_own_tool():
    """The subtraction is the point: alone on a hub, a Card inherits exactly nothing."""
    state, matcher = _linked_state(
        {"t0": [Link(kind="tool", target="read_file", weight=1.0)]},
        similarities={"first subject": 0.9},
    )

    notes = compute_notes(state, "why?", matcher)

    assert notes["t0"] == pytest.approx(0.9)


def test_a_hub_of_three_hands_each_card_the_sum_of_the_other_two():
    """Summing per hub and subtracting the Card's own term equals the pairwise sum, by arithmetic."""
    state, matcher = _linked_state(
        {title: [Link(kind="tool", target="run_query", weight=1.0)] for title in ("t0", "t1", "t2")},
        similarities={"first subject": 0.4, "second subject": 0.2, "third subject": 0.1},
    )

    notes = compute_notes(state, "why?", matcher)

    factor = _W_TOOL * _DECAY
    assert notes["t0"] == pytest.approx(0.4 + (0.2 + 0.1) * factor)
    assert notes["t1"] == pytest.approx(0.2 + (0.4 + 0.1) * factor)
    assert notes["t2"] == pytest.approx(0.1 + (0.4 + 0.2) * factor)


def test_the_linear_hub_agrees_with_the_degree_squared_reference():
    """The optimization is an optimization, not a different formula."""
    state, matcher = _linked_state(
        {
            "t0": [
                Link(kind="tool", target="run_query", weight=1.0),
                Link(kind="tool", target="read_file", weight=1.0),
                Link(kind="follows", target="t1", weight=1.0),
            ],
            "t1": [
                Link(kind="tool", target="run_query", weight=1.0),
                Link(kind="similar", target="t2", weight=0.75),
            ],
            "t2": [
                Link(kind="tool", target="read_file", weight=1.0),
                Link(kind="artifact", target="t0", weight=1.0),
            ],
        },
        similarities={"first subject": 0.4, "second subject": 0.2, "third subject": 0.9},
    )

    notes = compute_notes(state, "why?", matcher)

    base = {"t0": 0.4, "t1": 0.2, "t2": 0.9}
    assert notes == pytest.approx(_naive_notes(state, base))


def test_an_edge_pointing_at_a_card_the_graph_no_longer_holds_is_skipped():
    """A stale target is a stale edge, not a corrupt state: the note is still computed."""
    state, matcher = _linked_state(
        {"t0": [Link(kind="similar", target="gone", weight=1.0)]},
        similarities={"first subject": 0.5},
    )

    notes = compute_notes(state, "why?", matcher)

    assert set(notes) == {"t0", "t1", "t2"}
    assert notes["t0"] == pytest.approx(0.5)


def test_propagation_only_adds_and_never_lowers_a_note():
    """Requirement 7.3 has no counterpart: there is no lateral inhibition in this version."""
    state, matcher = _linked_state(
        {
            "t0": [Link(kind="tool", target="run_query", weight=1.0), Link(kind="follows", target="t1", weight=1.0)],
            "t1": [Link(kind="tool", target="run_query", weight=1.0), Link(kind="similar", target="t2", weight=0.5)],
        },
        similarities={"first subject": 0.4, "second subject": 0.2, "third subject": 0.1},
        turn=3,
    )

    notes = compute_notes(state, "why?", matcher)

    for title, similarity in (("t0", 0.4), ("t1", 0.2), ("t2", 0.1)):
        assert notes[title] >= similarity


def test_permuting_the_insertion_order_of_cards_and_links_leaves_every_note_identical():
    """Requirement 8.12: confluence comes from the frozen ``base``, not from dictionary ordering."""
    edges = {
        "t0": [Link(kind="tool", target="run_query", weight=1.0), Link(kind="similar", target="t2", weight=0.3)],
        "t1": [Link(kind="tool", target="run_query", weight=1.0), Link(kind="follows", target="t0", weight=1.0)],
        "t2": [Link(kind="artifact", target="t1", weight=1.0)],
    }
    similarities = {"first subject": 0.4, "second subject": 0.2, "third subject": 0.9}

    forward = _state(
        _card("t0", 0, "first subject"),
        _card("t1", 1, "second subject"),
        _card("t2", 2, "third subject"),
        turn=0,
    )
    backward = _state(
        _card("t2", 2, "third subject"),
        _card("t1", 1, "second subject"),
        _card("t0", 0, "first subject"),
        turn=0,
    )
    for title, links in edges.items():
        forward.links[title] = list(links)
        backward.links[title] = list(reversed(links))

    assert compute_notes(forward, "why?", StubMatcher(similarities)) == compute_notes(
        backward, "why?", StubMatcher(similarities)
    )


def test_propagation_leaves_the_state_untouched():
    """The note is read-only over the graph: no link, no Card and no reuse entry is rewritten."""
    state, matcher = _linked_state(
        {
            "t0": [Link(kind="tool", target="run_query", weight=1.0)],
            "t1": [Link(kind="tool", target="run_query", weight=1.0), Link(kind="similar", target="t2", weight=0.5)],
        },
        similarities={"first subject": 0.4},
    )
    cards_before = copy.deepcopy(state.cards)
    links_before = copy.deepcopy(state.links)

    compute_notes(state, "why?", matcher)

    assert state.cards == cards_before
    assert state.links == links_before


# --- the distribution by budget ------------------------------------------------------------------
#
# Every case below pins the resolution by budget, and the one thing none of them may ever show is a
# Card that cleared ``expand_threshold`` landing on ``"title"``: that would be a verdict, and the
# resolution is only ever allowed to step down one rung.


def _artifact(title, turn, description="an artifact"):
    """An artifact Card, which this function must never lift to full content, whatever the note."""
    return Card(
        title=title,
        kind="artifact",
        turn=turn,
        dialogue_ids=(f"{title}-d",),
        evidence_ids=(f"{title}-e",),
        pairs=(),
        tool_names=frozenset(),
        references=("ref-1",),
        numeric_lines=(),
        tags=(),
        description=description,
        reference="ref-1",
        content_type="text/plain",
        size_bytes=10,
    )


def _pair(tool_use_id, *, consumed):
    """One tool pair, addressing two evidence identities."""
    return ToolPair(
        tool_use_id=tool_use_id,
        tool_name="run_query",
        tracking_ids=(f"{tool_use_id}-use", f"{tool_use_id}-result"),
        consumed=consumed,
    )


def _with_pairs(title, turn, *pairs):
    """A subject Card whose evidence is exactly ``pairs``."""
    card = _card(title, turn, f"{title} subject")
    identities = tuple(identity for pair in pairs for identity in pair.tracking_ids)
    return dataclasses.replace(card, pairs=pairs, evidence_ids=identities, tool_names=frozenset({"run_query"}))


def _distribute(state, notes, *, expand_threshold=0.6, collapse_floor=0.2, body_budget=None, costs=None):
    """Call ``distribute`` with the two thresholds defaulted, so each test names only what it exercises."""
    return distribute(
        notes,
        state,
        expand_threshold=expand_threshold,
        collapse_floor=collapse_floor,
        body_budget=body_budget,
        costs=costs,
    )


def _flat_costs(state, dialogue, evidence=0):
    """The same cost for every dialogue part, and the same for every evidence part."""
    return {(title, "dialogue"): dialogue for title in state.cards} | {
        (title, "evidence"): evidence for title in state.cards
    }


def test_every_card_is_in_the_choice_and_the_mapping_is_frozen():
    """Requirements 8.1, 8.9: no Card is dropped from the call, and the choice is locked by immutability."""
    state = _three_cards()

    choice = _distribute(state, {"t0": 0.9, "t1": 0.3, "t2": 0.0})

    assert set(choice.by_title) == set(state.cards)
    assert choice.full_pass is False
    with pytest.raises(TypeError):
        choice.by_title["t0"] = None  # type: ignore[index] - MappingProxyType rejects assignment


def test_the_three_rungs_of_the_dialogue_follow_the_two_thresholds():
    """Requirements 8.3, 8.4, 8.5: at or above expand is full, between is description, below floor is title."""
    # ``turn=0`` leaves no Card standing for the previous turn, so no continuity masks the thresholds.
    state = _state(
        _card("t0", 0, "first subject"),
        _card("t1", 1, "second subject"),
        _card("t2", 2, "third subject"),
        turn=0,
    )

    choice = _distribute(state, {"t0": 0.6, "t1": 0.2, "t2": 0.19})

    assert choice.by_title["t0"].dialogue == "full"
    assert choice.by_title["t1"].dialogue == "description"
    assert choice.by_title["t2"].dialogue == "title"


def test_no_ceiling_gives_full_content_to_every_card_over_the_threshold():
    """Requirement 8.8: ``body_budget=None`` is the absence of a ceiling, not a very large one."""
    state = _three_cards()

    choice = _distribute(state, {"t0": 0.9, "t1": 0.8, "t2": 0.7}, body_budget=None, costs=_flat_costs(state, 10**9))

    assert [choice.by_title[title].dialogue for title in ("t0", "t1", "t2")] == ["full", "full", "full"]


def test_the_card_that_no_longer_fits_steps_down_to_description_and_never_to_title():
    """Requirement 8.6: the Card at the back of the queue was not judged irrelevant, it just will not fit."""
    state = _three_cards()

    choice = _distribute(
        state,
        {"t0": 0.9, "t1": 0.8, "t2": 0.7},
        body_budget=100,
        costs=_flat_costs(state, 60),
    )

    assert choice.by_title["t0"].dialogue == "full"
    assert choice.by_title["t1"].dialogue == "description"
    assert choice.by_title["t2"].dialogue == "description"
    assert all(card_choice.dialogue != "title" for card_choice in choice.by_title.values())


def test_the_budget_is_handed_out_in_descending_note():
    """Requirement 8.7: the highest note is served first, so it is the one that gets the single slot."""
    state = _three_cards()

    choice = _distribute(
        state,
        {"t0": 0.7, "t1": 0.9, "t2": 0.8},
        body_budget=50,
        costs=_flat_costs(state, 50),
    )

    assert choice.by_title["t1"].dialogue == "full"
    assert choice.by_title["t0"].dialogue == "description"
    assert choice.by_title["t2"].dialogue == "description"


def test_the_turn_ordinal_breaks_a_tie_in_the_note():
    """Requirement 8.12: equal notes are not an ambiguity — the earlier turn is served first."""
    state = _three_cards()

    choice = _distribute(
        state,
        {"t0": 0.9, "t1": 0.9, "t2": 0.9},
        body_budget=50,
        costs=_flat_costs(state, 50),
    )

    assert choice.by_title["t0"].dialogue == "full"
    assert choice.by_title["t1"].dialogue == "description"
    assert choice.by_title["t2"].dialogue == "description"


def test_the_sum_of_the_costs_in_full_content_stays_within_the_budget():
    """Requirement 8.3: the ceiling is debited, so it is a ceiling and not a suggestion."""
    state = _state(*[_card(f"t{index}", index, f"subject {index}") for index in range(6)])
    costs = {(title, "dialogue"): 40 for title in state.cards} | {(title, "evidence"): 0 for title in state.cards}

    choice = _distribute(state, dict.fromkeys(state.cards, 0.9), body_budget=100, costs=costs)

    spent = sum(
        costs[(title, "dialogue")] for title, decision in choice.by_title.items() if decision.dialogue == "full"
    )
    assert spent <= 100


def test_the_active_subject_keeps_full_content_at_a_note_of_zero():
    """Requirement 6.6: continuity is arithmetic, so the previous turn's Card does not need a note."""
    state = _three_cards()

    choice = _distribute(state, dict.fromkeys(state.cards, 0.0))

    assert choice.by_title["t2"].dialogue == "full"
    assert choice.by_title["t0"].dialogue == "title"


def test_a_consumed_pair_drops_the_evidence_and_an_unconsumed_one_keeps_it_whole():
    """Requirements 6.3, 6.5: the evidence axis reads the order of the messages, never the note."""
    state = _state(
        _with_pairs("t0", 0, _pair("a", consumed=True), _pair("b", consumed=True)),
        _with_pairs("t1", 1, _pair("c", consumed=True), _pair("d", consumed=False)),
        _card("t2", 2, "third subject"),
    )

    choice = _distribute(state, {"t0": 0.0, "t1": 0.0, "t2": 0.0})

    assert choice.by_title["t0"].evidence == "description"
    assert choice.by_title["t1"].evidence == "full"


def test_the_evidence_resolution_does_not_move_with_the_note():
    """Requirement 6.1: the two axes are independent, and only one of them is a function of the note."""
    state = _state(
        _with_pairs("t0", 0, _pair("a", consumed=True)),
        _with_pairs("t1", 1, _pair("b", consumed=False)),
        _card("t2", 2, "third subject"),
    )

    low = _distribute(state, {"t0": 0.0, "t1": 0.0, "t2": 0.0})
    high = _distribute(state, {"t0": 1.0, "t1": 1.0, "t2": 1.0})

    for title in ("t0", "t1"):
        assert low.by_title[title].evidence == high.by_title[title].evidence


def test_an_artifact_card_never_reaches_full_content_whatever_the_note():
    """Requirement 11.8: the search alone must never bring 100k tokens back."""
    state = _state(
        _card("t0", 0, "first subject"),
        _artifact("art", 1),
        _card("t2", 2, "third subject"),
    )

    choice = _distribute(state, {"t0": 1.0, "art": 1.0, "t2": 1.0}, body_budget=None)

    assert choice.by_title["art"].dialogue == "description"
    assert choice.by_title["art"].evidence == "description"


def test_the_artifact_that_is_the_active_subject_still_stops_at_description():
    """Requirement 11.8 outranks continuity: an artifact rises to full content only by explicit request."""
    state = _state(_card("t0", 0, "first subject"), _card("t1", 1, "second subject"), _artifact("art", 2))

    choice = _distribute(state, dict.fromkeys(state.cards, 0.0))

    assert choice.by_title["art"].dialogue == "description"


def test_an_artifact_over_the_threshold_does_not_spend_the_budget_it_cannot_use():
    """The artifact is short-circuited before the debit, so the slot is left for a Card that can use it."""
    state = _state(_artifact("art", 0), _card("t1", 1, "second subject"), _card("t2", 2, "third subject"))
    costs = _flat_costs(state, 50)

    choice = _distribute(state, {"art": 1.0, "t1": 0.9, "t2": 0.0}, body_budget=50, costs=costs)

    assert choice.by_title["art"].dialogue == "description"
    assert choice.by_title["t1"].dialogue == "full"


def test_an_artifact_below_the_floor_still_collapses_to_title():
    """The artifact rule caps the resolution; it does not raise a Card the note put on the bottom rung."""
    state = _state(_artifact("art", 0), _card("t1", 1, "second subject"), _card("t2", 2, "third subject"))

    choice = _distribute(state, {"art": 0.0, "t1": 0.9, "t2": 0.9})

    assert choice.by_title["art"].dialogue == "title"


def test_evidence_larger_than_the_whole_budget_leaves_the_remainder_at_zero():
    """The loop invariant holds under an unconsumed pair that travels whole regardless of the ceiling."""
    state = _state(
        _with_pairs("t0", 0, _pair("a", consumed=False)),
        _card("t1", 1, "second subject"),
        _card("t2", 2, "third subject"),
    )
    costs = {(title, "dialogue"): 10 for title in state.cards} | {(title, "evidence"): 10**6 for title in state.cards}

    choice = _distribute(state, {"t0": 0.9, "t1": 0.9, "t2": 0.9}, body_budget=100, costs=costs)

    assert choice.by_title["t0"].dialogue == "full"
    assert choice.by_title["t0"].evidence == "full"
    # The budget is gone, so what follows steps down one rung — and no further.
    assert choice.by_title["t1"].dialogue == "description"
    assert choice.by_title["t2"].dialogue == "description"


def test_a_missing_note_reads_as_the_floor_rather_than_raising():
    """A Card the matcher never scored is still in the choice, on the bottom rung."""
    state = _three_cards()

    choice = _distribute(state, {"t0": 0.9}, body_budget=None)

    assert set(choice.by_title) == set(state.cards)
    assert choice.by_title["t1"].dialogue == "title"


def test_a_zero_cost_part_fits_a_spent_budget():
    """``cost <= remaining`` and not ``<``: a part that costs nothing fits a budget that is exhausted."""
    state = _three_cards()
    costs = {("t0", "dialogue"): 100, ("t1", "dialogue"): 0, ("t2", "dialogue"): 0} | {
        (title, "evidence"): 0 for title in state.cards
    }

    choice = _distribute(state, {"t0": 0.9, "t1": 0.8, "t2": 0.7}, body_budget=100, costs=costs)

    assert [choice.by_title[title].dialogue for title in ("t0", "t1", "t2")] == ["full", "full", "full"]


def test_the_distribution_leaves_the_state_untouched():
    """Requirements 8.10, 11.9: the choice is read-only over the graph."""
    state = _state(
        _with_pairs("t0", 0, _pair("a", consumed=True)),
        _artifact("art", 1),
        _card("t2", 2, "third subject"),
    )
    cards_before = copy.deepcopy(state.cards)
    links_before = copy.deepcopy(state.links)

    _distribute(state, {"t0": 0.9, "art": 0.9, "t2": 0.9}, body_budget=10, costs=_flat_costs(state, 5))

    assert state.cards == cards_before
    assert state.links == links_before


def test_two_runs_over_the_same_state_agree_card_by_card():
    """Requirement 8.12: same state, same notes, same budget — identical choice."""
    state = _state(*[_card(f"t{index}", index, f"subject {index}") for index in range(5)])
    notes = {"t0": 0.9, "t1": 0.9, "t2": 0.5, "t3": 0.1, "t4": 0.9}
    costs = _flat_costs(state, 30)

    first = _distribute(state, notes, body_budget=70, costs=costs)
    second = _distribute(state, notes, body_budget=70, costs=costs)

    assert dict(first.by_title) == dict(second.by_title)
