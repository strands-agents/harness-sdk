"""Relevance scoring for offloaded tool result chunks.

This module defines the scoring contract used by the ``offload:relevance``
strategy (:class:`~strands._context_manager.strategies.offload.relevance.RelevanceStrategy`).
The contract is intentionally narrow: given a query and a list of chunk texts,
return one score per chunk. Anything that prevents that (transport failure,
timeout, malformed response) surfaces as :class:`RerankerError`, so the caller
has a single exception type to catch when falling back to the positional
preview.

Two sibling plugins also score text against text, and the three protocols are deliberately
not one:

- ``Reranker`` here is stateless, scores the chunks of a single tool result, and needs a true
  ``[0.0, 1.0]`` because ``relevance_threshold`` reads it absolutely. It is the only one of the
  three that *must* raise instead of degrading, which is why
  :meth:`~BedrockReranker.score` refuses to clamp an out-of-range score: a wrong score here
  drops the passage the question needed, and a wrong answer is worse than a positional preview.
- :class:`~strands.vended_plugins.progressive_tool_disclosure.index.ToolIndex` has a build
  phase, because tool specifications are static, and its scores carry no absolute meaning
  since selection is ``top_k``.

A scorer whose miss only costs tokens can clamp an out-of-range score and degrade quietly;
this one refuses to, because its miss drops the passage the question needed. Same question,
opposite answer, each correct for its own cost of being wrong.

The embedding round trip and its cache live in :mod:`strands.vended_plugins._embedding`. This
module does not use it: rerank is a single call that returns scores directly, with no vectors
to cache.

Example:
    ```python
    class FakeReranker:
        max_sources_per_query = 100

        async def score(self, query: str, chunks: list[str]) -> list[float]:
            if not query.strip():
                raise RerankerError("query must not be empty")
            return [1.0 if query in chunk else 0.0 for chunk in chunks]
    ```
"""

import asyncio
import math
from typing import Any, Protocol, runtime_checkable

import boto3
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import BotoCoreError, ClientError

__all__ = ["BedrockReranker", "Reranker", "RerankerError"]

_DEFAULT_MODEL_ID = "amazon.rerank-v1:0"
_DEFAULT_TIMEOUT_SECONDS = 10
_MAX_SOURCES_PER_QUERY = 100


class RerankerError(Exception):
    """Raised when relevance scoring is unavailable or its result is unusable.

    This is the only exception type a :class:`Reranker` implementation is
    allowed to raise from :meth:`Reranker.score`. Callers treat it as a signal
    to fall back to the positional preview, never as a fatal error.
    """


@runtime_checkable
class Reranker(Protocol):
    """Scores text chunks by relevance to a query.

    Implement this protocol to plug a custom scorer into the ``"relevance"``
    preview strategy. The SDK ships :class:`BedrockReranker`, built on the
    Bedrock ``rerank`` operation.

    Contract:
        Every implementation must honor all of the following. The selection
        step pairs scores with chunks by index and interprets them against a
        fixed ``[0.0, 1.0]`` scale, so violations make the preview meaningless.

        * One score per chunk: ``len(result) == len(chunks)``, and
          ``result[i]`` is the score of ``chunks[i]``.
        * Order preserved: scores come back in the order the chunks were
          received, never sorted by score.
        * Range: each score is a finite number within the closed interval
          ``[0.0, 1.0]``. Both ``0.0`` and ``1.0`` are valid.
        * No mutation: the received list is returned untouched in size, order
          and element contents.
        * Empty input: an empty chunk list yields an empty score list, without
          touching the underlying scoring dependency.
        * Empty query: a query that is empty or whitespace-only raises
          :class:`RerankerError`, without touching the underlying scoring
          dependency.
        * All-or-nothing: on failure, raise :class:`RerankerError` rather than
          returning a partial score list.

    Attributes:
        max_sources_per_query: Maximum number of chunks submitted to the
            underlying scoring dependency per call, an integer greater than or
            equal to 1. This bounds batch size, not the size of the list
            :meth:`score` accepts: larger lists are paginated internally.
    """

    max_sources_per_query: int

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        """Score each chunk by relevance to the query.

        Args:
            query: Scoring query. Must contain at least one non-whitespace
                character.
            chunks: Chunk texts to score, in chunk index order. Not mutated.

        Returns:
            One score in ``[0.0, 1.0]`` per chunk, aligned by index with
            ``chunks``. Empty when ``chunks`` is empty.

        Raises:
            RerankerError: If ``query`` is empty or whitespace-only, if the
                scoring dependency fails or times out, or if the response does
                not yield one valid score per chunk.
        """
        ...


class BedrockReranker:
    """Score chunks with the Amazon Bedrock ``rerank`` operation.

    Uses the ``bedrock-agent-runtime`` client. AWS configuration follows the
    same pattern as
    :class:`~strands.vended_plugins.context_offloader.storage.S3Storage`:
    an optional ``boto_session``, ``region_name`` honored only when no session
    is given, and ``user_agent_extra="strands-agents"`` merged into the client
    config.

    Timeouts default to 10 seconds for both connect and read. A rerank call
    that outlives them fails fast so the caller can fall back to the positional
    preview instead of stalling the agent loop. Pass ``boto_client_config``
    with explicit timeouts to override them.

    Args:
        model_id: Reranking model identifier, or a full model ARN. A bare
            identifier is resolved to a foundation-model ARN in the client's
            region.
        boto_session: Optional boto3 session. If not provided, a new session is
            created using the given ``region_name``.
        boto_client_config: Optional botocore client configuration. Values set
            here win over the defaults applied by this class.
        region_name: AWS region. Used only when ``boto_session`` is not
            provided.

    Example:
        ```python
        from strands._context_manager.methods.reranker import BedrockReranker

        reranker = BedrockReranker(region_name="us-west-2")
        ```
    """

    max_sources_per_query: int = _MAX_SOURCES_PER_QUERY
    """Maximum number of chunks submitted per ``rerank`` call."""

    def __init__(
        self,
        model_id: str = _DEFAULT_MODEL_ID,
        *,
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
    ) -> None:
        """Initialize the Bedrock-backed reranker.

        Args:
            model_id: Reranking model identifier, or a full model ARN.
            boto_session: Optional boto3 session. If not provided, a new
                session is created using the given ``region_name``.
            boto_client_config: Optional botocore client configuration. Values
                set here win over the defaults applied by this class.
            region_name: AWS region. Used only when ``boto_session`` is not
                provided.
        """
        session = boto_session or boto3.Session(region_name=region_name)

        # Defaults first, caller config second: botocore's merge lets the
        # right-hand side win for every option explicitly set on it.
        client_config = BotocoreConfig(
            connect_timeout=_DEFAULT_TIMEOUT_SECONDS,
            read_timeout=_DEFAULT_TIMEOUT_SECONDS,
        )
        user_agent_extra = "strands-agents"
        if boto_client_config:
            existing_user_agent = getattr(boto_client_config, "user_agent_extra", None)
            if existing_user_agent:
                user_agent_extra = f"{existing_user_agent} strands-agents"
            client_config = client_config.merge(boto_client_config)
        # Applied last so a caller-supplied user agent extends ours, never replaces it.
        client_config = client_config.merge(BotocoreConfig(user_agent_extra=user_agent_extra))

        self._client: Any = session.client(service_name="bedrock-agent-runtime", config=client_config)
        self._model_arn = (
            model_id
            if model_id.startswith("arn:")
            else f"arn:aws:bedrock:{self._client.meta.region_name}::foundation-model/{model_id}"
        )

    async def score(self, query: str, chunks: list[str]) -> list[float]:
        """Score each chunk by relevance to the query.

        Chunks are paginated into batches of at most
        :attr:`max_sources_per_query`, in index order, each chunk landing in
        exactly one batch. Bedrock returns results sorted by score, so each
        result is remapped to the index of the chunk it refers to; an index
        without a result keeps ``0.0``.

        Each ``rerank`` call runs in a worker thread: the boto3 client is
        synchronous and rerank pays inference latency, which would otherwise
        block the agent's event loop.

        Args:
            query: Scoring query. Must contain at least one non-whitespace
                character.
            chunks: Chunk texts to score, in chunk index order. Not mutated.

        Returns:
            One score in ``[0.0, 1.0]`` per chunk, aligned by index with
            ``chunks``. Empty when ``chunks`` is empty.

        Raises:
            RerankerError: If ``query`` is empty or whitespace-only, or if a
                ``rerank`` call fails or returns an unusable response.
        """
        if not query.strip():
            raise RerankerError("query must contain at least one non-whitespace character")

        if not chunks:
            return []

        scores = [0.0] * len(chunks)
        offset = 0

        while offset < len(chunks):
            batch = chunks[offset : offset + self.max_sources_per_query]

            # Any batch failure aborts the whole call: a partial score list would be
            # silently misread as "these chunks are irrelevant".
            try:
                response = await asyncio.to_thread(self._rerank, query, batch)
            except (ClientError, BotoCoreError) as error:
                # ReadTimeoutError and ConnectTimeoutError are BotoCoreError subclasses,
                # so the configured timeouts land here too.
                raise RerankerError(f"rerank call failed: {error}") from error
            except TimeoutError as error:
                raise RerankerError(f"rerank call timed out: {error}") from error

            if not isinstance(response, dict) or "results" not in response:
                raise RerankerError("malformed rerank response: missing 'results'")

            for item in response["results"]:
                local_index = _validated_index(item, len(batch))
                scores[offset + local_index] = _validated_score(item)

            offset += len(batch)

        return scores

    def _rerank(self, query: str, batch: list[str]) -> dict[str, Any]:
        """Invoke the Bedrock ``rerank`` operation for a single batch.

        Args:
            query: Scoring query.
            batch: Chunk texts of this batch, at most
                :attr:`max_sources_per_query` items.

        Returns:
            The raw ``rerank`` response.
        """
        response: dict[str, Any] = self._client.rerank(
            queries=[{"type": "TEXT", "textQuery": {"text": query}}],
            sources=[
                {
                    "type": "INLINE",
                    "inlineDocumentSource": {"type": "TEXT", "textDocument": {"text": chunk}},
                }
                for chunk in batch
            ],
            rerankingConfiguration={
                "type": "BEDROCK_RERANKING_MODEL",
                "bedrockRerankingConfiguration": {
                    # Always the full batch: selection by threshold and budget is
                    # local, and letting the service truncate would hide whether a
                    # chunk was rejected or merely omitted.
                    "numberOfResults": len(batch),
                    "modelConfiguration": {"modelArn": self._model_arn},
                },
            },
        )
        return response


def _validated_index(item: Any, batch_size: int) -> int:
    """Extract the batch-local chunk index of a rerank result.

    Args:
        item: A single entry of the ``results`` list.
        batch_size: Number of chunks submitted in this batch.

    Returns:
        The chunk index, within ``[0, batch_size)``.

    Raises:
        RerankerError: If the index is absent, not an integer, or outside the
            batch range. An out-of-range index means the response cannot be
            aligned with the chunks, so there is nothing safe to keep.
    """
    if not isinstance(item, dict):
        raise RerankerError(f"malformed rerank result: expected a mapping, got {type(item).__name__}")

    index = item.get("index")
    if not isinstance(index, int) or isinstance(index, bool):
        raise RerankerError(f"malformed rerank result: index must be an integer, got {index!r}")

    if not 0 <= index < batch_size:
        raise RerankerError(f"rerank result index {index} is outside the batch range [0, {batch_size})")

    return index


def _validated_score(item: Any) -> float:
    """Extract the relevance score of a rerank result.

    Args:
        item: A single entry of the ``results`` list.

    Returns:
        The score, a finite float within ``[0.0, 1.0]``.

    Raises:
        RerankerError: If the score is absent, not a finite real number, or
            outside ``[0.0, 1.0]``. Clamping is deliberately avoided: a score
            off the expected scale means the response is not what the contract
            describes, and the caller is better served by the positional
            preview than by an invented value.
    """
    score = item.get("relevanceScore")
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
        raise RerankerError(f"malformed rerank result: relevanceScore must be a finite number, got {score!r}")

    if not 0.0 <= score <= 1.0:
        raise RerankerError(f"rerank result relevanceScore {score!r} is outside [0.0, 1.0]")

    return float(score)
