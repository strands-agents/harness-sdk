"""Private Bedrock text-embedding client with an in-process cache.

Several vended plugins score text against text, and each does it differently on purpose: the
tool index counts terms, the offloader's reranker calls a rerank model, and the graph matches
Cards by embedding similarity. Those scoring protocols stay separate — their failure
semantics and score scales are deliberately different, and collapsing them would make one of
them wrong. See :mod:`strands.vended_plugins.context_offloader.reranker` and
:mod:`strands.vended_plugins.progressive_tool_disclosure.index`.

What *was* duplicated is the piece below: the embedding round trip, plus the cache that makes
it affordable. This module is that piece and nothing else. It holds no threshold, no ranking
and no policy — callers keep those, because the right answer differs per caller.

**Purpose is a parameter, not a constant.** An embedding model is not asked the same question
by every caller. Comparing two topic names is *symmetric*: both sides are the same kind of
short string, and both are embedded the same way. Comparing a question against a summary is
*asymmetric*: the question is a query and the summary is a document, and Cohere's models
expect to be told which is which. Passing ``"clustering"`` where ``"query"`` was meant does
not fail — it silently returns a worse vector. Hence
:class:`EmbeddingPurpose` and the per-call override on :meth:`BedrockEmbedder.embed`.

**Failure is raised, not swallowed.** :class:`EmbeddingError` surfaces every failure so each
caller can apply its own contract: the topic matcher must never raise and degrades to
comparing names by equality, while a caller whose correctness depends on the score should let
the error through. A helper that swallowed would force the first behavior on everyone.
"""

import asyncio
import json
import logging
from collections import OrderedDict
from collections.abc import Sequence
from typing import Any, Literal

import boto3
from botocore.config import Config as BotocoreConfig
from botocore.exceptions import BotoCoreError, ClientError

__all__ = ["BedrockEmbedder", "EmbeddingError", "EmbeddingPurpose", "cosine_similarity"]

logger = logging.getLogger(__name__)

EmbeddingPurpose = Literal["clustering", "query", "document"]
"""How the embedded text will be compared, which changes the vector the model returns.

- ``"clustering"``: symmetric comparison, both sides the same kind of text. Comparing two
  topic names against each other.
- ``"query"``: the short side of an asymmetric comparison — the question being asked.
- ``"document"``: the long side of an asymmetric comparison — the text being searched.

A ``"query"`` vector is meant to be compared against ``"document"`` vectors, not against
other ``"query"`` vectors. Models without a notion of input type ignore this; see
:class:`BedrockEmbedder`.
"""

_PURPOSES: tuple[str, ...] = ("clustering", "query", "document")
"""Accepted values of ``purpose``, case-sensitive."""

_COHERE_INPUT_TYPES: dict[str, str] = {
    "clustering": "clustering",
    "query": "search_query",
    "document": "search_document",
}
"""Maps a purpose onto the ``input_type`` Cohere's embedding models expect."""

_DEFAULT_MODEL_ID = "cohere.embed-multilingual-v3"
"""Multilingual by default.

The failures this was built for include an English and a Portuguese rendering of the same
subject, and an English-only model scores those two as unrelated.
"""

_DEFAULT_TIMEOUT_SECONDS = 10
"""Connect and read timeout, matching ``BedrockReranker``.

An embedding call that outlives this fails fast so the caller can fall back rather than stall
the agent.
"""

_DEFAULT_CACHE_SIZE = 512
"""Distinct ``(purpose, text)`` pairs kept per instance.

Bounded rather than unbounded: callers that embed a growing set of summaries would otherwise
hold every vector produced in a long session. Topic names repeat heavily, so even a small
cache absorbs most of the traffic.
"""

_COHERE_MAX_BATCH = 96
"""Texts per Cohere embed call. Longer inputs are paged."""


class EmbeddingError(Exception):
    """Raised when embedding is unavailable or its response is unusable.

    The only exception :meth:`BedrockEmbedder.embed` raises for a transport failure, a
    timeout or a malformed response, so a caller has a single type to catch when deciding how
    to degrade.
    """


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    """Return the cosine similarity of two vectors, clamped to ``[0.0, 1.0]``.

    Negative similarity is clamped rather than preserved: callers express thresholds on a
    zero-to-one scale, and for that decision "points the other way" and "unrelated" are the
    same answer.

    Args:
        left: First vector.
        right: Second vector.

    Returns:
        Similarity in ``[0.0, 1.0]``. Zero when the lengths differ or either vector has zero
        magnitude, so a degenerate input reads as "unrelated" instead of raising.
    """
    if len(left) != len(right):
        return 0.0

    dot: float = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm: float = sum(a * a for a in left) ** 0.5
    right_norm: float = sum(b * b for b in right) ** 0.5
    if not left_norm or not right_norm:
        return 0.0

    return max(0.0, min(1.0, dot / (left_norm * right_norm)))


def _validate_purpose(purpose: str, *, argument: str) -> None:
    """Reject a purpose outside :data:`EmbeddingPurpose`.

    Args:
        purpose: Value to check.
        argument: Parameter name to name in the error message.

    Raises:
        ValueError: If ``purpose`` is not one of ``"clustering"``, ``"query"`` or
            ``"document"``.
    """
    if purpose not in _PURPOSES:
        accepted = ", ".join(repr(item) for item in _PURPOSES)
        raise ValueError(f"{argument} must be one of {accepted}, got {purpose!r}")


class BedrockEmbedder:
    """Embed text with Amazon Bedrock, caching by purpose and text.

    AWS configuration follows the same pattern as
    :class:`~strands.vended_plugins.context_offloader.reranker.BedrockReranker`: an optional
    ``boto_session``, ``region_name`` honored only when no session is given, and
    ``user_agent_extra="strands-agents"`` merged into the client config. The client is built
    lazily on first use, so constructing an embedder performs no I/O and a caller that never
    embeds never opens a connection.

    Two model families are handled. Cohere's embedding models take a batch and an
    ``input_type``, so :data:`EmbeddingPurpose` maps onto that field and a batch is one call.
    Titan's take a single text and have no notion of input type, so purpose is accepted and
    ignored, and a batch becomes one call per text — which makes Cohere the better choice
    whenever purposes are mixed.

    The cache key is ``(purpose, text)``, not ``text``. The same string embedded as a query
    and as a document yields different vectors, and keying on text alone would return one
    where the other was asked for.

    Args:
        model_id: Bedrock embedding model. Cohere and Titan embedding families are handled.
        purpose: Default purpose for :meth:`embed`, overridable per call.
        boto_session: Optional boto3 session. If not provided, one is created on first use
            with ``region_name``.
        boto_client_config: Optional botocore client configuration. Values set here win over
            the defaults applied by this class.
        region_name: AWS region. Used only when ``boto_session`` is not provided.
        cache_size: Distinct ``(purpose, text)`` pairs to keep, or ``None`` for no bound.

    Raises:
        ValueError: If ``purpose`` is not a valid :data:`EmbeddingPurpose`, or if
            ``cache_size`` is neither ``None`` nor an integer greater than zero.

    Example:
        ```python
        from strands.vended_plugins._embedding import BedrockEmbedder, cosine_similarity

        # Symmetric: comparing two names of the same kind.
        embedder = BedrockEmbedder(purpose="clustering")
        left, right = embedder.embed(["btg-positions", "btg-investment-positions"])
        score = cosine_similarity(left, right)

        # Asymmetric: a question against summaries, one purpose each.
        (question,) = await embedder.embed_async(["which asset is my largest?"], purpose="query")
        summaries = await embedder.embed_async(front_texts, purpose="document")
        ranked = sorted(summaries, key=lambda vector: -cosine_similarity(question, vector))
        ```
    """

    def __init__(
        self,
        model_id: str = _DEFAULT_MODEL_ID,
        *,
        purpose: EmbeddingPurpose = "clustering",
        boto_session: boto3.Session | None = None,
        boto_client_config: BotocoreConfig | None = None,
        region_name: str | None = None,
        cache_size: int | None = _DEFAULT_CACHE_SIZE,
    ) -> None:
        """Initialize the embedder without opening a client.

        Args:
            model_id: Bedrock embedding model.
            purpose: Default purpose for :meth:`embed`, overridable per call.
            boto_session: Optional boto3 session.
            boto_client_config: Optional botocore client configuration.
            region_name: AWS region. Used only when ``boto_session`` is not provided.
            cache_size: Distinct ``(purpose, text)`` pairs to keep, or ``None`` for no bound.

        Raises:
            ValueError: If ``purpose`` is invalid, or ``cache_size`` is neither ``None`` nor a
                positive integer.
        """
        _validate_purpose(purpose, argument="purpose")

        if cache_size is not None and (
            isinstance(cache_size, bool) or not isinstance(cache_size, int) or cache_size < 1
        ):
            raise ValueError(f"cache_size must be None or an integer greater than or equal to 1, got {cache_size!r}")

        self._model_id = model_id
        self._purpose: EmbeddingPurpose = purpose
        self._session = boto_session
        self._client_config = boto_client_config
        self._region_name = region_name
        self._cache_size = cache_size
        self._client: Any = None
        # Insertion-ordered so the oldest key is the one evicted, and a hit moves to the end.
        self._cache: OrderedDict[tuple[str, str], list[float]] = OrderedDict()

    @property
    def model_id(self) -> str:
        """Bedrock model this embedder calls."""
        return self._model_id

    def _ensure_client(self) -> Any:
        """Return the Bedrock runtime client, building it on first use.

        Returns:
            The ``bedrock-runtime`` client.
        """
        if self._client is not None:
            return self._client

        session = self._session or boto3.Session(region_name=self._region_name)

        # Defaults first, caller config second: botocore's merge lets the right-hand side win
        # for every option explicitly set on it.
        client_config = BotocoreConfig(
            connect_timeout=_DEFAULT_TIMEOUT_SECONDS,
            read_timeout=_DEFAULT_TIMEOUT_SECONDS,
        )
        user_agent_extra = "strands-agents"
        if self._client_config:
            existing_user_agent = getattr(self._client_config, "user_agent_extra", None)
            if existing_user_agent:
                user_agent_extra = f"{existing_user_agent} strands-agents"
            client_config = client_config.merge(self._client_config)
        # Applied last so a caller-supplied user agent extends ours, never replaces it.
        client_config = client_config.merge(BotocoreConfig(user_agent_extra=user_agent_extra))

        self._client = session.client(service_name="bedrock-runtime", config=client_config)
        return self._client

    def embed(self, texts: Sequence[str], *, purpose: EmbeddingPurpose | None = None) -> list[list[float]]:
        """Embed each text, returning one vector per input in the order received.

        Cached ``(purpose, text)`` pairs are served without a call, and only the misses reach
        Bedrock. A batch of all-hits therefore performs no I/O.

        Args:
            texts: Texts to embed. Not mutated.
            purpose: Purpose for this call, defaulting to the one fixed at construction.

        Returns:
            One vector per entry of ``texts``, aligned by index. Empty when ``texts`` is
            empty.

        Raises:
            ValueError: If ``purpose`` is not a valid :data:`EmbeddingPurpose`.
            EmbeddingError: If a Bedrock call fails, times out, or returns a response from
                which one vector per text cannot be read.
        """
        resolved = self._purpose if purpose is None else purpose
        _validate_purpose(resolved, argument="purpose")

        if not texts:
            return []

        # Deduplicated so a batch repeating a text pays for it once.
        pending: list[str] = []
        for text in texts:
            key = (resolved, text)
            if key not in self._cache and text not in pending:
                pending.append(text)

        if pending:
            for vector, text in zip(self._invoke(pending, resolved), pending, strict=True):
                self._remember(resolved, text, vector)

        return [self._recall(resolved, text) for text in texts]

    async def embed_async(self, texts: Sequence[str], *, purpose: EmbeddingPurpose | None = None) -> list[list[float]]:
        """Embed each text without blocking the caller's event loop.

        The boto3 client is synchronous and embedding pays inference latency, so the call runs
        in a worker thread. When every text is already cached no thread is used, which keeps
        the common case on the critical path cheap.

        Args:
            texts: Texts to embed. Not mutated.
            purpose: Purpose for this call, defaulting to the one fixed at construction.

        Returns:
            One vector per entry of ``texts``, aligned by index.

        Raises:
            ValueError: If ``purpose`` is not a valid :data:`EmbeddingPurpose`.
            EmbeddingError: If a Bedrock call fails, times out, or returns an unusable
                response.
        """
        resolved = self._purpose if purpose is None else purpose
        _validate_purpose(resolved, argument="purpose")

        if not texts:
            return []

        if all((resolved, text) in self._cache for text in texts):
            return [self._recall(resolved, text) for text in texts]

        return await asyncio.to_thread(self.embed, texts, purpose=resolved)

    def _remember(self, purpose: str, text: str, vector: list[float]) -> None:
        """Store a vector, evicting the least recently used entry when the cache is full.

        Args:
            purpose: Purpose the text was embedded under.
            text: Text that was embedded.
            vector: Vector to store.
        """
        self._cache[(purpose, text)] = vector
        if self._cache_size is not None:
            while len(self._cache) > self._cache_size:
                self._cache.popitem(last=False)

    def _recall(self, purpose: str, text: str) -> list[float]:
        """Return a cached vector, marking it as recently used.

        Args:
            purpose: Purpose the text was embedded under.
            text: Text that was embedded.

        Returns:
            The cached vector.

        Raises:
            EmbeddingError: If the entry is absent, which means the response did not cover
                every text submitted.
        """
        key = (purpose, text)
        if key not in self._cache:
            raise EmbeddingError(f"no embedding returned for text of length {len(text)} under purpose {purpose!r}")

        self._cache.move_to_end(key)
        return self._cache[key]

    def _invoke(self, texts: list[str], purpose: str) -> list[list[float]]:
        """Call Bedrock for texts that are not cached.

        Args:
            texts: Texts to embed, none of them cached.
            purpose: Purpose to embed them under.

        Returns:
            One vector per entry of ``texts``, aligned by index.

        Raises:
            EmbeddingError: If a call fails or a response is unusable.
        """
        if self._model_id.startswith("cohere."):
            vectors: list[list[float]] = []
            for offset in range(0, len(texts), _COHERE_MAX_BATCH):
                batch = texts[offset : offset + _COHERE_MAX_BATCH]
                payload = self._call(
                    {"texts": batch, "input_type": _COHERE_INPUT_TYPES[purpose]},
                )
                vectors.extend(_cohere_vectors(payload, len(batch)))
            return vectors

        # Titan and anything else single-text: one call per text, purpose has no equivalent.
        return [_titan_vector(self._call({"inputText": text})) for text in texts]

    def _call(self, body: dict[str, Any]) -> dict[str, Any]:
        """Invoke the model once and parse its JSON response.

        Args:
            body: Request body to serialize.

        Returns:
            The parsed response payload.

        Raises:
            EmbeddingError: If the call fails, times out, or the response is not JSON.
        """
        try:
            client = self._ensure_client()
            response = client.invoke_model(modelId=self._model_id, body=json.dumps(body))
            payload = json.loads(response["body"].read())
        except (ClientError, BotoCoreError) as error:
            # Read and connect timeouts are BotoCoreError subclasses, so the configured
            # timeouts land here too.
            raise EmbeddingError(f"embedding call failed: {error}") from error
        except TimeoutError as error:
            raise EmbeddingError(f"embedding call timed out: {error}") from error
        except (KeyError, TypeError, ValueError) as error:
            raise EmbeddingError(f"malformed embedding response: {error}") from error

        if not isinstance(payload, dict):
            raise EmbeddingError(f"malformed embedding response: expected an object, got {type(payload).__name__}")

        return payload


def _cohere_vectors(payload: dict[str, Any], expected: int) -> list[list[float]]:
    """Read the embeddings out of a Cohere response.

    Args:
        payload: Parsed response payload.
        expected: Number of texts submitted in this batch.

    Returns:
        The vectors, in the order the texts were submitted.

    Raises:
        EmbeddingError: If the payload has no usable ``embeddings`` list, or its length does
            not match the batch. A short list cannot be aligned with the texts, so there is
            nothing safe to keep.
    """
    embeddings = payload.get("embeddings")
    if not isinstance(embeddings, list):
        raise EmbeddingError("malformed embedding response: missing 'embeddings'")

    if len(embeddings) != expected:
        raise EmbeddingError(f"embedding response covered {len(embeddings)} of {expected} texts")

    return [_as_vector(item) for item in embeddings]


def _titan_vector(payload: dict[str, Any]) -> list[float]:
    """Read the single embedding out of a Titan response.

    Args:
        payload: Parsed response payload.

    Returns:
        The vector.

    Raises:
        EmbeddingError: If the payload carries no usable ``embedding``.
    """
    if "embedding" not in payload:
        raise EmbeddingError("malformed embedding response: missing 'embedding'")

    return _as_vector(payload["embedding"])


def _as_vector(item: Any) -> list[float]:
    """Coerce a response entry into a vector of floats.

    Args:
        item: Entry to coerce.

    Returns:
        The entry as a list of floats.

    Raises:
        EmbeddingError: If the entry is not a non-empty list of real numbers.
    """
    if not isinstance(item, list) or not item:
        raise EmbeddingError(f"malformed embedding response: expected a non-empty list, got {type(item).__name__}")

    for value in item:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise EmbeddingError(f"malformed embedding response: vector holds a non-number, {value!r}")

    return [float(value) for value in item]
