"""The similarity link, and the cache that has to exist for it to be created at all.

The writing half cannot embed: it runs on ``MessageAddedEvent`` and must not reach the network. So it
measures a ``similar`` edge from ``_GraphState.vectors`` and answers "unmeasurable" when that cache is
empty. Nothing filled it — ``compute_notes`` asks the matcher for numbers, and the vectors behind them
stayed inside the embedder — so no ``similar`` edge was ever created and ``link_threshold`` compared
against a value that never arrived.

These tests guard the loop that closes it: the reading half deposits the vectors, and the next turn's
derivation can measure.
"""

from types import SimpleNamespace

import pytest

from strands.vended_plugins.context_graph.cards import register_card
from strands.vended_plugins.context_graph.plugin import _GraphStrategy
from strands.vended_plugins.context_graph.state import Card, _GraphState

CONFIG = {
    "expand_threshold": 0.55,
    "collapse_floor": 0.45,
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


class VectorMatcher:
    """A matcher that answers with vectors as well as notes, like the shipped one."""

    def __init__(self, by_text):
        self.by_text = by_text
        self.vector_calls = 0

    def score(self, question, descriptions):
        return [0.5] * len(descriptions)

    def vectors(self, descriptions):
        self.vector_calls += 1
        return [self.by_text[text] for text in descriptions]


class NoteOnlyMatcher:
    """A matcher exposing only ``score`` — every custom implementation written before this."""

    def score(self, question, descriptions):
        return [0.5] * len(descriptions)


def _card(title, turn, description):
    return Card(
        title=title,
        kind="subject",
        turn=turn,
        dialogue_ids=(f"d{turn}",),
        evidence_ids=(),
        pairs=(),
        tool_names=frozenset(),
        references=(),
        numeric_lines=(),
        tags=(),
        description=description,
    )


def _state(*cards):
    state = _GraphState()
    for card in cards:
        state.cards[card.title] = card
        state.links[card.title] = []
    state.turn = len(state.cards)
    return state


def _strategy(matcher):
    return _GraphStrategy(**{**CONFIG, "matcher": matcher})


def test_the_reading_half_deposits_a_vector_per_description():
    state = _state(_card("a", 0, "about a"), _card("b", 1, "about b"))
    matcher = VectorMatcher({"about a": (1.0, 0.0), "about b": (0.0, 1.0)})

    _strategy(matcher)._cache_vectors(state)

    assert state.vectors == {"a": ("about a", (1.0, 0.0)), "b": ("about b", (0.0, 1.0))}


def test_a_populated_cache_is_what_creates_the_similar_edge():
    """The defect this file exists for: with an empty cache no edge was ever created."""
    first, second = _card("a", 0, "about a"), _card("b", 1, "about b")
    state = _state(first)
    matcher = VectorMatcher({"about a": (1.0, 0.0), "about b": (1.0, 0.0)})
    state.cards[second.title] = second
    _strategy(matcher)._cache_vectors(state)
    del state.cards[second.title]

    register_card(state, second, [], link_threshold=0.5, tags_per_card=5, rarity_weight=0.7)

    kinds = {link.kind for edges in state.links.values() for link in edges}
    assert "similar" in kinds


def test_the_edge_carries_the_measured_similarity_as_its_weight():
    """The only one of the four weights that is not arbitrary."""
    first, second = _card("a", 0, "about a"), _card("b", 1, "about b")
    state = _state(first)
    matcher = VectorMatcher({"about a": (1.0, 0.0), "about b": (1.0, 0.0)})
    state.cards[second.title] = second
    _strategy(matcher)._cache_vectors(state)
    del state.cards[second.title]

    register_card(state, second, [], link_threshold=0.5, tags_per_card=5, rarity_weight=0.7)

    similar = [link for link in state.links["b"] if link.kind == "similar"]
    assert similar[0].weight == pytest.approx(1.0)


def test_a_similarity_below_the_threshold_creates_no_edge():
    first, second = _card("a", 0, "about a"), _card("b", 1, "about b")
    state = _state(first)
    matcher = VectorMatcher({"about a": (1.0, 0.0), "about b": (0.0, 1.0)})
    state.cards[second.title] = second
    _strategy(matcher)._cache_vectors(state)
    del state.cards[second.title]

    register_card(state, second, [], link_threshold=0.5, tags_per_card=5, rarity_weight=0.7)

    assert not [link for link in state.links["b"] if link.kind == "similar"]


def test_a_stale_vector_is_not_measured_against():
    """Keyed with the Description it was computed from, so a changed Description reads unmeasurable."""
    state = _state(_card("a", 0, "about a"), _card("b", 1, "about b"))
    matcher = VectorMatcher({"about a": (1.0, 0.0), "about b": (1.0, 0.0)})
    _strategy(matcher)._cache_vectors(state)

    changed = _card("b", 1, "about b, rewritten")
    state.cards["b"] = changed
    register_card(state, changed, [], link_threshold=0.5, tags_per_card=5, rarity_weight=0.7)

    assert not [link for link in state.links["b"] if link.kind == "similar"]


def test_a_matcher_without_vectors_leaves_the_cache_empty():
    """Optional by member: every custom matcher written before this keeps working, degraded."""
    state = _state(_card("a", 0, "about a"))

    _strategy(NoteOnlyMatcher())._cache_vectors(state)

    assert state.vectors == {}


@pytest.mark.parametrize("answer", [[], [(1.0, 0.0)]], ids=["empty", "wrong-length"])
def test_an_unusable_answer_leaves_the_cache_as_it_was(answer):
    """Embedding failure answers empty, and a half-filled cache would measure some pairs and not others."""
    state = _state(_card("a", 0, "about a"), _card("b", 1, "about b"))
    state.vectors["a"] = ("about a", (0.5, 0.5))

    _strategy(SimpleNamespace(score=lambda q, d: [0.5] * len(d), vectors=lambda d: answer))._cache_vectors(state)

    assert state.vectors == {"a": ("about a", (0.5, 0.5))}


def test_reading_the_vectors_back_costs_no_extra_embedding_round(monkeypatch):
    """The vectors were computed moments ago for the note, and the embedder caches by (purpose, text)."""
    from strands.vended_plugins._embedding import BedrockEmbedder
    from strands.vended_plugins.context_graph.matcher import EmbeddingSimilarityMatcher

    calls = []

    class CountingEmbedder(BedrockEmbedder):
        def embed(self, texts, *, purpose=None):
            calls.append((purpose, tuple(texts)))
            return [(1.0, 0.0)] * len(texts)

    matcher = EmbeddingSimilarityMatcher(embedder=CountingEmbedder())
    matcher.score("q", ["about a", "about b"])
    before = len(calls)

    matcher.vectors(["about a", "about b"])

    # One more call by count, and the embedder's own cache is what makes it free in I/O.
    assert len(calls) == before + 1
    assert calls[-1][0] == "document"
