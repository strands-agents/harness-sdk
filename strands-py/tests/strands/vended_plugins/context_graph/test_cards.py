"""Unit tests of the turn boundary, the Dialogue/Evidence partition, the tool pairs and the Cards.

Two conventions run through the file. The boundary rule is asserted against ``_is_user_turn`` itself,
not against a copy of its truth table, because the point of the delegation is that there is only one
rule — a test carrying its own copy would keep passing after the two drifted apart. And the partition
is checked as a partition, by union and intersection over the turn's addressed identities, since
"exhaustive and disjoint" is the property, not the contents of either tuple.

The consumption tests use the two shapes the design names: a turn ending in assistant text, and a turn
ending in a ``toolResult``. Those are the two sides of Requirements 6.4 and 6.5, and everything else
about the evidence axis follows from which of the two a turn looks like.
"""

import copy
import logging
from dataclasses import replace

import pytest
from hypothesis import assume, given
from hypothesis import strategies as st

from strands.injection._message_injection import _is_user_turn
from strands.vended_plugins.context_graph.cards import (
    closed_turn_ranges,
    derive_and_register,
    derive_and_register_artifacts,
    derive_artifact_cards,
    derive_card,
    is_evidence,
    is_turn_boundary,
    partition_turn,
    rebuild,
    rebuild_into,
    register_artifact_cards,
    register_card,
    retag,
    tool_pairs_of,
    turn_ranges,
)
from strands.vended_plugins.context_graph.describe import compose_description

from .strategies import (
    GraphState,
    conversations,
    conversations_with_open_turn,
    conversations_with_tool_pairs,
    is_turn_start,
    property_settings,
)
from .strategies import is_evidence as generated_is_evidence


def _user(text="hello", tracking_id="u1"):
    """A plain user ask: the shape that opens a turn."""
    return {"role": "user", "content": [{"text": text}], "tracking_id": tracking_id}


def _assistant_text(text="here it is", tracking_id="a1"):
    """An assistant answer in prose: the shape that consumes evidence."""
    return {"role": "assistant", "content": [{"text": text}], "tracking_id": tracking_id}


def _tool_use(tool_use_id="tu1", name="run_query", tracking_id="a2", text=None):
    """An assistant message carrying a ``toolUse`` block, optionally preceded by text."""
    content = [{"text": text}] if text is not None else []
    content.append({"toolUse": {"toolUseId": tool_use_id, "name": name, "input": {}}})
    return {"role": "assistant", "content": content, "tracking_id": tracking_id}


def _tool_result(tool_use_id="tu1", tracking_id="u2"):
    """A user message carrying a ``toolResult`` block: evidence, and not a turn boundary."""
    return {
        "role": "user",
        "content": [{"toolResult": {"toolUseId": tool_use_id, "status": "success", "content": [{"text": "42"}]}}],
        "tracking_id": tracking_id,
    }


# --- the boundary, in each shape ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        (_user(), True),
        (_tool_result(), False),
        (_assistant_text(), False),
        (_tool_use(), False),
        ({"role": "user", "content": []}, True),
    ],
    ids=["plain-user", "user-with-tool-result", "assistant-text", "assistant-tool-use", "empty-user"],
)
def test_is_turn_boundary_covers_each_shape(message, expected):
    assert is_turn_boundary(message) is expected


@given(message=st.sampled_from([_user(), _tool_result(), _assistant_text(), _tool_use()]))
@property_settings
def test_is_turn_boundary_is_the_reused_rule(message):
    # The delegation is the point: one rule, one place. A local truth table would survive a drift.
    assert is_turn_boundary(message) == _is_user_turn([message])


def test_turn_ranges_skips_messages_before_the_first_boundary():
    conversation = [_assistant_text(tracking_id="a0"), _user(tracking_id="u1"), _assistant_text()]

    assert turn_ranges(conversation) == ((1, 3),)


def test_turn_ranges_spans_a_tool_result_without_opening_a_turn():
    conversation = [_user(), _tool_use(), _tool_result(), _assistant_text(), _user(tracking_id="u3")]

    assert turn_ranges(conversation) == ((0, 4), (4, 5))


def test_closed_turn_ranges_excludes_the_turn_in_progress():
    conversation = [_user(), _assistant_text(), _user(tracking_id="u3"), _tool_use()]

    assert turn_ranges(conversation) == ((0, 2), (2, 4))
    assert closed_turn_ranges(conversation) == ((0, 2),)


@pytest.mark.parametrize("conversation", [[], [_assistant_text()], [_user()]], ids=["empty", "no-boundary", "one-turn"])
def test_closed_turn_ranges_is_empty_without_a_closed_turn(conversation):
    assert closed_turn_ranges(conversation) == ()


@given(conversation=conversations())
@property_settings
def test_turn_ranges_agree_with_the_literal_boundary_rule(conversation):
    starts = tuple(index for index in range(len(conversation)) if is_turn_start(conversation, index))

    assert tuple(start for start, _ in turn_ranges(conversation)) == starts


@given(conversation=conversations_with_open_turn())
@property_settings
def test_closed_turn_ranges_never_reach_the_last_boundary(conversation):
    closed = closed_turn_ranges(conversation)
    last_start = max(index for index in range(len(conversation)) if is_turn_start(conversation, index))

    assert all(stop <= last_start for _, stop in closed)


# --- the partition -----------------------------------------------------------------------------


def test_partition_splits_dialogue_from_evidence():
    turn = [_user(), _tool_use(), _tool_result(), _assistant_text()]

    dialogue, evidence = partition_turn(turn)

    assert dialogue == ("u1", "a1")
    assert evidence == ("a2", "u2")


def test_partition_treats_a_message_without_tracking_id_as_a_message_without_card():
    turn = [_user(), {"role": "assistant", "content": [{"text": "no address"}]}]

    dialogue, evidence = partition_turn(turn)

    assert dialogue == ("u1",)
    assert evidence == ()


def test_partition_places_a_message_carrying_text_and_tool_use_in_the_evidence():
    # One block decides: carrying a tool block is enough, regardless of the text alongside it.
    turn = [_tool_use(text="let me check", tracking_id="a2")]

    assert partition_turn(turn) == ((), ("a2",))


@given(conversation=conversations_with_tool_pairs())
@property_settings
def test_partition_is_exhaustive_and_disjoint(conversation):
    addressed = {message["tracking_id"] for message in conversation if message.get("tracking_id")}

    dialogue, evidence = partition_turn(conversation)

    assert set(dialogue) | set(evidence) == addressed
    assert set(dialogue) & set(evidence) == set()
    assert len(dialogue) + len(evidence) == len(addressed)


@given(conversation=conversations_with_tool_pairs())
@property_settings
def test_is_evidence_matches_the_literal_rule(conversation):
    assert [is_evidence(message) for message in conversation] == [
        generated_is_evidence(message) for message in conversation
    ]


# --- consumption, from order alone --------------------------------------------------------------


def test_pair_is_consumed_in_a_turn_ending_in_text():
    turn = [_user(), _tool_use(), _tool_result(), _assistant_text()]

    (pair,) = tool_pairs_of(turn)

    assert pair.consumed is True
    assert pair.tool_name == "run_query"
    assert pair.tracking_ids == ("a2", "u2")


def test_pair_is_unconsumed_in_a_turn_ending_in_tool_result():
    turn = [_user(), _tool_use(), _tool_result()]

    (pair,) = tool_pairs_of(turn)

    assert pair.consumed is False


def test_text_preceding_the_result_does_not_consume_the_pair():
    turn = [_user(), _tool_use(text="let me check"), _tool_result()]

    (pair,) = tool_pairs_of(turn)

    assert pair.consumed is False


def test_an_unmatched_tool_use_yields_an_unconsumed_pair():
    turn = [_user(), _tool_use()]

    (pair,) = tool_pairs_of(turn)

    assert pair.consumed is False
    assert pair.tracking_ids == ("a2",)


def test_an_orphan_tool_result_yields_an_unconsumed_pair():
    turn = [_tool_result(), _user(tracking_id="u3")]

    (pair,) = tool_pairs_of(turn)

    assert pair.tool_use_id == "tu1"
    assert pair.tool_name == ""
    assert pair.consumed is False


def test_two_tool_uses_in_one_message_yield_two_pairs_sharing_the_identity():
    turn = [
        _user(),
        {
            "role": "assistant",
            "content": [
                {"toolUse": {"toolUseId": "tu1", "name": "run_query", "input": {}}},
                {"toolUse": {"toolUseId": "tu2", "name": "read_file", "input": {}}},
            ],
            "tracking_id": "a2",
        },
        _tool_result("tu1", tracking_id="u2"),
        _tool_result("tu2", tracking_id="u3"),
        _assistant_text(),
    ]

    pairs = tool_pairs_of(turn)

    assert [pair.tool_use_id for pair in pairs] == ["tu1", "tu2"]
    assert [pair.tool_name for pair in pairs] == ["run_query", "read_file"]
    assert all(pair.consumed for pair in pairs)
    assert pairs[0].tracking_ids == ("a2", "u2")


def test_a_pair_consumed_earlier_stays_consumed_when_a_later_pair_is_not():
    turn = [
        _user(),
        _tool_use(),
        _tool_result(),
        _assistant_text(),
        _tool_use("tu2", tracking_id="a3"),
        _tool_result("tu2", tracking_id="u3"),
    ]

    first, second = tool_pairs_of(turn)

    assert first.consumed is True
    assert second.consumed is False


@given(conversation=conversations_with_tool_pairs())
@property_settings
def test_scanning_a_turn_never_mutates_it(conversation):
    snapshot = copy.deepcopy(conversation)

    partition_turn(conversation)
    tool_pairs_of(conversation)
    turn_ranges(conversation)

    assert conversation == snapshot


# --- derivation ---------------------------------------------------------------------------------


_PREVIEW = (
    "[Offloaded: 2 blocks, ~3,000 tokens]\n"
    "Tool result was offloaded to external storage due to size.\n\n"
    "saldo 2024: R$ 1.200,00\n\n"
    "[Stored references:]\n"
    "  mem_1_tu1_0 (text, 4,096 chars)\n"
    "  mem_1_tu1_1 (json, 900 bytes)"
)
"""A preview in the shape the offloader writes, listing two references and carrying a numeric line."""

_CONFIG = {"description_tokens": 100, "tags_per_card": 5, "rarity_weight": 0.7}
"""The construction defaults of the three derivation parameters."""


def _closed_turn(text="how are the balances?", tool_name="run_query", result_text="total: 3.451,90 BRL"):
    """A closed turn: a user ask, a tool pair, an assistant answer, and the next boundary."""
    return [
        _user(text=text),
        _tool_use(name=tool_name),
        {
            "role": "user",
            "content": [{"toolResult": {"toolUseId": "tu1", "status": "success", "content": [{"text": result_text}]}}],
            "tracking_id": "u2",
        },
        _assistant_text(),
        _user(text="and now?", tracking_id="u9"),
    ]


def _ids(messages_):
    """Durable identities of ``messages_``, skipping the ones that carry none."""
    return [message["tracking_id"] for message in messages_ if message.get("tracking_id")]


def _derive(conversation, turn=1, **overrides):
    """Derive the Card of the first closed turn of ``conversation``."""
    start, stop = closed_turn_ranges(conversation)[0]
    return derive_card(conversation, _ids(conversation[start:stop]), turn, **{**_CONFIG, **overrides})


def test_derive_card_partitions_the_turn_and_names_its_tools():
    conversation = _closed_turn()

    card = _derive(conversation)

    assert card.kind == "subject"
    assert card.turn == 1
    assert card.title == "how are the balances?"
    assert card.dialogue_ids == ("u1", "a1")
    assert card.evidence_ids == ("a2", "u2")
    assert card.tool_names == frozenset({"run_query"})
    assert [pair.tool_use_id for pair in card.pairs] == ["tu1"]


def test_derive_card_copies_numeric_lines_literally_into_the_description():
    card = _derive(_closed_turn())

    assert card.numeric_lines == ("total: 3.451,90 BRL",)
    assert "total: 3.451,90 BRL" in card.description
    assert card.description.startswith("how are the balances?")


def test_derive_card_stores_no_message_text_beyond_numeric_lines_and_the_title():
    conversation = _closed_turn(text="how are the balances?", result_text="rows: 12\nsecret narrative prose")

    card = _derive(conversation)

    assert "secret narrative prose" not in card.description
    assert card.numeric_lines == ("rows: 12",)


def test_derive_card_reads_references_out_of_the_preview():
    conversation = _closed_turn(result_text=_PREVIEW)

    card = _derive(conversation)

    assert card.references == ("mem_1_tu1_0", "mem_1_tu1_1")
    assert "saldo 2024: R$ 1.200,00" in card.description


def test_derive_card_reads_an_inline_placeholder_reference():
    conversation = _closed_turn(result_text="[image: png, 900 bytes | ref: mem_1_tu1_2]")

    assert _derive(conversation).references == ("mem_1_tu1_2",)


def test_derive_card_ignores_a_message_without_tracking_id():
    conversation = _closed_turn()
    conversation.insert(3, {"role": "assistant", "content": [{"text": "orphan 999"}]})

    card = _derive(conversation)

    assert "999" not in card.description
    assert set(card.dialogue_ids) | set(card.evidence_ids) == {"u1", "a1", "a2", "u2"}


def test_derive_card_tags_the_tool_name_before_any_textual_candidate():
    card = _derive(_closed_turn())

    assert card.tags[0] == "run_query"
    assert len(card.tags) <= _CONFIG["tags_per_card"]


def test_derive_card_never_mutates_the_conversation():
    conversation = _closed_turn()
    snapshot = copy.deepcopy(conversation)

    _derive(conversation)

    assert conversation == snapshot


def test_derive_card_is_deterministic_character_for_character():
    conversation = _closed_turn()

    assert _derive(conversation) == _derive(conversation)


def test_derive_card_titles_a_turn_whose_boundary_carries_no_identity():
    # The boundary has no address, so it is a message without a Card and the Title falls back.
    conversation = [
        {"role": "user", "content": [{"text": "unaddressed ask"}]},
        _assistant_text(),
        _user(tracking_id="u9"),
    ]
    start, stop = closed_turn_ranges(conversation)[0]

    card = derive_card(conversation, _ids(conversation[start:stop]), 1, **_CONFIG)

    assert card.title == "here it is"
    assert card.dialogue_ids == ("a1",)


@given(conversation=conversations())
@property_settings
def test_derive_card_partition_is_exhaustive_and_disjoint(conversation):
    ranges = closed_turn_ranges(conversation)
    assume(ranges)
    start, stop = ranges[0]
    turn_ids = _ids(conversation[start:stop])

    card = derive_card(conversation, turn_ids, 1, **_CONFIG)

    assert set(card.dialogue_ids) | set(card.evidence_ids) == set(turn_ids)
    assert set(card.dialogue_ids) & set(card.evidence_ids) == set()


# --- the four links -----------------------------------------------------------------------------


def _state_with(*cards_):
    """A graph state holding ``cards_``, with no links yet."""
    state = GraphState()
    for card in cards_:
        state.cards[card.title] = card
    return state


def _register(state, card, conversation, *, link_threshold=0.5, similarity=None, tags_per_card=None):
    """Register ``card`` on ``state`` with the construction defaults."""
    register_card(
        state,
        card,
        conversation,
        link_threshold=link_threshold,
        tags_per_card=tags_per_card or _CONFIG["tags_per_card"],
        rarity_weight=_CONFIG["rarity_weight"],
        similarity=similarity,
    )


def test_register_card_creates_one_tool_link_per_tool_name():
    conversation = _closed_turn()
    card = _derive(conversation)
    state = GraphState()

    _register(state, card, conversation)

    tool_links = [link for link in state.links[card.title] if link.kind == "tool"]
    assert [(link.target, link.weight) for link in tool_links] == [("run_query", 1.0)]


def test_register_card_creates_one_artifact_link_per_reference():
    conversation = _closed_turn(result_text=_PREVIEW)
    card = _derive(conversation)
    state = GraphState()

    _register(state, card, conversation)

    artifact_links = [link for link in state.links[card.title] if link.kind == "artifact"]
    assert [link.target for link in artifact_links] == ["mem_1_tu1_0", "mem_1_tu1_1"]
    assert {link.weight for link in artifact_links} == {1.0}


def test_register_card_follows_the_previous_turn_and_the_first_card_follows_nothing():
    conversation = _closed_turn()
    first = _derive(conversation, turn=1)
    state = GraphState()
    _register(state, first, conversation)

    assert [link for link in state.links[first.title] if link.kind == "follows"] == []

    second = replace(_derive(conversation, turn=2), title="second ask")
    _register(state, second, conversation)

    (follows,) = [link for link in state.links[second.title] if link.kind == "follows"]
    assert (follows.target, follows.weight) == (first.title, 1.0)


def test_register_card_links_similar_cards_bidirectionally_with_the_measured_weight():
    conversation = _closed_turn()
    existing = replace(_derive(conversation, turn=1), title="earlier ask")
    state = _state_with(existing)
    card = replace(_derive(conversation, turn=2), title="later ask")

    _register(state, card, conversation, similarity=lambda _left, _right: 0.83)

    outgoing = [link for link in state.links[card.title] if link.kind == "similar"]
    incoming = [link for link in state.links[existing.title] if link.kind == "similar"]
    assert [(link.target, link.weight) for link in outgoing] == [("earlier ask", 0.83)]
    assert [(link.target, link.weight) for link in incoming] == [("later ask", 0.83)]


@pytest.mark.parametrize(
    ("measured", "expected"),
    [(0.49, 0), (0.5, 1), (0.51, 1), (None, 0)],
    ids=["below", "at-threshold", "above", "unmeasurable"],
)
def test_similar_link_exists_only_at_or_above_the_threshold(measured, expected):
    conversation = _closed_turn()
    existing = replace(_derive(conversation, turn=1), title="earlier ask")
    state = _state_with(existing)
    card = replace(_derive(conversation, turn=2), title="later ask")

    _register(state, card, conversation, similarity=lambda _left, _right: measured)

    assert len([link for link in state.links[card.title] if link.kind == "similar"]) == expected


def test_default_similarity_reads_the_vector_cache_and_never_the_network():
    conversation = _closed_turn()
    existing = replace(_derive(conversation, turn=1), title="earlier ask")
    state = _state_with(existing)
    card = replace(_derive(conversation, turn=2), title="later ask")
    # Identical vectors: the cosine is 1.0, so the edge exists on the cache alone.
    state.vectors[existing.title] = (existing.description, (1.0, 0.0, 1.0))
    state.vectors[card.title] = (card.description, (1.0, 0.0, 1.0))

    _register(state, card, conversation)

    (similar,) = [link for link in state.links[card.title] if link.kind == "similar"]
    assert similar.weight == pytest.approx(1.0)


def test_default_similarity_skips_a_description_the_cache_does_not_match():
    conversation = _closed_turn()
    existing = replace(_derive(conversation, turn=1), title="earlier ask")
    state = _state_with(existing)
    card = replace(_derive(conversation, turn=2), title="later ask")
    state.vectors[existing.title] = ("a description it no longer has", (1.0, 0.0))
    state.vectors[card.title] = (card.description, (1.0, 0.0))

    _register(state, card, conversation)

    assert [link for link in state.links[card.title] if link.kind == "similar"] == []


def test_registering_the_same_card_twice_does_not_duplicate_an_edge():
    conversation = _closed_turn(result_text=_PREVIEW)
    card = _derive(conversation)
    state = GraphState()

    _register(state, card, conversation)
    _register(state, card, conversation)

    kinds = [(link.kind, link.target) for link in state.links[card.title]]
    assert len(kinds) == len(set(kinds))


# --- rarity recomputed when the graph gains a Card -----------------------------------------------


def test_gaining_a_card_retags_the_existing_ones():
    #  Two Cards sharing a word: once both exist, the shared word stops distinguishing either.
    first = [
        _user(text="the connector connector connector broke", tracking_id="u1"),
        _assistant_text(tracking_id="a1"),
        _user(text="next", tracking_id="u9"),
    ]
    second = [
        _user(text="the connector connector and billing billing", tracking_id="u3"),
        _assistant_text(tracking_id="a3"),
        _user(text="next", tracking_id="u8"),
    ]
    conversation = first[:2] + second
    state = GraphState()

    early = derive_card(conversation, ("u1", "a1"), 1, **{**_CONFIG, "tags_per_card": 2})
    _register(state, early, conversation, tags_per_card=2)
    alone = state.cards[early.title].tags

    later = derive_card(conversation, ("u3", "a3"), 2, **{**_CONFIG, "tags_per_card": 2})
    _register(state, later, conversation, tags_per_card=2)

    assert "connector" in alone
    # Present in both Cards now, so it lost to a candidate belonging to this one alone.
    assert "connector" not in state.cards[early.title].tags[:1]
    assert state.cards[early.title].tags != alone


def test_retag_leaves_descriptions_untouched():
    conversation = _closed_turn()
    card = _derive(conversation)
    state = GraphState()
    _register(state, card, conversation)

    retag(state, conversation, tags_per_card=5, rarity_weight=0.7)

    assert state.cards[card.title].description == card.description


def test_retag_is_deterministic_over_the_same_graph():
    conversation = _closed_turn()
    card = _derive(conversation)
    state = GraphState()
    _register(state, card, conversation)

    first = state.cards[card.title].tags
    retag(state, conversation, tags_per_card=5, rarity_weight=0.7)

    assert state.cards[card.title].tags == first


def test_retag_survives_a_card_whose_messages_are_gone():
    conversation = _closed_turn()
    card = _derive(conversation)
    state = GraphState()
    _register(state, card, conversation)

    retag(state, [], tags_per_card=5, rarity_weight=0.7)

    # Structural candidates survive: they come from the Card, not from the conversation.
    assert state.cards[card.title].tags == ("run_query",)


# --- failure completes the hook without a Card --------------------------------------------------


def test_derive_and_register_returns_the_card_on_the_happy_path():
    conversation = _closed_turn()

    state = GraphState()
    card = derive_and_register(state, conversation, _ids(conversation[:4]), 1, link_threshold=0.5, **_CONFIG)

    assert card is not None
    assert state.cards == {card.title: card}


def test_derive_and_register_logs_exactly_one_warning_and_registers_nothing(monkeypatch, caplog):
    conversation = _closed_turn()
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.cards.compose_description",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("derivation exploded")),
    )
    state = GraphState()

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        card = derive_and_register(state, conversation, _ids(conversation[:4]), 1, link_threshold=0.5, **_CONFIG)

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert card is None
    assert state.cards == {}
    assert state.links == {}
    assert len(warnings) == 1
    assert warnings[0].exc_info is not None


def test_derive_and_register_does_not_propagate_a_link_failure(caplog):
    conversation = _closed_turn()
    existing = replace(_derive(conversation, turn=1), title="earlier ask")
    state = _state_with(existing)

    def _explode(_left, _right):
        raise RuntimeError("similarity exploded")

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        card = derive_and_register(
            state,
            conversation,
            _ids(conversation[:4]),
            2,
            link_threshold=0.5,
            similarity=_explode,
            **_CONFIG,
        )

    assert card is None
    assert len([record for record in caplog.records if record.levelno == logging.WARNING]) == 1


# --- the artifact Card ---------------------------------------------------------------------------

_RAW = "row 1: 10,00\nsecret narrative prose the offloader moved out of context"
"""Content that must never end up in a Card: it lives in the offloader's ``Storage``."""

_OFFLOADED_PREVIEW = (
    "[Offloaded: 3 blocks, ~3,000 tokens]\n"
    "Tool result was offloaded to external storage due to size.\n\n"
    "row 1: 10,00\n\n"
    "[Stored references:]\n"
    "  mem_1_tu1_0 (text, 4,096 chars)\n"
    "  mem_1_tu1_1 (json, 900 bytes)\n"
    "  mem_1_tu1_2 (image/png, 900 bytes)"
)
"""The preview the offloader writes over a three-block result, two textual and one image."""


def _offloaded_result(preview=_OFFLOADED_PREVIEW, *placeholders):
    """A tool result in the shape the offloader leaves behind: a preview, then the placeholders."""
    return {
        "toolUseId": "tu1",
        "status": "success",
        "content": [{"text": preview}, *({"text": text} for text in placeholders)],
    }


def _artifacts(result, tool_name="run_query", turn=3, **overrides):
    """Derive the artifact Cards of ``result`` with the construction defaults."""
    return derive_artifact_cards(result, tool_name, turn, **{**_CONFIG, **overrides})


def test_derive_artifact_cards_makes_one_card_per_reference_titled_by_it():
    cards_ = _artifacts(_offloaded_result())
    assert [card.title for card in cards_] == ["mem_1_tu1_0", "mem_1_tu1_1", "mem_1_tu1_2"]
    assert {card.kind for card in cards_} == {"artifact"}
    assert {card.reference for card in cards_} == {card.title for card in cards_}
    assert {card.turn for card in cards_} == {3}


def test_derive_artifact_cards_holds_the_reference_and_never_the_raw_content():
    result = _offloaded_result()
    cards_ = _artifacts(result)
    # The raw return went to Storage; nothing derived from it may carry its prose back.
    assert all("secret narrative prose" not in card.description for card in cards_)
    assert all(_RAW not in card.description for card in cards_)
    # No message is addressed either: an artifact points at Storage, not at the conversation.
    assert all(card.dialogue_ids == () and card.evidence_ids == () for card in cards_)
    assert all(card.reference in card.description for card in cards_)


def test_derive_artifact_cards_reads_the_content_type_and_size_of_a_listed_descriptor():
    by_title = {card.title: card for card in _artifacts(_offloaded_result())}
    assert (by_title["mem_1_tu1_0"].content_type, by_title["mem_1_tu1_0"].size_bytes) == ("text/plain", None)
    assert (by_title["mem_1_tu1_1"].content_type, by_title["mem_1_tu1_1"].size_bytes) == ("application/json", 900)
    assert (by_title["mem_1_tu1_2"].content_type, by_title["mem_1_tu1_2"].size_bytes) == ("image/png", 900)


def test_derive_artifact_cards_prefers_the_placeholder_over_a_listing_that_names_no_type():
    # The listing describes a document by file name, which is not a media type; the placeholder is.
    preview = "[Stored references:]\n  mem_1_tu1_0 (report.pdf, 4,000 bytes)"
    (card,) = _artifacts(_offloaded_result(preview, "[document: pdf, report.pdf, 4000 bytes | ref: mem_1_tu1_0]"))
    assert (card.content_type, card.size_bytes) == ("application/pdf", 4000)


def test_derive_artifact_cards_leaves_an_undescribed_reference_without_facts():
    (card,) = _artifacts(_offloaded_result("[image: png, 12 bytes | ref: mem_1_tu1_9]"))
    # An unrecognized type falls to the non-textual Description, which is the conservative side.
    assert card.title == "mem_1_tu1_9"
    assert card.content_type == "image/png"


def test_derive_artifact_cards_keeps_numeric_lines_only_for_textual_content():
    by_title = {card.title: card for card in _artifacts(_offloaded_result())}
    assert "row 1: 10,00" in by_title["mem_1_tu1_0"].numeric_lines
    # Bytes that were never text have no lines to select.
    assert by_title["mem_1_tu1_2"].numeric_lines == ()


def test_derive_artifact_cards_describes_a_textual_artifact_by_reference_tool_and_turn():
    by_title = {card.title: card for card in _artifacts(_offloaded_result())}
    description = by_title["mem_1_tu1_0"].description
    assert description.startswith("reference: mem_1_tu1_0")
    assert "tool: run_query" in description
    assert "turn: 3" in description


def test_derive_artifact_cards_describes_a_non_textual_artifact_by_file_type_and_size():
    description = {card.title: card for card in _artifacts(_offloaded_result())}["mem_1_tu1_2"].description
    assert description.startswith("file: mem_1_tu1_2")
    assert "content_type: image/png" in description
    assert "size: 900 bytes" in description


def test_derive_artifact_cards_tags_the_reference_and_the_tool():
    (card, *_rest) = _artifacts(_offloaded_result())
    assert set(card.tags) == {"mem_1_tu1_0", "run_query"}


def test_derive_artifact_cards_yields_nothing_without_an_offloader():
    # Nothing replaced the return, so the scan finds no reference and there is no artifact Card.
    plain = {"toolUseId": "tu1", "status": "success", "content": [{"text": _RAW}]}
    assert _artifacts(plain) == ()


def test_derive_artifact_cards_is_deterministic_and_never_mutates_the_result():
    result = _offloaded_result()
    snapshot = copy.deepcopy(result)
    assert _artifacts(result) == _artifacts(result)
    assert result == snapshot


def test_register_artifact_cards_links_the_tool_and_nothing_else():
    conversation = _closed_turn()
    state = GraphState()
    cards_ = _artifacts(_offloaded_result())
    register_artifact_cards(state, cards_, conversation, tags_per_card=5, rarity_weight=0.7)
    edges = [link for card in cards_ for link in state.links[card.title]]
    assert {(link.kind, link.target, link.weight) for link in edges} == {("tool", "run_query", 1.0)}
    assert set(state.cards) == {card.title for card in cards_}


def test_register_artifact_cards_keeps_the_subject_cards_and_their_ordering():
    conversation = _closed_turn()
    subject = _derive(conversation, turn=1)
    state = GraphState()
    _register(state, subject, conversation)

    register_artifact_cards(state, _artifacts(_offloaded_result()), conversation, tags_per_card=5, rarity_weight=0.7)
    later = replace(_derive(conversation, turn=2), title="later ask")
    _register(state, later, conversation)

    # The artifact Card is not a turn, so it never becomes the target of a ``follows`` edge.
    (follows,) = [link for link in state.links[later.title] if link.kind == "follows"]
    assert follows.target == subject.title
    assert state.cards[subject.title].kind == "subject"


def test_the_subject_artifact_edge_resolves_onto_the_artifact_card():
    # The subject side derives the edge from the reference alone, so hook order cannot break it.
    conversation = _closed_turn(result_text=_OFFLOADED_PREVIEW)
    subject = _derive(conversation)
    state = GraphState()
    _register(state, subject, conversation)
    register_artifact_cards(state, _artifacts(_offloaded_result()), conversation, tags_per_card=5, rarity_weight=0.7)

    targets = [link.target for link in state.links[subject.title] if link.kind == "artifact"]
    assert targets == ["mem_1_tu1_0", "mem_1_tu1_1", "mem_1_tu1_2"]
    assert all(target in state.cards for target in targets)


def test_registering_the_same_artifact_twice_does_not_duplicate_an_edge():
    conversation = _closed_turn()
    state = GraphState()
    cards_ = _artifacts(_offloaded_result())
    for _ in range(2):
        register_artifact_cards(state, cards_, conversation, tags_per_card=5, rarity_weight=0.7)
    for card in cards_:
        edges = [(link.kind, link.target) for link in state.links[card.title]]
        assert len(edges) == len(set(edges))


def test_derive_and_register_artifacts_registers_the_batch_on_the_happy_path():
    conversation = _closed_turn()
    state = GraphState()
    cards_ = derive_and_register_artifacts(state, conversation, _offloaded_result(), "run_query", 3, **_CONFIG)
    assert [card.title for card in cards_] == ["mem_1_tu1_0", "mem_1_tu1_1", "mem_1_tu1_2"]
    assert set(state.cards) == set(card.title for card in cards_)


def test_derive_and_register_artifacts_logs_nothing_without_an_offloader(caplog):
    conversation = _closed_turn()
    subject = _derive(conversation)
    state = GraphState()
    _register(state, subject, conversation)
    plain = {"toolUseId": "tu1", "status": "success", "content": [{"text": _RAW}]}

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        cards_ = derive_and_register_artifacts(state, conversation, plain, "run_query", 3, **_CONFIG)

    assert cards_ == ()
    assert state.cards == {subject.title: state.cards[subject.title]}
    assert [record for record in caplog.records if record.levelno == logging.WARNING] == []


def test_derive_and_register_artifacts_logs_one_warning_and_registers_nothing(monkeypatch, caplog):
    conversation = _closed_turn()
    subject = _derive(conversation)
    state = GraphState()
    _register(state, subject, conversation)
    before = (dict(state.cards), {title: list(edges) for title, edges in state.links.items()})
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.cards.compose_description",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("derivation exploded")),
    )

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        cards_ = derive_and_register_artifacts(state, conversation, _offloaded_result(), "run_query", 3, **_CONFIG)

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert cards_ == ()
    assert (state.cards, state.links) == before
    assert len(warnings) == 1
    assert warnings[0].exc_info is not None


def test_derive_and_register_artifacts_restores_the_whole_batch_on_a_late_failure(monkeypatch, caplog):
    conversation = _closed_turn()
    state = GraphState()
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.cards.retag",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("retag exploded")),
    )

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        cards_ = derive_and_register_artifacts(state, conversation, _offloaded_result(), "run_query", 3, **_CONFIG)

    # Half a batch would read as a graph that saw one block of a three-block result.
    assert cards_ == ()
    assert state.cards == {}
    assert state.links == {}


# --- the rebuild scan ----------------------------------------------------------------------------


def _turn(index, *, tool_name="run_query", result_text="total: 3.451,90 BRL"):
    """One turn's worth of messages, with identities unique to ``index``.

    The turn is only *closed* once a later boundary exists, so ``_conversation`` is what decides that.
    """
    return [
        _user(text=f"turn {index}: how are the balances?", tracking_id=f"u{index}"),
        _tool_use(tool_use_id=f"tu{index}", name=tool_name, tracking_id=f"a{index}"),
        {
            "role": "user",
            "content": [
                {"toolResult": {"toolUseId": f"tu{index}", "status": "success", "content": [{"text": result_text}]}}
            ],
            "tracking_id": f"r{index}",
        },
        _assistant_text(tracking_id=f"x{index}"),
    ]


def _conversation(count=3, **kwargs):
    """``count`` turns back to back. The last one is the turn in progress, so ``count - 1`` are closed."""
    return [message for index in range(count) for message in _turn(index, **kwargs)]


def _lexical_similarity(left, right):
    """A deterministic stand-in for the vector cache: word overlap of the two Descriptions.

    Symmetric and reachable without a network call, which is what makes it usable in an equality test
    — the cache-only default measures nothing on a fresh state, so it would exercise no ``similar``
    edge at all.
    """
    left_words = set(left.description.split())
    right_words = set(right.description.split())
    if not left_words or not right_words:
        return 0.0

    return len(left_words & right_words) / len(left_words | right_words)


def _rebuild(conversation, *, link_threshold=0.5, similarity=None):
    """Run the rebuild scan with the construction defaults."""
    return rebuild(conversation, link_threshold=link_threshold, similarity=similarity, **_CONFIG)


def _build_incrementally(conversation, *, link_threshold=0.5, similarity=None):
    """Build the graph the way the writing half does: one closed turn at a time.

    Each step sees only the messages that existed when its boundary arrived, which is what the hook
    sees, and is why the equality below is not an artifact of both constructions reading the same list.
    """
    ranges = closed_turn_ranges(conversation)
    state = GraphState()

    for turn, (start, stop) in enumerate(ranges):
        turn_ids = _ids(conversation[start:stop])
        if not turn_ids:
            continue
        derive_and_register(
            state,
            conversation[: stop + 1],
            turn_ids,
            turn,
            link_threshold=link_threshold,
            similarity=similarity,
            **_CONFIG,
        )

    state.turn = len(ranges)
    return state


def test_rebuild_derives_one_subject_card_per_closed_turn():
    state = _rebuild(_conversation(count=3))

    assert [card.turn for card in state.cards.values()] == [0, 1]
    assert {card.kind for card in state.cards.values()} == {"subject"}
    assert state.turn == 2


def test_rebuild_never_reaches_the_turn_in_progress():
    conversation = _conversation(count=3)

    addressed = {identity for card in _rebuild(conversation).cards.values() for identity in card.dialogue_ids}

    # The third turn opens at "turn 2" and no boundary follows it, so nothing about it is derivable.
    assert "u2" not in addressed
    assert "u0" in addressed and "u1" in addressed


def test_rebuild_chains_follows_by_turn_ordinal():
    state = _rebuild(_conversation(count=4))

    by_turn = sorted(state.cards.values(), key=lambda card: card.turn)
    follows = {
        card.title: [link.target for link in state.links[card.title] if link.kind == "follows"] for card in by_turn
    }
    assert follows[by_turn[0].title] == []
    assert follows[by_turn[1].title] == [by_turn[0].title]
    assert follows[by_turn[2].title] == [by_turn[1].title]


def test_rebuild_equals_the_incremental_construction():
    conversation = _conversation(count=4)

    rebuilt = _rebuild(conversation)
    incremental = _build_incrementally(conversation)

    assert rebuilt.cards == incremental.cards
    assert rebuilt.links == incremental.links
    assert rebuilt.turn == incremental.turn


def test_rebuild_equals_the_incremental_construction_with_similar_edges():
    # Without a measurable similarity the two constructions would agree on an empty edge kind, which
    # is the one kind whose weight is the measurement itself.
    conversation = _conversation(count=4)

    rebuilt = _rebuild(conversation, similarity=_lexical_similarity, link_threshold=0.2)
    incremental = _build_incrementally(conversation, similarity=_lexical_similarity, link_threshold=0.2)

    assert any(link.kind == "similar" for edges in rebuilt.links.values() for link in edges)
    assert rebuilt.cards == incremental.cards
    assert rebuilt.links == incremental.links


def test_rebuild_equals_the_incremental_construction_over_a_preview():
    conversation = _conversation(count=3, result_text=_PREVIEW)

    rebuilt = _rebuild(conversation)
    incremental = _build_incrementally(conversation)

    assert any(link.kind == "artifact" for edges in rebuilt.links.values() for link in edges)
    assert rebuilt.cards == incremental.cards
    assert rebuilt.links == incremental.links


def test_rebuild_over_an_empty_conversation_is_the_empty_graph():
    state = _rebuild([])

    assert state.cards == {}
    assert state.links == {}
    assert state.turn == 0


@pytest.mark.parametrize(
    "conversation",
    [
        [_user()],
        [_user(), _assistant_text()],
        [{"role": "assistant", "content": [{"text": "no boundary here"}], "tracking_id": "a0"}],
        _turn(0),
    ],
    ids=["user-only", "user-and-answer", "no-boundary-at-all", "one-open-turn"],
)
def test_rebuild_without_a_closed_turn_is_the_empty_graph(conversation):
    state = _rebuild(conversation)

    assert state.cards == {}
    assert state.turn == 0


def test_rebuild_skips_a_turn_without_a_durable_identity_and_keeps_the_ordinals():
    conversation = _conversation(count=3)
    for message in conversation[:4]:
        del message["tracking_id"]

    state = _rebuild(conversation)

    # The first turn is entirely made of messages without a Card, so it has none — and it still
    # consumes ordinal 0, which is what keeps the second turn's ordinal where the hook put it.
    assert [card.turn for card in state.cards.values()] == [1]
    assert state.turn == 2


def test_rebuild_addresses_only_messages_present_in_the_conversation():
    conversation = _conversation(count=3)

    state = _rebuild(conversation)

    present = {message["tracking_id"] for message in conversation if message.get("tracking_id")}
    addressed = {identity for card in state.cards.values() for identity in (*card.dialogue_ids, *card.evidence_ids)}
    assert addressed <= present


def test_rebuild_leaves_the_vector_cache_empty_and_derives_no_similar_edge():
    state = _rebuild(_conversation(count=4))

    # A missing entry costs one embedding on the next turn the reading half runs, never a value.
    assert state.vectors == {}
    assert not [link for edges in state.links.values() for link in edges if link.kind == "similar"]


def test_rebuild_never_mutates_the_conversation():
    conversation = _conversation(count=3)
    snapshot = copy.deepcopy(conversation)

    _rebuild(conversation)

    assert conversation == snapshot


def test_rebuild_is_deterministic():
    conversation = _conversation(count=4)

    first = _rebuild(conversation, similarity=_lexical_similarity)
    second = _rebuild(conversation, similarity=_lexical_similarity)

    assert first.cards == second.cards
    assert first.links == second.links


def test_rebuild_absorbs_a_turn_whose_derivation_fails(monkeypatch, caplog):
    conversation = _conversation(count=3)
    monkeypatch.setattr(
        "strands.vended_plugins.context_graph.cards.compose_description",
        lambda card, tokens: (
            (_ for _ in ()).throw(RuntimeError("derivation exploded"))
            if card.turn == 0
            else compose_description(card, tokens)
        ),
    )

    with caplog.at_level(logging.WARNING, logger="strands.vended_plugins.context_graph.cards"):
        state = _rebuild(conversation)

    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert [card.turn for card in state.cards.values()] == [1]
    assert state.turn == 2


def test_rebuild_into_writes_on_the_state_the_hook_holds_and_keeps_the_fed_back_note():
    conversation = _conversation(count=3)
    state = GraphState()
    state.reuse["earlier ask"] = (0.2, 7)

    rebuild_into(state, conversation, link_threshold=0.5, similarity=None, **_CONFIG)
    once = dict(state.cards)
    rebuild_into(state, conversation, link_threshold=0.5, similarity=None, **_CONFIG)

    # Idempotent, because a graph derived from the messages cannot depend on what was there before.
    assert state.cards == once
    assert state.cards == _rebuild(conversation).cards
    assert state.reuse == {"earlier ask": (0.2, 7)}


@given(conversation=conversations())
@property_settings
def test_rebuild_addresses_only_present_messages_over_any_conversation(conversation):
    state = _rebuild(conversation)

    present = {message["tracking_id"] for message in conversation if message.get("tracking_id")}
    for card in state.cards.values():
        assert set(card.dialogue_ids) | set(card.evidence_ids) <= present
    assert state.turn == len(closed_turn_ranges(conversation))


@given(conversation=conversations_with_open_turn())
@property_settings
def test_rebuild_over_an_open_turn_never_covers_the_turn_in_progress(conversation):
    ranges = turn_ranges(conversation)
    in_progress = _ids(conversation[ranges[-1][0] :]) if ranges else []

    state = _rebuild(conversation)

    addressed = {identity for card in state.cards.values() for identity in (*card.dialogue_ids, *card.evidence_ids)}
    assert addressed.isdisjoint(in_progress)
