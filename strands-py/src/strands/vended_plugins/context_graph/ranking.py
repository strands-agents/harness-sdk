"""The optional second stage of the selection: reorder the candidates with a rerank model.

A cascade over the embedding pass, because a rerank call costs roughly ten times the latency of the embedding path:
embedding scores every Card in one round trip, the reranker scores only the candidates it selected.

Failure is a skipped step, never a failed call. The package's ``Reranker`` protocol raises by contract, and on the
critical path of a model call that contract cannot be honoured upward, since the agent must answer. So anything handed
to this module may raise, and the answer is then the order the embedding already produced plus one debug log.
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
        The titles in descending relevance, or ``titles`` unchanged when the reranker was unusable: raising, timing out,
        answering the wrong length, or answering non-numerically.
    """
    if len(titles) < 2 or len(titles) != len(documents):
        # Nothing to reorder, or a caller that mispaired the two: the embedding order is the answer.
        return tuple(titles)

    try:
        scores = _score(question, list(documents), reranker)
        if len(scores) != len(titles):
            raise ValueError(f"rerank score count=<{len(scores)}> | expected=<{len(titles)}>")
        ranked = sorted(
            range(len(titles)),
            # The embedding position breaks ties, so an indifferent reranker leaves the order it was given rather than
            # permuting it arbitrarily.
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

    The turn choice runs in a synchronous hook inside the agent's own running loop, so neither ``await`` nor
    ``asyncio.run`` is available here. A worker thread with a loop of its own is.

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
