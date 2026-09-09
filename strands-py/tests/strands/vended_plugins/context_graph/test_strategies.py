"""Self-consistency tests for the shared strategies and the doubles.

These verify the generators, not the graph: a generator that quietly produces an inconsistent Card
would make every property test downstream vacuous. Each check asserts the invariant the strategy
promises in its docstring.
"""

import socket

import pytest
from hypothesis import given
from hypothesis import strategies as st

from .conftest import NetworkUsedError
from .strategies import (
    FAILURE_MODES,
    INSTRUMENTATION_POINTS,
    MIN_EXAMPLES,
    cards,
    cards_with_pairs,
    conversations,
    conversations_with_open_turn,
    conversations_with_pins,
    conversations_with_tool_pairs,
    engagement_points,
    failure_modes,
    graph_states,
    graph_states_with_costs,
    id_subsets,
    instrumentation_points,
    is_evidence,
    is_turn_start,
    out_of_domain_values,
    property_settings,
    similarity_vectors,
    tag_universes,
    tool_result_ids,
    tool_use_ids,
    turn_choices,
)
from .stubs import FakeBedrockEmbedder, StubMatcher


def test_property_settings_meets_the_minimum():
    assert property_settings.max_examples >= MIN_EXAMPLES == 100


@property_settings
@given(conversations())
def test_conversations_alternate_and_open_with_user(conversation):
    assert conversation[0]["role"] == "user"
    assert is_turn_start(conversation, 0)
    identities = [message["tracking_id"] for message in conversation if message.get("tracking_id")]
    assert len(identities) == len(set(identities))


@property_settings
@given(conversations_with_tool_pairs())
def test_tool_pairs_are_matched(conversation):
    assert tool_use_ids(conversation) == tool_result_ids(conversation)
    assert any(is_evidence(message) for message in conversation)


@property_settings
@given(conversations_with_open_turn())
def test_open_turn_ends_after_the_last_turn_start(conversation):
    starts = [index for index in range(len(conversation)) if is_turn_start(conversation, index)]
    assert starts, "an open turn still has to have opened"
    assert starts[-1] <= len(conversation) - 1


@property_settings
@given(conversations_with_pins())
def test_pins_land_in_metadata(conversation):
    for message in conversation:
        custom = message.get("metadata", {}).get("custom", {})
        if "pinned" in custom:
            assert custom["pinned"] is True


@property_settings
@given(cards())
def test_card_parts_are_disjoint(card):
    assert set(card.dialogue_ids).isdisjoint(card.evidence_ids)
    assert card.tool_names == frozenset(pair.tool_name for pair in card.pairs)
    assert len(card.tags) <= 5
    if card.kind == "artifact":
        assert card.reference is not None
        assert card.content_type is not None
        assert card.size_bytes is not None
    else:
        assert card.reference is None


@property_settings
@given(cards_with_pairs())
def test_cards_with_pairs_address_evidence(card):
    assert card.pairs
    for pair in card.pairs:
        assert set(pair.tracking_ids) <= set(card.evidence_ids)


@property_settings
@given(graph_states())
def test_similar_edges_are_bidirectional(state):
    assert state.cards
    for title, edges in state.links.items():
        for edge in edges:
            if edge.kind == "similar":
                mirrored = [
                    other
                    for other in state.links[edge.target]
                    if other.kind == "similar" and other.target == title and other.weight == edge.weight
                ]
                assert mirrored, f"{title} -> {edge.target} has no mirror"
            if edge.kind in ("follows", "artifact"):
                assert edge.target in state.cards


@property_settings
@given(graph_states_with_costs())
def test_costs_cover_both_parts_of_every_card(state_and_costs):
    state, costs = state_and_costs
    assert set(costs) == {(title, part) for title in state.cards for part in ("dialogue", "evidence")}
    assert all(cost >= 0 for cost in costs.values())


@property_settings
@given(graph_states().flatmap(lambda state: st.tuples(st.just(state), turn_choices(state))))
def test_choice_domain_is_every_card(state_and_choice):
    state, choice = state_and_choice
    assert set(choice.by_title) == set(state.cards)
    assert all(item.evidence != "title" for item in choice.by_title.values())
    with pytest.raises(TypeError):
        choice.by_title["injected"] = None


@property_settings
@given(graph_states().flatmap(lambda state: st.tuples(st.just(state), similarity_vectors(state))))
def test_similarity_is_one_score_per_card_in_range(state_and_scores):
    state, scores = state_and_scores
    assert set(scores) == set(state.cards)
    assert all(0.0 <= score <= 1.0 for score in scores.values())


@property_settings
@given(conversations().flatmap(lambda conversation: st.tuples(st.just(conversation), id_subsets(conversation))))
def test_id_subsets_stay_inside_the_conversation(conversation_and_subset):
    conversation, subset = conversation_and_subset
    present = {message["tracking_id"] for message in conversation if message.get("tracking_id")}
    assert subset <= present


@property_settings
@given(tag_universes())
def test_tag_universe_has_one_entry_per_card(universe):
    assert len(universe) >= 2
    for candidates in universe:
        assert len(candidates) == len(set(candidates))


@property_settings
@given(failure_modes())
def test_every_failure_mode_fails(mode):
    assert mode.kind in FAILURE_MODES
    if mode.raises():
        with pytest.raises((RuntimeError, TimeoutError)):
            mode.respond(3)
        return
    answer = mode.respond(3)
    assert not (isinstance(answer, list) and len(answer) == 3)


@property_settings
@given(engagement_points(), instrumentation_points())
def test_points_are_drawn_from_the_declared_sets(engagement, instrumentation):
    assert engagement
    assert instrumentation in INSTRUMENTATION_POINTS


@property_settings
@given(out_of_domain_values())
def test_out_of_domain_values_fail_a_canonical_check(value):
    # No drawn value can satisfy both canonical shapes at once: a ratio in [0, 1] and a count >= 1.
    is_ratio = type(value) in (float, int) and 0.0 <= value <= 1.0
    is_count = type(value) is int and value >= 1
    assert not (is_ratio and is_count)


def test_stub_matcher_scores_by_membership():
    matcher = StubMatcher({"known": 0.9})
    assert matcher.score("question", ["known", "other"]) == [0.9, 0.0]
    assert matcher.calls == [("question", ("known", "other"))]


def test_stub_matcher_raises_what_it_was_given():
    matcher = StubMatcher(fail=RuntimeError("down"))
    with pytest.raises(RuntimeError):
        matcher.score("question", ["a"])
    assert matcher.call_count == 1


def test_fake_embedder_records_purpose_per_text():
    embedder = FakeBedrockEmbedder()
    embedder.embed(["question"], purpose="query")
    embedder.embed(["one", "two"], purpose="document")

    assert embedder.call_count == 2
    assert embedder.purposes_for("question") == ["query"]
    assert embedder.purposes_for("two") == ["document"]
    assert embedder.embed(["one"], purpose="document") == embedder.embed(["one"], purpose="document")


def test_network_guard_blocks_outbound_connections():
    with pytest.raises(NetworkUsedError):
        socket.create_connection(("example.com", 443))
