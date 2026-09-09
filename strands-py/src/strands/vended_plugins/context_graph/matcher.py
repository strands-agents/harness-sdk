"""The fourth scoring protocol: question against N Cards descriptions.

The embedding round trip and the cache that makes it affordable live in
:mod:`strands.vended_plugins._embedding` and are reused verbatim. What is new here is the protocol
and the adapter.

**Asymmetric by construction.** The short side is a question and the long side is a description of
up to ``description_tokens``, which asks for ``"query"`` against ``"document"``. Passing
``"clustering"`` where ``"query"`` was right does not fail: it silently returns a worse vector. That
is why the purpose is a parameter and why the cache is keyed by the ``(purpose, text)`` pair rather
than by text alone.

Unlike the ``Reranker`` protocol, which raises by contract, :class:`SimilarityMatcher` reports
unavailability by returning an empty sequence.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol, runtime_checkable

import boto3
from botocore.config import Config as BotocoreConfig

from .._embedding import BedrockEmbedder, EmbeddingError, cosine_similarity

__all__ = ["EmbeddingSimilarityMatcher", "SimilarityMatcher"]

logger = logging.getLogger(__name__)

_DEFAULT_MODEL_ID = "cohere.embed-multilingual-v3"
"""Multilingual by default: an English-only model scores two renderings of one subject as unrelated."""


@runtime_checkable
class SimilarityMatcher(Protocol):
    """Scores how strongly the turn's question relates to each Card's description."""

    def score(self, question: str, descriptions: Sequence[str]) -> Sequence[float]:
        """Return one similarity per description received, in the same order.

        Args:
            question: The turn's question. Embedded under purpose ``"query"``.
            descriptions: The Cards' descriptions. Embedded under purpose ``"document"``. Must
                not be mutated, reordered or resized.

        Returns:
            Exactly ``len(descriptions)`` values, each in ``[0.0, 1.0]``. An empty sequence
            signals unavailability, and the caller degrades to full content everywhere.
            Implementations must not raise.
        """
        ...


class EmbeddingSimilarityMatcher:
    """Default implementation: ``BedrockEmbedder`` with asymmetric purpose and a vector cache.

    One embedding round per turn — the question under ``"query"``, the descriptions under
    ``"document"`` — and within it only the texts not already cached reach Bedrock. The cache is
    keyed by the ``(purpose, text)`` pair, so an unchanged description costs nothing next turn.

    Never raises. :class:`~strands.vended_plugins._embedding.EmbeddingError` becomes an empty
    sequence plus one debug-level log carrying ``exc_info``. A caller whose correctness depends on
    the score should use the embedder directly and let the error through.

    Args:
        model_id: Bedrock embedding model. Defaults to a multilingual model.
        boto_session: Optional boto3 session. The client is built lazily on first use, so
            constructing a matcher performs no I/O.
        boto_client_config: Optional botocore client configuration.
        region_name: Region, used only when no session is supplied.
        embedder: Pre-built embedder, which takes precedence over the arguments above. Lets an
            application share one client and one cache across matchers.
    """

    def __init__(
        self,
        model_id: str = _DEFAULT_MODEL_ID,
        *,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
        embedder: BedrockEmbedder | None = None,
    ) -> None:
        """Initialize the matcher without opening a client.

        Args:
            model_id: Bedrock embedding model. Defaults to a multilingual model.
            boto_session: Optional boto3 session.
            boto_client_config: Optional botocore client configuration.
            region_name: Region, used only when no session is supplied.
            embedder: Pre-built embedder, which takes precedence over the other arguments.
        """
        # "document" as the construction default; the question overrides it per call.
        self._embedder = embedder or BedrockEmbedder(
            model_id,
            purpose="document",
            boto_session=boto_session,
            boto_client_config=boto_client_config,
            region_name=region_name,
        )

    def score(self, question: str, descriptions: Sequence[str]) -> Sequence[float]:
        """Return the cosine similarity of ``question`` against each description.

        Args:
            question: The turn's question, embedded under ``"query"``.
            descriptions: The Cards' descriptions, embedded under ``"document"``. Read only:
                neither its elements, its order nor its size is touched.

        Returns:
            Exactly ``len(descriptions)`` values in ``[0.0, 1.0]``, aligned by index. Empty when
            embedding is unavailable, which the caller reads as "score nothing, send everything".
        """
        if not descriptions:
            return []

        # Copied before crossing the boundary: the caller's sequence is not ours to hand out.
        texts = list(descriptions)

        try:
            question_vector, description_vectors = self._embed_both(question, texts)
        except EmbeddingError:
            logger.debug("graph similarity embedding failed for %d description(s)", len(texts), exc_info=True)
            return []

        # cosine_similarity already clamps to [0.0, 1.0], the scale the two thresholds read.
        return [cosine_similarity(question_vector, vector) for vector in description_vectors]

    def vectors(self, descriptions: Sequence[str]) -> Sequence[Sequence[float]]:
        """Return the document vector of each description, for the caller's own cache.

        Free after :meth:`score`: the embedder caches by ``(purpose, text)``, so the vectors this
        returns are the ones already computed for the note and no call goes out. The ``similar`` edge
        between two Cards is measured from that cache and never from a remote call, so a caller that
        never fills it can create no such edge.

        Args:
            descriptions: The Cards' descriptions. Read only.

        Returns:
            One vector per description, in order. Empty when embedding is unavailable, which leaves
            the cache as it was and the edge unmeasurable rather than asserted absent.
        """
        if not descriptions:
            return []
        try:
            return self._embedder.embed(list(descriptions), purpose="document")
        except EmbeddingError:
            logger.debug("graph description vectors unavailable for %d text(s)", len(descriptions), exc_info=True)
            return []

    def _embed_both(self, question: str, texts: list[str]) -> tuple[list[float], list[list[float]]]:
        """Embed the question and the descriptions, overlapping the two round trips.

        Two calls and not one, because the asymmetry forces it: the question goes under ``"query"``
        and the descriptions under ``"document"``, and one Cohere call carries one ``input_type``.
        The two are overlapped rather than sequential.

        Threads rather than the event loop, because :meth:`score` is called from a synchronous hook
        on the critical path and cannot await. The client is materialized first, on this thread: a
        botocore client is safe to *call* from several threads but is built lazily, and two threads
        racing to build it is the one hazard here.

        Args:
            question: The turn's question.
            texts: The descriptions, already copied.

        Returns:
            The question's vector, and one vector per description in order.

        Raises:
            EmbeddingError: Propagated from either call, for :meth:`score` to turn into an empty
                sequence.
        """
        # Materialized here so neither worker has to. ``boto3.Session.client`` is not safe to call
        # from two threads at once, and the real embedder builds its client on first use — so the
        # first scored turn is exactly where that race would live. Read through ``getattr`` because
        # the embedder is duck-typed: an in-memory double has no client to build and needs none.
        getattr(self._embedder, "client", None)

        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="context-graph-embed") as pool:
            pending_question = pool.submit(self._embedder.embed, [question], purpose="query")
            pending_descriptions = pool.submit(self._embedder.embed, texts, purpose="document")
            # The question first: it is the smaller call, so a failure of it is reported without
            # waiting on the larger one.
            (question_vector,) = pending_question.result()
            return question_vector, pending_descriptions.result()
