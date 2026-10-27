"""The optional rerank stage, and the one rule that matters about it: failure is a skipped step.

The ``Reranker`` protocol of this package raises by contract, because in the offloader a partial
relevance list would be worse than an error. On the critical path of a model call that contract cannot
be honoured upward — the agent has to answer — so every failure here has exactly one outcome: the
order the embedding already produced.

The doubles are async, like the reranker the package ships, because the awaiting is the part most
likely to be wrong: the turn choice is a **synchronous** hook inside the agent's running loop, where
neither ``await`` nor ``asyncio.run`` is available.
"""

import asyncio

import pytest

from strands.vended_plugins.context_graph.ranking import rerank


class AsyncReranker:
    """Scores from a canned map, the way the shipped reranker's interface looks."""

    def __init__(self, scores):
        self.scores = scores
        self.calls = []

    async def score(self, query, chunks):
        self.calls.append((query, list(chunks)))
        await asyncio.sleep(0)
        return [self.scores[chunk] for chunk in chunks]


class SyncReranker:
    """A synchronous implementation, which the protocol also allows."""

    def __init__(self, scores):
        self.scores = scores

    def score(self, query, chunks):
        return [self.scores[chunk] for chunk in chunks]


class Raising:
    """The contract's own failure mode."""

    def __init__(self, error):
        self.error = error

    async def score(self, query, chunks):
        raise self.error


TITLES = ("a", "b", "c")
DOCUMENTS = ("doc a", "doc b", "doc c")


def test_the_candidates_come_back_in_descending_relevance():
    reranker = AsyncReranker({"doc a": 0.1, "doc b": 0.9, "doc c": 0.5})

    assert rerank("q", TITLES, DOCUMENTS, reranker) == ("b", "c", "a")


def test_a_synchronous_reranker_is_accepted_too():
    reranker = SyncReranker({"doc a": 0.9, "doc b": 0.1, "doc c": 0.5})

    assert rerank("q", TITLES, DOCUMENTS, reranker) == ("a", "c", "b")


def test_the_documents_reach_the_reranker_paired_with_their_titles():
    reranker = AsyncReranker({document: 0.5 for document in DOCUMENTS})

    rerank("the question", TITLES, DOCUMENTS, reranker)

    assert reranker.calls == [("the question", list(DOCUMENTS))]


def test_an_indifferent_reranker_leaves_the_order_it_was_given():
    """The embedding position breaks ties, so a flat answer is not a permutation."""
    reranker = AsyncReranker({document: 0.5 for document in DOCUMENTS})

    assert rerank("q", TITLES, DOCUMENTS, reranker) == TITLES


@pytest.mark.parametrize(
    "reranker",
    [
        Raising(RuntimeError("upstream refused")),
        Raising(TimeoutError()),
        AsyncReranker({}),  # KeyError inside the double: a malformed answer
    ],
    ids=["raises", "times-out", "answers-malformed"],
)
def test_any_failure_keeps_the_embedding_order(reranker):
    assert rerank("q", TITLES, DOCUMENTS, reranker) == TITLES


def test_a_wrong_score_count_keeps_the_embedding_order():
    class TooFew:
        async def score(self, query, chunks):
            return [0.9]

    assert rerank("q", TITLES, DOCUMENTS, TooFew()) == TITLES


def test_a_failure_logs_once_at_debug_with_a_traceback(caplog):
    """One record, and a traceback in it: a skipped step has to be findable without being noisy."""
    with caplog.at_level("DEBUG", logger="strands.vended_plugins.context_graph.ranking"):
        rerank("q", TITLES, DOCUMENTS, Raising(RuntimeError("nope")))

    records = [record for record in caplog.records if record.exc_info]
    assert len(records) == 1
    assert records[0].levelname == "DEBUG"


def test_a_single_candidate_is_not_reranked():
    """Reranking one candidate spends a round trip to confirm an order that has no alternative."""

    class Unused:
        async def score(self, query, chunks):  # pragma: no cover - must not be reached
            raise AssertionError("the reranker was called for a single candidate")

    assert rerank("q", ("only",), ("doc",), Unused()) == ("only",)


def test_mispaired_titles_and_documents_are_not_reranked():
    class Unused:
        async def score(self, query, chunks):  # pragma: no cover - must not be reached
            raise AssertionError("the reranker was called on a mispaired input")

    assert rerank("q", TITLES, ("one", "two"), Unused()) == TITLES


def test_the_received_sequences_are_not_mutated():
    titles, documents = list(TITLES), list(DOCUMENTS)
    reranker = AsyncReranker({"doc a": 0.1, "doc b": 0.9, "doc c": 0.5})

    rerank("q", titles, documents, reranker)

    assert titles == list(TITLES)
    assert documents == list(DOCUMENTS)
