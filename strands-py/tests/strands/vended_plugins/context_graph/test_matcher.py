"""Unit tests of ``matcher.py``: asymmetric purpose, vector reuse and the failure rule.

The asymmetric purpose is silent in production — passing ``"clustering"`` where ``"query"`` was right
returns a worse vector without any error — so the only way to verify it is a double that records the
``(purpose, text)`` pair of every call. That is what ``FakeBedrockEmbedder`` is for.

Vector reuse is verified against the *real* ``BedrockEmbedder`` with only its transport stubbed, because
the reuse is a property of the cache in ``_embedding.py``, which this module reuses verbatim rather than
reimplements. Counting the fake's calls would prove nothing about the cache; counting the real cache's
misses proves exactly the claim.

Zero network calls, enforced by the package-wide guard rather than by discipline.
"""

import logging

import pytest

from strands.vended_plugins._embedding import BedrockEmbedder, EmbeddingError
from strands.vended_plugins.context_graph.matcher import (
    EmbeddingSimilarityMatcher,
    SimilarityMatcher,
)

from .stubs import FakeBedrockEmbedder, StubMatcher

DESCRIPTIONS = ("posicoes consolidadas do portfolio", "status dos conectores", "projecao de aportes")
QUESTION = "qual e o meu maior ativo?"


def _matcher(embedder: object) -> EmbeddingSimilarityMatcher:
    """Build the matcher over a double, bypassing every AWS argument."""
    return EmbeddingSimilarityMatcher(embedder=embedder)  # type: ignore[arg-type] - structural double


class _StubbedEmbedder(BedrockEmbedder):
    """The real embedder, real cache, with only the transport replaced.

    ``_invoke`` is the single seam between the cache and Bedrock, so counting its calls counts cache
    misses and nothing else.
    """

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)  # type: ignore[arg-type]
        self.invocations: list[tuple[str, tuple[str, ...]]] = []

    def _invoke(self, texts: list[str], purpose: str) -> list[list[float]]:
        self.invocations.append((purpose, tuple(texts)))
        return [[float(len(text)), 1.0, 0.0, 0.0] for text in texts]


# --- the protocol -------------------------------------------------------------------------------


def test_protocol_is_satisfied_by_member_not_by_inheritance():
    """Requirement 7.10: the contract is structural, so a double never inherits from anything."""
    assert isinstance(StubMatcher(), SimilarityMatcher)
    assert isinstance(EmbeddingSimilarityMatcher(embedder=FakeBedrockEmbedder()), SimilarityMatcher)  # type: ignore[arg-type]
    assert not isinstance(object(), SimilarityMatcher)


def test_default_construction_opens_no_client():
    """The client is lazy, so building a matcher performs no I/O — which the guard would catch."""
    matcher = EmbeddingSimilarityMatcher()

    assert matcher._embedder.model_id == "cohere.embed-multilingual-v3"


# --- the asymmetric purpose ---------------------------------------------------------------------


def test_question_is_a_query_and_descriptions_are_documents():
    """Requirements 7.8, 7.9: the question goes in as ``"query"``, each description as ``"document"``."""
    embedder = FakeBedrockEmbedder()

    _matcher(embedder).score(QUESTION, DESCRIPTIONS)

    assert embedder.purposes_for(QUESTION) == ["query"]
    for description in DESCRIPTIONS:
        assert embedder.purposes_for(description) == ["document"]


def test_one_batch_per_side_and_nothing_more():
    """Requirement 7.8: one embedding round per turn, which is one batch per purpose."""
    embedder = FakeBedrockEmbedder()

    _matcher(embedder).score(QUESTION, DESCRIPTIONS)

    assert embedder.batches == [("query", (QUESTION,)), ("document", DESCRIPTIONS)]


def test_shared_client_is_reused_across_matchers():
    """Requirement 17.2: a pre-built embedder is shared, so two matchers share one cache."""
    embedder = FakeBedrockEmbedder()
    first, second = _matcher(embedder), _matcher(embedder)

    assert first._embedder is second._embedder is embedder


# --- the shape of the answer --------------------------------------------------------------------


def test_score_returns_one_value_per_description_in_range_and_in_order():
    """Requirement 7.10: exactly ``len(descriptions)`` values in ``[0.0, 1.0]``, aligned by index."""
    scores = _matcher(FakeBedrockEmbedder()).score(QUESTION, DESCRIPTIONS)

    assert len(scores) == len(DESCRIPTIONS)
    assert all(0.0 <= value <= 1.0 for value in scores)

    reordered = _matcher(FakeBedrockEmbedder()).score(QUESTION, tuple(reversed(DESCRIPTIONS)))
    assert list(reordered) == list(reversed(list(scores)))


def test_identical_description_scores_identically():
    """The score is a function of the pair, so a repeated description repeats its value."""
    descriptions = (DESCRIPTIONS[0], DESCRIPTIONS[1], DESCRIPTIONS[0])

    scores = _matcher(FakeBedrockEmbedder()).score(QUESTION, descriptions)

    assert scores[0] == scores[2]


def test_received_sequence_is_not_mutated():
    """Requirement 7.12: not in element, not in order, not in size."""
    descriptions = list(DESCRIPTIONS)

    _matcher(FakeBedrockEmbedder()).score(QUESTION, descriptions)

    assert descriptions == list(DESCRIPTIONS)


def test_no_descriptions_costs_no_call():
    """Nothing to score is not a failure, and it is certainly not worth an embedding call."""
    embedder = FakeBedrockEmbedder()

    assert list(_matcher(embedder).score(QUESTION, [])) == []
    assert embedder.call_count == 0


# --- vector reuse ------------------------------------------------------------------------------


def test_unchanged_description_costs_nothing_on_the_next_turn():
    """Requirements 7.9, 14.10: the ``(purpose, text)`` cache is what makes reuse free."""
    embedder = _StubbedEmbedder()
    matcher = _matcher(embedder)

    matcher.score(QUESTION, DESCRIPTIONS)
    embedded_first = list(embedder.invocations)

    # Same descriptions, new question: only the question is a miss.
    matcher.score("e aquele outro lancamento?", DESCRIPTIONS)

    assert embedded_first == [("query", (QUESTION,)), ("document", DESCRIPTIONS)]
    assert embedder.invocations[len(embedded_first) :] == [("query", ("e aquele outro lancamento?",))]


def test_only_the_changed_description_is_embedded_again():
    """Requirement 7.9: the shared client is invoked for the question and the changed texts only."""
    embedder = _StubbedEmbedder()
    matcher = _matcher(embedder)

    matcher.score(QUESTION, DESCRIPTIONS)
    embedder.invocations.clear()

    changed = (DESCRIPTIONS[0], "status dos conectores, dois em erro", DESCRIPTIONS[2])
    matcher.score(QUESTION, changed)

    assert embedder.invocations == [("document", (changed[1],))]


def test_question_and_description_do_not_share_a_cache_entry():
    """The key is the pair, not the text: the same string under two purposes is two vectors."""
    embedder = _StubbedEmbedder()
    matcher = _matcher(embedder)

    matcher.score(QUESTION, (QUESTION,))

    assert embedder.invocations == [("query", (QUESTION,)), ("document", (QUESTION,))]


# --- the failure rule --------------------------------------------------------------------------


def test_embedding_error_becomes_an_empty_sequence_with_one_debug_log(caplog: pytest.LogCaptureFixture):
    """Requirement 7.11: never raises, returns empty, logs exactly one debug record with ``exc_info``."""
    embedder = FakeBedrockEmbedder(error=EmbeddingError("bedrock unavailable"))

    with caplog.at_level(logging.DEBUG, logger="strands.vended_plugins.context_graph.matcher"):
        scores = _matcher(embedder).score(QUESTION, DESCRIPTIONS)

    assert list(scores) == []

    records = [record for record in caplog.records if record.name.endswith("context_graph.matcher")]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG
    assert records[0].exc_info is not None


def test_failure_on_the_descriptions_side_degrades_the_same_way():
    """The empty answer is the signal regardless of which side of the asymmetry failed."""

    class _FailsOnDocuments(FakeBedrockEmbedder):
        def embed(self, texts, *, purpose=None):  # type: ignore[no-untyped-def]
            if purpose == "document":
                raise EmbeddingError("document embedding failed")
            return super().embed(texts, purpose=purpose)

    assert list(_matcher(_FailsOnDocuments()).score(QUESTION, DESCRIPTIONS)) == []
