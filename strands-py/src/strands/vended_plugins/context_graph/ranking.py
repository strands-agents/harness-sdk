"""The optional second stage of the selection: reorder the candidates with a rerank model.

**Why a second stage rather than a replacement.** Embedding cosine scores every Card for the price of
one round trip, which is what makes scoring the whole graph affordable. A rerank model scores far
better and costs about ten times as much — measured in this package at ~2.6s per call against the
embedding path's ~262ms. So the shape is the standard cascade: embed everything to get candidates,
rerank only the candidates.

**Why it is worth the round trip at all, and only once selection exists.** Measured over 133 scored
Cards, the default matcher answered with a minimum note of 0.346 and a median of 0.563 — the whole
conversation inside a band about 0.4 wide. That is the signature of a score that ranks but does not
discriminate, and it is why ``collapse_floor`` had to move from 0.15 to 0.45 before the bottom rung
was reachable at all. While the note only decided *size*, being wrong cost tokens and a sharper score
was not worth ten times the latency. Once the note decides *which Cards the call addresses*, being
wrong costs the answer.

**Failure is a skipped step, never a failed call.** The ``Reranker`` protocol of this package raises
by contract — deliberately, because in the offloader a partial relevance list would be worse than an
error. On the critical path of a model call that contract cannot be honoured upward: the agent must
answer. So anything this module is handed may raise, and the answer is always the order the embedding
already produced, plus one debug log. The reranking is an improvement to the ranking, so the absence
of it is the ranking.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Coroutine, Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Any, cast

__all__ = ["rerank"]

logger = logging.getLogger(__name__)


def rerank(question: str, titles: Sequence[str], documents: Sequence[str], reranker: Any) -> tuple[str, ...]:
    """Reorder ``titles`` by the reranker's relevance of ``documents`` to ``question``.

    Args:
        question: The turn's question.
        titles: The candidate titles, in the order the embedding ranked them. Not mutated.
        documents: The description of each candidate, aligned by index with ``titles``.
        reranker: Object exposing ``score(query, chunks)``, sync or async. May raise.

    Returns:
        The titles in descending relevance, or ``titles`` unchanged when the reranker was unusable —
        which covers raising, timing out, answering the wrong length, and answering non-numerically.
    """
    if len(titles) < 2 or len(titles) != len(documents):
        # Nothing to reorder, or a caller that mispaired the two. Either way the embedding order is
        # already the answer, and reranking one candidate would spend 2.6s to confirm it.
        return tuple(titles)

    try:
        scores = _score(question, list(documents), reranker)
        if len(scores) != len(titles):
            raise ValueError(f"rerank score count=<{len(scores)}> | expected=<{len(titles)}>")
        ranked = sorted(
            range(len(titles)),
            # The embedding position breaks ties, so an indifferent reranker leaves the order it was
            # given rather than permuting it arbitrarily.
            key=lambda index: (-float(scores[index]), index),
        )
        return tuple(titles[index] for index in ranked)
    except Exception:
        logger.debug(
            "graph reranking unavailable for %d candidate(s) | keeping the embedding order",
            len(titles),
            exc_info=True,
        )
        return tuple(titles)


def _score(question: str, documents: list[str], reranker: Any) -> Sequence[float]:
    """Call ``reranker.score``, awaiting it on a worker thread when it is a coroutine.

    The reranker this package ships is async, and the turn choice runs in a **synchronous** hook on
    the critical path — inside the agent's own running loop, so neither ``await`` nor ``asyncio.run``
    is available here. A worker thread with a loop of its own is, and the call it wraps is a network
    round trip measured in seconds, so the handoff is not the cost.

    Args:
        question: The turn's question.
        documents: The candidate descriptions. Handed over as our own list.
        reranker: Object exposing ``score(query, chunks)``.

    Returns:
        One score per document.

    Raises:
        Exception: Whatever the reranker raises, for :func:`rerank` to turn into a skipped step.
    """
    result = reranker.score(question, documents)
    if not inspect.isawaitable(result):
        return cast("Sequence[float]", result)

    coroutine = cast("Coroutine[Any, Any, Sequence[float]]", result)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="context-graph-rerank") as pool:
        return pool.submit(asyncio.run, coroutine).result()
