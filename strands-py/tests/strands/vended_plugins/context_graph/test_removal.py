"""Unit tests of ``removal_ids``: the request derived from the (Card, part) pair and nothing else.

The assertions are set comparisons, because the return is a set and its order carries no meaning. What
each test really pins down is one of the module's structural absences — the turn in progress, the Card
that was never derived, the message with no Card, the title missing from the choice — and each of them
is checked by building the state that exercises it rather than by patching a branch, since there is no
branch to patch.

``deepcopy`` guards the no-mutation contract instead of an identity check on the container: replacing a
tuple in place would keep the container identical and still be a mutation.
"""

import copy
from types import MappingProxyType

import pytest

from strands.agent.conversation_manager.compression.pin_message import pin_message
from strands.vended_plugins.context_graph.removal import apply_removal, removal_ids
from strands.vended_plugins.context_graph.state import Card, CardChoice, TurnChoice, _GraphState

from .strategies import frozen_choice


def _card(title, turn, dialogue_ids, evidence_ids, kind="subject"):
    """Build a Card carrying only what the removal reads: the two id tuples and the title."""
    return Card(
        title=title,
        kind=kind,
        turn=turn,
        dialogue_ids=tuple(dialogue_ids),
        evidence_ids=tuple(evidence_ids),
        pairs=(),
        tool_names=frozenset(),
        references=(),
        numeric_lines=(),
        tags=(),
        description="",
        reference="ref-1" if kind == "artifact" else None,
    )


def _state(*cards):
    """A graph state holding ``cards``, keyed by title in the order given."""
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
    state.turn = len(state.cards)
    return state


# --- derivation from the pair ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("dialogue", "evidence", "expected"),
    [
        ("full", "full", set()),
        ("description", "full", {"d1", "d2"}),
        ("full", "description", {"e1", "e2"}),
        ("title", "description", {"d1", "d2", "e1", "e2"}),
        ("description", "description", {"d1", "d2", "e1", "e2"}),
        ("title", "full", {"d1", "d2"}),
    ],
)
def test_each_part_is_requested_exactly_when_it_is_not_full(dialogue, evidence, expected):
    """Requirement 6.2: the two axes are read independently, part by part."""
    state = _state(_card("t0", 0, ("d1", "d2"), ("e1", "e2")))
    choice = frozen_choice({"t0": CardChoice(dialogue=dialogue, evidence=evidence)})

    assert removal_ids(state, choice, frozenset()) == expected


def test_a_choice_that_is_full_everywhere_requests_nothing():
    """Requirement 1.11: with nothing below full content, the removal has nothing to ask for."""
    state = _state(
        _card("t0", 0, ("d1",), ("e1",)),
        _card("t1", 1, ("d2",), ("e2",)),
    )
    choice = frozen_choice(
        {title: CardChoice(dialogue="full", evidence="full") for title in state.cards},
    )

    assert removal_ids(state, choice, frozenset()) == frozenset()


def test_parts_of_several_cards_accumulate():
    """The set is the union over every (Card, part) below full content, and nothing else."""
    state = _state(
        _card("t0", 0, ("d0",), ("e0",)),
        _card("t1", 1, ("d1",), ("e1",)),
        _card("t2", 2, ("d2",), ("e2",)),
    )
    choice = frozen_choice(
        {
            "t0": CardChoice(dialogue="title", evidence="description"),
            "t1": CardChoice(dialogue="full", evidence="description"),
            "t2": CardChoice(dialogue="description", evidence="full"),
        }
    )

    assert removal_ids(state, choice, frozenset()) == {"d0", "e0", "e1", "d2"}


def test_an_empty_state_requests_nothing():
    """No Card, no request — the shape a fresh agent has."""
    assert removal_ids(_GraphState(), frozen_choice({}), frozenset()) == frozenset()


def test_a_card_with_an_empty_part_contributes_nothing_for_that_part():
    """A turn with no tool call has no evidence identities, and asks for none."""
    state = _state(_card("t0", 0, ("d1",), ()))
    choice = frozen_choice({"t0": CardChoice(dialogue="description", evidence="description")})

    assert removal_ids(state, choice, frozenset()) == {"d1"}


# --- the turn in progress never enters ---------------------------------------------------------


def test_identities_of_the_turn_in_progress_are_never_requested():
    """Requirements 3.6 and 6.2: the open turn stays whole, whatever the choice says."""
    state = _state(_card("t0", 0, ("d1", "d2"), ("e1", "e2")))
    choice = frozen_choice({"t0": CardChoice(dialogue="title", evidence="description")})

    requested = removal_ids(state, choice, frozenset({"d2", "e1"}))

    assert requested == {"d1", "e2"}


def test_a_card_wholly_inside_the_turn_in_progress_drops_out_entirely():
    """The lag between the two halves: the Card exists, the turn is still open, nothing is asked."""
    state = _state(_card("t0", 0, ("d1",), ("e1",)))
    choice = frozen_choice({"t0": CardChoice(dialogue="title", evidence="description")})

    assert removal_ids(state, choice, frozenset({"d1", "e1"})) == frozenset()


def test_current_turn_ids_unknown_to_the_graph_are_harmless():
    """Subtracting identities that belong to no Card changes nothing — no error, no leftover."""
    state = _state(_card("t0", 0, ("d1",), ()))
    choice = frozen_choice({"t0": CardChoice(dialogue="description", evidence="full")})

    assert removal_ids(state, choice, frozenset({"unknown", "also-unknown"})) == {"d1"}


# --- structural fail-safes ---------------------------------------------------------------------


def test_a_card_that_was_never_derived_cannot_be_requested():
    """Requirements 3.10 and 16.5: absent from ``state.cards`` means unreachable, not checked.

    The choice names a title the state does not hold — the shape a failed derivation leaves behind.
    """
    state = _state(_card("t0", 0, ("d0",), ()))
    choice = frozen_choice(
        {
            "t0": CardChoice(dialogue="description", evidence="full"),
            "t-never-derived": CardChoice(dialogue="title", evidence="description"),
        }
    )

    assert removal_ids(state, choice, frozenset()) == {"d0"}


def test_a_title_missing_from_the_choice_is_read_as_full():
    """The choice is frozen per turn; a Card derived after that instant is kept whole."""
    state = _state(
        _card("t0", 0, ("d0",), ("e0",)),
        _card("t1", 1, ("d1",), ("e1",)),
    )
    choice = frozen_choice({"t0": CardChoice(dialogue="description", evidence="description")})

    assert removal_ids(state, choice, frozenset()) == {"d0", "e0"}


def test_an_artifact_card_follows_the_choice_with_no_special_case():
    """Requirement 11.8 lives in the scoring; here the artifact is read exactly like a subject."""
    state = _state(_card("art", 3, (), ("a1", "a2"), kind="artifact"))

    kept = removal_ids(state, frozen_choice({"art": CardChoice("full", "full")}), frozenset())
    dropped = removal_ids(state, frozen_choice({"art": CardChoice("full", "description")}), frozenset())

    assert kept == frozenset()
    assert dropped == {"a1", "a2"}


# --- the return is a request, and the inputs are untouched -------------------------------------


def test_the_return_is_an_immutable_set():
    """A request handed to the projection and to the compaction must not be mutable by either."""
    state = _state(_card("t0", 0, ("d1",), ()))
    choice = frozen_choice({"t0": CardChoice(dialogue="description", evidence="full")})

    assert isinstance(removal_ids(state, choice, frozenset()), frozenset)


def test_nothing_is_mutated():
    """Requirement 11.9: the graph state and the choice come out exactly as they went in."""
    state = _state(
        _card("t0", 0, ("d0", "d1"), ("e0",)),
        _card("t1", 1, ("d2",), ("e1", "e2")),
    )
    choice = frozen_choice(
        {
            "t0": CardChoice(dialogue="title", evidence="description"),
            "t1": CardChoice(dialogue="description", evidence="full"),
        }
    )
    current_turn_ids = frozenset({"e2"})
    # The state's own ``choice`` field holds a mappingproxy, which does not survive a deepcopy of the
    # dataclass; the cards are what this function reads, so they are what gets snapshotted.
    cards_before = copy.deepcopy(state.cards)
    links_before = copy.deepcopy(state.links)
    turn_before = state.turn
    choice_before = dict(choice.by_title)

    removal_ids(state, choice, current_turn_ids)

    assert state.cards == cards_before
    assert state.links == links_before
    assert state.turn == turn_before
    assert dict(choice.by_title) == choice_before
    assert current_turn_ids == frozenset({"e2"})


def test_the_choice_mapping_stays_read_only():
    """The frozen choice is a ``MappingProxyType``, and the removal is not the place that unfreezes it."""
    state = _state(_card("t0", 0, ("d0",), ()))
    by_title = MappingProxyType({"t0": CardChoice(dialogue="description", evidence="full")})
    choice = TurnChoice(by_title=by_title, full_pass=False)

    removal_ids(state, choice, frozenset())

    assert isinstance(choice.by_title, MappingProxyType)


def test_two_runs_over_the_same_inputs_agree():
    """Requirement 8.12 downstream: same state, same choice, same request."""
    state = _state(
        _card("t0", 0, ("d0",), ("e0",)),
        _card("t1", 1, ("d1",), ("e1",)),
    )
    choice = frozen_choice(
        {
            "t0": CardChoice(dialogue="title", evidence="description"),
            "t1": CardChoice(dialogue="description", evidence="description"),
        }
    )

    assert removal_ids(state, choice, frozenset({"e1"})) == removal_ids(state, choice, frozenset({"e1"}))


# --- the wiring: ``apply_removal`` over ``project_messages`` --------------------------------------
#
# What is under test is that the projection contract holds when the request comes from a graph
# choice: a subsequence of the same objects, in the same relative order, with no duplication and no
# insertion, and the four guards intact.


def _conversation():
    """A two-turn history: a tool pair, assistant text, and one message with no durable identity."""
    return [
        {"role": "user", "content": [{"text": "turn zero"}], "tracking_id": "d0"},
        {
            "role": "assistant",
            "content": [{"toolUse": {"toolUseId": "tu1", "name": "run_query", "input": {}}}],
            "tracking_id": "e0",
        },
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tu1", "status": "success", "content": [{"text": "ok"}]}}],
            "tracking_id": "e1",
        },
        {"role": "assistant", "content": [{"text": "answer zero"}], "tracking_id": "d1"},
        {"role": "user", "content": [{"text": "turn one"}], "tracking_id": "d2"},
        {"role": "assistant", "content": [{"text": "answer one"}], "tracking_id": "d3"},
        {"role": "assistant", "content": [{"text": "no address at all"}]},
    ]


def _conversation_state():
    """The graph state matching :func:`_conversation`, part by part."""
    return _state(
        _card("t0", 0, ("d0", "d1"), ("e0", "e1")),
        _card("t1", 1, ("d2", "d3"), ()),
    )


def _all_below_full():
    """The most aggressive choice the graph can make: both parts of both Cards below full."""
    return frozen_choice(
        {
            "t0": CardChoice(dialogue="title", evidence="description"),
            "t1": CardChoice(dialogue="title", evidence="description"),
        }
    )


def _tool_ids(messages, block):
    """Every ``toolUseId`` carried by a ``block`` — ``"toolUse"`` or ``"toolResult"`` — in order."""
    return {
        content[block]["toolUseId"]
        for message in messages
        for content in message.get("content", [])
        if isinstance(content, dict) and block in content
    }


def test_the_removal_is_a_subsequence_of_the_same_objects():
    """Requirement 9.1: same objects by identity, same relative order, nothing inserted."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    positions = [next(i for i, m in enumerate(conversation) if m is message) for message in projected]

    assert positions == sorted(positions)
    assert len(positions) == len(set(positions))  # no duplication
    assert all(any(message is original for original in conversation) for message in projected)
    assert len(projected) < len(conversation)


def test_the_request_that_produced_the_removal_comes_back_with_it():
    """The compaction derives what actually left from the pair (request, removal), so it gets both."""
    conversation = _conversation()
    state, choice = _conversation_state(), _all_below_full()

    _, requested = apply_removal(conversation, state, choice, frozenset())

    assert requested == removal_ids(state, choice, frozenset())


def test_a_choice_full_everywhere_returns_the_same_list_object():
    """Requirement 9.9: nothing below full content allocates nothing and changes nothing."""
    conversation = _conversation()
    choice = frozen_choice(
        {
            "t0": CardChoice(dialogue="full", evidence="full"),
            "t1": CardChoice(dialogue="full", evidence="full"),
        }
    )

    projected, requested = apply_removal(conversation, _conversation_state(), choice, frozenset())

    assert projected is conversation
    assert requested == frozenset()


def test_a_message_with_no_durable_identity_always_survives():
    """The fail-safe for derivation lag: an unaddressed message cannot be requested, so it stays."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    assert conversation[-1] in projected


def test_the_turn_in_progress_survives_the_removal():
    """Requirement 3.6 end to end: what the request excludes, the projection keeps."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset({"d2", "d3"}))

    assert conversation[4] in projected
    assert conversation[5] in projected


# --- the four inherited guards, over a graph choice ---------------------------------------------


def test_the_tool_pair_travels_together():
    """Requirements 11.1 and 11.2: the two id sets stay equal, whatever the evidence resolution is."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    assert _tool_ids(projected, "toolUse") == _tool_ids(projected, "toolResult")
    assert conversation[1] not in projected
    assert conversation[2] not in projected


def test_half_a_pair_held_by_the_turn_in_progress_drops_with_the_other_half():
    """Requirement 11.2 again, from the direction the graph creates: an id kept out of the request is
    not protection. The pair reconciles toward DROP, so the set equality survives the lag."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset({"e1"}))

    assert _tool_ids(projected, "toolUse") == _tool_ids(projected, "toolResult") == set()


def test_a_pin_wins_over_the_resolution():
    """Requirement 11.5: an explicit pin from the main agent enters, whatever the choice decided."""
    conversation = _conversation()
    pin_message(conversation, 3)

    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    assert conversation[3] in projected


def test_pinning_one_half_of_a_pair_keeps_both():
    """Requirement 11.3: protection travels along the pair, so the whole pair stays."""
    conversation = _conversation()
    pin_message(conversation, 1)

    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    assert conversation[1] in projected
    assert conversation[2] in projected
    assert _tool_ids(projected, "toolUse") == _tool_ids(projected, "toolResult") == {"tu1"}


def test_the_first_user_message_leads_the_removal():
    """Requirement 11.4: the provider rejects a conversation that does not open with a user turn."""
    conversation = _conversation()
    projected, _ = apply_removal(conversation, _conversation_state(), _all_below_full(), frozenset())

    assert projected[0] is conversation[0]
    assert projected[0]["role"] == "user"


def test_a_non_empty_history_never_projects_to_nothing():
    """Requirement 9.8: an empty request is not a cheaper call, it is a rejected one.

    No user message and no pin, so nothing is protected and the rescue is the only thing left.
    """
    conversation = [
        {"role": "assistant", "content": [{"text": "one"}], "tracking_id": "d0"},
        {"role": "assistant", "content": [{"text": "two"}], "tracking_id": "d1"},
    ]
    state = _state(_card("t0", 0, ("d0", "d1"), ()))
    choice = frozen_choice({"t0": CardChoice(dialogue="title", evidence="description")})

    projected, _ = apply_removal(conversation, state, choice, frozenset())

    assert len(projected) >= 1


def test_an_empty_history_projects_empty():
    """The other half of Requirement 9.8, and the shape a fresh agent has."""
    projected, _ = apply_removal([], _GraphState(), frozen_choice({}), frozenset())

    assert projected == []


def test_the_removal_is_a_fixed_point():
    """Requirement 11.6: reconciliation terminates with nothing left to reconcile."""
    conversation = _conversation()
    state, choice = _conversation_state(), _all_below_full()

    projected, requested = apply_removal(conversation, state, choice, frozenset())
    again, _ = apply_removal(projected, state, choice, frozenset())

    assert [id(message) for message in again] == [id(message) for message in projected]


def test_apply_removal_mutates_nothing():
    """Requirements 9.3 and 11.9: the list, its dicts and the graph state all come out as they went in."""
    conversation = _conversation()
    state, choice = _conversation_state(), _all_below_full()
    conversation_before = copy.deepcopy(conversation)
    cards_before = copy.deepcopy(state.cards)

    apply_removal(conversation, state, choice, frozenset())

    assert conversation == conversation_before
    assert state.cards == cards_before
    assert dict(choice.by_title) == {
        "t0": CardChoice(dialogue="title", evidence="description"),
        "t1": CardChoice(dialogue="title", evidence="description"),
    }


def test_two_runs_over_the_same_inputs_produce_the_same_removal():
    """Requirement 9.11: same list, same choice, same messages element by element."""
    conversation = _conversation()
    state, choice = _conversation_state(), _all_below_full()

    first, _ = apply_removal(conversation, state, choice, frozenset())
    second, _ = apply_removal(conversation, state, choice, frozenset())

    assert [id(message) for message in first] == [id(message) for message in second]
